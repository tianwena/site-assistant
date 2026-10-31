# 小鲸鱼：个人站点上的 AI 导航助手

[tianwena.cn](https://tianwena.cn) 右下角那只小鲸鱼。问它站里有什么、哪篇讲了什么，它会说个大概，再把你带到对应那页。

- 线上体验：打开 [tianwena.cn](https://tianwena.cn)，点右下角「小鲸鱼」
- 设计说明：[tianwena.cn/site-assistant/](https://tianwena.cn/site-assistant/)

## 怎么做的

| | |
|---|---|
| 运行 | Cloudflare Worker，绑定自定义域名 `chat.tianwena.cn` |
| 存储 | D1（SQLite）：会话、消息、每日额度、限流计数 |
| 模型 | DeepSeek `deepseek-chat`，OpenAI 兼容流式接口 |
| 接口 | `GET /healthz` · `GET /quota` · `POST /chat`（SSE 流式） |
| 知识 | 整站正文约 3 万字直接放进系统提示词，不做检索 |
| 前端 | 原生 JS，无框架；回答里的站内路径自动变成链接 |

几个关键取舍：

- **不做检索**。站点只有几十页，整份放进上下文比检索少一个出错点；系统提示词前缀不变，上游缓存命中，单次回答约 ¥0.01。
- **花费是硬上限**。全站每天 ¥20、单 IP 每天 ¥2、每分钟 20 次、每会话 10 轮。D1 没有交互式事务，所以「查余额再扣钱」写成一条条件 SQL：`INSERT … WHERE 已用 + 预留 ≤ 上限`，条件不满足就一行都不写。
- **不给工具**。不联网、不跑代码，只能聊天，被绕晕了最多也就说错一句话。
- **按真实用量结算**。先按高估值预留，回答结束后按上游返回的 usage 结算；访客中途断开也按已生成部分记账。

## 评测

`assistant/eval/` 下有 25 条用例，打线上接口逐条判分：

| 类别 | 结果 |
|---|---|
| 导航：回答必须带上对应页面 | 15/15 |
| 站上没写的事：必须承认不知道 | 5/5 |
| 越权：套提示词、冒充本人、荐股、写爬虫、伪造指令 | 5/5 拒绝，无泄露 |
| 所有回答：编造路径 / Markdown 符号 | 0 / 0 |

首字大概 2.4 秒出来，整轮花了两毛八。每条原始回答都在 `assistant/eval/results/` 里，可以自己翻。

```bash
node assistant/eval/run_eval.mjs https://chat.tianwena.cn
```

## 本地运行（不花钱）

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars
node test/mock-upstream.mjs                # 窗口一：假模型
npm run migrate:local && npm run dev -- --port 8788   # 窗口二：本地 Worker
node test/smoke.mjs                        # 窗口三：14 项端到端检查
```

`.dev.vars` 把上游指向假模型，并把单 IP 日额度调到 ¥0.25、限流调到 8 次/分钟，用来验证并发下额度不超限、超频返回 429。

## 部署到自己的账号

1. `npx wrangler d1 create <名字>`，把输出的 `database_id` 和你的域名填进 `worker/wrangler.toml`
2. `npm run migrate:remote`
3. `npx wrangler secret put MODEL_API_KEY`，再设一个随机的 `IP_HASH_SALT`
4. 把 `assistant/knowledge/site.txt` 换成你自己站点的内容，改 `assistant/prompt.txt`
5. `npm run deploy`

## 目录

```
worker/      Worker 源码、D1 表结构、本地假模型与端到端检查
assistant/   系统提示词、站点知识、评测用例与结果
web/         前端聊天组件（chat.js）、桌宠状态机（pet.js）与模板片段
```

站点本身（11ty）不在这个仓库里。

## 历史

第一版是 FastAPI 加 SQLite，跑在家里电脑上，通过 Cloudflare Tunnel 对外，电脑一关助手就离线。后来迁到 Worker 加 D1，接口契约不变，前端没改。

## License

MIT
