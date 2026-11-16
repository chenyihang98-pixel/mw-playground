# 关卡工坊的实测记录（P8 第 0 条）

本机实验，用来确定提示词、超时和是否关闭思考。实验脚本是 `scripts/workshop-probe.ts`，用法：`npx tsx scripts/workshop-probe.ts [--headed] [--runs 10] [--skip-think] [--skip-tools]`。

实验的边界：

- 只连 127.0.0.1 上的 Ollama；
- 不改 Ollama 的配置（上下文长度随请求传），不拉取模型；
- 不连任何外部服务。

## 环境

| 项目 | 取值 |
|---|---|
| 系统 | Windows 11，Node v24.18.0 |
| Ollama | 0.34.0，模型 `qwen3.5:9b-q4_K_M`（9.7B，Q4_K_M，模型支持的上下文 262144，能力 completion / vision / tools / thinking） |
| 显卡 | RTX 5080，16 GB（实验前 `nvidia-smi` 显示已用约 1.8 GB） |
| LangChain | `@langchain/ollama` 1.3.0 的 `ChatOllama`，`@langchain/core` 1.3.0 |
| 浏览器 | Playwright 1.65 的 Chromium，**无头**，带 `--enable-gpu --ignore-gpu-blocklist --use-angle=d3d11` |

浏览器无头运行，但 WebGL 走的是独显：`WEBGL_debug_renderer_info` 报告 `ANGLE (NVIDIA, NVIDIA GeForce RTX 5080 (0x00002C02) Direct3D11 vs_5_0 ps_5_0, D3D11)`。所以游戏和模型确实在抢同一块显卡。

游戏页面开的是 `/?level=gen-3`（雪夜高台，夜晚、下雨），整个实验期间一直在渲染。

## 实验前后 `ollama ps`

| 时机 | 输出 |
|---|---|
| 实验前 | 没有加载中的模型 |
| 第一次调用之后、结构化输出期间、实验结束时 | `qwen3.5:9b-q4_K_M  5.7 GB  100% GPU  8192  4 minutes from now` |

- CPU / GPU 的比例：100% 在 GPU 上，没有分到 CPU。
- 上下文长度：8192，就是请求里传的 `num_ctx`。没有改 Ollama 的默认配置。

游戏同时保持渲染：

- 第 1 组：10 次结构化输出约 29 秒，渲染了 1757 帧，约 60 帧/秒；
- 第 3 组：约 23 秒，1394 帧。

## 1. 思考模式

`ChatOllama` 的 `think` 选项会传给 Ollama 的 `think` 字段。`think: false` 时回复里没有思考内容（`reasoning_content` 为空）。

只试了开和关两档：这个模型通过这个接口没有“思考预算”之类的限制方式。

问的是一个短问题（“用一句话说明守卫的作用”）：

| 组 | think | 耗时 | 思考内容 | 生成的 token |
|---|---|---|---|---|
| 第 1 组 | false（冷启动，含加载模型） | 11,619 ms | 0 | 42 |
| 第 1 组 | false | 416 ms、493 ms | 0 | 35、39 |
| 第 1 组 | true | 15,617 ms | 5,057 字 | 1,635 |
| 第 2 组 | false | 461 ms、428 ms、502 ms | 0 | — |
| 第 2 组 | true | 11,714 ms | 3,911 字 | — |

思考打开、同时要求结构化输出时（3 次）：

- 每次 63.8–73.2 秒，思考 2.1–2.4 万字；
- 只有 1 次通过组合规则。

**结论：关闭思考（`think: false`）。** 打开思考慢 20–30 倍，通过率反而更低。

## 2. 结构化输出：P5 说明书的 JSON Schema

做法：

- 用 `z.toJSONSchema(briefSchema)` 生成 JSON Schema（1,504 个字符），作为 `format` 传给 Ollama；
- 回复先 `JSON.parse`，再用 P5 的 `briefSchema` 校验字段，再用 `parseBrief`（含组合规则、人物在不在名册里）校验；
- 通过的再交给 P5 的流水线 `produceLevel` 生成和检查。

