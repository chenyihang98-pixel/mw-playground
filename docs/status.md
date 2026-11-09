# 任务状态

每个任务一节。“运行过的检查和结果”与“未运行或未验证”分开写。

## P1：工程骨架

### 内容

- 工程：Vite + TypeScript（strict，另开 `noUncheckedIndexedAccess`）+ three.js 的单页应用。页面是一个能渲染的空场景（地面、灯光、相机）；开发和测试模式下另有夹具预览和测试钩子，生产构建里没有。
- 依赖全部是确切版本：
  - 运行时：`three` 0.187.0、`zod` 4.6.7。
  - 开发：`@types/three` 0.187.0、`vitest` 5.1.0、`@playwright/test` 1.65.0、`eslint` 10.14.0、`typescript-eslint` 8.72.1、`tsx` 4.23.15。
  - 要求 1 的清单之外的三个依赖及理由：
    - `typescript` 6.0.3、`vite` 8.3.6：工程本身就是 “Vite + TypeScript”，类型检查和构建离不开它们。TypeScript 选 6.0.3 是因为 typescript-eslint 8.72.1 支持的范围是 `>=4.8.4 <6.1.0`。
    - `@types/node` 24.19.2：命令行脚本和测试用到 `node:fs`、`node:child_process` 等，严格类型检查需要 Node 的类型。主版本与本机 Node 24 对应。
  - 没有加 `@eslint/js`、`globals` 等其他包。
- npm 脚本：dev、build、preview、typecheck、lint、test、e2e、inspect-asset、lock-summary（用法见 README）。
- `.gitattributes`：`* text=auto eol=lf`；`package-lock.json -diff`；`*.glb`、`*.png`、`*.jpg`、`*.ktx2` 等标为 binary。`.gitignore` 在原有条目后追加了 `test-results/`、`playwright-report/`、`blob-report/`、`playwright/.cache/` 和 `.local/`。
- 锁文件摘要：`scripts/lock-summary.ts`（逻辑在 `scripts/lib/lockSummary.ts`）。本任务的摘要是 `docs/deps/P1-lock-summary.md`，由 `npm run -s lock-summary -- f178799 HEAD` 在锁文件提交之后生成。
- GLB 结构检查：纯模块 `src/asset/inspect/`（输入 ArrayBuffer / Uint8Array，不用 fs、DOM、three 的加载器，ESLint 规则限制了这个目录的导入和全局对象），命令行包装 `scripts/inspect-asset.ts`。
- GLB 夹具：`src/asset/fixtures/`，自带最小的 GLB 写入器和 PNG 编码器，全部在内存里生成，不依赖 fs。覆盖要求 6 列出的全部情况，另加一个内嵌图片的夹具（PNG 4×2 + 只有文件头的 JPEG 16×8）。
- 文档：README、`docs/conventions.md`、本文件。

### 运行过的检查和结果

环境：Windows 11、Node v24.18.0、npm 11.16.0。

- 安装验证：删除 `node_modules` 后运行 `npm ci`，成功（退出码 0）；随后 `npx playwright install chromium` 成功。
- 实际安装的版本：three 0.187.0；@playwright/test 1.65.0；Chromium 158.0.8127.18（Playwright 的 chromium 与 chromium-headless-shell，修订号 1254）。
- `npm run typecheck`：通过。
- `npm run lint`：通过，没有警告。
- `npm test`：5 个测试文件、100 个测试全部通过。包括：
  - 每个夹具的报告字段（`tests/unit/inspect-fixtures.test.ts`）；loop 的四种情况；extras 不是对象；同名和无名片段；外部 buffer 和 Draco 时写“未计算”和原因；损坏容器的错误。
  - 边界情况（`tests/unit/inspect-edge.test.ts`）：OBJ / STL / PLY / .gltf、版本 1、截断、块越界、JSON 错误、缺 min/max、稀疏访问器、量化的 POSITION、data URI buffer 等。
  - GLTFLoader 对应关系（`tests/unit/gltfloader-mapping.test.ts`）：在 vitest 的 Node 环境里用 three 0.187.0 的 `GLTFLoader.parseAsync` 加载 9 个不含贴图的夹具，断言 `clip.userData.loop` 与检查报告的原始值一致、loop 缺失时 `clip.userData` 没有 loop、无名片段名为 `animation_<序号>`、extras 为数字时只打警告不合并。不需要任何环境补丁。
  - 命令行（`tests/unit/inspect-cli.test.ts`）：夹具写到系统临时目录后运行 inspect-asset；退出码 0 / 1（OBJ、.gltf、magic 错误、截断）/ 2（文件不存在、目录、缺参数、未知选项）；运行前后临时目录里的文件不变。
  - lock-summary（`tests/unit/lock-summary.test.ts`）：在系统临时目录建临时 git 仓库，验证新增、删除、升级、来源变化、缺 integrity、hasInstallScript；起点没有锁文件时全部列为新增；读的是提交而不是工作区。临时仓库由测试文件自己删除。
