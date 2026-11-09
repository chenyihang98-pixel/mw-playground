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
- `npm test`：6 个测试文件、148 个测试全部通过。包括：
  - 每个夹具的报告字段（`tests/unit/inspect-fixtures.test.ts`）；loop 的四种情况；extras 不是对象；同名和无名片段；外部 buffer 和 Draco 时写“未计算”和原因；损坏容器的错误。
  - 边界情况（`tests/unit/inspect-edge.test.ts`）：OBJ / STL / PLY / .gltf、版本 1、截断、尾部多余字节、块越界、块未对齐、重复的 JSON / BIN 块、BIN 不在第二位、BIN 与 buffers[0].byteLength 不符、JSON 的 BOM 和 0 字节补齐、缺 asset.version、缺 min/max、稀疏访问器、量化的 POSITION、data URI buffer 等。
  - 健壮性（`tests/unit/inspect-robustness.test.ts`）：count 为 2**50、越界的偏移和 byteStride、NaN / Infinity、数值溢出、30 万个通道；并对每个合法夹具的访问器和 bufferView 字段做变异、把 BIN 覆盖成 NaN / Infinity / 随机字节，断言不抛异常、报告里没有非有限数。
  - GLTFLoader 对应关系（`tests/unit/gltfloader-mapping.test.ts`）：在 vitest 的 Node 环境里用 three 0.187.0 的 `GLTFLoader.parseAsync` 加载 9 个不含贴图的夹具，断言 `clip.userData.loop` 与检查报告的原始值一致、loop 缺失时 `clip.userData` 没有 loop、无名片段名为 `animation_<序号>`、extras 为数字时只打警告不合并。不需要任何环境补丁。
  - 命令行（`tests/unit/inspect-cli.test.ts`）：夹具写到系统临时目录后运行 inspect-asset；退出码 0 / 1（OBJ、.gltf、magic 错误、截断）/ 2（文件不存在、目录、缺参数、未知选项）；运行前后临时目录里的文件不变。
  - lock-summary（`tests/unit/lock-summary.test.ts`）：在系统临时目录建临时 git 仓库，验证新增、删除、升级、来源变化、缺 integrity、hasInstallScript；起点没有锁文件时全部列为新增；读的是提交而不是工作区。临时仓库由测试文件自己删除。
- `npm run e2e`：3 个测试全部通过（Chromium，无头）。页面打开后控制台没有 error；canvas 尺寸不为零，WebGL2 上下文可用且未丢失；渲染帧数在增加，画面有三角形；带骨骼的夹具加载了 idle / walk / run，mixer 的时间在前进；通过测试钩子切换夹具；不能预览的夹具被拒绝。截图存到 `test-results/`（已忽略，不提交）。
- 无头 Chromium 的 WebGL：Playwright 1.65 默认就给 Chromium 加了 `--enable-unsafe-swiftshader`，WebGL2 走 SwiftShader 软件渲染（渲染器字符串为 “ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)”）。Playwright 配置里没有另加启动参数。
- `npm run build`：通过；生产构建的 JS 里没有 `__MW_TEST__`（夹具预览和测试钩子没有打进去）。
- 测试跑完后 `git status` 干净（`test-results/`、`dist/` 都已被忽略）。
- `git diff --stat f178799..HEAD` 与加 `--ignore-cr-at-eol` 的结果一致（没有 CRLF）。

### 第 1 轮审查后的修改

Codex 第 1 轮审查（候选 abf8088）提出 3 项阻塞问题，都已修正（违反的都是要求 5）：