同一个请求连续 10 次：“想要一个下雨的夜晚，中等大小的地图，宝石都藏在高台上，两个守卫来回巡逻，让星璇跟着我。”名册快照里有两个人物：小兵（同伴或守卫）、星璇（只能当同伴）。

| 组 | 提示词 | 可解析的 JSON | 通过 zod 的 schema | 通过组合规则和分工 | 生成成功 | 每次耗时 |
|---|---|---|---|---|---|---|
| 第 1 组 | 第 1 版：人物用完整 ID（实验用 64 位的 `aaa…` / `bbb…`） | 10/10 | 10/10 | **2/10** | 2/2 | 2.4–3.3 s |
| 第 2 组 | 第 2 版：人物用代号 r1、r2；elevated 的规则写成可以照着算的式子（人物 ID 换成 SHA-256 样子的） | 10/10 | 10/10 | **4/10** | 4/4 | 2.2–3.0 s |
| 第 3 组 | 第 3 版：再写明“一个人物只能有一个分工”“守卫不需要都由名册人物来当” | 10/10 | 10/10 | **10/10** | 10/10（都没有程序调整） | 1.8–2.6 s |

没通过的原因：

- 第 1 组：
  - 7 次 elevated（只放在高台上）配 2 个高台、5 个宝石，违反“每个高台最多 2 个”；
  - 6 次出场人物出错：64 位的 ID 抄错，或者同一个人物出现两次。
- 第 2 组：6 次同一个人物既当同伴又当守卫。

结构化输出本身很稳：30 次都是合法的 JSON，都符合 schema。出错的都是 schema 表达不了的组合规则，这正是 P5 的 `briefProblems` 管的，也是工坊要把原因交回模型修改的那一类。

## 3. 工具调用

做法：用 `bindTools` 绑定“查名册快照”工具（`lookup_roster`），配“理解请求”的提示词，请求里点名了“星璇”。

| 组 | 调用了工具的次数 | 第一次调用的耗时 | 工具返回后再问一次的耗时 |
|---|---|---|---|
| 第 1 组 | 1/3 | 0.67–1.19 s | 0.95 s |
| 第 2 组 | 1/3 | 0.79–0.98 s | 0.84 s |

- 工具调用能用：回复的 `tool_calls` 里工具名和参数都对，把 `ToolMessage` 交回去后模型给出总结。
- 调不调工具由模型决定。

**结论：** 写说明书时，名册快照一直都放在提示里（结构化输出那一步不能调工具），所以“理解请求”这一步的工具调用是可选的。这一步最多执行一轮工具调用，只执行这一个只读工具。

## 4. 单次响应的时间

都是游戏同时在渲染时测的：

- 冷启动（第一次调用，含加载 5.7 GB 的模型）：约 11.6 s；
- 加载之后：
  - 短问题 0.4–0.5 s；
  - 写一份说明书 1.8–3.3 s；
  - “理解请求”0.7–1.2 s。

## 据此确定的做法

- 关闭思考：`think: false`。
- 上下文：`num_ctx` 8192，随请求传（`MW_OLLAMA_NUM_CTX` 可改）。模型 100% 在 GPU 上，没有改 Ollama 的配置。
- 提示词：用第 3 版（`server/prompts.ts`）：
  - 人物用代号，服务再换回真正的 ID（`server/roster.ts`）；
  - 组合规则写成可以照着算的式子，数值从 P5 的 `GEN_CONFIG` 取。
- 采样：理解请求温度 0.3，最多 400 个 token；写说明书温度 0.4，最多 900 个 token。不让 LangChain 自动重试（`maxRetries: 0`），重试由工坊自己的修复流程负责。
- 超时：
  - 单次模型调用 60 s（`MW_WORKSHOP_CALL_TIMEOUT_MS`）：加载后单次不到 3.5 s，冷启动约 12 s，留出抢显卡的余量；
  - 整个请求 180 s（`MW_WORKSHOP_REQUEST_TIMEOUT_MS`）：理解请求最多 2 次调用，加上写说明书最多 3 次。
- 取消：`ChatOllama` 自己只在两个输出块之间检查取消。工坊给每次调用新建模型对象，`fetch` 绑定这次调用的 AbortSignal，取消或超时时真正中断 HTTP 请求。
  - 用假的 HTTP 服务验证过：服务端看到连接被中断。
  - 真实的 Ollama 在中断后多久停止生成，没有单独测。

