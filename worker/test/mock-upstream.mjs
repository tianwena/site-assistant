/* 本地假模型：OpenAI 兼容的流式 /v1/chat/completions，回答里带站内路径，用来验导航链路。
   不检查密钥；记录最近一次请求，供 smoke.mjs 核对「系统提示词 + 整站知识」确实发了出去。 */
import http from "node:http";
const PORT = Number(process.env.MOCK_PORT || 8799);
let last = null;
http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/last") { res.end(JSON.stringify(last)); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    last = JSON.parse(body || "{}");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const parts = ["AI MV 工厂的做法写在 ", "/ai-mv/", " 这一页，", "完整的 MV 在 /mv/ 可以看。"];
    let i = 0;
    const tick = setInterval(() => {
      if (i < parts.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 30000, completion_tokens: 24 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        clearInterval(tick);
        res.end();
      }
    }, 40);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`mock upstream on ${PORT}`));