1. 容器损坏被当作检查成功：重复的 JSON 块、重复的 BIN 块、未按 4 字节对齐的块只记在“问题”里，退出码 0。现在凡是检查到的容器损坏都返回错误（退出码 1）：块长度不是 4 的倍数、重复的 JSON 块、重复或不在第二位的 BIN 块、头部声明长度小于实际长度（尾部多余字节）、BIN 块比 buffers[0].byteLength 短或长出 3 字节以上、buffers[0] 指向 BIN 块但没有 BIN 块。顺带把 JSON 块的 BOM、0 字节补齐，以及缺 asset / asset.version、版本不是 2.x 也改为错误（three r187 的 GLTFLoader 在缺 asset.version 时会直接出错）。规范允许的未知类型块仍只记在“问题”里。
2. 访问器按未经验证的 count 分配数组：count 为 2**50 时抛 RangeError，被当作内部错误。现在先按 JSON 声明的 bufferView / buffer 长度检查访问区间（外部 buffer 也能检查），再读数据；读取改成按需逐个读取，不再按 count 分配数组；没有 bufferView 的全零访问器只检查一个元素。三角面数用到的 count 也先经过同样的检查。
3. FLOAT 分量的 NaN / Infinity 没有检查：包围盒在 JSON 里变成 null 但仍标为已计算。现在读取时逐个检查有限性，受影响的指标（实际包围盒、实际时长、水平位移）写“未计算”和原因，并在“问题”里记一条；包围盒和位移的计算结果也检查是否溢出。

另外修了一处同类问题：动画时长原来用 `Math.max(...列表)`，通道数很多时（实测 30 万个）会超出调用栈而抛异常。

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
- 锁文件里的 `@dimforge/rapier3d-compat` 0.12.0 是 `@types/three` 0.187.0 自带的依赖（three 的 Rapier 物理插件的类型要用），不是本项目直接加的；只在开发时安装，不进生产构建。
- 生产构建只有一个约 536 kB 的 JS 文件（主要是 three.js），已把 Vite 的体积提示阈值调到 1000 kB。以后需要时再拆分。

## P2：基础玩法

### 内容

- 玩法规格：`src/game/spec.ts`（取值见下表）。`specProblems()` 检查规格之间的约束（高台高于最大跳跃高度等），有单元测试。
- 关卡布局：`src/game/level/schema.ts`（zod 结构校验 + 依赖规格的语义校验 `layoutProblems`），`src/game/level/geometry.ts`（盒子、高台、坡道统一成 XZ 矩形 + 顶面高度），`src/game/level/builtin.ts`（三张内置图：`meadow` 手工固定地图、`test-a`、`test-b`）。游戏只通过 `parseLevel` 加载关卡。
- 模拟：`src/game/sim/`，全部是纯函数，按固定步长推进（`stepGame(state, input, dt)`；`advance` 把一帧的经过时间换成固定步）。移动、碰撞、收集、计时、守卫、胜负、暂停、重开都在这里，不读墙钟、不用随机数、不依赖 three。ESLint 对 `src/game/spec.ts`、`src/game/level/`、`src/game/sim/` 强制这一点。
- 渲染和界面：`src/game/render/`（低模小人、程序化姿态、关卡场景、第三人称相机）、`src/game/input/`（键盘、指针锁定 / 拖动）、`src/game/ui/`（HUD、开始 / 暂停 / 结算面板），`src/game/app.ts` 把它们接在一起。渲染层只读模拟状态。
- 测试钩子：`src/dev/gameTestHooks.ts`，只在开发和测试模式下安装。游戏页只有 `getState`（每次返回新建并深度冻结的快照）和 `listLevels`；选关卡只能通过网址参数 `?level=<id>`（同样只在开发和测试模式下生效）。
- 对 P1 文件的改动（没有改名或移动）：`src/main.ts` 改为默认启动游戏，P1 的夹具预览移到开发和测试模式下的 `?view=fixtures`；`src/scene/createScene.ts` 增加 `ground` 选项（游戏按关卡尺寸自己建地面）；`src/dev/testHooks.ts` 的夹具钩子加了 `kind: 'fixtures'`，与游戏钩子区分；`tests/e2e/scene.spec.ts` 改为打开 `/?view=fixtures`；`eslint.config.js` 增加模拟纯度规则；README 和 `docs/conventions.md` 增加 P2 的内容。

### 玩法规格的取值

