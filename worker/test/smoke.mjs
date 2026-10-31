/* 本地端到端：先起 mock-upstream.mjs，再 `npm run dev`（读 .dev.vars），然后跑本脚本。
   验：契约字段、两轮会话、超长 400、CORS 白名单、并发下单 IP 日额度是硬的、限流 429。 */
const BASE = process.argv[2] || "http://127.0.0.1:8788";
const ORIGIN = "https://tianwena.cn";
let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`); };

async function chat(message, conversation_id = "") {
  const r = await fetch(BASE + "/chat", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ message, conversation_id }) });
  if (!r.ok) return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
  const text = await r.text();
  const frames = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
  return { status: r.status, frames, headers: r.headers, answer: frames.map((f) => f.delta || "").join("") };
}

const h = await fetch(BASE + "/healthz").then((r) => r.json());
ok(JSON.stringify(h) === '{"ok":true}', "/healthz 只回 ok");
const q = await fetch(BASE + "/quota").then((r) => r.json());
ok(["limit", "used", "remaining", "reset_at"].every((k) => k in q) && q.remaining > 0, "/quota 四个字段", JSON.stringify(q));

const a = await chat("MV 工厂在哪看？");
const done = a.frames && a.frames.at(-1);
ok(a.status === 200 && done && done.done && done.conversation_id, "第一轮：流式回答并以 done 结束", a.answer);
ok(a.answer.includes("/ai-mv/") && a.answer.includes("/mv/"), "回答里带站内路径");
ok(a.headers.get("access-control-allow-origin") === ORIGIN, "白名单来源拿到 CORS 头");
const sent = await fetch("http://127.0.0.1:8799/last").then((r) => r.json());
const sys = sent.messages[0].content;
ok(sent.messages[0].role === "system" && sys.includes("/ai-mv/") && !("tools" in sent), "上游收到整站知识，且没有 tools 参数", `system=${sys.length} 字符`);

const b = await chat("那 AI 主播呢？", done.conversation_id);
const sent2 = await fetch("http://127.0.0.1:8799/last").then((r) => r.json());
ok(b.status === 200 && b.frames.at(-1).conversation_id === done.conversation_id, "第二轮沿用同一会话");
ok(sent2.messages.length === 4, "第二轮带上第一轮的上下文", `messages=${sent2.messages.length}`);

const long = await chat("长".repeat(2001));
ok(long.status === 400 && long.body.reason === "bad_message", "2001 字符被 400 拦下");
const bad = await fetch(BASE + "/healthz", { headers: { Origin: "https://evil.example" } });
ok(!bad.headers.get("access-control-allow-origin"), "白名单外来源拿不到 CORS 头");
const unknown = await chat("hi", "not-a-real-id");
ok(unknown.status === 500 && unknown.body.reason === "conversation_not_found", "未知会话 id 不会静默新建");

// 单 IP 日额度 0.25：前两轮已记账约 0.12，剩余只够约一次预留。并发 5 个，最多 1 个能过
const burst = await Promise.all([1, 2, 3, 4, 5].map((i) => chat(`并发 ${i}`)));
const okN = burst.filter((r) => r.status === 200).length;
const quotaN = burst.filter((r) => r.status === 429 && r.body.reason === "daily_quota_exhausted").length;
ok(okN <= 1 && okN + quotaN === 5, "并发下额度仍是硬上限", `200=${okN} 429=${quotaN}`);
const q2 = await fetch(BASE + "/quota").then((r) => r.json());
ok(q2.used <= 0.25 + 1e-6, "已用不超过单 IP 上限", `used=${q2.used}`);

// 限流 8 次/分钟：上面已计 8 次（2 + 1 未知会话 + 5 并发），再来一次必须 429 rate_limited
const rl = await chat("限流");
ok(rl.status === 429 && rl.body.reason === "rate_limited" && rl.headers.get("retry-after"), "超过每分钟次数 429 + Retry-After");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
