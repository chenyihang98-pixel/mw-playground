# mw-playground

本机运行的浏览器 3D 小游戏：导入“模匠”导出的角色文件，替换主角，或加入为同伴、守卫。

当前进度：P1（工程骨架）。有一个能渲染的空场景、开发用的夹具预览、GLB 结构检查工具和锁文件摘要工具，还没有玩法。各任务的进度见 [docs/status.md](docs/status.md)，项目约定见 [docs/conventions.md](docs/conventions.md)（后续任务开始前都要先读）。

## 环境要求

- Node.js 24（本机验证用 v24.18.0；`package.json` 的 `engines` 写的是 `>=24.18.0 <25`）
- npm 11（随 Node 24 安装）
- git（`lock-summary` 和单元测试会用到）
- 端到端测试需要 Playwright 的 Chromium（见下面的安装步骤）

## 安装

```sh
npm ci
npx playwright install chromium
```

`npm ci` 严格按 `package-lock.json` 安装。所有依赖都是确切版本（不带 `^` 或 `~`）。

## npm 脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动 Vite 开发服务器（http://127.0.0.1:5173）。开发模式下页面左上角有夹具预览面板。 |
| `npm run build` | 生产构建，输出到 `dist/`。生产构建不包含夹具预览和测试钩子。 |
| `npm run preview` | 预览生产构建（http://127.0.0.1:4173）。 |
| `npm run typecheck` | TypeScript 严格模式类型检查（`tsconfig.app.json` 管页面代码，`tsconfig.node.json` 管脚本、测试和配置）。 |
| `npm run lint` | ESLint（typescript-eslint 的 strict + stylistic 类型检查规则）。 |
| `npm test` | Vitest 单元测试，只在 Node 里跑，不需要浏览器。 |
| `npm run e2e` | Playwright 端到端测试（Chromium）。Playwright 自己启动和关闭 Vite 服务器：固定端口 4317、`--strictPort`、不复用已有服务。截图等输出在 `test-results/`（不提交）。 |
| `npm run inspect-asset -- <文件路径> [--json]` | GLB 结构检查，见下文。 |
| `npm run lock-summary -- <起点引用> <终点引用>` | 比较两个提交里的 `package-lock.json`，输出 Markdown 摘要到标准输出。 |

npm 会在脚本输出前打印两行命令回显；需要把输出重定向到文件时用 `npm run -s`（`--silent`）去掉它，例如：

```sh
npm run -s lock-summary -- f178799 HEAD > docs/deps/P1-lock-summary.md
```

## inspect-asset：GLB 结构检查

```sh
npm run inspect-asset -- path/to/character.glb          # 文本报告
npm run inspect-asset -- path/to/character.glb --json   # JSON 报告
```

- 相对路径按运行命令时所在的目录解析。
- 只读：只读取这一个文件；不联网，不写任何文件；外部资源（buffer、图片的非 `data:` uri）只列出，不读取。
- 检查逻辑在 `src/asset/inspect/`，是纯模块（输入 `ArrayBuffer` 或 `Uint8Array`，不用 fs、DOM、three 的加载器），以后浏览器里的导入预检会复用它。`scripts/inspect-asset.ts` 只负责读文件和输出。

退出码：

| 退出码 | 含义 |
|---|---|
| 0 | 检查完成（报告里可能有“未计算”的项或“问题”） |
| 1 | 不是合法的 GLB，标准错误里写明原因。包括：OBJ / STL / PLY、`.gltf` 文本、空文件；magic 或容器版本不对；文件被截断，或头部声明长度与实际长度不一致；块结构损坏（块越界、长度不是 4 的倍数、第一个块不是 JSON、重复的 JSON 块、重复或不在第二位的 BIN 块）；BIN 块与 `buffers[0].byteLength` 对不上；JSON 块有 BOM、用 0 字节补齐、不是合法 UTF-8 或无法解析；JSON 结构不合法、缺 `asset.version` 或版本不是 2.x。 |
| 2 | 用法错误（缺参数、未知选项、多个文件）或读不了文件（不存在、是目录、没有权限） |
| 3 | 检查工具内部错误（程序缺陷，应当报告） |

文本报告的各节：