| 参数 | 取值 | 说明 |
|---|---|---|
| 胶囊半径 | 0.35 m | 碰撞、守卫接触、关卡校验共用 |
| 胶囊高度 | 1.75 m | 脚底到头顶；默认小人按这个高度缩放（单元测试核对包围盒高度） |
| 走路速度 | 2.2 m/s | |
| 跑步速度 | 5.0 m/s | 按住 Shift |
| 转向角速度 | 12 rad/s | 朝向转向移动方向 |
| 迈步高度 | 0.3 m | 站在地面上能直接迈上的高度差；也是下坡贴地的最大落差 |
| 跳跃初速度 | 4.5 m/s | |
| 重力 | 15 m/s² | |
| 最大跳跃高度 | 0.675 m | = 初速度² / (2 × 重力)。按 1/60 s 固定步长实际能到约 0.6375 m |
| 高台高度 | 1.2 m | 大于最大跳跃高度：高台只能从坡道上去 |
| 坡道最大坡度 | 30° | 对应高台坡道最短 2.078 m；固定地图的坡道 2.6 m（约 24.8°） |
| 守卫巡逻速度 | 2.0 m/s | |
| 守卫接触扣时 | 10 s | |
| 扣时冷却 | 2.0 s | 冷却在玩家身上，对所有守卫共用 |
| 收集半径 | 0.8 m | 收集点中心到玩家胶囊轴线的距离不超过它就算收集到 |
| 收集点悬浮高度 | 0.9 m | 收集点中心离所在表面（地面或高台顶面）的高度 |
| 模拟步长 | 1/60 s | 一帧最多推进 8 步，卡顿时多出的时间丢弃 |

### 设计说明

- 碰撞是 2.5D 的：胶囊在 XZ 平面上是圆，盒子、高台、坡道是 XZ 矩形加顶面高度。脚底高度为 y 时，顶面高于 y + 余量的部分是墙（着地时余量 = 迈步高度，空中为 0）；坡道的顶面是线性的，高于某个高度的部分仍是一个矩形。圆被推出墙时只去掉法向分量，所以能沿墙滑动；位移按半个半径分段，挤不进比直径窄的缝时停在原处。地图边界直接限制圆心。
- 支撑高度取圆心所在位置的最高顶面；走出高台边缘时圆心离开顶面就开始下落。
- 守卫沿路线（最后一点回到第一点）匀速循环，只在地面上走，不受玩家影响；关卡校验要求路线离所有实体至少一个胶囊半径。守卫与玩家的胶囊水平距离小于两个半径、竖直范围重叠就算接触。
- 胜负在同一步里先判收集再判时间；分出胜负、暂停、未开始时 `stepGame` 原样返回。重开就是重新生成关卡的初始状态（`restartGame` 的结果与 `createInitialState` 相等），界面上随后直接开始。
- 暂停时 `advance` 不推进并丢弃累计时间（继续时不会补上暂停期间的时间），同时释放指针锁定；连装饰性的动画（宝石旋转、待机呼吸）也停下。指针锁定时浏览器用 Esc 退出锁定，游戏把“游玩中丢失锁定”当作暂停；之后 400 毫秒内的 Esc 按键被忽略，避免暂停后马上又继续。
- 指针锁定请求失败（浏览器不支持、被拒绝、出错）时改用按住左键拖动转视角；方向键也能转视角。游玩中没有锁定时，点一下画面会重新请求锁定。游戏自己释放锁定（暂停、结束）和浏览器解除锁定（Esc）分开处理，暂停后马上继续不会被误判成又一次暂停。
- 视觉模型和物理胶囊分开：`CharacterView.root` 跟随胶囊脚底位置和朝向，模型挂在它下面的 `model-slot`。守卫用同款小人，换红黑配色。

### 运行过的检查和结果

环境：Windows 11、Node v24.18.0、Chromium 158.0.8127.18（Playwright 1.65.0，无头）。

