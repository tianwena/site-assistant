/* =========================================================================
   助手后端 · Cloudflare Worker 版（chat.tianwena.cn）

   端点与契约与 assistant/app.py 完全一致，前端 chat.js 不用改：
     GET  /healthz   只回 {"ok":true}
     GET  /quota     {limit, used, remaining, reset_at}
     POST /chat      {message, conversation_id} → text/event-stream
                     帧：{"delta":"…"} … {"done":true,"conversation_id":"…","remaining_cost":n}

   沿用的十条红线（编号同 app.py）：
     1 无工具权限：上游请求里没有 tools / functions，知道的只有提示词 + 整站知识
     2 全局日额度硬上限   3 单会话轮数上限   4 单条字符上限   5 每 IP 每分钟限流
     6 上游细节不回显（502 固定文案）   7 /healthz 只回 ok   8 密钥只从 secret 读、不进日志
     9 CORS 白名单，⛔ 不是 *   10 所有上限都在 wrangler.toml 的 [vars] 里

   与 Python 版最大的不同：Worker 会同时跑多份，进程内的锁和计数都不可靠。
   所以每个「查余额再写入」的动作都写成**一条带条件的 SQL**（D1 单条语句是原子的）：
     · 限流：INSERT … SELECT … WHERE 窗口内次数 < 上限
     · 轮数：UPDATE … SET rounds = rounds + 1 WHERE rounds < 上限
     · 额度：INSERT 用户消息（cost = 预留额）… WHERE 已用 + 预留 ≤ 上限（全局与单 IP 同时判）
   条件不成立 ⇒ 一行都没写 ⇒ 拒绝。并发请求不可能一起越过上限。
   ========================================================================= */
import PROMPT_TEXT from "../../assistant/prompt.txt";
import SITE_TEXT from "../../assistant/knowledge/site.txt";

const PLACEHOLDER = "〔待用户填写 · 系统提示词〕";
const MIN_OUTPUT_TOKENS = 64;
const EPS = 1e-9;

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const SSE_HEADERS = {
  "Cache-Control": "no-cache, no-store, no-transform",
  "X-Accel-Buffering": "no",
  "Content-Type": "text/event-stream; charset=utf-8",
};
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/* ---------------- 配置 ---------------- */
function num(v, d) { const n = Number(v); return Number.isFinite(n) && v !== "" && v != null ? n : d; }

function settings(env) {
  const origins = String(env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    apiBase: String(env.MODEL_API_BASE || "https://api.deepseek.com/v1").replace(/\/+$/, ""),
    apiKey: env.MODEL_API_KEY || "",
    model: env.MODEL_NAME || "deepseek-chat",
    priceIn: num(env.PRICE_IN_CNY_PER_M, 2.0),
    priceInCached: num(env.PRICE_IN_CACHED_CNY_PER_M, 0.5),
    priceOut: num(env.PRICE_OUT_CNY_PER_M, 8.0),
    dailyLimit: num(env.DAILY_LIMIT_CNY, 20),
    ipDailyLimit: num(env.PER_IP_DAILY_LIMIT_CNY, 2),
    maxRounds: Math.trunc(num(env.MAX_ROUNDS_PER_CONVERSATION, 10)),
    maxChars: Math.trunc(num(env.MAX_MESSAGE_CHARS, 2000)),
    maxBodyBytes: Math.trunc(num(env.MAX_BODY_BYTES, 65536)),
    ratePerMinute: Math.max(1, Math.trunc(num(env.RATE_LIMIT_PER_MINUTE, 20))),
    maxOutputTokens: Math.trunc(num(env.MAX_OUTPUT_TOKENS, 1024)),
    timeoutMs: num(env.UPSTREAM_TIMEOUT_S, 45) * 1000,
    salt: env.IP_HASH_SALT || "change-me",
    tzHours: num(env.TZ_OFFSET_HOURS, 8),
    maxContextChars: Math.trunc(num(env.MAX_CONTEXT_CHARS, 60000)),
    origins: origins.length ? origins : ["https://tianwena.cn", "https://portfolio-6ru.pages.dev"],
    allowLocal: env.ALLOW_LOCAL_ORIGINS !== "false",
  };
}

