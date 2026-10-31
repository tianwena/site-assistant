/* =========================================================================
   chat.js —— 导航助手的前端。

   端点（后端是 Cloudflare Worker，见 worker/；接口与旧的 assistant/ FastAPI 版相同）：
     GET  /healthz   探活
     GET  /quota     今日剩余额度
     POST /chat      text/event-stream 流式回答

   后端不在线时（额度用尽、上游故障、部署中），降级不是兜底而是正常路径：
   输入框禁用并显示站主写的降级文案，开场白与联系入口始终保留。
   ⚠️ 七条降级文案来自 site.json 的 degraded，由 base.njk 注入；下面 COPY 里的占位符
   只是"没注入进来"的哨兵，一旦上屏就说明接线断了。
   ========================================================================= */
(function () {
  "use strict";

  var boot = document.currentScript && document.currentScript.dataset;
  var BASE = (boot && boot.chatBase) || "";

  var box = document.querySelector("[data-talk]");
  if (!box) return;

  var msgs = box.querySelector("[data-msgs]");
  var input = box.querySelector("[data-input]");
  var sendBtn = box.querySelector("[data-send]");
  var chips = Array.prototype.slice.call(box.querySelectorAll("[data-q]"));
  var degraded = box.querySelector("[data-degraded]");
  var online = document.querySelector("[data-online]");
  var stateEl = document.querySelector("[data-state]");
  var dotEl = document.querySelector(".assistant .dot");

  var conversationId = "";
  var busy = false;
  var blocked = false;

  /* 降级提示的文案全部来自 src/_data/site.json 的 degraded（用户 2026-09-16 决定 D13，
     2026-09-18 用户逐条定稿 —— 七条已是真句子，不再是占位）。
     下面这份兜底**刻意留成占位符、充当哨兵**（不复制正文），它只在数据没注入进来时生效；
     真出现就说明接线断了 —— 全站其余地方的 `〔待用户填写〕` 都已清掉，
     所以这个串一旦上屏立刻可见异常。ui.spec.js「降级文案已定稿」那条用例守着它。 */
  var FALLBACK = "〔降级提示未注入〕";
  var COPY = {
    offline: FALLBACK,
    exhausted: FALLBACK,
    rate: FALLBACK,
    rounds: FALLBACK,
    tooLong: FALLBACK,
    upstream: FALLBACK,
    empty: FALLBACK,
  };
  try {
    var injected = JSON.parse((boot && boot.chatCopy) || "{}");
    Object.keys(COPY).forEach(function (k) {
      if (injected[k]) COPY[k] = injected[k];
    });
  } catch (e) { /* 数据缺失就用上面那组占位 */ }

  /* ---------- 渲染一条消息 ----------
     设计稿的消息是 `.msg.ai` / `.msg.me` + 一个 `.who` 小标（Guide / Visitor）。
     这两个词是**设计稿里就有的固定标签**，不是"文案"（工单铁律 §2.④ 管的是句子）。
     访客能读到的每一句内容仍然只来自用户（正文/占位符）或助手后端。 */
  /* 助手回答里出现的站内地址要能点。认两种写法：站内路径（/ai-mv/）与本站完整网址
     （https://tianwena.cn/ai-mv/，知识里的站点地图就是这种写法，模型常照抄）。
     站内路径一律以 / 结尾，所以「6/8 拍」「A/B 对决」这类正文不会被误认成链接；
     前一个字符是字母数字或 / . : - 时也不认（避免截到别的网址中间）。
     别的字符一律当纯文本——不解析任何其它语法。 */
  var PATH_RE = /(^|[^a-z0-9\/.:\-])(?:(https?:\/\/(?:www\.)?tianwena\.cn(\/(?:[a-z0-9][a-z0-9\-]*\/)*))|(\/(?:[a-z0-9][a-z0-9\-]*\/)+))(?![a-z0-9])/gi;
  function appendRich(parent, text) {
    String(text || "").split("\n").forEach(function (line, li) {
      if (li) parent.appendChild(document.createElement("br"));
      var last = 0, m;
      PATH_RE.lastIndex = 0;
      while ((m = PATH_RE.exec(line)) !== null) {
        var start = m.index + m[1].length;
        var path = m[3] || m[4];
        if (start > last) parent.appendChild(document.createTextNode(line.slice(last, start)));
        var a = document.createElement("a");
        a.href = path;
        a.textContent = path;
        parent.appendChild(a);
        last = start + (m[2] || m[4]).length;
      }
      if (last < line.length) parent.appendChild(document.createTextNode(line.slice(last)));
    });
  }


  function addLine(text, me) {
    var d = document.createElement("div");
    d.className = "msg " + (me ? "me" : "ai");
    var who = document.createElement("span");
    who.className = "who";
    who.textContent = me ? "你" : "小鲸鱼";
    d.appendChild(who);
    if (me) d.appendChild(document.createTextNode(text || ""));
    else appendRich(d, text);
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  function addTyping() {
    var t = addLine("", false);
    var sp = document.createElement("span");
    sp.className = "typing";
    sp.innerHTML = "<i></i><i></i><i></i>";
    t.appendChild(sp);
    return t;
  }

  /* ---------- 降级态：一个写入点，别在多处各改一遍 ---------- */
  function setState(text, live) {
    if (stateEl) stateEl.textContent = text;
    if (dotEl) dotEl.classList.toggle("live", !!live);
  }

  function setDegraded(message) {
    blocked = true;
    setState("离线 · 加微信找我", false);
    box.classList.add("chat-off");
    if (degraded) {
      degraded.textContent = message;
      degraded.hidden = false;
    }
    if (input) {
      input.disabled = true;
      input.placeholder = message;
    }
    if (sendBtn) sendBtn.disabled = true;
    chips.forEach(function (c) { c.disabled = true; });
    if (online) online.textContent = message;
    /* ⚠️ 这里**不要**去隐藏开场白（`[data-draft]`，用户 D22，2026-09-16）：
       它是**用户写的自我介绍**，不是助手说的话，不该跟"助手能不能用"绑定。
       曾经有一行
         msgs.querySelectorAll("[data-draft]").forEach(n => n.hidden = true);
       —— 后端没上线时一加载就进降级态，于是首页连自我介绍都没了。
       降级只该影响"助手能不能用"。 */
  }

  function setOnline() {
    blocked = false;
    setState("在线 · 站上内容都能答", true);
    box.classList.remove("chat-off");
    if (degraded) degraded.hidden = true;
    if (input) input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    chips.forEach(function (c) { c.disabled = false; });
  }

  /* ---------- 流式：POST /chat（text/event-stream） ---------- */
  function parseData(line) {
    var s = line.slice(5).trim(); // 去掉 "data:"
    if (!s) return null;
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  function sendStream(message, onDelta) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 60000);

    return fetch(BASE + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ message: message, conversation_id: conversationId || "" }),
      signal: ctrl.signal,
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          var err = new Error("chat_failed");
          err.status = res.status;
          err.reason = body && body.reason;
          throw err;
        });
      }
      if (!res.body || !res.body.getReader) throw new Error("stream_unsupported");

      var reader = res.body.getReader();
      var dec = new TextDecoder("utf-8");
      var buf = "";

      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { clearTimeout(timer); return; }
          buf += dec.decode(r.value, { stream: true });
          var parts = buf.split("\n");
          buf = parts.pop();
          parts.forEach(function (line) {
            line = line.trim();
            if (!line || line.charAt(0) === ":") return;
            if (line.indexOf("data:") !== 0) return;
            var j = parseData(line);
            if (!j) return;
            if (j.delta) onDelta(j.delta);
            if (j.done && j.conversation_id) conversationId = j.conversation_id;
          });
          return pump();
        });
      }
      return pump();
    }).then(function () { clearTimeout(timer); }, function (e) { clearTimeout(timer); throw e; });
  }

  /* ---------- 发一条 ---------- */
  function submit(text) {
    if (busy || blocked) return;
    var v = String(text || input.value || "").trim();
    if (!v) return;
    if (v.length > 2000) {
      // 契约：400 = 消息为空或**超过 2000 字符**。这条是"内容太长"，不是"这一轮聊完了"，
      // 所以用独立的 tooLong 文案（2026-09-16 审查 B2）
      addLine(COPY.tooLong, false);
      return;
    }
    input.value = "";
    addLine(v, true);
    busy = true;
    if (sendBtn) sendBtn.disabled = true;
    var t = addTyping();
    var acc = "";
    if (window.__pet) window.__pet.think();

    sendStream(v, function (delta) {
      if (acc === "") t.textContent = "";
      acc += delta;
      /* 流式过程中也走同一套渲染：文字里一旦出现完整的 /路径/ 就变成链接 */
      while (t.firstChild) t.removeChild(t.firstChild);
      appendRich(t, acc);
      msgs.scrollTop = msgs.scrollHeight;
    }).then(function () {
      if (acc === "") t.appendChild(document.createTextNode(COPY.empty));
    }).catch(function (err) {
      if (t.parentNode) t.parentNode.removeChild(t);
      var reason = err && err.reason;
      if (err && err.name === "AbortError") { addLine(COPY.upstream, false); return; }
      if (reason === "daily_quota_exhausted") { setDegraded(COPY.exhausted); return; }
      if (reason === "conversation_limit") { addLine(COPY.rounds, false); return; }
      if (reason === "rate_limited") { addLine(COPY.rate, false); return; }
      if (err && err.status === 502) { addLine(COPY.upstream, false); return; }
      if (err && err.status === 400) { addLine(COPY.tooLong, false); return; }
      // 连不上后端（家里断电 / 还没上线）→ 整块降级
      setDegraded(COPY.offline);
    }).finally(function () {
      // ⚠️ 必须用 finally：上面 catch 里有 return 的分支（如"额度用尽"会直接转降级），
      // 用 .then 接在后面会被跳过 —— 那样 busy 永远为 true、桌宠卡在思考、
      // 发送键再也不恢复（2026-09-16 审查 B3）
      busy = false;
      if (!blocked && sendBtn) sendBtn.disabled = false;
      if (window.__pet) window.__pet.rest();
    });
  }

  if (sendBtn) sendBtn.addEventListener("click", function () { submit(); });
  if (input) {
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });
  }
  chips.forEach(function (c) {
    // 注意：chip 上的 "▸ " 是 CSS ::before 画的，不在 textContent 里 —— 别去 replace 它
    c.addEventListener("click", function () { submit(c.textContent.trim()); });
  });

  /* ---------- 启动：先问健康，再问额度 ---------- */
  function getJSON(path, ms) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    return fetch(BASE + path, { signal: ctrl.signal })
      .then(function (r) {
        if (!r.ok) throw new Error("http_" + r.status);
        return r.json();
      })
      .then(function (j) { clearTimeout(timer); return j; },
            function (e) { clearTimeout(timer); throw e; });
  }

  function boot_() {
    getJSON("/healthz", 3000)
      .then(function (h) {
        if (!h || h.ok !== true) throw new Error("unhealthy");
        return getJSON("/quota", 3000);
      })
      .then(function (q) {
        /* 三分支（2026-09-16 审查 B4）：只有**确切的 0**才算"额度用尽"；
           拿不到数字 / 解析失败 / 500 都归"不可达" —— 两者在界面上必须可区分，
           否则访客看到"今日额度已用完"却其实是家里断电，语义是错的。 */
        if (!q || q.remaining === undefined || q.remaining === null) {
          setDegraded(COPY.offline);
          return;
        }
        var remaining = Number(q.remaining);
        if (!isFinite(remaining)) { setDegraded(COPY.offline); return; }
        if (remaining > 0) { setOnline(); return; }

        setDegraded(COPY.exhausted);
        // 契约：reset_at = 次日本地零点。到点自动恢复（否则访客得刷新页面）
        if (q.reset_at) {
          var left = new Date(q.reset_at).getTime() - Date.now();
          if (left > 0 && left < 86400000) setTimeout(boot_, left + 1500);
        }
      })
      .catch(function () { setDegraded(COPY.offline); });
  }

  boot_();
})();