- `npm run typecheck`：通过。
- `npm run lint`：通过（含新增的模拟纯度规则）。
- `npm test`：10 个测试文件、215 个测试全部通过。P2 新增 5 个文件：
  - `game-spec-level.test.ts`：规格约束；三张内置图的结构和内容；不合法布局（坡道太陡、目标数大于收集点数、出生点在盒子里、越界、重复 id、守卫路线穿过盒子、收集点在盒子里、未知字段等）被拒绝。
  - `game-movement.test.ts`：走和跑的速度；斜着走不超速；按相机方向移动；跳跃最高点不超过规格；不穿墙、沿墙滑动、不出边界；比胶囊直径窄的缝过不去、宽的缝能过；沿坡道走上高台并在顶面行走；从边缘掉下来；下坡贴地；贴着高台侧面连续起跳也上不去；坡道侧面高处是墙。
  - `game-rules.test.ts`：收集；达到目标数胜利；时间用完失败；分出胜负后不再推进；重开恢复初始状态；暂停时不推进、继续后推进；固定步长累加器；同样的输入序列结果完全相同；守卫巡逻循环；连续多帧重叠只扣一次、冷却结束后再扣一次；测试小关 B 站着不动 10 秒扣 3 次且间隔不短于冷却时长。
  - `game-view.test.ts`：小人包围盒高度等于胶囊高度、脚底在原点、宽度在胶囊半径内、面向 +Z；视觉模型挂在外层节点下的模型槽里；守卫换配色；程序化姿态；键位；时间格式；测试钩子对象只有读的方法、快照冻结。
- `npm run e2e`：9 个测试全部通过（P2 新增 6 个，P1 的 3 个夹具预览测试改为打开 `/?view=fixtures` 后照常通过）。P2 的 e2e 只用鼠标和键盘玩，断言只通过钩子读状态：
  - 测试小关 A：用鼠标点“开始”，按住 W 走到收集点，出现胜利结算。
  - 测试小关 B：站着不动，守卫经过出生点时扣一次时间（HUD 时间变色），两次扣时的间隔不短于冷却时长。
  - 固定地图：按 P 暂停后等 1.5 秒，剩余时间、模拟时间、守卫位置都不变；再按 P 继续，时间开始减少。
  - 固定地图：只用键盘沿坡道走上高台，收集高台上的宝石（脚底高度等于高台高度）。
  - 暂停面板的“继续”按钮；指针锁定时按 Esc 暂停（锁定释放）、再按 Esc 继续；点画面后连按两次 P（暂停后马上继续），游戏保持在游玩状态。
  - 测试钩子：快照是冻结的副本，改它不影响游戏；钩子只有 `getState`、`listLevels`、`kind`、`version`；`window.__MW_TEST__` 不能被替换。
  - 截图存到 `test-results/`（不提交）。无头 Chromium 授予了指针锁定，WebGL 仍走 SwiftShader，没有加启动参数。
- `npm run build`：通过；生产构建里没有 `__MW_TEST__`、夹具预览代码，也不读 `?level=`。
- 测试跑完后 `git status` 干净；`git diff --stat 2af4472..HEAD` 与加 `--ignore-cr-at-eol` 的结果一致。
- 没有改依赖和锁文件。

### 未运行或未验证

- 只在无头 Chromium 里自动化测试过；没有在带 GPU 的真实浏览器里手动游玩，手感（速度、相机距离、鼠标灵敏度）未经人工确认。
- 鼠标转视角没有自动化测试：e2e 没有移动鼠标，只验证了指针锁定的获得和释放。按住左键拖动的替代方式没有被 e2e 覆盖（无头 Chromium 会授予指针锁定，走不到这条路径）；方向键转视角也没有 e2e。
- 没有在 Firefox、Safari 上验证指针锁定和 Esc 的行为。
- 相机不避开障碍（本任务不要求），会穿过墙或高台。

### 已知问题和后续项

- 盒子、高台、坡道都是轴对齐的，不支持旋转；以后的地图生成器要按这个限制出图，或者扩展几何模块。
- 守卫只在地面上沿固定路线走，不追玩家，也不被玩家挡住。
- 渲染没有在两次模拟步之间插值，刷新率不是 60 Hz 时画面可能有轻微抖动。
- 生产构建的 JS 约 651 kB（three.js 约 530 kB），仍在体积提示阈值内。内置的测试小关数据也打进了生产构建，但生产构建不读 `?level=`，玩家进不去。