- `npm run e2e`：3 个测试全部通过（Chromium，无头）。页面打开后控制台没有 error；canvas 尺寸不为零，WebGL2 上下文可用且未丢失；渲染帧数在增加，画面有三角形；带骨骼的夹具加载了 idle / walk / run，mixer 的时间在前进；通过测试钩子切换夹具；不能预览的夹具被拒绝。截图存到 `test-results/`（已忽略，不提交）。
- 无头 Chromium 的 WebGL：Playwright 1.65 默认就给 Chromium 加了 `--enable-unsafe-swiftshader`，WebGL2 走 SwiftShader 软件渲染（渲染器字符串为 “ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)”）。Playwright 配置里没有另加启动参数。
- `npm run build`：通过；生产构建的 JS 里没有 `__MW_TEST__`（夹具预览和测试钩子没有打进去）。
- 测试跑完后 `git status` 干净（`test-results/`、`dist/` 都已被忽略）。
- `git diff --stat f178799..HEAD` 与加 `--ignore-cr-at-eol` 的结果一致（没有 CRLF）。

### 未运行或未验证

- 真实模匠文件的结构检查：本任务没做。仓库里没有真实资产（按约定也不放进来），由操作者在独立验证时用 `npm run inspect-asset` 对项目外的真实文件运行。
- 模匠输出的约定（骨骼命名、片段命名、`extras` 的写法、+Z 朝向、1.75 m 身高）只按任务背景写进了夹具，没有用真实文件核对。
- 只在 Windows 11 + Node 24.18.0 + Chromium 上运行过；没有在 macOS / Linux、Firefox、WebKit 上验证。
- e2e 用的是 SwiftShader 软件渲染；带 GPU 的真实浏览器里的画面没有自动化检查。
- inspect-asset 没有用大文件（几十 MB 以上）测过耗时和内存。
- JPEG 尺寸读取只用合成的文件头测过，没有用真实相机或导出器生成的 JPEG 测过。
- KTX2、WebP 等图片不读尺寸（报告写“未计算”和原因）；Draco、meshopt 不解码（同上）。

### 已知问题和后续项

- `npm audit` 报 9 个 moderate，都是同一个 minimatch 的 ReDoS 公告（GHSA-g3hv-75wg-m249），在 eslint 10 和 typescript-eslint 的依赖链里，只在开发时运行 lint 用到，输入是本仓库自己的路径模式。修复方式是把 eslint 降到 9（不兼容变更），本任务不处理，等上游发布修复版本后再升级。
- npm 11 安装时提示 `esbuild@0.28.2` 的 postinstall 安装脚本“没有被 allowScripts 覆盖”。本任务没有批准它，也没有改 npm 配置；esbuild 的二进制来自可选依赖 `@esbuild/win32-x64`，tsx 和 vite 都能正常工作。锁文件摘要的 “hasInstallScript” 一节列出了 esbuild 和 fsevents（fsevents 只在 macOS 上安装）。
- 生产构建只有一个约 536 kB 的 JS 文件（主要是 three.js），已把 Vite 的体积提示阈值调到 1000 kB。以后需要时再拆分。