## 本机模型验收

验收命令（默认跳过）是 `MW_WORKSHOP_ACCEPTANCE=1 npm run workshop-acceptance`，10 条固定请求在 `tests/data/workshop-requests.json`。结果见 [docs/status.md](status.md) 的 P8 一节。

## 冷启动（F2）

### 操作者测的事实（2026-11-16，操作者在本机测，不是本任务里测的）

- Ollama 已从 0.34.0 升级到 0.40.16，模型还是 `qwen3.5:9b-q4_K_M`。
- 跑 `npm run workshop-acceptance` 时，第 1 条请求用了 56.9 秒（两次模型调用，第一次包含加载模型）；2026-11-10 的两遍各约 10–11 秒。之后 9 条是 2.1–4.2 秒。
- 随后卸载模型再冷加载，两次都是 3.3 秒。所以慢的是长时间没用之后的第一次加载，原因没有查实。
- 当时单次模型调用的超时（`MW_WORKSHOP_CALL_TIMEOUT_MS`，默认 60 秒）把加载时间也算在里面。超时后走 `server/workshop.ts` 的 `finishFailure`：结果记为 error，回退到内置关卡。
- Ollama 0.40.16 的加载接口：
  - `POST {baseUrl}/api/generate`，请求体 `{"model": <模型>, "stream": false, "options": {"num_ctx": 8192}}`，不带 prompt：Ollama 只加载模型，返回 `{"done": true, "done_reason": "load", ...}`。
  - 冷加载 3.4 秒，模型已经加载时 94 毫秒。
  - 加载之后 `/api/ps` 显示 context_length 8192；接着用同样 num_ctx 的对话请求，load_duration 是 0.002 秒。
  - 对话请求换成 num_ctx 4096 时会重新加载（4.1 秒）。所以加载请求的 num_ctx 必须和 ChatOllama 用的 numCtx 相同。

### 据此的做法

- 生成时，检查模型可用之后、跑流程之前，先调用一次提供方的 `prepare`：
  - Ollama 发上面那个加载请求。请求体只有 `{ model, stream: false, options: { num_ctx } }`，num_ctx 和 ChatOllama 用同一份配置（`MW_OLLAMA_NUM_CTX`），不带 keep_alive；
  - OpenAI 兼容接口什么都不发。
- 加载有自己的超时 `MW_WORKSHOP_PREPARE_TIMEOUT_MS`（默认 150 秒，没设时取 150 秒和整个请求的超时两者中较小的；设了时不能大于整个请求的超时）。加载的时间算在整个请求里，不算在单次模型调用的超时里。
- 健康检查不加载模型：只请求 `/api/tags`。只打开工坊面板、不生成关卡的人，不会被占掉约 6 GB 显存。
- 统计的 `timingsMs.prepare` 记加载用了多少毫秒；`npm run workshop-acceptance` 每一行输出加载模型的毫秒数。

### 本任务里跑过的（2026-11-16，本机实测）

- 只连 127.0.0.1 上的 Ollama 0.40.16，没有拉取模型，没有改 Ollama 的配置，也没有手动卸载模型。
- 运行前 `/api/ps` 里没有加载中的模型（所以第 1 条是冷加载）。
- 命令：`MW_WORKSHOP_ACCEPTANCE=1 npm run workshop-acceptance`，10 条固定请求。
- 结果：
  - 8 条首次通过，2 条修复后通过；其他四类都是 0。
  - 加载模型：
    - 第 1 条 3,623 ms（冷加载）；
    - 之后 9 条 5–14 ms（模型已经加载，加载请求马上返回）。
  - 第 1 条：
    - 合计 6.3 秒，其中理解请求 841 ms、写说明书 1,715 ms；
    - 第一次模型调用里没有再包含加载时间。
  - 之后 9 条合计 2.0–5.7 秒。
  - 运行后 `/api/ps`：context_length 8192，size_vram 等于 size（全部在显存里）。
- 操作者遇到的“长时间没用之后第一次加载要几十秒”这次没有复现（这次的冷加载 3.6 秒），原因仍然没有查实。