/* 本地日期与次日零点（额度按 TZ_OFFSET_HOURS 的本地零点重置，格式同 Python isoformat） */
function localDay(s, now = Date.now()) {
  return new Date(now + s.tzHours * 3600e3).toISOString().slice(0, 10);
}
function resetAt(s, now = Date.now()) {
  const shifted = new Date(now + s.tzHours * 3600e3);
  shifted.setUTCHours(24, 0, 0, 0);
  const sign = s.tzHours >= 0 ? "+" : "-";
  const abs = Math.abs(s.tzHours);
  const hh = String(Math.floor(abs)).padStart(2, "0");
  const mm = String(Math.round((abs % 1) * 60)).padStart(2, "0");
  return shifted.toISOString().slice(0, 19) + `${sign}${hh}:${mm}`;
}
/* 当前本地时间，带毫秒与时区（落库的 created_at / last_at 用；按它排序同一会话的消息） */
function nowIso(s) { return isoLocal(s, Date.now()); }
function isoLocal(s, t) {
  const shifted = new Date(t + s.tzHours * 3600e3);
  const sign = s.tzHours >= 0 ? "+" : "-";
  const abs = Math.abs(s.tzHours);
  return shifted.toISOString().slice(0, 23) + `${sign}${String(Math.floor(abs)).padStart(2, "0")}:${String(Math.round((abs % 1) * 60)).padStart(2, "0")}`;
}

/* ---------------- 小工具 ---------------- */
function corsHeaders(request, s) {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  const ok = s.origins.includes(origin) || (s.allowLocal && LOCAL_ORIGIN.test(origin));
  if (!ok) return {};
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Expose-Headers": "Retry-After", Vary: "Origin" };
}

function json(status, body, cors, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS, ...cors, ...(extra || {}) },
  });
}

class ChatError extends Error {
  constructor(status, reason, detail, extra) { super(detail || reason); this.status = status; this.reason = reason; this.extra = extra || {}; }
}
class UpstreamUnavailable extends Error {}

function redact(text, s) {
  let out = String(text);
  if (s.apiKey) out = out.split(s.apiKey).join("***");
  return out.replace(/Bearer\s+\S+/g, "Bearer ***");
}

async function hashIp(ip, salt) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function uuidHex() { return crypto.randomUUID().replace(/-/g, ""); }

/* token 估算：故意高估（预留口径，宁可多留）；真实花费以上游 usage 为准 */
function countCjk(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x2e7f) n++;
  return n;
}
function estimateIn(text) { const c = countCjk(text); return Math.trunc((c + (text.length - c) / 3) * 1.2) + 1; }
function estimateOut(text) { const c = countCjk(text); return Math.trunc(c + (text.length - c) / 3) + 1; }

function cost(s, tin, tout, cached = 0) {
  const fresh = Math.max(0, tin - Math.max(0, cached));
  return (fresh * s.priceIn + Math.max(0, cached) * s.priceInCached + Math.max(0, tout) * s.priceOut) / 1e6;
}

function sse(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }

/* ---------------- 提示词与知识（红线 1：助手知道的只有这两样） ---------------- */
function promptReady(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    return !line.includes(PLACEHOLDER);
  }
  return false;
}

function systemText(s) {
  let site = SITE_TEXT || "（站点内容尚未导出：请先运行 python export_knowledge.py）";
  if (s.maxContextChars > 0 && site.length > s.maxContextChars) {
    site = site.slice(0, s.maxContextChars) + "\n\n（站点内容过长，以上为截断部分）";
    console.warn(`知识被截断：MAX_CONTEXT_CHARS=${s.maxContextChars}`);
  }
  const prompt = PROMPT_TEXT.replace(/^﻿/, "");
  return `${prompt}\n\n以下是本站的完整内容（导航与回答只依据这些内容，不要凭印象编造）：\n\n${site}`;
}