- **[容器]** 文件大小；容器版本；GLB 头声明的长度和实际长度（以及是否一致）；各个块的类型和长度。
- **[资产]** `asset.generator`、`asset.version`；`extensionsUsed`、`extensionsRequired`（需要解码器的扩展会标出，例如 `KHR_draco_mesh_compression`）。
- **[外部资源引用]** `buffers` 和 `images` 里不是 `data:` 的 uri。只列出，不读取。
- **[网格]** 网格数、图元数、三角面数。三角面数按图元的 `indices`（没有则 `POSITION`）的 `count` 和 `mode` 计算；点和线图元的三角面数是 0。
- **[贴图]** 贴图数、图片数；每张图片的来源（bufferView / data URI / 外部 uri）、声明的 mimeType、识别出的格式，以及能从内嵌 PNG/JPEG 文件头读出的尺寸。
- **[蒙皮]** skins 数和每个 skin 的关节数。
- **[动画]** 每个片段：序号；原始名字（没有名字或名字为空字符串时写“无名；GLTFLoader 加载后为 animation_<序号>”）；通道数；时长；`extras`；`extras.loop`；重名标记；`translation` 通道首末关键帧的水平（XZ）位移。
  - `extras.loop（原始）` 是 GLB 原始 JSON 里 `animation.extras.loop` 的值，分四种：`true`、`false`、缺失（写明是没有 extras、extras 不是对象，还是 extras 里没有 loop）、其他类型（列出类型和原值）。它不是加载后的值；加载后对应 `clip.userData.loop`（three r187 GLTFLoader：只有 extras 是对象时才合并进 `clip.userData`）。这个对应关系由单元测试固定在锁定的 three 0.187.0 上。
  - 重名按加载后的名字判断，同名的片段都会标出。
- **[包围盒]** 按 `POSITION` 访问器和节点静态变换计算，不含蒙皮姿态（骨骼动画造成的形变）。
- **[问题]** 容器本身合法、但 glTF 内容里有不一致的地方，例如：节点树有环或引用了不存在的节点、通道引用了不存在的采样器、`extensionsRequired` 不在 `extensionsUsed` 里、数据里有 NaN / Infinity，以及规范允许并要求忽略的未知类型块。受影响的指标写“未计算”和原因；引用不存在的访问器之类的问题直接体现在相应指标的“未计算”原因里。

声明值和实际值分开写：

- 时长：声明值是动画输入（时间）访问器声明的 `max`；实际值是从 BIN 数据里读出的最大时间。
- 包围盒：声明值来自 `POSITION` 访问器的 `min`/`max`（8 个角点经节点变换）；实际值来自 BIN 里的每个顶点经节点变换。

算不出的指标写“未计算（原因）”，绝不填 0。常见原因：使用了需要解码器的压缩扩展（例如 Draco）、访问器缺 `min`/`max`、引用了外部 buffer、稀疏访问器（未实现读取）、访问器的 `count` / 偏移超出 bufferView 或 buffer 声明的长度、数据里有 NaN / Infinity、计算结果超出数值范围。本工具不实现任何解码器。

读取数据前先按 JSON 声明的长度检查访问区间，读取时不按 `count` 分配内存，所以异常的 `count` 不会导致内存暴涨或崩溃。三角面数用到的 `count` 也先经过同样的检查。

`--json` 输出 `{ "ok": true, "file": ..., "report": ... }`；失败时是 `{ "ok": false, "file": ..., "error": { "code", "message" } }`。报告里每个可能算不出的指标都是 `{ "status": "computed", "value": ... }` 或 `{ "status": "not-computed", "reason": ... }`。字段定义见 `src/asset/inspect/types.ts`。

## lock-summary：锁文件摘要

```sh
npm run lock-summary -- <起点引用> <终点引用>
```

只读：用 `git show` 读两个提交里的 `package-lock.json`（起点没有锁文件就当作空），不读工作区，结果只写到标准输出。列出新增、删除、版本有变化的包（名称、安装路径、旧版本、新版本），版本没变但 `resolved`/`integrity` 变了的包，`resolved` 来源主机的汇总，终点锁文件里缺 `integrity` 的包和带 `hasInstallScript` 的包。只支持 lockfileVersion 2/3。

## 测试夹具

测试用的 GLB 全部由 `src/asset/fixtures/` 里的代码在内存中生成（自带一个最小的 GLB 写入器），不下载任何外部模型，仓库里也不提交 `.glb` 文件。夹具覆盖：带骨骼的人形（idle / walk / run）、loop 为 false、loop 为字符串、extras 为数字、同名片段、无名片段、带水平位移的片段、无骨骼的节点动画、静态网格、内嵌图片、外部 buffer、声明 Draco 的文件、magic 错误和被截断的容器。完整列表见 `src/asset/fixtures/fixtures.ts`。

## 真实资产不进仓库

模匠导出的真实角色文件（以及任何其他真实模型、贴图）不进仓库，放在项目外的目录里，用路径传给 `inspect-asset` 等工具。`.gitignore` 里的 `.local/` 只给本机临时文件用，也不是存放真实资产的地方。`.gitattributes` 把 `*.glb`、`*.png` 等标为二进制，只是为了防止误提交时被当成文本处理。