/* ---------------- 读请求体（边读边数，chunked 也挡得住） ---------------- */
async function readBody(request, max) {
  const declared = request.headers.get("Content-Length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > max) throw new ChatError(400, "bad_message", `declared=${declared}`);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch (e) { /* 忽略 */ } throw new ChatError(400, "bad_message", `streamed>${max}`); }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

/* ---------------- 库操作 ---------------- */
async function usedToday(db, day) {
  const r = await db.prepare("SELECT COALESCE(SUM(cost), 0) AS u FROM MESSAGE WHERE day = ?").bind(day).first();
  return Number(r?.u || 0);
}

async function noteBlocked(db, day) {
  await db.prepare(
    "INSERT INTO DAILY_QUOTA (day, used_cost, calls, blocked) VALUES (?,0,0,1) ON CONFLICT(day) DO UPDATE SET blocked = blocked + 1",
  ).bind(day).run();
}

/* 红线 5：每 IP 每分钟窗口，判定与记录在同一条语句里 */
async function rateCheck(db, ipHash, s) {
  const now = Date.now();
  const res = await db.prepare(
    `INSERT INTO RATE_HIT (ip_hash, at) SELECT ?1, ?2
     WHERE (SELECT COUNT(*) FROM RATE_HIT WHERE ip_hash = ?1 AND at > ?2 - 60000) < ?3`,
  ).bind(ipHash, now, s.ratePerMinute).run();
  if (res.meta.changes > 0) return { ok: true };
  const oldest = await db.prepare("SELECT MIN(at) AS t FROM RATE_HIT WHERE ip_hash = ? AND at > ?").bind(ipHash, now - 60000).first();
  const retry = oldest?.t ? Math.max(0, 60000 - (now - Number(oldest.t))) / 1000 : 60;
  return { ok: false, retry };
}

/* 红线 2/3：先原子地占一轮，再原子地预留额度；预留失败就把这一轮还回去 */
async function reserve(db, s, message, fullInput, conversationId, ipHash) {
  const day = localDay(s);
  const now = nowIso(s);
  let created = false;

  if (conversationId) {
    const r = await db.prepare(
      "UPDATE CONVERSATION SET rounds = rounds + 1, last_at = ? WHERE id = ? AND rounds < ?",
    ).bind(now, conversationId, s.maxRounds).run();
    if (r.meta.changes === 0) {
      const exists = await db.prepare("SELECT rounds FROM CONVERSATION WHERE id = ?").bind(conversationId).first();
      if (!exists) throw new ChatError(500, "conversation_not_found", `unknown conversation_id=${conversationId.slice(0, 64)}`);
      throw new ChatError(429, "conversation_limit", `rounds=${exists.rounds}`);
    }
  } else {
    conversationId = uuidHex();
    created = true;
  }

  const giveBackRound = async () => {
    if (!created) await db.prepare("UPDATE CONVERSATION SET rounds = MAX(0, rounds - 1) WHERE id = ?").bind(conversationId).run();
  };

  const estIn = estimateIn(fullInput);
  const costIn = cost(s, estIn, 0);
  // 两次机会：第一次读到的余额若被并发请求抢先用掉，条件插入会失败，再按新余额算一次
  for (let attempt = 0; attempt < 2; attempt++) {
    const globalLeft = s.dailyLimit - (await usedToday(db, day));
    const ipRow = await db.prepare("SELECT COALESCE(SUM(cost), 0) AS u FROM MESSAGE WHERE day = ? AND ip_hash = ?").bind(day, ipHash).first();
    const ipLeft = s.ipDailyLimit - Number(ipRow?.u || 0);
    const available = Math.min(globalLeft, ipLeft) - 1e-12;
    let outTokens = Math.trunc(((available - costIn) * 1e6) / Math.max(s.priceOut, 1e-9));
    outTokens = Math.max(0, Math.min(s.maxOutputTokens, outTokens));
    if (available <= 0 || outTokens < MIN_OUTPUT_TOKENS) break;

    const reserved = cost(s, estIn, outTokens);
    const messageId = uuidHex();
    const ins = await db.prepare(
      `INSERT INTO MESSAGE (id, conversation_id, role, content, created_at, tokens, tokens_in, tokens_out,
                            cached_tokens, cost, day, ip_hash)
       SELECT ?1, ?2, 'user', ?3, ?4, ?5, ?5, 0, 0, ?6, ?7, ?8
       WHERE (SELECT COALESCE(SUM(cost), 0) FROM MESSAGE WHERE day = ?7) + ?6 <= ?9 + ${EPS}
         AND (SELECT COALESCE(SUM(cost), 0) FROM MESSAGE WHERE day = ?7 AND ip_hash = ?8) + ?6 <= ?10 + ${EPS}`,
    ).bind(messageId, conversationId, message, now, estIn, reserved, day, ipHash, s.dailyLimit, s.ipDailyLimit).run();
    if (ins.meta.changes > 0) {
      if (created) {
        await db.prepare("INSERT INTO CONVERSATION (id, created_at, last_at, rounds, ip_hash) VALUES (?,?,?,1,?)")
          .bind(conversationId, now, now, ipHash).run();
      }
      return { conversationId, messageId, day, ipHash, reserved, maxTokens: outTokens, estIn, created };
    }
  }

  await giveBackRound();
  await noteBlocked(db, day);
  throw new ChatError(429, "daily_quota_exhausted", "quota", { reset_at: resetAt(s) });
}

async function contextMessages(db, conversationId) {
  const { results } = await db.prepare(
    "SELECT role, content FROM MESSAGE WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 40",
  ).bind(conversationId).all();
  return results.map((r) => ({ role: r.role, content: r.content }));
}

/* 一次调用的费用只记在 assistant 那一行，user 行的预留清零（同一个事务） */
async function recordAssistant(db, s, rsv, content, tin, tout, cached, c) {
  await db.batch([
    db.prepare(
      `INSERT INTO MESSAGE (id, conversation_id, role, content, created_at, tokens, tokens_in, tokens_out,
                            cached_tokens, cost, day, ip_hash) VALUES (?,?,'assistant',?,?,?,?,?,?,?,?,?)`,
    ).bind(uuidHex(), rsv.conversationId, content, nowIso(s), tin + tout, tin, tout, cached, c, rsv.day, rsv.ipHash),
    db.prepare("UPDATE MESSAGE SET tokens = 0, tokens_in = 0, tokens_out = 0, cached_tokens = ?, cost = 0 WHERE id = ?")
      .bind(cached, rsv.messageId),
    db.prepare(
      "INSERT INTO DAILY_QUOTA (day, used_cost, calls, blocked) VALUES (?,?,1,0) ON CONFLICT(day) DO UPDATE SET used_cost = used_cost + ?, calls = calls + 1",
    ).bind(rsv.day, c, c),
  ]);
}

/* 一个字都没吐出来：预留降到 newCost（通常是 0） */
async function releaseUnused(db, rsv, newCost) {
  await db.prepare("UPDATE MESSAGE SET cost = ? WHERE id = ?").bind(Math.max(0, newCost), rsv.messageId).run();
}

/* 首块就失败：整条撤销，不留空会话；已有会话则把这一轮还回去 */
async function abandon(db, rsv) {
  const stmts = [db.prepare("DELETE FROM MESSAGE WHERE id = ?").bind(rsv.messageId)];
  if (rsv.created) {
    stmts.push(db.prepare("DELETE FROM CONVERSATION WHERE id = ? AND NOT EXISTS (SELECT 1 FROM MESSAGE WHERE conversation_id = ?)")
      .bind(rsv.conversationId, rsv.conversationId));
  } else {
    stmts.push(db.prepare("UPDATE CONVERSATION SET rounds = MAX(0, rounds - 1) WHERE id = ?").bind(rsv.conversationId));
  }
  await db.batch(stmts);
}

/* ---------------- 上游（唯一的出站请求；红线 1：没有 tools / functions） ---------------- */
async function* callUpstream(s, messages, maxTokens) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), s.timeoutMs);
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), s.timeoutMs); };
  let resp;
  try {
    resp = await fetch(`${s.apiBase}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ model: s.model, messages, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new UpstreamUnavailable(`${e && e.name}: ${e && e.message}`);
  }
  if (resp.status >= 400) {
    clearTimeout(timer);
    const detail = (await resp.text().catch(() => "")).slice(0, 500);
    throw new UpstreamUnavailable(`HTTP ${resp.status}: ${redact(detail, s)}`);
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      let r;
      try { r = await reader.read(); } catch (e) { throw new UpstreamUnavailable(`read: ${e && e.name}`); }
      if (r.done) break;
      bump();
      buf += dec.decode(r.value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (let line of lines) {
        line = line.trim();
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (raw === "[DONE]") return;
        let chunk;
        try { chunk = JSON.parse(raw); } catch (e) { continue; } // 偶发半行：跳过
        if (chunk && chunk.error) throw new UpstreamUnavailable(`stream error: ${JSON.stringify(chunk.error).slice(0, 300)}`);
        const usage = chunk && chunk.usage ? chunk.usage : null;
        const piece = chunk && Array.isArray(chunk.choices) && chunk.choices[0] && chunk.choices[0].delta;
        const delta = piece && typeof piece === "object" && typeof piece.content === "string" ? piece.content : "";
        if (delta || usage) yield { delta, usage };
      }
    }
  } finally {
    clearTimeout(timer);
    try { reader.cancel(); } catch (e) { /* 忽略 */ }
  }
}

/* ---------------- 路由 ---------------- */
async function handleQuota(env, s, cors) {
  try {
    const used = await usedToday(env.DB, localDay(s));
    return json(200, { limit: s.dailyLimit, used: Math.round(used * 1e6) / 1e6, remaining: Math.round(Math.max(0, s.dailyLimit - used) * 1e6) / 1e6, reset_at: resetAt(s) }, cors);
  } catch (e) {
    console.error("读额度失败", e && e.message);
    // 失败时宁可少给：剩余按 0
    return json(200, { limit: s.dailyLimit, used: s.dailyLimit, remaining: 0, reset_at: resetAt(s) }, cors);
  }
}

async function handleChat(request, env, ctx, s, cors) {
  const db = env.DB;
  let body;
  try { body = JSON.parse(await readBody(request, s.maxBodyBytes)); } catch (e) {
    if (e instanceof ChatError) throw e;
    throw new ChatError(400, "bad_message", "invalid json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ChatError(400, "bad_message", "body not object");
  let message = body.message;
  const conversationId = body.conversation_id || "";
  if (typeof message !== "string" || !message.trim()) throw new ChatError(400, "bad_message", "empty message");
  if (typeof conversationId !== "string") throw new ChatError(400, "bad_message", "conversation_id not string");
  message = message.trim();
  if (message.length > s.maxChars) throw new ChatError(400, "bad_message", `too_long len=${message.length}`); // 红线 4

  // CF-Connecting-IP 由 Cloudflare 边缘写入，客户端伪造不了
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await hashIp(ip, s.salt);
  const rate = await rateCheck(db, ipHash, s);
  ctx.waitUntil(db.prepare("DELETE FROM RATE_HIT WHERE at < ?").bind(Date.now() - 120000).run().catch(() => {}));
  if (!rate.ok) {
    ctx.waitUntil(noteBlocked(db, localDay(s)).catch(() => {}));
    return json(429, { reason: "rate_limited" }, cors, { "Retry-After": String(Math.trunc(rate.retry) + 1) });
  }

  if (!promptReady(PROMPT_TEXT)) throw new ChatError(500, "internal", "prompt not ready");
  if (!s.apiKey) {
    console.error("MODEL_API_KEY 未设置：用 `npx wrangler secret put MODEL_API_KEY` 设置");
    return json(502, { reason: "upstream_unavailable" }, cors);
  }

  const sys = systemText(s);
  const build = (history) => {
    const msgs = [{ role: "system", content: sys }, ...history];
    if (!history.length || history[history.length - 1].content !== message) msgs.push({ role: "user", content: message });
    return msgs;
  };
  let history = conversationId ? await contextMessages(db, conversationId) : [];
  let messages = build(history);

  const rsv = await reserve(db, s, message, messages.map((m) => m.content).join("\n"), conversationId, ipHash);
  history = await contextMessages(db, rsv.conversationId);
  messages = build(history);

  // 先拿到第一块再回 200：第一块就失败时还能按契约回 502
  const it = callUpstream(s, messages, rsv.maxTokens);
  let first;
  try {
    const r = await it.next();
    first = r.done ? null : r.value;
  } catch (e) {
    console.error(`上游不可用 conv=${rsv.conversationId}: ${redact(e && e.message, s).slice(0, 800)}`);
    await abandon(db, rsv);
    return json(502, { reason: "upstream_unavailable" }, cors);
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  ctx.waitUntil(pump(db, s, rsv, it, first, writer, enc));
  return new Response(readable, { status: 200, headers: { ...SSE_HEADERS, ...cors } });
}

/* SSE 推流 + 结算。一旦开始推流，错误只能以数据帧告知；客户端断开也照实记账 */
async function pump(db, s, rsv, it, first, writer, enc) {
  const acc = [];
  let usage = null;
  let clientGone = false;
  const send = async (obj) => {
    if (clientGone) return;
    try { await writer.write(enc.encode(sse(obj))); } catch (e) { clientGone = true; }
  };
  const settlePartial = async () => {
    const partial = acc.join("");
    const tout = estimateOut(partial);
    const c = cost(s, rsv.estIn, tout);
    if (partial.trim()) await recordAssistant(db, s, rsv, partial, rsv.estIn, tout, 0, c);
    else await releaseUnused(db, rsv, 0);
  };
  const remaining = async () => Math.round(Math.max(0, s.dailyLimit - (await usedToday(db, rsv.day))) * 1e6) / 1e6;

  try {
    let pending = first;
    for (;;) {
      if (!pending) {
        const r = await it.next();
        if (r.done) break;
        pending = r.value;
      }
      if (pending.usage) usage = pending.usage;
      if (pending.delta) { acc.push(pending.delta); await send({ delta: pending.delta }); }
      pending = null;
      if (clientGone) { await it.return(); break; }
    }
  } catch (e) {
    console.error(`上游中断 conv=${rsv.conversationId}: ${redact(e && e.message, s).slice(0, 800)}`);
    if (!acc.length) {
      await abandon(db, rsv);
      await send({ error: "upstream_unavailable" });
    } else {
      await settlePartial();
      await send({ error: "upstream_interrupted" });
      await send({ done: true, conversation_id: rsv.conversationId, remaining_cost: await remaining(), partial: true });
    }
    try { await writer.close(); } catch (err) { /* 忽略 */ }
    return;
  }

  try {
    const text = acc.join("");
    if (clientGone) {
      await settlePartial();
    } else if (!text.trim()) {
      await releaseUnused(db, rsv, 0);
      await send({ delta: "" });
    } else if (usage && Number.isInteger(usage.completion_tokens)) {
      const tin = Number(usage.prompt_tokens) || rsv.estIn;
      const tout = usage.completion_tokens;
      const cached = Number(usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
      await recordAssistant(db, s, rsv, text, tin, tout, cached, cost(s, tin, tout, cached));
    } else {
      console.warn(`上游未返回 usage，按估算记账 conv=${rsv.conversationId}`);
      const tout = estimateOut(text);
      await recordAssistant(db, s, rsv, text, rsv.estIn, tout, 0, cost(s, rsv.estIn, tout));
    }
    await send({ done: true, conversation_id: rsv.conversationId, remaining_cost: await remaining() });
  } catch (e) {
    console.error(`结算失败 conv=${rsv.conversationId}: ${e && e.message}`);
    await send({ error: "internal_error" });
  }
  try { await writer.close(); } catch (e) { /* 忽略 */ }
}

export default {
  async fetch(request, env, ctx) {
    const s = settings(env);
    const cors = corsHeaders(request, s);
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (!cors["Access-Control-Allow-Origin"]) return new Response("Disallowed CORS origin", { status: 400, headers: SECURITY_HEADERS });
      return new Response(null, {
        status: 204,
        headers: { ...cors, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Accept", "Access-Control-Max-Age": "600" },
      });
    }

    try {
      if (pathname === "/healthz" && request.method === "GET") return json(200, { ok: true }, cors);
      if (pathname === "/quota" && request.method === "GET") return await handleQuota(env, s, cors);
      if (pathname === "/chat" && request.method === "POST") return await handleChat(request, env, ctx, s, cors);
      return json(404, { reason: "not_found" }, cors);
    } catch (e) {
      if (e instanceof ChatError) {
        if (e.status >= 500) console.error(`chat error ${e.reason}: ${e.message}`);
        if (e.reason === "daily_quota_exhausted") e.extra.reset_at = e.extra.reset_at || resetAt(s);
        return json(e.status, { reason: e.reason, ...e.extra }, cors);
      }
      console.error(`未预期异常 path=${pathname}: ${e && e.stack}`);
      return json(500, { reason: "internal_error" }, cors);
    }
  },
};
