# 游戏素材大师 · 详细工程文档

> 本文档由 README 的完整版迁来，保留算法细节、自检契约与历史踩坑记录。
> 简洁的入门文档见 [../README.md](../README.md)。

---

# 游戏素材大师 · DSH 插件

从一张设定图出发，批量产出游戏要用的角色素材。生图走**可切换的后端**——默认
**本机 ComfyUI**（可保存多份工作流、参数面板按节点定义自动生成），也可以切 **ToAPIs** 异步接口
（见 `src/imageprovider.ts`、`src/customimage.ts`、`src/workflows.ts`、`src/workflowparams.ts`）；
**MiniMax** 负责图生视频（默认只走它，也可改走 ComfyUI / ToAPIs），抠绿幕与合成全部在本地用
ffmpeg + 内置 JS 完成——不需要任何系统图像库，也不需要把素材传到第三方服务。

> 生图后端的分发只在一个地方：`imageprovider.generateImageWithProvider`。所有生图调用点
> （八方向图 / 图片生成 / 骨骼动画 / 地图地块）都经过它，**不要在模块里自己判 `imageProvider`**
> ——那种分叉漏掉一处不会报错，只会偷偷继续用另一家模型，`verify-custom-image.mjs` 会拦。

插件包含八个功能模块，共用同一套 API 配置与抠像默认值：

| 模块 | 做什么 |
|---|---|
| **八方向图生成** | 一张人物设定图 → 8 方位 × 8 帧精灵图（含行走动画验收与 WASD 操控预览） |
| **图片生成** | 按提示词出图，可带参考图 → 可一键抠绿幕导出透明 PNG |
| **序列帧生成** | 首帧图 **或** 参考图+参考视频 → 生成视频 → 抽帧 → 抠像 → 横向合成，并可循环播放预览 |
| **骨骼动画生成**（实验性） | 角色整图 → 自动拆件 → 装配定位 → 推骨骼与动画（待机/行走/奔跑/挥手/跳跃/攻击）→ 打包 Spine 图集 |
| **45°地图编辑器**（**全本地零计费**） | 2:1 等距菱形地块 → 自动连接 / 多格高处物件 / 动画 / 标记 / 环绕 → 导出 PNG / JSON / zip |
| **俯视地图编辑器**（**全本地零计费**） | 选一张素材图 → 直接画（参照 AsLib 的 RPG Map Maker：一屏、纯图标、零术语；素材形态自动识别与自动连接、地图四周环绕、动画地块、一键生成） |

> ⚠️ 骨骼动画生成是**实验性模块**：界面上页签带角标、
> 每次进入弹窗说明、模块内常驻提示条
> （`ExperimentalModuleDialog` / `RigExperimentalBar` / `MODULES[].experimental`）。功能不完善，
> 共建入口见 [GitHub 仓库](https://github.com/universe-st/dsh-game-material-master)。
> **地图编辑器与 45° 地图编辑器都已转正**：链路全本地、零计费，几何与导出都有像素级自检兜底
> （`verify-map*` 四件），所以它没有角标、没有进入弹窗、也没有常驻提示条 ——
> `verify-map-client.mjs` 会逐条反向验证这三处都不能出现。

每个阶段都有独立的验收界面：看图、改提示词、单独重跑、打「通过」。任何一步不满意都可以只重做那一步。

六个模块的**全部功能都可以通过对话调用**：agent 用工具驱动同一条流水线，
多步流程（八方向图这种）能自己推进、等待、审查，也可以在每一步停下来让你验收——
详见下面的[对话调用](#对话调用agent-也能驱动整条流水线)。

---

## 一些绕不开的坑（先说，省得踩）

- **不要用「剪影」这个词写提示词。** 实测生图模型会按字面把角色画成纯黑轮廓。
- **提示词里要区分「转身」和「视线」。** 只写「朝画面左上方」时模型会理解成抬头仰视，
  必须补一句「只绕竖轴转身，禁止抬头低头，视线始终水平」。
- **图生视频不保证守住纯色背景。** 同一段素材里有的帧背景保持绿色，有的会逐渐打光成橙黄渐变。
  所以抠像不能只认绿色——见下面的「抠像」。
- **重复提交会白花钱。** 三个模块都做了重复提交拦截：同一张图 / 同一段视频在跑时再点一次会被拒绝。
  agent 走对话调用时同样受这条约束（工具层不重复拦一次，报错信息才清楚）。
- **工具返回值必须能「无损过 JSON」。** 新版 DSH（typert 0.1.7+）在工具边界做这道校验：
  返回值里只要有一个 `undefined` 的键（或 `NaN` / `Infinity` / `-0`），**整次工具调用直接失败**，
  界面上只有一句 `tool "…" returned invalid output: value is not lossless JSON`。
  快照里的 `file` / `url` 这类可选字段是按 `file: node.file` 直接写的，节点还没生成时它就是
  `undefined`（键在、值是 undefined），所以**项目只跑了一半时 `status` / `review` / `wait` /
  `call getProject` 会一起报错**，项目空空如也时反而看不出来——很像「插件装坏了」。
  出口统一在 `src/tools.ts` 的 `register()` 里过一遍 `jsonSafe()`（做的正是 `JSON.stringify`
  本来就会做的事，模型看到的内容不变）。**注意 `JSON.stringify` 自己看不出这个问题**，
  所以「断言 stringify 之后没有 undefined」是永远为真的假检查——真检查在 `verify-tools.mjs`
  的 6.5 节（每次 `run()` 都审计一遍返回值）。
- **抠完底之后再做一次「不感知 alpha」的缩放，一定会留下白边。**（规划中的 `tile` 模块已踩过）
  只把背景像素的 alpha 置 0、RGB 原样留着，再用普通 LANCZOS 把 RGBA 一起缩，
  边缘那些「半透明的浅色」就被平均成「**不透明的浅色**」——一圈肉眼可见的描边。
  症状很好认：成品的 `alpha` 只剩 `{0, 255}` 两个值，完全没有抗锯齿。
  正确做法见 `research/tile-isometric/tile-isometric-research-report.md` §8.7：**软 alpha（必须带死区）+ 只用可信像素的颜色
  （其余位置用最近可信邻居填充）+ 颜色与 alpha 分开缩放**。
  实测白边像素 184 → 0，剪影面积不变（1186 → 1185）。
  两个附带教训：软 alpha 的映射**不能没有死区**（纯白底图的压缩噪声 dist≈2~10，
  无死区会被判成 α≈0.03 的「前景」，白边反而更严重）；unmatte（`F=(C−(1−α)B)/α`）
  对「上千个源像素平均出来的颜色」无效，别用。

---

## 对话调用：agent 也能驱动整条流水线

插件挂载时会把自己的控制面注册成一组模型工具，并追加一段系统提示词，
约定**固定流程**与验收协议。所以「帮我做个八方向的角色」这句话本身就能跑完整条链路。

### 工具

对话面只有一个工具 `game_material`，用 `action` 选择动作：

| action | 作用 |
|---|---|
| `guide` | 按主题读手册：`overview` / `workflow` / `config` / `methods` / `ai-asset` / 八个模块主题；方法表由 `TOOL_METHODS` 自动生成，并按 `hiddenModules` 过滤 |
| `intake` | **固定流程第 0 步**：按真实状态算出「还缺哪些关键参数」与「必须先解决的阻塞」，并把「自动审核 / 每步人工审核」这个必问项一起交出来 |
| `call` | 万能通道：插件界面上有的功能都能调（176 个方法），`{method, payload}`；方法名与参数在 guide 里 |
| `upload` | 按**本机路径**上传素材（源图 / 参考图 / 首尾帧 / 参考视频），宿主自己读盘，不用把 base64 贴进对话 |
| `reviewMode` | 记录用户选的审核模式，存在项目 / 任务上；界面与对话读写同一份 |
| `status` | 读进度：项目 / 任务清单，或某个目标的阶段进度与产物 URL |
| `wait` | 阻塞等待「没有任务在跑」或超时（默认 120s，上限 900s），回来就是可审查状态 |
| `review` | 出**验收包**：每个产物的绝对 URL、状态、通过标记、报错与建议的下一步 |
| `approve` | 打「通过 / 取消通过」（八方向图按阶段+方位，图片按张，序列帧按步骤，骨骼动画按阶段+部件） |

底层没有第二套实现：工具直接复用界面用的那个 Typert 远程服务，所以
「界面上做到的事」与「对话里做到的事」永远是同一件事、同一份数据。

**被用户隐藏的模块是例外**：每个 action 都先按 `hiddenModules` 查一次模块归属，
命中就拒绝（`status` 既不列它的清单也不给它的深链接，`guide` 也不泄露它的手册）。
理由与做法见「配置 → 功能管理：隐藏的模块必须对 AI 也关上」。

### 渐进披露：常驻只有一个工具

工具定义与系统提示词**每次请求都会进上下文**。旧版把整条流水线拆成 8 个工具、
把方法表与固定流程写进描述，实测常驻 **49,393 B**（工具 schema 33,615 B + 系统提示词 15,778 B），
无关任务也要付这笔 token。

现在：

- 常驻只有 `game_material` 一个工具；工具 schema + 系统提示词合计 **≤ 6,000 B**
  （`verify-tools.mjs` 会打印实际值并断言，当前约 3.9 KB）；
- 详细流程 / 方法签名 / 参数放在 `src/toolguides.ts`，由 `action:"guide"` 按主题读取；
- `methods` 目录由 `TOOL_METHODS` + `METHOD_MODULE` + `SHARED_TOOL_METHODS` **自动生成**，
  新增方法不会「做了但手册没提」；
- 自动任务（AI 生成素材 / 音乐 / 谱曲）的第一行会明确要求先读 `guide`。

⚠️ **硬约束**：新增远程方法时，必须写进对应模块主题（并自动出现在 `methods` 目录）；
**不许**把方法表或固定流程重新塞回工具描述 / 系统提示词。`verify-tools.mjs` 的字节预算会拦。

旧工具名 → 新调用：

```text
game_material_intake({...})          → game_material({action:"intake", ...})
game_material_call({method,payload}) → game_material({action:"call", method, payload})
game_material_upload({...})          → game_material({action:"upload", ...})
game_material_reviewMode({...})      → game_material({action:"reviewMode", ...})
game_material_status({...})          → game_material({action:"status", ...})
game_material_wait({...})            → game_material({action:"wait", ...})
game_material_review({...})          → game_material({action:"review", ...})
game_material_approve({...})         → game_material({action:"approve", ...})
```

### 固定流程

```
第 0 步  先问，再动手
         agent 必须先用 game_material({action:"intake", module}) 把缺的参数问清楚，
         并且必须问「自动审核 还是 每一步人工审核」——合并成一次提问。
         两个问题都拿到答复之前，不允许调用任何生成 / 删除类方法。
第 1 步  逐阶段推进（八方向图：images → videos → frames → sheet；
         骨骼动画：parts → layout → rig → atlas，其中只有 parts 花钱）
         每次提交类调用之后立刻 game_material({action:"wait", id})。
第 2 步  每步都审：game_material({action:"review", ...}) 看逐项 status / error / URL。
第 3 步  按审核模式分岔
         auto   → agent 自己判断没问题就 approve 并进入下一步
         manual → 贴出验收链接并停下等用户回复，用户说「通过」才继续
```

审核模式也可以在界面上直接改（六个模块都有下拉），因为它就是同一份数据。
没设置时界面显示「未设置（对话里会先问）」。

### 点链接切界面

工具返回里的 `openUrl` 是给用户点的深链接，形如：

```
http://127.0.0.1:43120/?dsh-gmm=1&module=sprite&project=p…&stage=videos
```

agent 会把它原样写成 Markdown 链接贴出来。用户点一下：

- 浏览器半区装了**捕获阶段的点击拦截器**，命中就 `preventDefault` 原地切到
  「游戏素材大师」面板，并落到对应模块 / 项目 / 阶段——不跳转、不新开标签；
- 若用户用中键 / Ctrl+点击强制新开标签页，链接会真的被打开，应用在
  `/?dsh-gmm=…` 上正常启动，插件读到参数后完成同样的切换（两条路径共用同一份意图）。

为什么链接必须是 `http(s)`：会话正文的 Markdown 渲染器对链接做了协议白名单
（只放行 http/https/mailto），自定义 scheme 会被丢掉、连 `<a>` 都不生成。
又因为宿主不知道对外 origin（可能被反代改写），浏览器半区会在挂载时把自己真实的
`location.origin` 上报给宿主（`reportClientOrigin`）。没收到上报时退化成
`http://localhost` —— 拦截是按参数匹配的，origin 不对也不影响点击。
DSH 0.2.1 的 `--public-url https://host/prefix/` 允许带路径前缀（反代把前缀剥掉再转给 DSH），
所以 `location.pathname` 也一起上报；宿主用 `links.assetBasePath()` 给所有 `assetBase`
补前缀、`buildOpenLink()` 默认拼 `origin + /prefix`。漏掉这一层的表现是「本地全对、
反代后面板里的图全裂、回链落到根页」，而且不报任何错。

拦截器只认 `dsh-gmm` 参数，其余链接（含站外的）一律放行。

---

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-game-material-master
```

装完**重启 DSH**（新增 bundle 只在启动时读取）。

> **改了代码之后**：浏览器半区是按磁盘上的 `lib/client.js` 现取的，**刷新浏览器**就能用上；
> 宿主半区（工具注册、系统提示词、远程方法）是启动时装入的，**必须重启 DSH**。
> `node scripts/verify-live-bundle.mjs` 可以确认运行中的宿主到底在提供哪一版浏览器束。

- 需要宿主提供 `webServer` 与 `typert`，二者由 `@deepseek-ai/dsh-base` / `dsh-web-app` 提供，无需额外依赖。
- 需要 **ffmpeg / ffprobe** 能找到。`src/media.ts` 的 `ffmpegPath()` / `ffprobePath()` 按
  `FFMPEG_PATH` / `FFPROBE_PATH` 环境变量 → **Windows 注册表**里的同名变量
  （`HKCU\\Environment`、`HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment`）→
  WinGet Links / Scoop shims / Chocolatey bin / `%ProgramFiles%\\ffmpeg\\bin` / `C:\\ffmpeg\\bin` /
  `D:\\ffmpeg\\bin` → 裸名字（交给 `PATH`）的顺序找：命中即缓存，没命中 10 秒后重试
  （用户可以现装 ffmpeg 再点重试，不用重启插件）。
  **为什么非要读注册表**：`setx` 只写注册表，**不会**改已经在跑的进程的环境——进程的环境块是
  启动时从父进程复制的快照，而父进程通常是登录时就起的 explorer。实测就是这样：`setx` 了
  `FFMPEG_PATH`、也重启了 DSH，插件里 `process.env.FFMPEG_PATH` 仍然是空的。
  设置页会显示探测结果。
- 本包**没有任何运行时 npm 依赖**：`zod`、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/cordis`
  都从 DSH 自身的安装树解析，避免出现两份不同版本的实例。

> 从旧版本（`dsh-8dir-sprites`）升级时，首次启动会把数据目录 `8dir-sprites/`
> 整体迁移到 `game-material-master/`，已有项目和配置无缝接上。

## 配置

**设置 → 游戏素材大师**：

| 项 | 说明 |
|---|---|
| 火山方舟 API Key | 「测试连接」会**真实生成一张 1K 小图**（产生少量费用），同时验证 Key 与模型 / 接入点 |
| 生图模型 | 默认 `doubao-seedream-5-0-flash-260915`；也可选 5.0 Pro / Lite、4.5，或填自定义接入点 ID（**别用 4.0**：它只输出 JPEG 且会把 2:1 等距菱形画变形，地图地块模块量不出几何） |
| MiniMax API Key | 「测试连接」只查一个不存在的任务，**免费**，能区分 Key 无效与其它错误 |
| 视频模型 | 默认 `MiniMax-H3`。选 H3/H3-Max 自动走 v2 协议，选 Hailuo/I2V 走 v1；**优云智算版 H3** 在同一个下拉里显式选择 |
| Base URL | **主机根**，不含 `/v1`、`/v2`。国内站 `https://api.minimax.cn`，国际站 `https://api.minimaxi.com`。选中「优云智算版 H3」时该字段固定为 `https://cp.compshare.cn`、不可编辑 |
| 默认参数 | 单格宽高、抽帧张数与工作尺寸、像素块边长、抠像阈值等 |
| 本地 ComfyUI（图生视频） | 勾选后图生视频改走本机 ComfyUI（替代 MiniMax）：地址、超时、提示词 / 首帧注入点、宽高 / 时长 / 种子、API 格式工作流 JSON。「测试连接」只读 `/system_stats` 与 `/queue`，**免费**（对比火山方舟那个会真生一张图）；另有 `comfyCookies`，供藏在鉴权反代后面的 ComfyUI 用 |
| 功能管理 | 逐个开关六个模块；关掉的模块界面不出现，对话工具面也拒绝（见下） |

Key 只写入本机 `<DSH_HOME>/game-material-master/config.json`，回传界面时始终脱敏（只给尾号）。

> **模型是插件级设置，三个模块共用。** 「生图模型」「视频模型」只在设置页里改，
> 图片任务 / 序列帧任务内部**不允许**再存一份自己的模型副本——模块里那两个字段是
> 只读展示。原因：网关地址与 API Key 都是全局的，任务里若留一份旧模型快照，
> 切换模型后就会把请求打到错误网关（实测：任务存官方 H3 + 全局切优云智算 →
> `cp.compshare.cn/v2/…` 404）。任务在保存与提交时会自动对齐当前模型，
> 时长 / 分辨率档位也一并按当前模型收敛。

### 视频参数与模型的对应关系

| 视频模型（下拉选项） | 协议 | 分辨率 | 时长 |
|---|---|---|---|
| `MiniMax-H3` | v2 | `2K` / `768P` | 4~15 秒 |
| `MiniMax-H3 优云智算` | v2 | `2K` / `1080P` / `768P` | 4~30 秒 |
| `MiniMax-H3-Max` | v2 | `768P` / `480P`（不支持 2K） | 5~15 秒 |
| `MiniMax-Hailuo-02` | v1 | `768P` / `1080P` | 6 / 10 秒 |
| `I2V-01` / `I2V-01-Director` | v1 | `720P` | 6 秒 |

> **优云智算版 H3** 是 MiniMax H3 的第三方网关版：与官方 H3 是同一个模型，但走
> `https://cp.compshare.cn`，请求路径多一层 `/minimax`（`/minimax/v2/video_generation`），
> 分辨率支持 1080P 后置超分，时长放宽到 4~30 秒。
>
> 它是一个**显式选项**：在「视频模型」下拉里选择 `MiniMax-H3 优云智算` 即启用，
> 插件**不会**根据 Base URL 或 Key 前缀自动判断。选中后 Base URL、路径前缀、
> 分辨率/时长档位全部自动跟着它走；切回官方模型时 Base URL 自动还原。

切换模型时非法值会被自动收敛（例如从 Hailuo 换到 H3 时 `1080P` → `2K`）。
**参考图 / 参考视频模式是 v2 才有的能力**，选 v1 模型时会明确报错而不是静默失败。

### 本地 ComfyUI 后端（可选，替代 MiniMax）

设置页打开「本地 ComfyUI（图生视频）」后，**只有「图生视频」这一步**改由本机 ComfyUI 跑。
`src/videogen.ts` 是分派层（提交 / 查询 / 下载三件事），`src/comfy.ts` 是客户端
（零依赖，只用 `node:http`）。生图、抠像、抽帧、合成不受影响，与 MiniMax 共用同一套下游。

| 环节 | 做法 |
|---|---|
| 提交 | 首尾帧图 `POST /upload/image`（multipart，`type=input`）→ 注入提示词 / 宽高 / 时长 / 种子 → `POST /prompt`，拿 `prompt_id` 当 taskId |
| 查询 | `GET /history/<prompt_id>`；还没进 history 就查 `GET /queue`，按 `queue_running` / `queue_pending` 区分「在跑」与「排队中（前面还有 N 个任务）」 |
| 取成品 | 从 `outputs` 里按打分挑视频：`metadata.kind === "video"` +5、扩展名 mp4/webm/mkv/mov +4、gif +2、图片 -5、音频 -4，总分 ≤0 丢弃。挑不到即判失败并提示「检查工作流终点节点」 |
| 下载 | `GET /view?filename=…&subfolder=…&type=…`，超时用 `comfyTimeoutMs` |

**两种工作流格式都收**：API 格式（`Workflow → Export (API)`）直通；**界面格式**（顶层是 `nodes` /
`links` 数组，官方示例
[FreeVideo-All-in-One.json](https://github.com/FlashML-org/FreeVideo/blob/main/example_workflows/FreeVideo-All-in-One.json)
就是这个形状）由 `parseComfyWorkflow` 内部的 `convertUiWorkflow` 先转成 API 格式，返回 `converted: true`，
设置页会显示「已自动转成 API 格式（N 个节点）」。转换规则：

1. `inputs[]` 里带 `link` 的按连线表写成 `[来源节点 id, 槽位]`——**旧版数组形式的 links 与新版对象
   形式的 `{ id, origin_id, origin_slot }` 都要认**；
2. 带 `widget` 字段的输入按出现顺序从 `widgets_values` 取值，值**后面**那个 `fixed` / `increment` /
   `decrement` / `randomize` 是 `control_after_generate`，必须跳过去（不跳就会把 `randomize` 当成
   种子写进工作流）；
3. `Note` / `MarkdownNote` 便签与 `mode` 为 2（静音）/ 4（旁路）的节点直接丢掉；
4. 剩下没能对应到输入名的 `widgets_values` 计数返回 `droppedWidgets`，设置页据此提示改用 Save
   (API Format)——**老版 ComfyUI 导出的界面格式里 widget 不在 `inputs[]` 里**，名字只能靠顺序猜，
   猜不中就是丢控件值，宁可说出来也不静默跑。

注意 `first` / `last` 这类**没连线的 IMAGE 槽不会进转换结果**（界面格式里它们是 `link: null` 且没有
`widget`），正好留给下面第 4 级「按节点定义补一个 LoadImage」接手——官方 All-in-One 的首帧就是靠这条
路径接上的（它的 LoadImage 不存在，全靠 `object_info` 里 `FreeVideoGenerate.optional.first`）。

**注入点是探测出来的，不是写死的**（`detectComfyBindings`，候选键名都是常量表）。四级顺序：

1. 设置页里的显式覆盖 `节点ID.输入名`（填了但无效——节点不存在 / 输入名不存在 / 那个输入是连线——
   只记一条 note 并退回自动探测，所以设置页可以拿它做预览而不怕报错）；
2. 工作流里**已有的字面量输入**，按候选键名匹配（提示词 `text` / `prompt` / `positive` /
   `positive_prompt` / `caption`；秒数 `seconds` / `duration` / `video_length` / `length`；种子
   `seed` / `noise_seed` / `rand_seed`），多个候选取节点 id 小的并记 note；
3. 首帧 / 尾帧：优先用工作流里**已经接好线的 `LoadImage`**（直接替换它的 `image` 文件名），
   其次是已有的 `first` / `last` 类字面量输入；
4. 都没有时读一次 `GET /object_info/<class_type>`：**optional 的 IMAGE 输入在工作流 JSON 里根本
   看不见**（`FreeVideoMedia.first` 只在节点定义里存在），只有它能回答「这个节点接得下 IMAGE、
   键名叫 first」。命中就在提交时插入一个 `LoadImage`（新节点 id = 现有最大数字 id + 1）连过去。

⚠️ `object_info` 的结构是 `{ input: { required, optional }, output, name }` —— **`input` 包了一层**，
漏了这层就永远探测不到 IMAGE 输入（最初的实现就是这么错的）。

命中首帧后，注入器还会把工作流里所有 `first_frame_reference === false` 改成 `true`：
FreeVideo 的 Generate 节点靠这个开关决定「要不要真的用首帧图」，不改就是「图传上去了但没生效」。

**一个 `LoadImage` 只代表一张图**：首帧用第一个、尾帧用第二个。只有一个 `LoadImage` 却真的注入了
尾帧时，尾帧会**静默**顶掉首帧的图——所以提交前会检查「尾帧图上传了但没人接收」并直接报错，
而不是丢掉（`verify-comfy.mjs` 里有这条，两个 `LoadImage` 的夹具也是为它准备的）。

**判断后端必须按节点上记的 `backend`，不能按当前配置。** MiniMax 的 `task_id` 与 ComfyUI 的
`prompt_id` 都是字符串，用户完全可能在任务跑到一半时改设置；按配置去查就会拿 MiniMax 的接口去查
一个 ComfyUI 的 id（表现：一边报「任务不存在」、另一边永远 pending）。序列帧任务同理。

**ComfyUI 后端不支持多模态参考模式**（参考图 / 参考视频）——那是 MiniMax v2 的能力，
`submitViaComfy` 会明确报错，请改用首尾帧模式。ComfyUI 后端还必须有首帧图。

设置页的「测试连接」只读 `/system_stats`（版本、显卡）与 `/queue`（队列长度），再解析一遍工作流
跑一次探测，把「探测到的注入点」显示出来：**不排队、不生成、不产生费用**。

**Cookie：藏在鉴权反代后面的 ComfyUI**（`comfyCookies`）。ComfyUI 自己不做鉴权，但把 8188 挂在
Cloudflare Access / Basic Auth 后面时，不带 `Cookie` 连 `/system_stats` 都读不到。`comfyFetch` 是
comfy.ts 里**唯一**的 HTTP 出口（`/system_stats`、`/object_info`、`/upload/image`、`/prompt`、
`/history`、`/queue` 全走它），头在那里统一挂上；**取回成品视频**那次 `GET /view` 走的是
`downloadVideoTask`（不在 comfy.ts 里），Cookie 由 `videogen.ts` 单独传给 `downloadVideo` 的第三个
参数——漏掉它就会「任务跑完但视频下不下来」。

`normalizeComfyCookies` 负责把用户粘贴的东西收成一行：用户多半直接从开发者工具里复制，那里带
`Cookie: ` 前缀，整段「Copy request headers」还夹着 Accept 之类的别的头，长 cookie 也可能折成几行。
规则是「只认 `Cookie:` 那一行，加上它后面不以 `名字:` 开头的续行」，再剥前缀、去掉每段自己的尾分号，
拼成 `a=1; b=2`（每段先各自去尾分号再拼，否则 `a=1;` + `b=2` 会拼出 `a=1;; b=2` —— `verify-comfy.mjs`
盯这条）。

它和 API Key **同一档待遇**：落盘明文、但**从不回传浏览器**，配置视图里只有 `comfyCookiesSet` /
`comfyCookiesHint`（尾 4 位）；保存约定也一致 —— 不带该键 = 保持原值、带字符串 = 覆盖、
`clearComfyCookies: true` = 清空。它也是 `saveConfig` 里 `directKeys` 的**唯一例外**：白名单里的键是
原样透传，而 Cookie 必须先归一化，所以在函数体里单独处理。

### 功能管理：隐藏的模块必须对 AI 也关上

设置页的「功能管理」逐个开关六个模块，配置字段是 `hiddenModules: string[]`
（合法值 = `links.ts` 的 `STUDIO_MODULES`；`normalizeHiddenModules` 丢掉不认识的 key
并按固定顺序排列，这样同一组勾选永远序列化成同一份 JSON）。

**只在界面上藏起来等于没藏。** 模型看不见页签，照样能调 `runIsoGenerate` 等本地方法 /
`runRigSheet` 这类方法，而且**每次调用都真实计费**。所以这道闸门有两半：

| 半区 | 做什么 | 在哪 |
|---|---|---|
| 浏览器 | 页签与侧栏菜单按可见性过滤；选中项被隐藏时落到第一个可见模块 | `client.ts` 的 `useHiddenModules` / `visibleModulesOf` / `activeModule` |
| 宿主 | `game_material` 的 `guide` / `call` / `intake` / `upload` / `wait` / `review` / `approve` 全部拒绝 | `tools.ts` 的 `assertModuleVisible` + `METHOD_MODULE` |

几个刻意的选择：

- **归类表是一份显式清单**（`METHOD_MODULE`），不是按方法名前缀猜。`verify-tools.mjs`
  有一条契约要求**每个** `TOOL_METHODS` 方法要么在表里、要么在 `SHARED_TOOL_METHODS` 里，
  新加方法忘了归类会直接红——漏一个就是「这个功能隐藏了但还能调」。
- **先拦后查**。`status({id:"t…"})` 在不存在的 id 上也先报「已被隐藏」，而不是
  「找不到」。否则模型会以为只是没找到，换个 id 继续试。
- **可见性本身不许模型改**。工具面对 `saveConfig({hiddenModules})` 直接报错，
  否则模型可以自己把隐藏的功能放出来，「隐藏」就成了摆设。
- **每次都现读配置**。`loadConfig()` 命中内存缓存、不打盘，所以用户在设置页取消隐藏后
  **下一次调用立刻可用**，不需要重启宿主（配置缓存由 `saveConfig` 更新，两侧读同一份）。
- **全隐藏是允许的**：工作台显示一句空态，侧栏菜单显示同样一句，不是白屏。

### 侧栏入口上的菜单按钮

需求是「在入口按钮上加快捷菜单」。实现上有个硬约束：宿主把插件的 `sidebar.panellist`
**渲染在它自己的 `<button class="…panelRow">` 内部**（`dsh-client-ui-sidebar` 的 `PanelRow`），
所以：

- 不能加平级的 `<button>`（会变成嵌套按钮），于是触发器是一个
  `span[role="button"][aria-haspopup="menu"]`，挂在图标右下角；
- 点击必须 `preventDefault` + `stopPropagation`：宿主那个 `<button>` 的 onClick
  就在同一条冒泡路径上，不拦就会「打开菜单顺带切面板」；
- 菜单用 **`position:fixed`** 而不是 `absolute`：侧栏面板列本身不裁剪，
  但祖先里有 `overflow:hidden` 的容器，`absolute` 在某些窗口布局下会被切掉；
- 菜单容器自己也吞掉 `onClick` / `onMouseDown`，理由同第二条；
- **被隐藏的模块不出现在菜单里**，菜单底部说明隐藏了几个。

侧栏收起（36×36 的窄栏）时同一个触发器仍然可点——`getBoundingClientRect()` 拿的是
图标的实际位置，菜单贴到窄栏右侧展开。

真机验证过：展开 / 收起两种侧栏宽度、点菜单项确实切面板且菜单自动关闭、
隐藏后页签与菜单同时消失（**不用刷新页面**）、深链接指向被隐藏模块时落到第一个可见模块、
全隐藏时的空态。

### 在外部浏览器里真机验收（Playwright 怎么进去）

桌面端的 web 服务（默认 `127.0.0.1:19387`）**只认启动时那一次 token**：`GET /?token=…` 校验通过后
写入绑定 authority 的签名 cookie，此后 `/` 与 `/api/*` 全靠它；**token 每个进程重新随机**，
打印在启动那一行 stdout 里。所以「随手拿个浏览器开 19387」永远是 401——外部浏览器没有别的渠道拿到它
（插件自己的静态资源路由不在认证范围，所以图能 200、根路径还是 401，很容易误判成「权限问题」）。

要一个**自己可控的浏览器**（Playwright / 自己的 Chrome），就单独开一个验证用 profile：

```bash
dsh plugin --profile gmmweb add /path/to/dsh-game-material-master   # 建 profile 并把插件 link 进去
# 再把 "@deepseek-ai/dsh-web-app" 手动补进该 profile 的 package.json → dsh.profile.bundles
dsh --profile gmmweb --port 19388     # 打印 http://127.0.0.1:19388/?token=… 并用默认浏览器打开
```

- `desktop` profile **不能**用 CLI 起（会报 `profile "desktop" is managed exclusively by the Electron application`），
  所以必须单开一个；它和桌面端**共用 `$DSH_HOME`**，插件数据（`game-material-master/` 下的项目）两边都看得到。
- token 就在启动输出那一行（`dsh web: http://127.0.0.1:19388/?token=…`）；`--no-open` 只决定要不要开浏览器。
- 把这个 URL 喂给 Playwright，就能用**元素级选择器 + JS 量尺寸 + 元素截图**做真机验收，
  比 Computer Use 的坐标点击稳得多。Computer Use 仍然有用（能看真实窗口、能截图），
  但 Electron 里**网页的 AX 树不暴露**（只有一堆 `AXGroup`），只能靠截图 + 坐标，容易点偏。

### 新建项目 / 任务时的命名：三态返回值

其余模块的「新建」先问一个名字（`askNewName()`）。返回值是**三态**，调用方必须照着写：

| 返回 | 含义 | 调用方要做的 |
|---|---|---|
| `null` | 用户点了取消 | **不要创建**（点了取消却多出一个项目，会被当成 bug） |
| 空串 / 全空白 | 用户没填 | 用默认名（原来的时间戳名） |
| 其余 | 用户输入 | 直接用它（已 trim） |

⚠️ **`window.prompt` 在 Electron 里是坏的**（DSH 桌面端就是 Electron）：函数**存在**、
`typeof` 判断完全看不出问题，但**一调用就抛**「prompt() is and will not be supported」。
抛出去会让调用方的 async 处理器变成未处理拒绝 —— 界面表现就是「点了新建什么都没发生」。
所以 `askNewName()` 里包了 try/catch 退回默认名（至少把任务建出来），
**模块六的地图编辑器已经彻底不用它**：改成面板自己渲染的对话框（`SPR_mapEdDlg`，
输入框 + 取消 / 确定，回车确认、Esc 取消），`verify-map-client.mjs` 会用一条返回 `null` 的
假 `window.prompt` 断言「模块六一次都没碰它」。其余模块若要同样的体验，照模块六那样接。

真机验收过：填名 / 取消不创建 / 空白走默认值 / 重命名改回原名，四条都过。

---

## 模块一：八方向图生成

### 方位约定

这是 **RPG 地图上的八方向行走**，不是「抬头 / 低头」。约定画面上方为北：

| 方位 | 屏幕朝向 | 能看到什么 |
|---|---|---|
| **北 N** | 朝画面**上**方走 | 后脑勺，**完全看不到脸** |
| **东北 NE** | 朝画面右上走 | 斜背面，**完全看不到脸** |
| **东 E** | 朝画面**右**走 | **右侧脸**（纯侧面） |
| **东南 SE** | 朝画面右下走 | 正脸，转向右侧约 45° |
| **南 S** | 朝画面**下**方走 | **完整正脸** |
| **西南 SW** | 朝画面左下走 | 正脸，转向左侧约 45° |
| **西 W** | 朝画面**左**走 | **左侧脸**（纯侧面） |
| **西北 NW** | 朝画面左上走 | 斜背面，**完全看不到脸** |

提示词把**转身**（`{facing}`）和**可见部位**（`{visibility}`）分成两段写，
这是为了避开上面说的「抬头」坑。

### 生成顺序

依赖是**有向的**，所以生成也一层层来；同层内并发（并发数可配）：

| 顺序 | 方位 | 参考图 |
|---|---|---|
| 1 | 南（正对镜头） | 源图 |
| 2 | 北（背对镜头） | 南 |
| 3 | 西南 / 东南 | 南 |
| 4 | 西北 / 东北 | 北 |
| 5 | 西 / 东 | 南 **+** 北 |

重新生成某个方向时，依赖它的下游会自动标成 **「需重做」**。

### 阶段①的两种生成方式：转圈截帧（默认）与逐方向生图

`Project.imageMode` 决定阶段①怎么产出那八张 `images/<方向>.png`；**两条路的产物形态完全相同**，
所以阶段②（行走视频）、③（抽帧）、④（整图）完全不必知道用的是哪一种。

| | `turn` 转圈截帧（默认） | `direct` 逐方向生图（备选） |
|---|---|---|
| 怎么来 | 一段「原地匀速转一整圈」的绿幕视频，按时间轴截出八个方向 | 八个方向各自一次 Seedream 生图，按依赖顺序 |
| 花费 | 一次视频调用（几分钟） | 八次生图调用 |
| 一致性 | **好**：八个方向同源（同一个角色、同一段光线、同一套画风） | 一般：模型每次都要「重新理解」角色，脸型/发色/服装容易漂移 |
| 清晰度 | 受视频分辨率限制（默认 768P/2K） | 受生图分辨率限制（默认 2K，更高） |
| 可调 | 时间轴上八个圆圈，随时重切（本机、免费） | 每个方向单独重跑 |

新项目默认 `turn`；**老项目**（还没有 `imageMode` 字段时建的）自动沿用 `direct`——
它们已经有八张图了，直接跳到空白的转圈页只会让人以为产物丢了。切换用
`setImageMode({projectId, mode})`，切换**不删任何产物**。

转圈模式的三步：

1. `runTurnVideo({projectId})`：一次 MiniMax 调用，整圈只有这一段视频。首帧优先用
   已经存在的 `images/front.png`（正面绿幕图），没有就退回源图——源图不一定是绿幕，
   所以提示词里明确要求「纯色绿幕 #00FF00」，由模型把背景重画成绿幕。实际用的是哪张
   记在 `turn.video.firstFrame` 里，排查「第一帧就不是正面」时全靠它。
2. 视频落地后宿主**自动**抽候选帧（本机 ffmpeg，免费）：默认 32 张，按
   `fps = 张数 / 时长` 均匀取样，第 i 张对应 `i × 时长 / 张数` 秒；同时把整圈缩略条带
   写进 `turn/strip.png`——界面上那八个圆圈就是对着这条条带拖的。
3. 按 `turn.frames.picks`（八个方向各自选中第几帧）把八张方向图切出来，覆盖
   `images/<方向>.png`。这一步只读 `turn/raw.bin` 缓存，所以拖动圆圈是**本地、免费**的。

**为什么位置必须可拖**：默认位置假设「视频从正面开始、匀速转满一圈、方向是顺时针」，
而模型经常不遵守——起步有一两秒静止、转速前快后慢、或者干脆往反方向转。任何一种都
会让八个默认位置整体偏掉，所以轴上给了八个圆圈（`setTurnPick({projectId,key,index})`）
和「换个转圈方向重排」（`resetTurnPicks({projectId,direction})`）。拖动只重切那一张，
但会**作废该方向的行走视频与序列帧**（它们拍的是另一个朝向），整图同样作废。

改候选帧数（`saveSettings({turnFrameCount})`，8~512）会**自动重抽**，并把用户拖过的位置
按比例换算（32 帧里的第 12 帧 → 8 帧里的第 6 帧）；直接保留下标会把八个位置整体打乱。
另外，八个位置在**第一次**抽帧时按这次的张数重新等分——否则「新建项目默认 32、第一次
却抽 16 张」时，四个方向会一起被夹到最后一帧。

### 第三条输入：本地自选视频（阶段①与阶段②共用）

两处「需要生成视频」的地方都不只有远程生成一条路：

| 槽位 | 界面入口 | 导入后 |
|---|---|---|
| `turn` 转圈视频 | 阶段①的「选择本地视频」 | 宿主**自动**抽候选帧并切出八个方向（与远端路径完全一样） |
| 八个方向之一的行走视频 | 阶段②每一格的「选择本地视频」 | 该方向的视频就绪，之后照旧到第 3 步抽帧 |

- 方法：`uploadVideo({projectId, key, name, data:base64})`，`key ∈ {turn} ∪ 八个方向`。
  界面走的是和源图同一条 base64 通道（插件零运行时依赖，不为它另开上传接口）。
- 产物**完全同形**：同一个 `videos/` 目录、同一个 `VideoNode` 形状，只有
  `origin: "local"` 与 `originalName` 两个字段标出来路；阶段③④一行都不用改。
- **旧产物必须一起作废**：方向槽位清掉该方向的序列帧与整图（`raw.bin` 留着就会拿
  上一段视频的帧去合成，界面看着一切正常）；转圈槽位把候选帧标成 `stale`，随后的自动
  抽帧会按新的 `picks` 重切八张图，并逐个作废那些方向的下游。
- **摘掉远端任务号**：导入的那一刻若正好有远端任务在跑（`taskId` 存在），会被清掉并写一条
  日志——否则它稍后拿到结果会把本地视频直接覆盖掉。单次已经在下载途中的那一轮仍可能落盘，
  所以日志里明确写了作废了哪个任务号。
- 上限 100MB（`pipeline.LOCAL_VIDEO_MAX_BYTES`）：这条链路只在本机跑 ffmpeg，不发给任何
  模型，所以比「要发给模型的参考视频」（40MB，受平台请求体上限约束）宽得多。容器按
  **文件头**认（MP4 / MOV / M4V / WebM / MKV / AVI），不看扩展名——从手机或剪辑软件
  拿到的文件经常被改名，容器认错了不会当场报错，而是抽帧时才失败。

### 保存中间图片（zip）

`exportImages({projectId})` 把这一路生成下来的**每一张图**打成一个 zip 落在 `out/` 下
（`out/<项目名>-images.zip`，静态资源路由可直接下载）：

- `images/<方向>.png`（八方向绿幕图）、`turn/strip.png` 与 `turn/frames/*.png`（转圈候选帧）、
  `frames/<方向>/f*.png` 与 `frames/<方向>/candidates/*.png`（抽出来的绿幕帧与手动选帧候选）、
  `keyed/<方向>/f*.png`（抠像帧）、`preview/*.png`、`out/sheet.png`（整图）。
- 包里保留**项目内的相对路径**，解压出来能和项目目录对上号；源图不算（它是输入，不是产物）。
- 界面上每个看得见的产物另有一个 `<a download>` 单张保存链接（绿幕图 / 转圈条带与视频 /
  预览带）；一抽 32~64 张的候选帧只走整包——一张一个链接既点不完也看不清。
- 单张读不到（手删过的旧记录）只跳过并如实回报 `skipped`，不让整包失败；一张都没有时明确报
  「还没有任何图片可保存」，而不是打一个空包。

### 统一附加提示词

「八方向绿幕图」这一步有一个**统一附加提示词**输入框：非空时会被追加到**每一张**生图
提示词末尾，用来写跨方向的共同注意事项（例如「必须穿同一双靴子」「不要出现文字」）。
改一次全部生效，不必逐个方向去改。每个方向仍然可以单独覆盖自己的提示词。

### 行走视频

提示词要求**固定机位 / 固定背景 / 原地走三步**。八个任务并发提交，宿主后台每 15 秒轮询一次；
**提交完可以离开页面**，插件重启后还会把没跑完的任务接上。

某个方向不满意可以点**「重新生成」**：宿主会先作废这一段旧视频**和它抽出来的序列帧**
（整图同样作废，需要重新抽帧再合成），然后重新提交——帧是从视频里抽的，不重抽就会
把上一版动作混进整图。**其它方向不受影响**。工具栏的「生成全部视频」只提交还没完成的
方向，已经成片的不会重跑；要是八个方向都已完成，它会直接告诉你该点哪个按钮而不是
转一圈了事。

### 界面刷新不许覆盖正在编辑的草稿（「我替换的时候它一秒钟又换回来」）

阶段①~④ 有任务在跑时都会轮询：模块①有任务时 **2.5 秒**一次、视频阶段**固定 5 秒**一次，
模块②③④ 各自 2.5~5 秒一次。轮询调的都是同一份 `loadProject()` / `load()`，而它们原本
**无条件**拿宿主的值整份覆盖界面草稿（提示词、统一附加提示词、参数）。于是用户正在长文本框里
替换视频提示词时，刚打进去的内容会在一两秒内被打回原形 —— 真机原话就是这个 bug 的标题。

现在的规则：`load()` **只更新用户没动过的字段**（`mergeDrafts()`）。

- 判定标准是「草稿 === 上一次从宿主读到的值」：相等 = 没改过，跟着宿主走（切语言、
  别处改了这条、重置默认都能同步）；不相等 = 用户改过，留着，直到他自己保存。
- **换项目 / 换任务**时整份换成宿主的（`force`），否则会把上一个项目的草稿带到新项目里。
- 点「重置提示词为默认」是**明确**要丢掉手改内容，所以那条路带 `resetDrafts: true` 强制替换。
- 对象草稿（八方向提示词、参数）按**字段**合并，保存某一个方向不会把别的方向正在改的草稿冲掉。
- 模块⑤ 更早就分了 `reload()`（只刷状态、轮询用）与 `load()`（切项目时清草稿），
  同一个教训；模块①②③④ 现在统一走 `mergeDrafts()`，新加字段照这个写。

自检：`verify-feedback.mjs` 直接用产物里的 `mergeDrafts` 跑「连续 5 次轮询后仍是用户输入的内容」，
`verify-client.mjs` 逐模块钉住「不再出现 `setPromptDraft(next.prompt ?? "")` 这种无条件覆盖」。

### 抽帧与合成

`ffmpeg` 用 `fps = 帧数 / 视频时长` 按时长平均取样。抽帧抽到的是**工作尺寸**
（长边上限，默认 768），不是最终格子尺寸——自动裁剪、统一缩放和像素量化都在 JS 里做，
这样八个方向才能共享同一个裁剪框、脚底对齐同一条基线。

「提取全部序列帧」对每一段就绪视频用**同一套**帧数等分。每个方向卡片上的「手动选帧」
只处理那一段视频：先匀抽出一串候选帧（默认 32，8~512），再在条带上拖圆圈决定每一张输出帧
落在哪一时刻。圆圈个数跟项目的「每段视频抽帧数」走，所以整图仍然是整齐的格子；拖动只读
本机缓存，不重新解码视频。再点「抽取 / 提取全部」会回到等分，并清掉这个方向的手动选帧。

### 行走预览

用 **WASD 或方向键**操控角色，验证八方向接起来顺不顺：

- 角色以**脚底中心**为锚点，帧推进按**走过的距离**而不是时间——步频和移动速度才对得上
- 「播放速度」只改步频快慢，「移动速度」只改走得多快，两者互不影响
- 切图用的是**整图自己记录的**行序与格子参数，所以改完行序即使还没重新合成，预览也不会取错方向
- 需要**点击画面取得键盘焦点**后才响应按键，避免和输入框抢键

---

## 模块二：图片生成

按提示词出图，可选带参考图（最多 10 张；多张时可在提示词里写「图一」「图二」）。
每张生成完，若开着抠像会自动抠一遍；也可以**把已有图片直接传进来只做抠像**——
这样它同时也是一个通用的绿幕抠像工具。

- 生成张数 1~8
- 每张可单独重新生成、删除、下载原图、下载透明 PNG（未抠像时原图是唯一产物，所以原图也有独立下载入口）
- 每张会记录**背景占比**，用来判断抠像是否可信（占比异常说明绿幕没生成好）
- 每张可单独打「通过」，也可以一键全部通过；对话里的 `game_material({action:"approve"})` 改的是同一份标记

### 生图后端：只剩 ComfyUI 与 ToAPIs

`config.imageProvider` 只有两个值：

| 值 | 说明 |
|---|---|
| `comfyui`（默认） | 本机 / 自建 ComfyUI，走 `customimage.generateComfyImage` |
| `toapis` | ToAPIs 异步接口，走 `toapis.generateToapisImage` |

**火山方舟 Seedream 与 OpenAI / SD WebUI 两种自定义协议已经删除。**
老配置里的 `"ark"` / `"custom"` 由 `normalizeConfig` 归一到 `comfyui` ——
留着旧值只会得到一个「后端不存在」的运行时错误，而那个错误发生在生图时，
离「升级插件」这件事很远。

`imageModelOf` 在 ComfyUI 侧回的是**当前工作流的名字**（不是模型名）：
ComfyUI 的模型由工作流里的 `CheckpointLoaderSimple.ckpt_name` 决定，
插件没有一个全局的「模型」概念，界面角标显示工作流名比显示空字符串有用。

### 多工作流（`src/workflows.ts`）

以前只有一个 `customWorkflow` 字符串 —— 想同时留着「文生图」「带参考图」两份就得来回覆盖粘贴，
粘错一次**不报任何错**，只是下一张图的构图全变了。

现在是一份有序列表：

```json
{ "workflows": [ { "id": "w…", "name": "文生图 · 25 步", "json": "{…}" } ], "activeWorkflowId": "w…" }
```

三条不变式（每条都对应一类真机坏法）：

1. **列表永远非空** —— 空列表等于「没有工作流可选」，生图按钮会变成死的。
   删到最后一份时自动补回内置的 `DEFAULT_COMFY_IMAGE_WORKFLOW`。
2. **id 必须唯一** —— 任务靠 id 找工作流，重复 id 会让「切了没反应」。
   `normalizeWorkflows` 遇到重复 id 会重新发一个。
3. **json 必须是能解析的非空对象** —— 存进去的时候校验，比等到提交时 400 好得多。
   `updateWorkflow` 对非法 JSON **整个拒绝并回 `error`**，不静默存下一份坏的。

`pickWorkflow` 在列表意外为空时也**不抛**，回一份空壳 —— 它被「读配置的每一条路径」
调用（界面角标 / 任务创建 / 生图分发），抛出去就是整个设置页打不开。

**图片任务记的是 `workflowId`，不是工作流内容**：用户改好工作流之后老任务跟着用新版，
这正是「我修好了工作流，重跑一遍」想要的行为。`settings.workflowId` 为空 = 跟随全局当前那份。

### 工作流参数面板（`src/workflowparams.ts`）

每份工作流的**可设置参数自动列在任务面板上**：类型（数字 / 文本 / 开关 / 下拉）、
取值范围、枚举候选值全部**从 ComfyUI 的 `/object_info` 现场读**。

为什么不手写参数清单：清单一定会和工作流脱节，而脱节的表现是「控件调了没反应」、
不报任何错 —— 这比控件根本不存在更坏。

`discoverWorkflowParams(workflow, info)` 的规则：

- 只暴露**本身是字面量**的输入；`["4", 0]` 这种是连线，改了会破坏拓扑。
- 控件类型由节点定义决定：`INT` / `FLOAT` → 数字框（带 min / max / step），
  枚举（`[["euler","ddim",…], {}]`）→ 下拉框，`STRING` → 文本框（`multiline` 时多行）。
- `/object_info` 拿不到时（ComfyUI 没开、节点包没装）**不抛错**，退化成按工作流里已有的值猜类型；
  表单照常能编辑，生图本身会给出更有用的错误。
- 顺序按节点 id 数字升序、再按定义里的输入顺序 —— 表单顺序稳定，不会每次刷新换个样子。

**参数只存用户改过的那些**（`settings.params`，键是 `节点id.输入名`）。
把每个参数都抄一遍没有意义，还会让任务文件变得很大。

### 参数类型必须按节点定义判定（踩过的坑）

`applyWorkflowParams` 的第三个参数是 `discoverWorkflowParams` 的结果，
**不能只看工作流里的当前值**：那些槽位往往还是 `"{{seed}}"` 这样的字符串占位符，
按值猜类型会把数字写成字符串，而 ComfyUI 的 `KSampler.seed` 是 int，直接报 type 错误。

调用链：`generateImageWithProvider` 发现有 `params` 时先查一次 `paramKindsOf()`（内部就是
`/object_info` + `discoverWorkflowParams`），把类型表传给 `generateComfyImage`。
查不到时传 `undefined`，退回按当前值 —— 总比一律写字符串好。

写回的顺序也是刻意的：**占位符替换 → 参数面板 → 提交**。
参数面板显示的是工作流里的真实输入，用户在那里改的东西必须赢过占位符与默认值。

### 界面两处

- **设置页**：只剩 ComfyUI 与 ToAPIs 两组。ComfyUI 那一组里有工作流下拉（编辑哪一份）、
  名字输入框、JSON 文本域、保存 / 另存为新工作流 / 删除这份。工作流 JSON 走**草稿**，
  点「保存工作流」才提交 —— 几 KB 的 JSON 每敲一个字往返一次会明显卡，
  而且中途的非法 JSON 存进去之后，下一次生成要在几十秒后才报错。
- **任务面板**：工作流下拉（跟随全局 / 具体某份）+ 参数控件。
  参数控件按 `param.kind` 分派：`boolean` → 开/关下拉，`enum` → 下拉，`int`/`float` → `NumField`，
  其余 → 文本框。参数改动**只存改过的那几个键**，`saveJob({ settings })` 走已有的保存队列。

### 自检

- `verify-custom-image.mjs`（**74 项**）：起一台假 ComfyUI，覆盖尺寸写法、提交 → 轮询 → 取图的
  端点顺序、占位符按 JSON 类型替换、参考图上传与 `LoadImage` 兜底、失败路径（提交被拒 / 执行报错 /
  空工作流 / 非法 JSON）、**参数发现与应用**（含「没有声明时会写错类型」这条反向验证）、
  多工作流六个函数、配置归一化与分发层真的换了端点。
- `verify-host.mjs`：配置读写、多工作流的增删改与「删空补一份」、`activeWorkflowId` 归一化、
  老 `ark` / `custom` 迁移。
- `verify-feedback.mjs`：设置页只剩两家后端、没有协议下拉、工作流列表与另存 / 删除按钮。

---

## 模块三：序列帧生成

两种输入模式，**平台规定互斥**：

- **首尾帧模式**：上传首帧图（必填）+ 尾帧图（选填）
- **多模态参考模式**：上传参考图（≤9 张）+ 参考视频（≤3 段，每段 2~15 秒）

> 参考视频要转成 base64 内联在请求里，平台请求体上限 64 MB，所以本地文件卡在 40 MB；
> 更大的文件平台要求改用公网 URL。

流程：**生成视频 → 抽帧（张数可配）→ 抠像 → 横向合成**，其中抽帧完成后会自动接着抠像与合成。
界面里可以：

- 播放生成出来的视频（`<video>`，支持拖动进度条）
- **循环播放抠像后的序列帧**（可调 fps 与缩放），直接判断动作连贯性与抠像边缘稳定性
- 导出横向条图与逐帧 PNG
- 对「视频 / 抽帧 / 条图」三步各自打「通过」；对话里的 `game_material({action:"approve"})` 改的是同一份标记

---

## 模块五：45° 地图编辑器（iso，全本地）

把「等距地块」变成一张能直接画、直接导出的地图。与模块六并列为两套独立编辑器：

| | 模块五 `iso` | 模块六 `map` |
|---|---|---|
| 格网 | 2:1 正交等距（菱形） | 正方形俯视 |
| 素材 | 导入自己的 45° 素材 / 内置程序化素材 | 导入自己的图集 / 内置素材 |
| 自动连接 | 4×4 = 16 块（N/E/S/W 位序） | A2 拼块 / 整格 16 块 |
| 物件 | 一张完整图，可占 N×M 格、可高出格子 | 整图（stamp）按格切块 |
| 渲染 | 宿主给 `z`，客户端按 `z` 排序绘制 | 按 chunk / 行优先 |
| 数据 | `iso-jobs/<id>/project.json` + `map.json` | `map-jobs/<id>/...` |

### 几何唯一真源

`src/isogeom.ts`：

```
stepX = cell.width / 2
stepY = cell.width / 4        // 菱形高的一半，不是 cellHeight / 4
cellCenter(r,c) = { x:(c-r)*stepX, y:(c+r)*stepY }
```

`pointToCell` 先把像素线性反解成实数 r/c，再 `floor(v + 0.5)`。用 `floor` 会在菱形
上半格整片偏一格；这个坑只在斜边附近显形，看起来像「偶尔点不中」。

物件底面中心不是锚点格中心：2×2 物件要再往右下各半格。`isogeom.objectBase` 是唯一口径。

### 渲染计划 / z

计划 op：`{l, r, c, t, x, y, a, z, cycle?, fps?}`。`z` 由宿主算：

```
depth = r + c                         // 地面
depth = r + c + cols + rows - 2       // 物件，取最靠前的占格
z = layerIndex * 1e12 + depth * 1e6 + r * 4096 + c
```

客户端把所有可见 op **全局按 z 排序**再画；导出 PNG 也按同一顺序。**不能**按 chunk 顺序
直接画 —— 不在同一个 chunk 的前后物件会反过来。

计划缓存按 8×8 格 chunk；界面报 `have`，宿主只回缺的块；编辑后用 `dropKeys` 精确失效。
`pending` 预览必须**不带 have**（否则预览改的格子往往落在已有块里，拖一路什么都看不见）。

### 素材

- `ground`：网格图块。静态时每块一个笔刷；`animRows` 时每列一个笔刷、每行一帧。
- `autotile`：严格 4×4 = 16 块，行优先 `mask = 0..15`，`N=1 / E=2 / S=4 / W=8`。
  缺 mask 回退 Hamming 最近的接法并告警，绝不留洞。
- `object`：一张完整图（多帧竖排），按**底边中点**摆放；`footprint` 只影响占格与遮挡；
  `pass[]` 逐格 0/1/2。物件占格必须完整落在地图内，**不跨环绕接缝**（否则图片会被切成两半）。

素材属性导入时定死；之后只能改名字 / 播放速度 / 循环方式（`saveIsoTileset`）。
`isotiles.paletteOf` **必须吃全项目的 flatTiles**：只传这一张素材，序号会从 1 重新开始，
第二张素材的笔刷会画成第一张的图（不报错，只是画错）。

### 数据

`IsoDoc.data` 只存地面层的语义序号；物件在 `objects[]`，标记在 `markers[]`。
一格只装得下一个序号，装不下「占 2×2 + 通行性」。改尺寸 / 图层 / 改名走 `saveIsoDoc`
（整份快照进撤销栈）；画笔 / 物件 / 标记走 `applyIsoOps`（逆 op 进撤销栈）。

`isoUndo` / `isoRedo` 对结构操作恢复快照，对 op 应用逆操作。一次拖拽用 `stroke`
合并成一条撤销。

### 导出

`dsh-gem-iso-map@1`（带标记语义时 `@2`）：`cell`、`grid`、`layers`、`ground[].data`、`objects[]`、`markers[]`、
`pass[]`、`tilesets`、`legend`。PNG 走 `rasterizeIso`（与客户端同一份计划、同一个 z 顺序）。
每次导出先清空目录；zip 时间戳写死，同文档两次导出逐字节一致。

### 容易静默坏的几处

- `stepY` 写成 `cellHeight / 4`：整张图裂开，不报错。
- 点命中用 `floor`：斜边附近偏一格，不报错。
- 物件的 `z` 取锚点格而不是最靠前占格：2×2 建筑会被前面的树盖住一截。
- 调色板只用单张素材的 flatTiles：第二张素材的笔刷画成第一张。
- 物件跨环绕接缝：图片被切成两半，另一半出现在地图另一头。
- 客户端按 chunk 直接画：不在同一块的前后物件顺序反了。
- schema 漏字段（`isoPlan.view` / `applyIsoOps.ops` / `importIsoTileset.*`）：界面点了没反应。

### AI 生成素材（首版：地面 / 物件）

素材卡点「AI 生成素材」不自己生图：开一个不挂靠项目的新对话，把项目 id / 格子 / 名字 / 帧数 /
生成方式 / 用途 / 物件占格写进首条消息；对话里的 agent 用图片或序列帧生成，再调
`composeIsoAsset({projectId,name,files,kind,footprint})` 整理到 `ai/`，最后把带
`dialog=add&asset=…&shape=ground|object` 的回链贴回来。

- 首版只支持 `ground`（一块 2:1 菱形，多帧竖排成动画地面）与 `object`（整张图 + footprint）。
  **`autotile` 4×4 不在首版**：单张 AI 图无法可靠推导 16 种接法，继续手工导入。
- `composeIsoAsset` 抠绿、按 alpha 裁内容、地面缩进菱形框（外圈向边缘平均色收敛，避免重复铺时出现网格缝），
  物件按第一帧比例与 footprint 缩放；最多留 4 倍分辨率，回链带 `scale`，导入时再缩到项目格子。
- **只整理、不进素材列表**：回链打开「新增素材」，用户点「确定」才真的导入。
- `ai/` 必须在 `SERVABLE_ISO_DIRS` 里，否则回链图片 403；`composeIsoAsset` 的每个字段
  （`files` / `kind` / `footprint` / `keyGreen`）都必须写进 wire schema，少了就是「点了没反应」。

### 自检

`verify-iso.mjs`（几何 / 锚点 / 环绕脏块 / 内置素材）、`verify-iso-pipeline.mjs`
（CRUD / 编辑 / 撤销 / 计划 / 动画 / 生成 / 导出可复现 / AI 整理 / 动画地面）、`verify-iso-gateway.mjs`
（21 个方法 / schema 逐键 / 模块枚举 / AI 回链参数）、`verify-iso-client.mjs`（客户端坐标函数黄金对照 /
按 z 绘制 / pending / 方法表 / AI 对话框）。`verify-host` 另测 `iso-assets` 路由，`verify-tools` 真调
intake / status / review。

## 模块六：俯视地图编辑器（导入自己的素材）

与模块五（45° 等距）**走的是另一条路**：这里是正方格俯视，**导入用户自己的素材图** ——
也可以一键装内置素材直接开画。这一版按 [AsPJT/AsLib](https://github.com/AsPJT/AsLib/tree/master)
的 **RPG Map Maker** 重做：一屏、纯图标、零术语。

| | 模块五 `iso` | 模块六 `map` |
|---|---|---|
| 素材 | AI 生成（每个变体一次 Seedream 调用） | **导入 / 内置**（零调用、零计费） |
| 格网 | 只有 2:1 等距 | 正方形俯视，**环绕**（`wrap` 默认 `true`） |
| 过渡 | 无（同族随机抽变体） | 自动连接：A2 拼块 5 形状 / 整格 `corner16`，全自动、零配置 |
| 图层 | 单层 + 装饰 + 建筑三条特殊管线 | 多图层（只有名字；没有高度 / 不透明度 / 类型 / 锁定） |
| 导出 | 地块包 + PNG + 自有 JSON | `map.png` + `map.json`（`dsh-gem-map@2`）+ 可选 `tilesets/**` + 自动打的 `<地图名>.zip` + `manifest.json` |

第一版那条「导入 tileset → 切分 → 地形族与掩码 → 多图层 → 导出 Tiled」的四步流水线
整体删除（旧实现留在 git 历史里）。删除的理由不是工程上不行，而是**用户反馈一致**：
门槛太高、专业名词太多，要先学会一套词汇才能画第一格。设计细节（数据模型、A2 几何、
编辑协议、验收标准）在 [地图编辑器-设计文档.md](地图编辑器-设计文档.md)，
这里只写**干活时必须知道的事**。

四个阶段 key（`assets | rules | paint | export`）**保留在宿主里**（对话面契约），
但 `rules`（自动连接）现在没有任何可配置项：素材形态在导入时识别好了、过渡是内置的，
所以它一开始就是 `done`、界面也不显示 —— 界面只有「素材 / 地图 / 导出」。

### 「AI 生成素材」：生成交给新对话，导入仍由用户拍板

素材卡片上那颗「AI 生成素材」**不在插件里生成图**：它开一个**新对话**，把拼好的需求发进去，
剩下的由对话里的 agent 用工具体系完成。这条链路跨了三个域，每一段的约定都不许漂：

| 段 | 谁做 | 约定 |
|---|---|---|
| 收需求 | 浏览器半区（`aiDialog`） | 提示词 / 素材名字 / 动画帧数（1–16，默认 1）/ 动画生成方式（生图模型 \| 视频模型）。**帧数为 1 时视频模型那格点不动**（自动回生图模型） |
| 开对话 | 浏览器半区（`attachSessionBridge` + `openAssetChat`） | `ctx.sessions.create({})` **不给 workspaceId 也不给 cwd**（= 不挂靠项目）→ `ctx.uiWorkspace.openSession` 切到对话界面 → `beginSubmission` + `session.prompt([text], 'queue')`。两个服务都是**可选依赖**（`ctx.inject` 懒接，**不许**写进 `inject` 数组，否则缺一个整块插件都不挂载） |
| 拼提示词 | 浏览器半区（`buildAssetRequestPrompt`） | **逐行拼、每行各自 `T()`**：整段塞进一条 `T()` 会让模板里的 JSON 花括号被 `{word}` 插值规则当成占位符。三种分岔（静态 / 生图多帧 / 视频抽帧）在提示词里写死步骤，参数与「不要再问」也写在里面 |
| 生成 | 对话里的 agent | 就走模块二 / 模块三的现成方法（`createImageJob` → `runImageJob`；视频那条多一步 `createSequenceJob` + `upload(firstFrame)` + `runSequenceVideo` + `runSequenceFrames`）。**视频模型必须先有首帧**：序列帧模块不支持纯文生视频 |
| 定形态 | 对话框（默认）或对话里的 agent | 「这块素材怎么用」三种：`plain` 普通 / `corner16` 整格 / `a2quad` 拼块。对话框默认**自动判断**（agent 按下面的判据定，用户也能在那里替它拍板）。判据：成片铺开、边缘要接上 → 拼块；要连成一条、拐角要对上 → 整格；一块一块单独摆、不跟邻居接 → 普通 |
| 按形态规划 | 浏览器半区（`buildAssetRequestPrompt`） | 生图**之前**就把「画什么」写进提示词：普通 = 每张一格内容；整格 = **一块**正方形、四边能接上自己的无缝墙砖（整张图就是这一块）；拼块 = **每个变体一块**同样的无缝材质。⚠️ 整格 / 拼块都要**明确禁止模型画多格排布**（见下面「AI 素材的接缝」） |
| 整理 | 宿主（`mapgen.composeMapAsset` + `maptiles`） | 读本机绝对路径 → 按形态从**同一块砖**的像素拼出全部格子（`sheetPlanOf` 给目标块阵）：普通每张 `fitFrameToCell`（中心裁 + 最近邻缩放到网格）后 `stackFrames` 竖排；整格 `stretchToSize` 缩到一格 → `corner16SheetFromTile` 复制成 16 格并在「断」边 `shadeSide` 加收口；拼块每个变体 → `a2SheetFromTiles` 拼成 N 列 × 5 行、每格四个小格按各自接法加收口 → 写 `ai/<名字>.png`。**只整理、不进素材列表** |
| 回链 | 宿主（`tools.ts` 的 `intentFromCall`） | openUrl = `module=map&job=<项目>&stage=assets&dialog=add&asset=ai/<名字>.png&frames=<N>&shape=<形态>`，`asset` / `frames` / `shape` 取的都是**返回值**（不在入参里）—— 这也是 `intentFromCall` 唯一要读 `value` 的地方 |
| 落地 | 浏览器半区（`openAiAssetDraft`） | 解析新意图 → `loadProject` → `fetch(assetBase + asset)` → `File` → 打开「新增素材」并预填：名字=文件干名、格子=项目网格、**用法 = 回链里的 `shape`**、会动吗 = `shape === 'plain' && 帧数 > 1`（拼块的动画走变体、整格没有帧这一维） |

三条只在真机上才会暴露的坑，写在这里免得重踩：

1. **格子必须等于地图网格**。图块是按原始尺寸画在格子左上角的（宿主计划与界面 `drawImage`
   都用 `rect.width/height`），一格素材与网格不同尺寸就会压到邻居格上 —— 所以缩放是**强制**的，
   不是「顺手优化」。同理 `ai/` 里那张图在导入前还不是素材。
2. **形态必须按回链里的 `shape` 预选，不能写死也不能留给「自动识别」**。写死 `plain` 时拼块 /
   整格的图会被当成普通素材导入，画出来全是碎块；而 `auto` 同样不行 —— `32×(32×N)` 这种竖条在
   「高 = 5 × 尺寸」成立时（例如 N = 5）会命中 A2 判据（`imageHeight === size * A2_SHAPES` 且宽能整除），
   自动识别会把翻页图认成拼块。两处都不报错，只是画不对。
   `composeMapAsset` 的返回值里带着它自己用的那个 `shape`，回链与预填都照抄它，别另算一套。

#### AI 素材的接缝（真实素材打回来过一次）

第一版让模型直接画「4 列 × 4 行 = 16 种接法」。结果是**每一处交界都有硬缝**，根因不在提示词，在**结构**：

- 地图上一排墙用到的是**三块不同的图块**（掩码 2 只连右 / 10 左右都连 / 8 只连左），
  于是相邻两格的内容来自素材图里**不同的格子**；
- 模型画的 16 个格子是**各自独立**的（霓虹灯带、板缝、铆钉各自偏几十像素），
  实测拼接处边缘差 **201**，而同一块内部相邻列只差 **58** —— 三倍多的跳变，肉眼就是一条缝。

修法就是「几何交给代码、内容交给 AI」：

| 谁 | 做什么 |
|---|---|
| 模型 | 只画**一块**正方形、四边能接上自己的无缝砖（整格 1 块；拼块每个变体 1 块） |
| `corner16SheetFromTile` | 把这一块缩到一格，复制成 4×4；掩码没置位的那几边 `shadeSide` 压收口（`capThicknessFor` = 尺寸/8，32px → 4px）|
| `a2SheetFromTiles` | 每个变体缩到一格，按形状行铺成 N 列 × 5 行；每一格的四个小格按**它自己那一侧**的接法收口（形状 0 四边、形状 1 只压横边、形状 2 只压纵边、形状 3 再多一个凹角 `shadeCorner`、形状 4 什么都不加）|
| `tileSeamRatios` | 量这块砖**自己的环绕缝**（对边差 ÷ 块内相邻列差）：> 2.2 就写进 `notes`，让用户知道该重画 |

好处：凡是「连」的边都是**同一块砖的边缘**，接缝等于砖自身的环绕缝（理论最好的结果）；
「断」的边仍然有收口，所以墙头 / 拐角 / 草地边缘看得见。自检里那条守门断言就是这么写的：
一排墙（掩码 2 → 10 → 8）的拼接差必须**等于**砖自身的环绕缝（±0.5 以内）。
提示词里也写明：`notes` 报「砖接不上自己」时**不要自动重跑**（重跑要真花钱），交给用户决定。

⚠️ 「素材说明」窗口里教用户排 4×4 / 5 行的那套排布**仍然是对的** —— 那是**手工导入**的约定
（`importMapTileset` 按位置认掩码）；AI 这条路现在是宿主替他把格子拼好，用户导入的还是同一张图。

#### 哪种「用法」会动（也是真机踩出来的）

用户在「整格」上选了「视频模型 + 8 帧」，提示词里于是同时出现「帧数 8」和「整格没有帧这一维」，
agent 按静态做完 —— 图不动，而且**没有人告诉他**。根因是界面允许了一个**做不到**的组合。现在的规则：

| 用法 | 会动吗 | 机制 |
|---|---|---|
| `corner16` 整格 | **不会** | 4×4 全是接法；`maprender` 的整格分支按 `mask` 选块，`animRows` 那条路（同列各行 = 帧）对它没有意义 |
| `a2quad` 拼块 | 会 | `variants` = 帧数，`a2Ops` 给每格 4 条**等长** `cycle`（帧号全局统一），客户端循环 → **既自动连接又会动** |
| `plain` 普通 | 会 | `animRows` 的翻页图：同列各行 = 帧，`cycle` 由 `maprender` 现拼 |

落地四处（缺一处就会重新出现「静默不动」）：
1. 对话框：选整格 → `NumField` 的 `disabled` 灰掉帧数（并夹回 1）、视频模型按钮点不动、hint 写明「想要会动改用拼块」；
2. `buildAssetRequestPrompt`：整格一律把帧数 / 方式**归一到静态**（不再自相矛盾）；用户原本要动画时加一条
   ⚠️ 要求 agent「这次按静态做，**并在回答里说清**为什么、怎么换成会动的」；形态待判断（自动）而用户要动画时，
   直接要求「判断成整格就改用拼块」；
3. `composeMapAsset`：「整格 + 多张」的报错点明「整格没有动画，要会动请用拼块」；
4. 自检：`verify-map-client` 钉住对话框与提示词两侧，`verify-map-pipeline` 钉住报错文案。

#### 素材自己的播放速度（`MapTileset.fps`）

「设置 → 动画速度」是**全局**一条（慢 / 中 / 快）；`fps` 是**单个素材**自己的速度
（0.5~30 帧/秒，留空 = 跟全局那条走）。加它是因为一片水该慢、一排霓虹灯该快，一个速度套不住。
它**不是**「属性一次定死」那一类：纯表现层，不动几何也不动序号，所以 `saveMapTileset({fps})`
随时能改（`null` = 清掉回全局），内置素材仍不许改（与其它属性一致）。

链路必须**一路带到底**，少一环都只是「存了个数」（不报错）：

| 环节 | 做什么 |
|---|---|
| `wire.ts` | `importMapTileset` / `saveMapTileset` 的 schema 里都要有 `fps`（**schema 里没有的键会被静默丢掉**）|
| `mapgen.ts` | `parseAssetFps` 归一（越界 / 乱码**抛错**，不静默夹到边界）；`importMapTileset` 带它、`saveMapTileset` 能改能清、`mapView` 交给界面 |
| `maprender.ts` | 每条 op 带上**自己的**速度（`PlanOp.fps`），计划再给一个 `fpsMax` = 最快那条 |
| `client.ts` | 动画时钟按 `clockFps = max(全局, fpsMax)` 推（否则 8 帧/秒的素材会被 1 帧/秒的时钟拖住，表现是「设了速度没变快」）；每一格的帧号按 `floor(经过秒数 × op.fps)` 算 |

⚠️ 两个静默坑，都踩过：
① `index.ts` 的 `mapTilesetBrief` 少列一个字段 → 界面永远看不到速度（网关自检现在专门盯它，
这次真就是它漏的）；② 客户端的计划身份 `planKey` 要带**素材动画属性签名**
（`id:shape:animRows:variants:fps`），否则改完速度缓存里的 op 还带着旧 `fps`，表现是「改了没反应」。

#### 图片最终处理的清晰度（`MapTileset.clarity` + `scale`）

AI 给的图是 1024² / 2048²，一格只有 32px，要缩小 32~64 倍。第一版用**最近邻**：60 倍缩小等于每 60 个
像素只留 1 个 —— 细霓虹线、铆钉、板缝整片丢掉，还带锯齿。而且它**发生在 `composeMapAsset` 里**：
一旦缩到 32px，细节就不可逆地没了，之后再选什么算法都救不回来。

所以现在的分工是「**大图先留着，最后一次才缩**」：

| 阶段 | 谁 | 做什么 |
|---|---|---|
| 合成 | `composeMapAsset` | 按形态拼好，但**留 `cell × k`**（k = 源图每块 ÷ 格子，上限 `MAX_ASSET_SCALE = 4`），这一步用面积平均；结果多返回一个 `scale` |
| 回链 | `tools.intentFromCall` | `openUrl` 多带 `scale`（>1 才带）；`scale > 1` 时「新增素材」才显示「清晰度」，并写明「这张图每格 128px，会缩到 32px」 |
| 导入 | `importMapTileset({clarity, scale})` | 先按 `1/scale` 用 `resampleToSize` 缩到格子大小，**存的就是缩好的图** —— 调色板 / 渲染 / legend 一行都不用改 |

三种清晰度（`maptiles.AssetClarity`）：

| 值 | 算法 | 什么时候用 |
|---|---|---|
| `smooth`（默认） | 面积平均（alpha **预乘**再平均） | AI 画的写实 / 金属 / 渐变图：细节保留、边缘柔和、无锯齿 |
| `sharp` | 最近邻（与第一版逐像素一致） | 本来就是像素画、或者整数倍缩小的图 |
| `crisp` | 面积平均 + 3×3 反锐化（`SHARPEN_AMOUNT = 0.75`） | 细节特别密的图：轮廓更利落 |

⚠️ 两个坑：① `mapTilesetBrief` 少列 `clarity` → 界面看不到（与 `fps` 同一个坑）；
② 抠像素材必须**预乘 alpha 再平均**，不预乘的话透明像素的黑色会被平均进来，缩小之后一圈发黑。
`scale = 1`（自己导格子大小的图，绝大多数手动导入）**逐字节原样存**，一个像素都不动 —— 自检里有一条
专门断言字节相等。

#### 循环方式（`MapTileset.loop`）

`forward` 正放 / `reverse` 倒放 / `pingpong` 来回，默认正放，在「新增素材」里定（与播放速度并列）。

实现只有一个地方：**把帧序展开**（`maptiles.applyLoop`，`maprender` 在两处 cycle 构造里调用）——
正放 `0,1,2,3`；倒放 `3,2,1,0`；来回 `0,1,2,3,2,1`（`[...frames, ...frames.slice(1,-1).reverse()]`，
2 帧时就是正放，循环点不会多一跳）。客户端一行都不用改：帧号照旧
`cycle[floor(经过秒数 × 速度) % cycle.length]`，只是 `cycle` 更长（`frameCount` = 最长 cycle，跟着变）。

它和播放速度一样属于**表现层**：`saveMapTileset({loop})` 随时能改，下一次 `mapPlan` 就是新帧序，**不用重切素材**。
⚠️ `mapTilesetBrief` 少列 `loop` 界面就看不到 —— 与 `clarity` / `fps` 是同一个坑。

#### 整图（多格印花，`stamp`）

一张图**一次占 N×M 格**（雕像 / 壁画 / 地毯），可带序列帧，**4 个旋转烘在素材图里**，
导入时逐格标通行性并随导出给出。它解决的问题是「一整栋多格建筑」：普通素材一格一块，
拼块 / 整格都是「一块砖铺出去」，都不适合「一整个物件」。

**数据模型**

| 位置 | 字段 |
|---|---|
| `MapTileset.stamp` | `{cols, rows, frames, pass[]}`（`pass` 长度 = `cols*rows`） |
| `MapDoc.stamps[]` | `{id, tilesetId, layerId, r, c, rot}` —— **实例**，不进 `layer.data` |

整图**不写进 `layer.data`**：一格只装得下一个图块序号，而整图要记「参考点 + 旋转 + 哪张素材」。
所以它像标记点一样是**自己的源数据**，占哪些格由 `stampSpan` 现算（派生数据不落盘）。
图块也不受影响：整图**不覆盖**下面的地砖（雕像立在草地上，草地还在）。

**两段式：源图 → 成品素材图**（`composeMapAsset` → `importMapTileset`）

| 阶段 | 谁做 | 几何 |
|---|---|---|
| 整理（AI 那条路） | `composeMapAsset` | `cols × rows*frames` 格，**不含旋转**（`stampSourceCells`） |
| 导入 / 原地重烘 | `stampTilesetImage` | 缩到 `cols × rows*frames` 每格 = 地图格子 → **烘 4 个旋转** |

⚠️ **旋转只能烘一次**。真机翻车：`composeMapAsset` 烘过 4 个旋转（8×2 的图 → 1024×2560），
`importMapTileset` 又把它当「一帧、2 行」压成 256×64 —— 地图上就是一条条横条纹（用户截图）。
现在两份职责分开，`verify-map-pipeline` 用「逐格唯一色」钉死：合成后导入，rot0 的每一格必须等于源图对应格。

**绿幕 → 透明**（`maptiles.keyStampBackground`）

整图是「立在格子上的物件」，绿幕是模型加的假背景：留着会在地图上多出一块绿框，还把本该空着的
角落也涂满。所以 `composeMapAsset` 对整图**逐帧**跑 `chroma.keyGreen`（其它形态**不抠** —— 它们的
背景就是材质本身），但用的是**整图专用参数** `STAMP_KEY_OPTIONS`：

| 参数 | 角色抠像默认 | 整图 | 为什么 |
|---|---|---|---|
| `keyLow` / `keyHigh` | 14 / 80 | **80 / 150** | 只认饱和纯绿。草地的绿优势值只有 26~59，默认参数会把草坪当绿幕 |
| `bgTolerance` | 40 | **0**（关掉空间分割） | 分割会从四边灌进去，把墙内部的阴影一起吃掉（实测 82% 变透明、城墙被啃成碎片） |

另外 `backgroundFraction < 0.02`（几乎没抠到）或 `> 0.98`（整张都被判成背景、图会变空白）就
**原样返回**，并在 `notes` 里说「没检测到绿幕，按原图用了」。⚠️ 别加「清掉孤立小渣子」这类连通分量过滤：
城门的墙本来就被砖缝切成上万个分量，按「保留最大块的 1.5%」筛会把整面墙筛没（试过，图上只剩几条淡线）。
手动导图走 `importMapTileset({stampKey:true})`（对话框里默认勾着）；回包带 `keyed`，回链带 `keyed=1`
让「新增素材」取消再抠一次。

**烘焙布局**（`bakeStampSheet`）

素材图 = `帧 × 4 旋转`，逐块竖排：

```
宽 = max(cols, rows) 格            高 = frames × 2(cols+rows) 格
[frame0: rot0(rows×cols) rot1(cols×rows) rot2 rot3] [frame1: …] …
```

旋转是顺时针；`rot` 为奇数时长宽互换（4×3 → 3×4）。**为什么烘进图里**：地图的绘制契约是
「一格一次 `drawImage(rect → 目标格)`」，宿主的光栅化器（导出 PNG）走同一条 —— 旋转若发生在
绘制时，客户端与宿主两边都要各写一套旋转几何、还要改黄金对照。烘进图里只多占 3 倍图高，
调色板 / legend / 导出 / 客户端全都不用知道旋转这回事。

**取块序号（`maprender.stampTileIndex`）**：`base + local` —— `base` 是这块素材第 0 块的
**1 基**全局序号（`tilesetBaseIndex` 取 `flatTiles` 的 index），`local` 是块在素材里的 **0 基**下标。
⚠️ 写成 `base + local + 1` 的后果是**整张图左移一格 + 最右一列取到 rot1 的竖块**（不报任何警告，
只有肉眼或像素级对照能发现）。`verify-map-pipeline` 第 22 节是这条的守门人：它把 `mapPlan` 里
每条 op 的矩形拿到素材图上取像素，逐格和源图比，并断言 rot0 的格子必须落在 rot0 那一段
（`y < rows*cell`）、rot1 必须落在 rot1 那一段 —— 把 `+1` 塞回去，这四条会立刻红。

**op 与覆盖规则**

- `stampPlace{tilesetId, r, c, rot}`：占格**由宿主从素材上读**（客户端不许传 cols/rows ——
  传错了就是几何错位）；同层已有整图压在同一批格子上时被替换（后者在上）。
- `stampRemove{id}`。
- `paint|fill|rect|replace` 落笔前**整张摘掉**被碰到的整图 —— 哪怕图块值没变也要摘：
  橡皮擦一格时那一格本来就是 0，不先摘的话「对着雕像按橡皮什么都不发生」。
- 整图**不能**用 `paint` 刷（拿它的图块序号去刷会跳过并说明），也**不进**一键生成的随机池。

**占格上限 = 地图自己**

`parseStampSpec` 只挡 `< 1` 与 `> 512`（硬上限，防离谱值；1×1 允许 —— 等于一格一张图）；真正的规则是
`assertStampFitsProject(spec, doc.cols, doc.rows)` —— 一张整图**最多和整张地图一样大**，
比地图大就明确报错（`整图比地图还大：这张是 13×10 格，而地图只有 12×10 格…`）。
校验放在 `registerTileset` **写盘之前**（与其它属性的原则一致），`composeMapAsset` 入口也拦一次。
客户端的 宽/高 `max` 直接取 `view.cols / view.rows`（`stampLimits` 兜底 64）。

**素材属性窗口**（点素材列表里的一行打开）

| 能改 | 不能改 |
|---|---|
| 名字、播放速度、循环方式、**整图的逐格通行区域** | 形态、格子尺寸、会动吗（几何） |

理由：前四样都**不动图块、不动序号**，改完 `mapPlan` 立刻是新样子，地图上画过的格子不用重画
（整图的新通行区域下一次 `mapPlan` / 导出就生效，不用重新印）。后三样要重切图块、序号整体平移，
画过的格子会错位。**内置素材也能改前四样**（`saveMapTileset` 里 `builtin && touchesGeometry` 才拒绝）
—— 老约定是「内置一律不许改」，但用户要的正是「改名 / 调速度」这种轻量改动。

通行区域的编辑在「素材属性」里复用「新增素材」那块**在图上点格子**的控件（`stampPassGrid`）：
宿主 `saveMapTileset({stampPass})` 要求长度**正好** `cols*rows`（短了不会按 0 补齐 —— 那会把用户没点过的
格子静默改成不可通过），取值仍走 `parseStampSpec` 的 0/1/2 校验。⚠️ 属性窗口里贴的已经是**烘过 4 个旋转
的成品图**（宽度 = `max(cols,rows)` 格、高度 = `frames × 2(cols+rows)` 格），所以铺图比例必须按真实行宽算，
不能照抄「新增素材」里那张原始图的 `100% <frames*100>%`；否则 4×3 这类非方形整图的格子会与画面错位。

**「新增素材」的整图界面**（三条真机反馈落地）

| 反馈 | 做法 |
|---|---|
| 窗口太长、点不到「确定」 | 窗口 `max-height: calc(100vh - 96px)` + `overflow-y:auto`；标题与底部按钮 `position:sticky` |
| 区域要「在图上点格子」 | `.SPR_mapEdStamp`：选中的图铺满（`background-size:100% 100%`），CSS grid 的格子严丝合缝压在图上；三态用 0.10/0.16 的淡色 + 内描边（涂重了会盖住画） |
| 整图找不到播放速度 | `animRows || a2quad || (stamp && stampFrames > 1)` 三处判定一致 |

⚠️ 三个坑：① 预览框要 `box-sizing:border-box`，否则 `width:100%` + 1px 边框会撑出 2px 横向滚动条；
② 多帧素材图是「各帧竖排」，预览只铺第 1 帧（`background-size: 100% <frames*100>%`）；
③ 预览 URL 必须**同步**拿（`createObjectURL`）——`FileReader` 那条路会在 effect 里反复 setState，
自检 harness 直接卡在「等待稳定超时」。

**通行性三态**（`StampPass`）

| 值 | 含义 | 引擎怎么用 |
|---|---|---|
| `0` | 不可通过 | 挡路（墙脚、烛台、底座） |
| `1` | 可通过 · **被人物遮挡** | 能走，**角色画在它上面**（地毯、地面装饰） |
| `2` | 可通过 · **遮挡人物** | 能走，**它画在角色上面**（雕像上身，绕后） |

编辑器不画角色，所以它只做**颜色叠加**（设置里的「区域」开关 → `mapPlan({pass:true})`），
真正的用途在导出：`map.json`（`@4`）里每个 stamp 带 `cells:[{r,c,pass}]`，引擎不用做任何像素分析。

⚠️ **整图的多格笔刷只借给「画笔」工具**。`brushStamp`（当前笔刷的 `{cols,rows,frames}`）的 memo 把
`tool` 一起收进依赖：`tool !== "pen"` 时返回 `null`，于是悬停框 / 右键旋转 / 落笔全部回到 1×1。
真机反馈：「印过整图之后切到标记 / 橡皮，悬停框还是 3×2」。右键也只在画笔下才是「转整图」；
橡皮 / 油漆桶 / 吸管选了哪个工具，右键就做那个工具的事（橡皮右键就是擦一格）。

**删除与老的坏数据**：删素材要连带删掉引用它的整图（`dropStampsOfTileset` ——
`layer.data` 的序号重映射清不到它们）；`normalizeMapDoc` 对缺字段 / 越界 / 引用不存在素材的整图
一律丢掉（地图被改小过的情况）。

#### 整格的方向：竖段换向 + 转角斜接

整格（`corner16`）是**墙体**用法，所以 16 块不是「同一张砖 + 收口」，而是带方向的：

| 掩码 | 形状 | 怎么烘 |
|---|---|---|
| 5 | 南北直线 | **砖顺时针转 90°**（砖缝跟着墙竖起来） |
| 3 / 6 / 9 / 12 | 四个转角 | **`joinCorner`**：沿「两条相连边中点」的斜接线，把横向砖与竖向砖拼起来（角那一侧用竖向的），线上提亮一线 |
| 其它 | 直线东西 / 端头 / T / 十字 / 孤立 | 砖本身 + 断开那几边的收口 |

真机反馈的原话：「围墙竖过来的部分花纹就没拼了，拐角处也没有拐角的效果」—— 前者是竖段用了同一张（横向）砖，
后者是转角只是两段直墙交叉。**只画一条亮线救不了**，得让砖缝真的换向、两块砖在转角斜着对口。

⚠️ 这些都烘在**素材图**里，改规则后已有素材不会自动变；「删掉再导」会清空画在它上面的格子，
所以配了 `recomposeMapTileset`：按同一份源图原地重烘，保留素材 id 与图块数（`map.json` 一格不动）。

⚠️ 两处**必须**跟着：① 写盘之前先比尺寸（重烘出来的图比原素材大或小，说明这块素材不是「AI 整理」出来的 ——
例如手动导的 2×2 图集 —— 必须拒绝，否则图块序号整体错位）；② 素材视图带 `rev`（文件 mtime），
界面拼 `?v=rev`，否则重烘后浏览器继续用缓存里的旧图（而且 `rev` 是派生数据、不落盘，
`importMapTileset` 的回包也要现取）。

#### 「细节尺寸」写进提示词（32px 装不下细砖纹）

一张 2K 的细密砖墙缩到 **32px** 一格只剩一片红雾：实测同一条块的「相邻像素差」32px 是 **8.9**、64px 是 **14.6**，
64px 那版砖缝清清楚楚、32px 那版看不出是砖（用户的原话是「宫廷围墙感觉不太好」）。这不是接缝 bug
（环绕缝比值 1.0 / 1.68，本来就在阈值内），是**分辨率**问题。

所以 `buildAssetRequestPrompt` 现在按项目网格写两件事：① 「任何细节不能小于一格的 1/4」+「砖块这类重复单元
一格最多排 3 / 4 / 5 排」（按 32 / 48 / 64 算）；② 一格 ≤32px 时直接劝退：按大砖画，并在回答里告诉用户
「做成一格 64px 再生成，同样一幅画能留 4 倍细节」。自检钉住这两句，以及 64 格时**不出现**劝退那句。

#### 自动裁边（`maptiles.trimUniformBorder`）

模型会无视「四边不留白」，在自己的图外面再留一圈白框（实测那张赛博墙 2048² 里 79/81/77/78px 是白框）。
留着的话每块素材边上都带一道白边。裁在 **`composeMapAsset` 里、对每张源图单独裁** —— 不是裁合成图：
多帧竖排时中间几帧的白框裁不到。

四道保险（缺一条就可能把内容裁坏）：① 只裁**浅色**带（亮度 ≥ `LIGHT_BAND` = 170；深色平底是道具自己的背景）；
② 每边最多 `maxRatio` = 6%（更宽 = 背景，不是画布边）；③ 裁完至少留 `minKeep` = 60%；④ 四条边都得有浅色带，
且里面**真的有内容**（≥2% 像素与边框色明显不同）—— 所以一张纯色图 / 单色砖一个像素都不动。
裁了会写进 `notes`。

#### 一格多大（地图网格 16 / 32 / 48 / 64）

项目级、**新建时定死**（「新建项目」对话框里选，默认 32；设置卡只读显示）。32 一格时 2K 的 AI 图必然被压扁，
要真的清楚就得 48 / 64。连带三处：

1. `composeMapAsset` 默认 `cell` = 项目网格（AI 素材按 64 出块，`scale` ×4 → 每块 256px）；
2. **内置素材**是按 32 画的，`importSampleTileset` 按 `项目网格 / 32` 重采样（整数倍放大用最近邻，否则面积平均），
   不缩放的话图块只有半格（看起来像缩小了一圈）；
3. `importMapTileset` **不给 `cell` 时仍走自动识别**（手动导「8×8 个 32px 小格」是常见用法，拿网格当默认会把小格
   切成 4 倍大），但**素材格子 ≠ 地图网格时给一条明确告警**（说清「图块只会画在左上角、把格子填成网格就对了」）。
3. **`ai/` 要进资源白名单**。回链落点要 `fetch` 这张图；白名单漏一条的表现是「链接点开了、
   对话框也弹了，但图没选上」。真源是 `mapgen.SERVABLE_MAP_DIRS`（`index.ts` 的资源路由直接引用
   它，不再各写一份），改一处两边都变 —— 但它仍然是**子目录级**白名单，`AssetScope` /
   `resolveAssetTarget` / `SCOPES` 那三处 scope 级的地方不用动。

排查顺序建议：`openUrl` 里参数齐不齐 → `composeMapAsset` 的返回（`file`）→ 资源路由能不能 200 →
「新增素材」草稿（名字 / 格子 / 用法 / 会动吗）。前三步任一坏了，界面表现都只是「链接没反应」。

### 四条架构决策（每条都在消灭旧模块的一类 bug）

| # | 决策 | 它替代掉的旧做法（都真的坏过） |
|---|---|---|
| D1 | **客户端零几何决策**：宿主下发绘制计划，界面只 `drawImage` | 旧模块界面复刻了「变体哈希 + 裁剪偏移 + 装饰居中 + 建筑锚点」四套口径 → 「保存后房子上移一格」「点到的格子不是涂到的格子」 |
| D2 | **画布渲染**（单 canvas + 视口裁剪 + 32×32 chunk） | 旧模块每格一个绝对定位节点，14×14 就是 196 个格子 |
| D3 | **宿主是唯一写者**：界面只发 op，宿主回 `dropKeys`；撤销走宿主侧逆操作日志 | 旧模块界面自己改草稿整份提交 → 预览与出图两套代码、撤销跳步 |
| D4 | **派生数据不落盘**：形状判定 / 动画帧 / 视口范围 / chunk 全现算 | 旧模块的 `buildings` / `buildingGround` / `map.pixel` 三份缓存各出过一次 bug |

这一版把 D2 又往前推了一步：**连「哪些 chunk 可见」也由宿主算**。
`mapPlan({view, have})` 回 `visibleKeys`（视口覆盖到的 unwrapped key）+ 只含「差集」的 `chunks`，
所以界面里连 chunk 计算都没有 —— 它只做「按 key 存 Map、删 `dropKeys`、补 `visibleKeys`」。
（`AGENTS.md` 那条「客户端只能执行宿主下发的绘制计划」，现在字面上也包含了 chunk 可见性。）
可见 chunk 数超过 `MAX_PLAN_CHUNKS = 256` 时截断并回 `truncated: true`，
界面提示「缩得太小，放大一点」—— 静默丢一半画面比提示难查得多。

### 界面里唯一允许复刻的东西

`src/client.ts` 模块六段落里的四个 `MAP_*` 函数：`MAP_pointToCell` / `MAP_cellAnchor` /
`MAP_cellTopLeft` / `MAP_lineCells`（宿主对应在 `mapgeom.ts` / `mapdoc.ts`）。

判据是**与宿主真实现逐点相同**，不是「我推的公式对不对」：
`verify-map-client.mjs` 拿宿主的真函数对同一组输入逐点比对（环绕与非环绕两组 ×
整张地图采样 + 边界 + 图外点），再断言「画布 `drawImage` 调用序列 == 宿主 `buildPlan` 计划」
逐项相等（含 4 象限与动画帧）。
**这两个契约之外，界面里不许出现**变体挑选、形状 / 掩码归约、绘制顺序、chunk 计算、坐标变换
（脚本最后一段直接扫源码拦）。

### 环绕（wrap）是默认：凡是「邻居」都要先取模

AsLib 的地图四周相接，本版照做（`MapGrid.wrap` 默认 `true`，可关）。取模集中在
`mapgeom` 的 `wrapRow` / `wrapCol` / `wrapCell`：

| 地方 | 取模怎么体现 |
|---|---|
| 网格与命中 | `pointToCell` 在环绕下**永不返回图外坐标**（越界点折回图内，`inMap` 恒 `true`） |
| 绘制范围 | `viewCellRange` 允许起点为负 / 超过尺寸；同一格会在多个像素位置各出现一次，这是正常的 |
| 脏块 | `dirtyChunksFor` 把每个变更格的 8 邻域先 `wrapCell`，再落到**规范** chunk |
| 自动连接 | `NeighborAt` 的坐标可能越界，**取模由调用方做**（宿主里就是 `wrapCell` 之后查图层数据） |
| 导出 | **不环绕**：`buildPlan` 不传 `range` 时按 `0..cols` / `0..rows` 算，PNG 就是这张图本身 |

⚠️ 漏掉任何一处取模的表现都是「**接缝处形状不对**」或「**撤销后画面花掉**」，
而且只在贴边时看得出来、不报错。所以 `verify-map.mjs` 里有一条「画第 0 行必须连带
弄脏最后一行所在的 chunk」，并配了**非环绕的反向验证**（把 wrap 关掉，同一条断言必须
不再成立）—— 否则这条断言在「忘了取模」的实现上也可能碰巧为真。

一条例外写进界面帮助：**洪水填充（油漆桶）不跨接缝** —— 它在 `0..cols/rows` 的平面数组上做，
AsLib 同款。

### A2 自动连接的真实几何（最容易被后来者写错的一处）

识别条件（`maptiles.detectLayout`）：`imageHeight === 5 × 格子高` **且**
`imageWidth % 格子宽 === 0` 才算 A2 拼块，且先按常见尺寸从小到大试 ——
免得 64×160 的草地被当成普通网格。

一张 `64×160` 的图 = **2 个变体 × 5 个形状**：小格 16px，逻辑块（= 屏幕上一格）32px
= 2×2 个小格；块行号 0..4 = 形状号，块列号 = 变体号。

| 量 | 公式 |
|---|---|
| 小格行 | `smallRow = 2 * shape + (上 0 / 下 1)` |
| 小格列 | `smallCol = 2 * variant + (左 0 / 右 1)` |
| 1-based 序号 | `t = 1 + smallRow * smallCols + smallCol` |

`buildTiles` 把 `tiles` 按**小格行优先**展开，于是 **1-based 序号 − 1 == AsLib 的 chip 下标**
（AsLib 的 `NumX * 2 * shape + tm_id(+1)(+NumX)`）。这是硬契约：序号就是图层数据里存的值。

渲染时一格发 **4 条 op**（TL / TR / BL / BR），每条贴一个小格，取哪一块由
`a2QuadrantShapes` 现推的形状号决定：

| 象限 | 看哪三个邻居 |
|---|---|
| TL | `left` / `up` / `upLeft` |
| TR | `right` / `up` / `upRight` |
| BL | `left` / `down` / `downLeft` |
| BR | `right` / `down` / `downRight` |

形状表照 AsLib `map20n_Number`：`left` 与 `up` 都不通 → 0；只有 `up` → 1；只有 `left` → 2；
两个都通但没有对角 → 3；两个都通且对角也通 → 4。**`diag` 只在两条边都接上时才看** ——
写成「两边接上就点亮角」，形状 3 会永远选不到，5 种形状静默退化成 4 种。

⚠️ **图层数据里存的是「代表序号」**：A2 素材在调色板里**只出一个笔刷**
（`MapViewTileset.palette` 长度恒 1，当前的 `index` 取满格那一行、变体 0 的第一个小格 ——
只是为了缩略图好看；渲染时真正用的是该素材在 `flatTiles` 里的**第一个序号** `base`），
写进 `data` 的就只是这个代表值；渲染时 `maprender` 见到所属素材 `shape === "a2quad"` 才展开成
4 条象限 op，形状由四邻居现推、变体走 `cycle`。**少了那条展开分支**，用户拿着「自动连接」笔刷
刷下去只会画出一个 16px 小格 —— 图还在、不报错，只是地图看着像花屏。

顺带一条同样「不报错」的坑：判断「相邻格是不是同一类」时**只比图集 id**，不许比 `shape` ——
比形状的话，用户从调色板随便点一块（不同变体 / 形状）就会被判成断开，大片地面碎成小方块。

另一种形态是 `corner16`（一套 16 块的整格素材）：位序 `N=1, E=2, S=4, W=8`，
导入 / 手动切成这个形态时宿主**按位序一次性算好掩码**（不需要用户点「按顺序分配」）；
缺的掩码走 `nearestMask` 回退，绝不留空（见下面「静默坏」表）。

### `dropKeys`：连「哪块缓存失效」都由宿主算

界面缓存的是**未取模**的 chunk key（画布能拖到任何地方，同一格会以多个像素位置出现），
宿主算出来的是**规范** key（`0..nx-1`）。让界面去换算，就等于把几何又抄了一遍，所以协议改成：

```
applyMapOps({ projectId, ops, stroke?, have?: string[] })
  → { changed, skipped[], dirtyChunks[], dropKeys[], canUndo, canRedo }
```

界面每次编辑 / 撤销都把当前缓存键（`have`）报上来，宿主对每个键做一次 `canonicalChunk`
映射后判断是否命中「变更格的 8 邻域」集合，只把**真正失效的那几个键原样返回**。
界面只做「删掉这些键 → 按 `visibleKeys` 补缺失的」，一个坐标都不算。
环绕是这一步的隐藏坑：**画第 0 行会连带弄脏最后一行所在的 chunk**，所以脏块集合必须走
`dirtyChunksFor`（它自己 wrap）。

### 动画：`op.cycle` 内联 + 全局帧号

- 多帧地块的 op 上多一条 `cycle`（该格的图块序号按帧序排列），`t` 恒等于 `cycle[0]`；
  `RenderPlan` 带 `fps`（默认 1，AsLib 的 60 帧 ≈ 1 秒切一次）与 `frameCount`
  （所有 cycle 长度的最大值）。传输层不回 `cycles` 数组，所以 cycle 一律**内联在 op 上**。
- A2 的「变体」就是帧：四个象限各带一条**等长**的 cycle，**共用同一个全局帧号**，
  否则同一格的四个角会各动各的。
- 界面只维护一个全局帧号，逐 op 取 `cycle[帧号 % cycle.length]` 去 `legend` 查矩形 ——
  选哪些图进循环是宿主定的，界面只推时钟，仍然不算「客户端挑图」。
- **「翻页图」（`animRows`）的帧是行**：同一列的每一行是同一个逻辑块的不同帧，所以调色板
  **每列只出第 0 帧那一条**（`mapgen.paletteFor`）。每帧都列出来，用户看到的就是 N 个
  一模一样的笔刷 —— 内置道具图（8 列 × 5 帧）曾经就是这样：`animRows` 少写了一个 `true`，
  40 个小格全成了独立图块，调色板里 40 条有 32 条逐像素重复。
- 同理，「行 = 帧」的素材**每一行必须真的不同**：内置道具图用一像素摆动
  （`SAMPLE_PROP_SWAY`，木箱 / 栅栏这类硬物允许静止），`scripts/make-map-sample-tileset.mjs
  --check` 逐列量帧差，整张图的行只要完全相同就直接判失败。
- 系统开了「减少动态效果」或页面被切到后台时**停在帧 0**
  （`prefers-reduced-motion: reduce` / `document.hidden`）。

### 导出窗口：一次选完 → 一次导出 → 一次下载

用户对这一版的原始抱怨是三条，三条都改在界面上：**「导出 PNG 是选项卡，导出 JSON 怎么
就点击直接操作了？而且还不能选择导出位置。而且多个文件应该打 zip。」** 于是：

| 抱怨 | 之前 | 现在 |
|---|---|---|
| 选择与执行混在一起 | 「导出图片 PNG」（primary 样式，看着像被选中的页签）与「导出存档 JSON」两个按钮并排，点谁都立刻导一份 | 内容改成**三只复选框**（地图图片 PNG / 存档数据 JSON / 素材原图），执行只有**一个「导出」**按钮；没勾任何一项时它是禁用的 |
| 不知道文件去哪了 | 只有一颗「打开导出目录」，而且打开的是**项目根目录**（那里并没有他要的文件） | 卡片上写出导出目录的**本机绝对路径**；「打开导出目录」带上 `target:"export"`，宿主按与导出同一处口径算目录名（`mapRevealDir`），没导出过就退回项目目录 |
| 多个文件要一个个点 | 三个产物 = 三个链接 | 产物超过一个时宿主打一个 `<地图名>.zip`，界面主按钮是**下载这个 zip**；勾了「素材原图」连素材图一起进包（`map.json` 的 `tilesets[].image` 与包内路径同形 → 整包自包含） |

「选择导出位置」这条按 Web 的常规做法给：主下载按钮是浏览器下载（位置由它的下载设置决定），
另配一颗「**另存为…**」—— 有 File System Access（`showSaveFilePicker`）时弹原生保存框，
没有（Electron 壳 / 老浏览器 / 跨源 iframe）就不显示这颗按钮、改用一行说明。
⚠️ 顺序不能反：`showSaveFilePicker` **必须在用户手势里调用**，先 `await fetch` 下载大文件会把
手势耗掉，Chromium 直接抛 `Must be handling a user gesture`；正确的顺序是「先弹框拿句柄 → 再取字节 → 再写盘」。

zip 由 `src/zip.ts` 手写（store / deflate，`node:zlib` 够用，零依赖）。三条硬约束：
时间戳写死 1980-01-01（同一份文档两次导出逐字节一致）、条目路径一律正斜杠、
非 ASCII 名置 UTF-8 标志位。`verify-map-pipeline.mjs` 里有一个**真的解包**的读取器
（中央目录 → 本地头 → inflateRaw → 校验长度与 CRC），不是「文件存在且字节数不小」那种断言。

同一批还删掉了卡片里的「确定」按钮（用户：「确定键可以删了，和右上角的 x 没区别」）：
阶段标记在界面上不可见，那颗按钮对用户就只剩「关掉卡片」，与右上角的 × 重复。
现在关卡片只有 ×；阶段标记仍可由对话面 / 验收流程（`setMapApproved`）改，界面上唯一还暴露它的
是设置卡片里那颗**有状态**的「整个模块看过了」（`data-on` 会变色，一次打四个阶段）。

### 术语黑名单是硬约束

`src/client.ts` **全文**里 `地形族 / 掩码 / 优先级 / 切分 / chunk / 图集 / 变体种子 / 高度偏移 /
Tiled / 等距` 十个词 **0 命中，注释里也不许出现**（`verify-map.mjs` 按文本扫）。

为什么是硬约束：第一版收到的反馈就是「**门槛太高、专业名词太多**」——
用户要先学会「图集 / 切分 / 地形族 / 掩码 / 优先级 / 变体种子 / 高度偏移」，
才知道自己该点哪。当时的补救是「就地小字 + 悬停解释 + 空态四步引导」，
等于承认「先解释、再动手」这条路走不通。所以这一版不是把词解释清楚，而是**让这些词无处可用**：
调色板只列素材图、自动连接零配置、图层只有名字。名词一旦回到界面，这条路就白走了。

### 「静默坏」清单

| 现象 | 根因 | 现在的做法 |
|---|---|---|
| 接缝处形状不对 / 撤销后画面花掉 | 「命中 / 绘制范围 / 脏块 / 邻域」里有一处忘了取模 | 取模集中在 `mapgeom` 的 `wrap*`；`verify-map.mjs` 断言「画第 0 行连带弄脏最后一行」并配非环绕反向验证 |
| 拿自动连接笔刷刷下去只出一个 16px 小格 | 图层数据里存的是 A2 的**代表序号**，渲染时没按 `shape === "a2quad"` 展开成 4 条象限 op | `maprender` 从代表序号现推四象限形状再发 4 条 op；界面不许自己挑象限 |
| 改一次格尺寸，人工配好的掩码 / 改过的名字全没了 | `buildTiles` 继承旧元数据时用**白名单**拷贝，`MapTile` 以后加字段（锚点 / 通行 / 标签）就会在每次重切时被静默清空 | 整份继承旧 tile，只覆盖几何派生项（`id` / `rect` / `shape` / `variant` / `frame`）—— 几何项**必须**覆盖，否则块号与 rect 对不上、静默错位 |
| 32px 的道具被两两并成一块 | `plain` 兜底若取「能整除的最大尺寸」（例如 64），会静默改掉素材的语义：一块里装四个道具 | 试算顺序 `PLAIN_PREFERRED_SIZES`：先 ≤32 的降序（32 → 24 → 16 → 8），再 48 → 64；全都不行才退回 32，并把「哪部分会被裁掉」写进 `reason` |
| 网格地图上出现透明洞 | 缺掩码（`corner16` 没配满 16 张）时留空 | **必须回退**：取 Hamming 距离最近的已配掩码（并列取最小），次数记进 `warnings`；一块都没配时退图集第一块 |
| 擦一条线要按 4 次撤销 | 拖动时 op 每 ~40ms 批量提交一次，每次都压一条历史 | 一次按下 → 抬起共用一条 `stroke`，后续提交**并进上一条**（撤销粒度 = 一笔，不是一次 flush） |
| 图裂（403） | 资源白名单**四处**同步：`SERVABLE_MAP_DIRS`、`AssetScope` 类型、`resolveAssetTarget` 分支、`SCOPES` 数组；漏一处只是 403，界面只表现为图裂 | `verify-map-gateway.mjs` 真调一遍路由（含白名单外子目录与目录穿越） |
| 面板一直空态 / 画布不画 | 界面读的字段与宿主给的形状对不上 | `verify-map-client.mjs` 用**真宿主数据**渲染面板，并断言 `drawImage` 序列 |
| 并发提交都开工 | `mapBusy` 读的作业是在几个 `await` 之后才登记的，两次并发调用都能通过检查 | `mapgen` 里用**同步预定集合** `reserved` 占位（`verify-map-gateway.mjs` 断言只放行一个） |
| 预览 / 导出跑完界面一直显示「任务进行中…」 | 这两个方法只回 `{started:true}`，界面提交完重读一次、那次仍是进行中，**此后没人再刷新** | 界面在 `view.busy === true` 时每 1.5s 重读，`busy` 转 false 再收尾。真机实测：导出约 2s 后文件列表自己冒出来 |
| 导出完了、文件在盘上，卡片却一直写着「还没有导出过」 | 同一项目可能同时在读好几次（挂载 / 导出后 / `busy` 轮询 / 打勾回读），**回来的顺序不保证与发出的一致**，迟到的旧响应把新状态顶回去 | `loadProject` 带自增序号，只认**最后一次发起**的那次响应（`loadSeq`）；`verify-map-client.mjs` 用真的 busy 轮询把这条路径跑一遍（`setInterval` 以前是空实现，等于这条路径没测过） |
| 勾了「素材原图」却一张都没拷进去 | `writeFile` **不会建父目录**：往 `export/<名>/tilesets/x.png` 写时那层目录还不存在 → ENOENT，被 catch 成一句 warning | `mapexport` 的 `write` 先 `mkdir(dirname(file), { recursive: true })`；自检断言 zip 里真的有 `tilesets/<文件>` 且与项目里那张逐字节一致 |
| 文案里出现星号 `**强调**` | 界面**不渲染 markdown**，星号会原样显示 | 模块六文案统一用「」；`verify-map-client.mjs` 断言渲染出来的文本里不出现 `**` |
| 滚轮缩放地图时**整块面板跟着滚**，控制台还报 `Unable to preventDefault inside passive event listener` | React 的 `onWheel` 是**被动**注册的，在里面 `preventDefault()` 无效（浏览器只警告，滚动照旧）。自检全绿也看不出来 —— 只有真机滚一下才知道 | 照 `RigModule` 的既有写法，用 **ref 回调**挂原生 `addEventListener("wheel", …, { passive: false })`（别用 `useEffect(…, [])`：空态时画布还不存在，空依赖的 effect 不会在它出现时再跑一次），并用 ref 转发最新的 `zoomAt`。Playwright 实测：修前 2 条 console error，修后 0 条且面板不滚 |
| 用吸管吸自动连接素材后，调色板的「当前笔刷」红框**凭空消失** | 吸管吸到的是这一格实际贴的那块 —— 对 A2 素材是某个 **16px 小格**，而调色板里只有该素材的**一个代表条目**，两边序号对不上就一个格子都匹配不到（画出来的东西其实没错，错的是「看不出自己在用什么」） | `pickAt` 里把吸到的序号**归到拥有它的那个调色板条目**上（普通素材每格都有条目，等于原样）。Playwright 实测：土路→4679、水→4719，各归各的代表序号 |
| 升级后打开旧项目，地图是**空的**（用户会说「我画的东西不见了」） | 第一版模块六把地图存在 `maps/<mapId>.json`，新版只读项目根的 `map.json`；两份数据都不提就是静默丢 | 旧文件**不删**；`warningsFor` 检测到 `maps/` 目录就给一条常驻告警，说清「新版只读 map.json、旧数据还在 maps/」。**不读两份数据**（那等于养一套迁移口径） |
| 工具按钮的说明「等一秒才出来」，或者和自绘小标签**叠成两个框** / 标签被裁掉半截 | 原生 `title` 样式不可控、延迟约 1 秒，去掉它又怕键盘用户没有说明；自绘标签若用 `absolute`，祖先里的 `overflow` 容器会把「按钮正上方」那一段裁掉（与侧栏菜单同一个坑） | `aria-label` 承担无障碍名字（`名称：介绍（快捷键）`），视觉说明走自绘 `.SPR_mapEdTip`：**`position:fixed`** + 坐标在悬浮 / 聚焦时用 `getBoundingClientRect()` 现算并夹在视口内；滚动或改窗口大小时**重新锚回按钮**而不是收起来（收起来的话鼠标还停在按钮上、`mouseenter` 不会再触发，用户得移开再挪回来才看得到说明）。`verify-map-client.mjs` 断言「不挂 title / 悬浮与聚焦都弹 / 落在按钮正上方 / fixed / 贴边被夹住」 |
| 新手看不懂说明标签（用户原话：「不够详细直白，小白看不懂」） | 原来的说明是**给自己人写的**：油漆桶写「同色的连通区一次填满」（连通区是行话）、调色板每块只挂原生 `title: "第 33 块"`（他看到的是一格草地，不是第 33 块）。这类文案不会报错、自检也测不出来，只有真人用才发现 | 每条说明统一按「**这是什么 → 什么时候用它 → 点下去会发生什么**」写，并**去掉行话**（连通区 → 连成一片；涂抹 → 按住鼠标左键在格子上拖）；看不见的属性要在**点之前**就讲明（自动连接的图「涂上去边缘会自己接上」、会动的图「这张图会动」）；调色板每块也改挂同一张自绘小标签（名称 = 素材名，说明 = 点了怎么用），原生 `title` 一并去掉。⚠️ 写的时候**核对了行为**：Shift 多选那几块只影响「一键生成」（手绘永远只用单项 `brush`），所以说明里挂到一键生成上，而不是写成「多选几块一起涂」。`verify-map-client.mjs` 钉住「调色板无 title / aria-label 是「名称：说明」/ 自动连接的素材必须写明会自己接上 / 多选说明指向一键生成」 |
| 「新增素材」对话框里悬停「用法 / 会动吗」弹出的说明**整片跑到窗口后面**去 | 标签节点挂在面板根节点下，是对话框遮罩（`.SPR_mapEdDlgMask`，`z-index:70`）的**兄弟**而不是子节点 —— 全屏蒙层一动就把 `z-index:60` 的它整片盖住。自检全绿：jsdom 不算绘制顺序 | `.SPR_mapEdTip` 提到 `z-index:90`（同时高于看图遮罩 `SPR_zoomMask` 的 80）；`verify-map-client.mjs` 直接比 CSS 里的数值并配反向验证（60 > 70 为假、没写 z-index 的选择器取不到数）。真机验收（Playwright 对正在跑的 GUI）：把标签的 z-index 临时改回 60，`elementsFromPoint` 在标签中心命中的是对话框输入框、栈顶是遮罩；90 时命中的是标签自己 |
| **点「新建项目」什么都不发生**（Electron 桌面端） | `window.prompt` 在 Electron 里存在但一调用就抛错，`typeof` 判断看不出来；抛出去变成未处理拒绝，界面没有任何反馈 | 模块六改自带对话框 `.SPR_mapEdDlg`（`position:fixed` 居中 + 输入框自动聚焦 + 回车确认 / Esc 取消 / 点遮罩取消）；`askNewName` 也包了 try/catch 兜底。真机验收：`nativePromptUsed === false`，确认后项目建出来并切过去 |
| 悬停红框不在鼠标底下，往左 / 往右偏**一整张地图** | 环绕模式下同一格在屏幕上有多份（地图比画布小时最常见：新建 32×32 缩到一屏能看见一份半）。红框按**取模后**的 `r/c` 画，就画到了「地图内的那一份」上 —— 实测在画布 5%/20% 处偏 +351px、80%/95% 处偏 −366px，中间一段看着却是对的（所以很容易以为没问题） | 命中测试把**未取模**的地图坐标一起带出来（`{r, c, x, y}`），红框用 `floor(hover.x / stepX)` 定位到指针所在的那一份；绘制/命中/数据三处口径都不变。`verify-map-client.mjs` 把相机拖到地图外，断言「指针的地图坐标落在红框矩形内」并配一条反向验证（取模位置离指针 > 200px）。⚠️ 那个用例的夹具必须是**缩放过**的视口（画布比地图宽），否则一份地图铺满画布，这个 bug 根本不会出现 |
| **按住画圈时莫名其妙画上整行**（横向扫一笔 → 整行 32 格全亮） | `paintCells` 的补间用的是**取模后**的格号。指针跨过地图接缝时（右边界那一份的 c=31 → 下一份的 c=0，屏幕上只差十几像素）会被算成「从第 31 列走到第 0 列」，Bresenham 一路走过去就把整行填满 —— 画圈手势很容易反复跨接缝，所以是「有时」 | 命中测试把**未取模**格号一起带出来（`rawR` / `rawC`），补间按未取模格号走、发出去的格允许越界（宿主 `applyOps` / `dirtyChunksFor` 自己会取模）。变化检测仍用取模后的格号 —— 同一逻辑格在另一份副本上不该重复写。`verify-map-client.mjs` 断言「跨接缝一笔只提交相邻两格（规范后正好是接缝两侧）」+ 反向验证「按取模格号补间会得到整行」，并配一条「同一格内挪 12 次不产生新的绘制帧」 |
| **素材属性改不了 / 内置素材被改坏**（用户新规则：属性在新增时定死，只能删） | 界面看似「少了个改格子的地方」，其实要三处一起：列表里不留入口、对话框在**新增时**一次带全属性、宿主对内置素材直接拒绝 `saveMapTileset` | `importMapTileset(pid, name, base64, {cell?, shape?, animRows?})`：先量真实尺寸再套用户填的值（留空走自动识别）；校验放在**写文件之前**（`normalizeCell` 是抛错的，先写后抛会留下孤儿图）。`builtin` 由 `importSampleTileset` 打标，`saveMapTileset` 见到就抛「内置素材的属性不能改」。客户端在新建项目后调一次 `importSampleTileset`（同名跳过）= 内置素材默认在列表里；「恢复默认素材」复用同一个方法 |
| **一笔画下来发几十次请求 / 顶栏保存状态一直闪** | 拖动期间按 40ms 分批提交，一笔能发几十次；那行「正在保存… / 已自动保存」跟着闪 | `queueOps` **不再排定时器**，只攒着等这一笔结束（`pointerup` / 离开 / 取消）提交一次；一步完成的编辑走 `immediate`。整块删掉保存状态文字（连带 `savedAt` / `saving` / `MAP_clock`） |
| **拖动期间格子不显示**（改成「一笔一次提交」之后，用户立刻发现：得看得见） | 客户端不许自己算形状、也不做乐观绘制，所以光靠「攒着不提交」＝「拖了半天什么都没有」 | `mapPlan` 加 `pending`：宿主把没提交的 op 盖到 `cloneDoc` 上算计划（走**同一个 `applyOps`**），**不 pushHistory、不写盘** —— 「看得见但不落盘」。客户端每 ~80ms 带一次 `pending`；取回的块记进 `previewKeys`，**提交时标成待重拉**（那些内容是按当时那部分 op 算的），预览响应若发现这一笔已经结束就直接丢掉。自检钉三条：拖动期间确实有 `pending` 查询、预览真的把笔画进了计划、`applyMapOps` 只在松手时发一次。客户端每 ~80ms 带一次 `pending`；取回的块记进 `previewKeys`，**提交时标成待重拉**（那些内容是按当时那部分 op 算的），预览响应若发现这一笔已经结束就直接丢掉 |
| **预览改了「已经缓存过的块」→ 拖动期间一片空白**（我第一版就这样，用户当场发现） | 预览查询带着 `have`，宿主认为「你有这一块」就不回传 —— 提交后靠 `dropKeys` 重拉才出现，看着就是「只有松手才上色」 | 客户端：**预览查询一律不带 `have`**（要一整份可视块；客户端不许自己算脏块）。宿主：`mapPlan` 按 `pending` 的脏块 `forced` 强制回传，作为第二道保险。⚠️ 自检那条断言原来写得太松（`chunks 有 op` **或** `visibleKeys 非空`）把它放过去了，现在按「回传块里**那一格**的内容真的变了」判，并另有一条「带上 have 也要强制回传」 |
| **相机能拖进空白、拖到右下角还会「复位」且左上角对不齐**（用户：「靠拖动很难拖到左上角」） | 相机没夹持时 `pan` 可以任意负：视口越过地图边界后宿主只能回**折回来的那一份**，画面在「一份地图」的边界上整体跳一格，看起来就是复位；而 `pan = 0` 这个位置既没有参照物也不在吸附点上 | `clampPan`：`pan`（画布左上角落在地图的哪个像素）取值范围 `0 .. max(0, 地图 - 视口)`。⚠️ **符号别想反**（我第一版写成负区间）：那样小图能拖进空白、大图反而一步不动。地图比视口小 → 钉在左上角，`pan = 0` 就是「地图左上角 = 画布左上角」。真机实测：往右下拖停在 (0,0) 不再乱跑；放大成大图后往左上拖能滚到 `地图-视口` 就停 |
| **画超过右边缘时左边缘被着色、超过下边缘时上边缘被着色** | `pointToCell` 在环绕下把越界点折回图内（`inMap` 恒 true），于是图外那片空白上的落笔被折到了对边 | `cellFromEvent` 只认**地图自己那一份**：未取模格号越界就不算命中 —— 图外不落笔也不悬停（红框同样不画）。真机实测：贴右边缘往右拖只新增第 40~47 列、贴下边缘往下拖只新增第 31 行，**没有折回第 0 列 / 第 0 行**。`verify-map-client.mjs` 有「地图外不落笔」三条断言 |
| **拖笔刷时画布一直闪**（真机：266 个采样里 77 个是空屏，约 29% 的时间整块画布是空的）；CPU 也一直满 | 两个原因叠加：①一块覆盖很大一片（当时的块边长 32 下，32×32 的新建项目**整张地图就是一块**），所以画一格就合法地让整块失效；客户端当时是**直接把它从缓存里删掉**，从「删掉」到「增量计划回来」（≥32ms 防抖 + 往返）之间这一块没有内容 → 每 40ms 闪一次全屏。②`hover` 每个 `pointermove` 都换新对象，而它是绘制回调的依赖 → 鼠标每动一次就「清屏 + 重画所有条目」，同格内挪 30 次就是 30 次全幅重画 | ①**旧内容留到新内容回来**：`dropKeys` 只把 key 记进 `staleRef`，**不删缓存**（画面不用重画），`have` 里剔掉待重拉的 key，`applyQuery` 收到后从集合里移除。②`setHover` 用函数式更新，**格号没变就返回同一个对象**让 React 跳过渲染（红框按格对齐，格号没变画面就没变）。真机实测：空屏帧 77 → **0**，同格内 30 次移动的全幅重画 30 → **0**，绘制间隔中位数 16.3ms（≈60fps）、无 >100ms 卡顿。`verify-map-client.mjs` 按帧断言「拖动期间一帧都不能是空的」+「重拉回来后改动过的格子画的是新贴图」 |
| 拖动时每 40ms 重发的量太大（宿主侧 ~4ms/批、**282KB/批**） | 块边长取 32 时，一块能覆盖整张 32×32 地图：改一格要重发 4096 条 op。它是**性能旋钮**，不是协议格式（两侧共用同一个常量） | `MAP_CHUNK_SIZE` 32 → **8**：同一场景每批重发 **4096 ops / 282KB → 299 ops / 37KB（约 1/14）**，可见块 4 → 25 个。⚠️ 宿主侧**墙钟时间没变**（~4ms/批，主导项是读 `map.json` 而不是序列化 op）—— 省下来的是**过线 + 浏览器侧的 JSON 解析与对象重建**。改这个常量时把断言里的块键按几何推（`verify-map` / `-pipeline` 里已经改成用 `MAP_CHUNK_SIZE` 推，不再写死数字） |
| **新建地图后素材列表里一堆一模一样的块**（用户：「创建新地图为什么会有很多重复的块？」） | 两处叠加：①`renderPropSheet` 按**列**取道具名、无视行号，8×5 的「帧表」5 行画得逐像素相同；②生成器把它声明成 `animRows: false` 的普通网格，于是 40 个小格全成了各自独立的图块，`paletteFor` 照单全收 —— 调色板里 4 张 A2 + 40 条道具，其中 32 条重复（8 列 × 5 行 = 8 个笔刷才合理）。⚠️ 自检当时**钉的就是这个错值**（`prop.palette.length === 40`），所以一路全绿 | 道具图改成**真帧**：`drawProp(bitmap, name, frame)` 按相位摆动（树 / 花 / 蘑菇 / 断枝，硬物允许静止）、`animRows: true`，`paletteFor` 对翻页图**每列只出第 0 帧**（帧由宿主按全局帧号现推）。`make-map-sample-tileset --check` 逐列量帧差、`verify-map-pipeline` 断言「内置道具 8 条 + 自建翻页图 4 条」，`verify-map-client` 把那条错误期望改回 8 条 |

### 内置素材与版权

AsLib 自带的 `Picture/MapChip/*_pipo.png` 是**第三方版权素材，不打包**
（它自己的 README 写明 "Third party content is copyrighted by its respective owners"）。
内置素材改由 `src/mapsamplegen.ts` **程序化生成**：不需要下载、不需要 API Key、不花钱。

- 4 张 A2 图（草地 / 土路 / 水 / 石墙，`64×160` = 2 变体 × 5 形状 × 32px）；
- 1 张道具网格图（树 / 花 / 石头 / 木箱 / 栅栏 / 蘑菇 / 断枝 / 石头堆，`256×160` = 8 列 × 5 帧 × 32px）；
- **变体与行都是帧**：A2 的两帧逐像素不同（水最明显）；道具图声明 `animRows: true`，
  每一行是一帧（树 / 花 / 蘑菇 / 断枝按 `SAMPLE_PROP_SWAY` 摆动，硬物静止）——
  所以调色板按列收一条，不会摊出一堆重复笔刷；
- ⚠️ 道具图 `256×160` 恰好也命中 A2 的尺寸判据（高 = 5×32），自动识别会把它认成
  「8 变体 × 5 形状」：内置素材因此走 `known` 通道登记（形态与格子在生成时就已知），
  **不经过自动识别** —— 免得自己产的一套图被 `detectLayout` 猜成别的形态。

确定性是硬要求：不许 `Math.random()` / `Date.now()`，同输入两次生成的 PNG **逐字节一致**
（`scripts/make-map-sample-tileset.mjs --check` 会断言这一点）。
`--ark` 可以改用火山引擎 Seedream 生成纹理覆盖表（之后仍走同一条本地合成管线），
这一步**真实计费、必须显式带 `--yes`**。

### 「素材说明」窗口：示例图为什么内联进浏览器束

「新增素材」里填的四项（素材图 / 名字 / 格子大小 / 用法）里，**只有「用法」这件事光看控件说不清**：
用户手上的图该排成几列几行、第几块是哪一种接法，说错了他排出来的图在界面上不会报任何错，
只会「画上去不对」。所以对话框标题行多了一颗「素材说明」按钮，点开是三页图文。

- **图全部是本机现算的**（`src/mapsamplegen.ts` 的 `renderGuideSheets()`）：普通图块那张是
  4 列 × 2 行的八个道具，整格那张是 4×4 的墙（行优先第 i 块 = 方向位序 i），拼块那张**直接取内置草地**
  —— 说明与用户点「恢复默认素材」真能拿到的东西同源，不会「说明里好看、拿到手不一样」。
- **图以内联 data URI 的形式跟浏览器束走**：浏览器半区必须是经典脚本（不能 import），宿主也没有
  「随便给个静态文件」的路由（`/plugins/<包>/<文件>` 一律 404，束走带 `rev` 的模块图 URL）。
  三张图合计约 3 KB，base64 之后约 4 KB —— 比为它开一条宿主路由（改 wire / 网关 / 重启 DSH）便宜得多。
  生成器是 `scripts/make-map-guide-art.mjs`，它整块改写 `src/client.ts` 里的 `MAP_GUIDE_ART` 标记块；
  `--check` 断言确定性、标记块是最新的、已经构建进 `lib/client.js`。
- **网格线的位置由生成器给的数字现算**（`100 / cols`、`100 / rows`、再按 `sub` 细分），
  不写死在 CSS 里：图从 4×2 改成别的排法，网格跟着走，不会出现「图变了、网格还在老位置」。
- **方向位序是契约，靠自检把 PNG 解回来量**：说明窗口照它教用户排图，所以 `--check` 会把整格那张图
  解码后逐块量四条边中点（上=1 / 右=2 / 下=4 / 左=8，行优先第 i 块就是加起来等于 i 的那种接法）。
  纯字节比对看不出来这种错 —— 画反了照样是「合法 PNG」。
- **网格循环隐现**由两条 CSS 动画承担（`.SPR_mapEdGuideGrid` / `.SPR_mapEdGuideSubGrid` 错开半拍，
  `@keyframes SPR_mapEdGuidePulse` 0 → 1 → 0，`prefers-reduced-motion` 下常显）。
  jsdom 不算动画，所以 `verify-map-client.mjs` 在 CSS 数值上钉住 `infinite` 与那半拍错开，并配反向验证；
  真机验收则是在**正在跑的 GUI** 里连采几次 `getComputedStyle(grid).opacity`，确认它真的在 0 / 1 之间循环。

### 画布的调试钩子

`window.__mapDebug = true` 时，每帧把「这一帧为什么画/没画出东西」写进
`window.__mapDrawStats`（`keys` / `cached` / `drawn` / `noLegend` / `noImage`）。
默认关闭、零开销；自检与真机验收都靠它区分「没拉到计划 / 缺图源 / 坐标飞了」。

### 真机验证

引擎里的自检（`verify-map*.mjs` + `e2e-map.mjs`，项数见脚本输出）全绿**不代表**界面对。
模块六额外要求：**canvas 截图与导出 PNG 逐像素比对** —— `scale=1`、无缩放无平移时，
浏览器画布与宿主的 `rasterize` 必须逐像素一致（差一个像素就是坐标口径分叉）。
人眼验收直接看 `scripts/e2e-map.mjs` 打印的产物路径：它**故意把产物留在**
`<DSH_HOME>/game-material-master/map-jobs/` 下，不联网、不花钱。

---

## 模块四：骨骼动画生成

把一张角色整图变成**可用的 Spine 骨骼动画**：拆件 → 装配定位 → 推骨骼与动画 → 打包图集。
整条流程参考并移植了 [spine-animation-ai](https://github.com/GenielabsOpenSource/spine-animation-ai)
（Genielabs 的 Claude skill），但做了两件它没有的事：

1. **每一步都可视化、可单独重跑**。参考项目是一条 Python 脚本跑到底，任何一步出问题都
   只能从头再来；这里四个阶段各有自己的状态、验收打标与重跑入口。
2. **不依赖 OpenCV / Python**。定位改用「多尺度掩码模板匹配 + 金字塔由粗到细搜索」，
   分割用纯 JS 连通域，全部跑在插件进程里。

| 阶段 | 做什么 | 花钱吗 | 重跑粒度 |
|---|---|---|---|
| ① 拆件 | 生图模型把角色拆成 16 个部件（4×4 网格），再自动分割成逐件透明 PNG | **一次 Seedream 生图**（约 0.2 元） | 整张重生成 / 用现有图重新分割（免费）/ 逐件上传替换 |
| ①.5 质检 | 自动查「同一部位被画了多遍」「装配相似度整体偏低」「部件数明显多出来」，并给出建议 | 免费（本地算） | 随时重跑 |
| ② 装配定位 | 把部件摆回参考姿态，出「参考图 \| 合成图」对比图 | 免费（本地算） | 整体、或只重跑指定部件 |
| ③ 骨骼与动画 | 按部件语义推骨骼层级 + 六个动画预设，出 `skeleton.json`（Spine 4.2）与 `skeleton_ske.json`（DragonBones 5.5），并给可播放预览 | 免费 | 整体、或逐台动画编辑关键帧 |
| ④ 图集 | 打包纹理图集，同时出 `.atlas`（Spine）与 `_tex.json`（DragonBones） | 免费 | 整体 |

- **每一格画什么由格子的名字决定**，提示词里逐格写成 `hip = hip / pelvis (…)` 这样的
  「名字 = 部位描述」。网格位置决定部件名，而骨架是拿「名字 → 语义」推的——
  实测标着 `hip` 的格子画出裙子、标着 `neck` 的格子画出大腿，**骨架从第一根骨头起就是错的**。
- **每个部位只画一次**。模型会为了填满网格把同一部位画进多个格子（实测 4 段大腿、
  4 只鞋、3 条袖子），多出来的会被硬塞进不相干的骨骼位。
- **左右成对的部件是镜像，不是复制**（实测两条「左右袖」同向重合 0.901）。
- **是「切图」不是「重画」**：格子名只决定切哪块，外观一律照参考图。
  写成「按解剖结构补全被遮住的部位」时，模型把 `hip` 画成了**短裤**（参考图里是裙子），
  外观与参考图不符、模板匹配全废；改成「照参考图切」之后 `hip` 恢复成裙子 + 围裙 + 鲸鱼尾。

> **拆件质量 ≠ 自动装配质量。** 即使拆件完全正确（16 块、命名对、左右镜像、画风一致），
> 模板匹配对**服装裁片**仍然失手——裁片只覆盖参考图里的一小块，而匹配要求整块相似。
> 拆件图里匹配得好的全是「封闭、独特、无遮挡」的件（领子 0.66、上衣 0.67、袖子 0.63~0.72、
> 鞋 0.60），头和腿这些「与身体连成一片」的件只有 0.10~0.28。所以下面那句
> 「自动摆位只是起点」是字面意思，不是客套。

### 拆件质检：拆件"看起来成功了"其实不可用

这是**被真实数据逼出来**的一步。用一张真实立绘跑完 ①，界面显示「部件（18）——逐件验收」一切正常，
装配却把「头」摆到了「大腿」下面。逐块看图之后发现三件事同时成立：

1. **同一个部位被画进了多个网格格子**：4 段「大腿→膝盖」、4 只「鞋袜脚」、3 条「整袖」，
   实际只有 12 块是真实部位。
2. **网格位置决定部件名，模型却按自己的理解画**：第 2 格叫「胯部」画的是裙子、
   第 9 格叫「脖子」画的是大腿。骨架是拿「名字 → 语义」推的，**名字错了骨架从第一根骨头起就是错的**。
3. **部件是重新绘制的**，与参考图像素不像，模板匹配只能挑一个「不那么错」的位置——
   相似度 0.08~0.50，而界面照样显示「已定位 17/18」。

三种都不是报错，而是"看起来成功了"。所以自动质检把它们变成明确结论：

| 检查 | 怎么做 | 判定 |
|---|---|---|
| 重复件 | 裁到内容包围盒 → 归一化 64×64 alpha 轮廓 → 两两 IoU | 同向 IoU ≥ 0.86 并组报错 |
| **左右件 vs 重复件** | 把 B 水平翻转后再比一次 | 镜像明显高于同向 = 左右各一，**不算重复** |
| 对称形状 | 同向与镜像都很高 | 分不出，降级为提示让人确认 |
| 装配质量 | 平均/最低相似度、低于 0.5 / 0.3 的个数 | 均值 < 0.5 报错 + 给出「先给先验再重跑」的命令 |
| 部件数超标 | 与「参考图目测约几个部位」比 | 超出报错（这项只能靠视觉，所以留成手填，给不出就不判断） |

实测判别力（真实部件量出来的）：同向重画的配对同向 0.90~0.98 / 镜像只有 0.15~0.75；
真·左右件正好相反（同向 0.66~0.76 / 镜像 0.93~0.96）。**镜像判别是关键**——
少了它会把「左右两条手臂」误报成重复，用户照做就缺一只手。

> 顺带修掉一个数据一致性问题：手工摆过位置的部件仍带着**旧的匹配分数**，
> 质检会拿这个陈旧数字当「这次装配准不准」的证据（手工摆对之后仍报「相似度 0.326，不可信」）。
> 现在摆位时会清掉 `score`/`coverage`，质检也跳过 `manual` 的项。

### 语义层：角色 / 父级 / 锚点

拆件之后、装配之前，每个部件会拿到一份**显式语义**：

| 字段 | 作用 | 默认从哪来 |
|---|---|---|
| `role` | 语义角色（头/脖子/躯干/胯/上臂/小臂/手/大腿/小腿/脚/头发/衣料/配饰/武器） | 按部件名关键词推断（支持中文名） |
| `parent` | 父部件名，决定骨骼挂在谁身上 | 由「角色 → 父角色」链推导 |
| `proximal` / `distal` | 近端 / 远端锚点（归一化到部件包围盒） | 角色默认值（四肢取上端为近端） |
| `tags` | 自由标签，供按组批量操作 | 角色名 + 左右侧 |

**为什么要有它**：以前骨架层级完全由「部件叫什么名字」隐式决定（按名字查固定表）。
这让名字承担了它承担不起的责任——模型没按网格摆、或角色不是标准人形时，用户只能
靠改名间接影响骨架，而改名又会连带动画。现在语义是数据：界面上改一次角色/父级/锚点，
骨架立刻跟着变。

两条设计约束：

1. **不填表也能跑**。所有字段都有推断兜底，所以历史任务与「直接上传部件 PNG」都不需要
   先填一张表；AI 或人之后只改**不对的那几条**。
2. **改语义不动装配**。语义只影响骨骼推导，所以改它会作废③骨骼与④图集，但**不会**
   作废②里已经摆好的位置——否则用户每试一次角色就要重摆一遍。

校验会给 error 与 warning 两级诊断（重名 / 未知角色 / 父级不存在 / 成环 / 锚点退化 /
**头的祖先链经过肢体** / 左右镜像缺失），并且**永远返回可用的语义表**，
让界面能显示「哪一条、为什么不对」，而不是一个保存失败的红点。

`parent: null` 是明确选择「挂 root」的持久化标记，经过保存、JSON 往返与骨骼重建都保留。
缺省 `parent` 才允许按名字/角色推断；不能用 `?? undefined` 把这两个意图混为一谈。
导出的普通部件骨骼总有父级（直接挂根时写 `parent: "root"`），只有系统根骨没有父级。
语义保存的业务结果 `ok: false` 不会抛异常；客户端必须读取这个字段并展示具体校验错误，
不能把 RPC 正常返回当成语义已保存。

### 骨骼的手工偏移：三通道

骨骼的局部姿势被拆成两层（照搬 DragonBones `Bone.offsetMode = Additive` 的思路）：

```
local = origin ⊕ offset        （⊕ 对位移/旋转是加法）
```

- **`origin`** 由②的装配位置 + 语义层的锚点**算出来**，每次重跑都会被重算；
- **`offset`** 是**人**给出的偏置，**任何自动重跑都不碰它**。

所以「重新推骨骼」不会丢掉你调过的偏置，而「清除偏移」就是回到几何推出来的姿势。
这一条是本模块最关键的承诺，`scripts/verify-rig-module.mjs` 与 Playwright 端到端
各有一条断言盯着（重跑后 `0° → 8°` 仍在）。

实现上有一处必须注意：子骨骼的局部坐标要相对父骨骼的**绑定姿势**（不含 offset）去算，
这样父骨骼一旦带上 offset，子骨骼会跟着一起动（转躯干时头/手臂跟着转）；
若把 offset 并进父骨骼的世界变换，子骨骼会被抵消、不跟随。

目前只支持**平移与旋转**：Spine 的 bone setup 可以带 scale，但预览播放器的骨骼世界
变换还没传播缩放，加上去会变成「导出有效、预览看不到」的假象。

### 贴图变体：换色 / 替换 / AI 重绘 / 一键回退

真实立绘上总有几块画得不好。v1 只能「重新生成整张拆件图」——代价高，还会把别的部件
一起换掉。现在每个部件有一条**版本链**：

```
parts/left-hand.png        ← v1（拆件出来的原版）
parts/left-hand.v2.png     ← 换色 / 手工上传
parts/left-hand.v3.png     ← AI 重绘
```

- **每一次操作都新增一版，永不覆盖原图**。「这张 AI 头发不行，换回原版」＝ 点一下 `v1`。
- `activeTexture` 是当前生效的版本；`part.file` / `width` / `height` 始终是它的**镜像**，
  所以装配、骨骼、图集、预览都不需要知道版本的存在。
- 每一版都带来源与说明（「色相+140°」「深蓝色布料手套…」），回退时看得懂哪版是什么。

四种产生新版本的方式：

| 方式 | 花钱 | 说明 |
|---|---|---|
| **换色** | 免费 | 色相 / 饱和 / 明度 / 亮度 / 对比五条滑杆；拖动时缩略图用 CSS filter **即时预览**，点「应用」才落成新版本 |
| **手工上传替换** | 免费 | 同名上传即新增一版（不是替换） |
| **AI 重绘** | 一次 Seedream 调用 | 给一句提示词，重绘这一块 |
| **（批量）** | — | 换色支持按语义 `tag` 批量，例如所有 `cloth` 一起换色调 |

**AI 重绘为什么不会把摆好的位置弄乱**：① 先把部件补成正方形再送出去（模型会按自己的
画幅习惯重排画面）；② 把结果**缩放到正方形尺寸**再裁回来、缩回原尺寸；③ 用原图的
**alpha 当掩码**——轮廓保持原样，模型画出来的背景被切掉。轮廓不变是硬要求：
装配框与骨骼锚点都绑在原来的轮廓上。

落盘前还有一道**健全性检查**：如果结果几乎是纯色（说明模型没画出内容），这一步
明确失败并**拒绝新增版本**——否则用户会拿到一版白块贴图，而且从版本列表上看不出它坏了。

> 排查用的 `scripts/probe-redraw.mjs` 与插件**共用同一个提示词构造器**，
> 直接看模型原始输出比在插件里反复重试便宜得多。这个「共用」不是洁癖：
> 第一版探针自己拼了一份提示词，于是「探针能通、插件不通」的差异让我去猜模型行为，
> 而真正的原因是**我自己的裁剪坐标用错了尺寸**（模型返回 2048×2048，裁剪却按 216×216
> 的补边图算，读到的只是大图左上角一块平坦区域）。教训写在
> `src/rigpose.ts` 的 `maskAndFit` 注释里，并有一条反向验证过的回归测试钉着它。

### 拆件为什么用固定网格

生图模型只负责「把部件画出来」，它不会告诉你哪一块是头。所以提示词要求模型按
**4 列 × 4 行**摆放 16 个标准人形部件——**格子位置就是部件身份**：

```
row 1: head          | neck           | torso            | hip
row 2: left-upper-arm| left-lower-arm | right-upper-arm  | right-lower-arm
row 3: left-hand     | right-hand     | left-upper-leg   | right-upper-leg
row 4: left-lower-leg| right-lower-leg| left-foot        | right-foot
```

名字确定之后，骨骼层级（谁挂在谁下面）与六个动画预设才能自动套上去，而不必让用户
手工给十几个文件命名。模型不按网格摆时（实测会发生）会明确告警，并可以：
重新生成拆件图，或者用「部件 PNG」上传框自己传（**文件名即部件名**），或者在部件卡片上
点「改名」。

### 自动摆位不准时：让 agent 给「视觉先验」

纯几何匹配有一个结构性弱点：**模型重画过的部件**（裙摆、袖子这类服装裁片）与参考图
局部外观只大致对应，错误位置也可能拿到不低的分数——实测一张真实立绘，16 个部件里
只有 3 个落在正确区域，头甚至被摆到了脚下面。

所以插件把「看懂素材」这一步交回给多模态模型（这一步参考项目本来就是这么做的，
我一开始为了可复现把它换成了固定网格，事实证明那个取舍是错的）：

1. agent 用 `read_image` 看 `getRigJob` 返回的 `sourcePath`（参考图）与
   `partsMontagePath`（**部件蒙太奇图**：所有部件按 `partsOrder` 顺序从左上到右下
   摆在一张图上，带格线可以直接数格子）；
2. 逐个判断「这块在参考图的哪个位置」，给出**大致**的像素框；
3. `setRigLayoutHints({jobId, hints:{部件名:{x,y,width,height}}})` → `runRigLayout`。

先验框会被向外放宽 35%，只约束模板**中心**——给粗一点没关系，给错区域才是问题。
界面上会用虚线画出先验框，和实际摆放对比着一看就知道该不该信它。

**实测效果**（同一张真实立绘 + Seedream 5.0 Pro 的拆件图）：

| | 落在指定区域的部件 | 结构检查 |
|---|---|---|
| 无先验 | 3 / 16 | ✗ 头被摆到脚下面 |
| 有先验 | **13 / 16** | ✓ 正确 |

### 拆件是怎么切的

生图模型不会老老实实「一格一件」。实测两个坑：

- 一件东西被画成**互不相连的几块**（围裙的白布片、鲸鱼刺绣、裙摆高光都是独立连通域）。
  按「同一格合并所有」会把它们和同格的**别的**部件揉在一起——实测出现过「一只手 + 两段
  袖子」并成一个部件。现在改成按**真实像素邻近距离**合并（只扫连通域的边界像素向外找，
  代价 O(周长×gap²)），阈值约为格子的 1.5%。
- 部件**溢出格子**多半是往下的（裙摆、头发、尾巴）。按面积最大归属会把整条裙子判给下面
  那格，于是它被命名成 `right-lower-arm`。现在在覆盖率不低于最大值一半的候选里取**最靠上**
  的那格——同一张图里裙子因此正确落到 `hip`。

#### 软 alpha 不能拿「离底色多远」当透明度

切出轮廓之后还要给每个像素定 alpha。原来这一步是 `alpha = (离底色距离 − 容差) / 羽化`，
本意是让抗锯齿边缘不留底色描边。**这个映射对「浅色角色 + 白底」是灾难性的**：

实测一张真实立绘里白色长袜的填充色是 `rgb(247,227,221)`，与白底 `rgb(252,252,254)` 只差 42，
而容差 30 / 羽化 26 正好把 30～56 这一段全判成半透明——于是**整条腿、不只是边缘**拿到了
约 45% 的 alpha。同一张图里：

| 部件 | 内部（离轮廓 ≥2px）半透明像素占比 |
|---|---|
| 头 | 4.5% |
| 手 | 33.0% |
| 右小腿 | **64.3%** |

规律是「填充越浅越透明」，只有深色描边（距离 440+）才拿得到不透明。用户看到的就是
「不该半透明的地方全是半透明」，而且调容差也救不回来（调小会把浅色填充整个吃掉）。

现在把两件事拆开：

- **形状**由硬掩码决定（颜色距离 > 容差），并且把**完全封闭**的孔洞补上——浅色高光一旦
  落进容差内，会在部件中间咬出一个**透明的洞**，那比白斑更糟（能透过角色看到背景）；
- **过渡**只发生在轮廓最外圈 2～3 个像素里（3-4 chamfer 算到「外部」的像素距离，比棋盘
  距离圆），内部一律不透明，**与颜色无关**。设置里的「边缘羽化」现在只决定这一圈有多软。

同一张拆件图重切，内部半透明像素从「手 33% / 小腿 64%」降到 **0 / 1,129,745 = 0.00%**。

### 装配定位是怎么算的

1. **几何先验**：拆件图相对参考图的缩放 `hint ≈ √(1.3 × 角色轮廓面积 / Σ部件像素面积)`。
   有了它，搜索阶梯只需要覆盖 `hint` 的 ±25%，不必从 0.06 盲扫到 1.9。
2. **由粗到细**：在最粗的一档（长边 96）搜「尺度 × 旋转 × 位置」，之后逐级放大、只在
   上一级最优点附近的窗口里精修位置；最后一档再做 ±10% 的尺度与 ±6° 的旋转微调。
3. **打分**：零均值归一化互相关（ZNCC），只在**参考图前景**上统计。排序分是
   `ZNCC × (0.3 + 0.7×覆盖率) + 证据项`：
   - 覆盖率那一项压住「放大」——模板越出角色轮廓，覆盖率直接掉；
   - 证据项（模板掩码占前景面积的比例）压住「缩小」——小块色斑贴在角色内部任何位置
     都能拿到高相关系数，而它其实什么都没解释。
4. **遮挡感知再匹配**：按人形默认层级，把挡在前面的部件先从参考图里「忽略」掉再匹配一次。
   不做这一步，被头挡住顶部的躯干会整体下移十几像素——而且这是**系统性**误差。
5. **镜像消解**：左右对称的部件在 ZNCC 眼里几乎可以互换（相关系数本来就减掉了均值），
   所以用一条与命名约定无关的几何约束兜底：同一组镜像部件必须分居角色中线两侧。

### 手动装配：自动摆位只是起点

不管自动摆位做得多好，**总有几件对不上**（实测这张立绘稳定剩 2～3 件），而「裙子该压住腿、
头发该盖住肩」这类层级关系更是自动流程永远猜不准的。所以 ② 装配定位 整页就是一个装配台，
自动结果只是它的**初始值**：

- **拖进画布**：左侧「未放置」部件栏，按住拖到画布上松手即落地；落地尺寸按全局尺度算好，
  不用再缩一遍。
- **拖动 / 缩放**：拖部件本体移动，选中后八个方向手柄缩放，`锁等比` 按住对面角、关掉则自由
  拉伸；拖动时实时显示与其它部件的中线/边缘**对齐参考线**（`吸附` 开关控制，默认开）。
- **键盘**：方向键微调 1px，`Shift` 10px；`Delete` 把部件收回部件栏（不是删除，随时能再拖回来）。
- **撤销 / 重做**：`Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z`，50 步，整批操作算一步。
- **视图缩放 / 平移**：滚轮以**光标为锚**缩放（25%～600%），`Ctrl/Cmd+0` 适应窗口；
  按住空格或中键拖动平移。
- **图层**：右侧图层列表从下到上排列，点选、批量「置顶 / 置底」，也可以直接改 z 值——
  这就是上面说的遮挡关系。
- **精确数值**：选中后出现 x / y / 宽 / 高 / 旋转 / z 六个输入框，外加「宽高互换」。
  数值一律是**参考图像素**，和自动摆位共用同一套坐标系。
- **单件重定位**：每件都有一个「重新定位」按钮，只对这件重跑模板匹配（免费）。
- **参考图底图**：画布可以垫上原参考图，半透明叠着对位。

画布本身是**客户端自己叠的一摞 `<img>`**，拖动时只改 CSS，不等宿主回图；松手才提交一次，
宿主重算合成图并写回 `layout.json`。所以拖起来是跟手的，而磁盘上的产物始终是完整的一份。

> 两个踩过的坑，都很能说明「客户端不完全信宿主」这件事的代价：
>
> 1. **两份 `mouseup`**。拖动/缩放和「从部件栏拖进画布」各有一份。移动/缩放那份**注册更早**，
>    它的 `mouseup` 先把 `drag` 置空，React 随即同步重渲染，把后面那份监听器当清理函数摘掉了——
>    表现是拖进去毫无反应、撤销也不亮。现在两份监听器各自判断 `drag.kind`，互不越界。
> 2. **两个键**。客户端本地草稿写的是 `placed`（「我要收回它」这个**意图**），而决定图层显隐
>    与「已放置 N/16」计数的是 `matched`（宿主也是读 `placed`、写回 `matched`）。合并草稿时
>    不把两者折算一下，Delete 收回、部件栏拖入这类**纯本地**改动就要等宿主回包才看得见；
>    一旦通信失败（比如宿主半区还没重启），界面会一动不动，看起来就像整个手动装配是坏的。
> 3. **撤销栈被自己的提交清空**（M7 收尾时撞出来的）。`setHistory([])` 原先挂在
>    `[job.id, job.updatedAt]` 上，而 `commit()` 写盘后 `updatedAt` 必然变化——于是每提交一次
>    就清空撤销栈，「撤销」按钮**永远是灰的**。拆成两个 effect：历史栈只跟 `job.id`，
>    草稿跟 `updatedAt`。
> 4. **重做是空操作**。`undo()` 把从历史栈弹出的**改动前**快照也塞进了重做栈，重做时还原的
>    还是那一份，等于又撤一次。改成先把「当前状态」抓进重做栈。

这 4 条 `scripts/verify-client.mjs` 里各有一条契约盯着。

### 骨骼是怎么推出来的

- **骨骼原点**取部件的近端锚点（上臂取上端＝肩，大腿取上端＝胯）；装配里旋转过的部件，
  先把近端/远端锚点绕图片中心旋转，再换到 Spine 坐标。图片的正旋转是顺时针，Spine 是逆时针。
- **骨轴是 Spine 的局部 +X**，朝向取 `atan2(dirY, dirX)`，骨尖是 `origin + length × (cosθ, sinθ)`。
  把骨轴误当 +Y 会让自己的播放器看着正常，但官方 IK 求值后整段手臂跳到另一侧。
- 骨骼的 `x`/`y` 换算到**父骨骼的局部坐标系**（spine-core 会先用父骨骼的旋转去转它）。
- 挂点用「图片中心 − 骨骼原点」再逆旋转到骨骼局部系，并用 `rotation` 抵消骨骼朝向——
  于是**初始姿态与装配结果逐像素一致**（`scripts/verify-rig.mjs` 断言偏差 < 0.02px，
  `verify-rig-runtime.mjs` 用官方解析器检查非90度旋转的锚点、region四角与mesh顶点），
  而动画一开始，部件就绕着正确的那节骨头转。
- 动画是 Spine **4.2 wire format**：旋转值写在 `value` 下（不是 3.8 时代的 `angle`），
  bezier 控制点是**绝对量**、且**每个被动画属性一份**（`rotate` 4 个数、`translate` 8 个）。
  这三点写错的表现分别是「骨骼不动」「骨架渲染一帧后整体消失」「运动突跳而不是缓动」。

**父级只解析一次**。语义层给了父级就用它，没给才按名字关键词往上找。解析结果存进一张
`resolvedParent` 表，**拓扑排序与写进产物的父子关系共用同一份**——这两处一旦各算一次，
「排序用的父级」和「产物里的父级」就可能分叉。

> 这里踩过一个**自 v1 起一直存在、却一条告警都没有**的坑：旧代码把「按名字找父级」和
> 「按祖先栈断环」揉在一个函数里，然后调用两次（排序传祖先栈、写骨骼传空集）；
> 更糟的是断环之后的兜底「挂到 torso」把刚断开的边**又接了回来**且不再复检。
> 默认网格里 `hip` 的语义父级是 `undefined`（身体根），而 `torso` 的父级正是 `hip`——
> 于是**每一份导出都带着 `hip ← torso` + `torso ← hip` 的互环**。
> 这个 bug 是被 DragonBones 的拓扑序校验揪出来的（Spine 那边一路绿灯），
> 所以现在两条导出路径都做拓扑序断言。回归测试在 `verify-rig.mjs` 第 12/13 节。

#### 骨骼方向指向「子部件的近端」

原先每根骨的方向都是「自己部件的上中 → 下中」。对竖直摆放的部件没问题，但**斜着摆的
部件会解出两条互相错开的骨骼**：实测举起的右臂，上臂骨原点到前臂骨原点只差 41.5px，
而上臂骨长 85px——拼图看着对，动画时部件绕的旋转中心却不在关节上。

现在方向改为指向**子部件的近端锚点**，叶子骨才退回自己部件的远端。**只改朝向与长度、
不改位置**，所以「初始姿态逐像素还原」依然成立。实测 11 根有子级的骨里 9 根末端误差
`0.000px`；`hip` / `torso` 非零是固有的（它们有多个子级，一根骨只能指向其中一个）。

> **连带影响（已知，未修）**：`length` 的含义从「部件长度」变成「到子骨原点的距离」，
> 于是**锚点质量开始直接影响骨骼长度**。实测前臂骨只剩 **14.3px**——因为 `left-hand`
> 的近端锚点是「部件顶端中点」，而手掌是**手指朝上张开**的，于是「手腕」被算在了指尖
> 那一侧、和肘挤在一起。改之前这个问题被「长度恒等于部件高度」**掩盖**了。
> 根因在锚点层（`RIG_SLOTS` 的 `P_TOP/P_BOTTOM` 假设肢体一律从上往下长），
> 而手/脚这类部件的正确锚点取决于**姿态**，通用规则覆盖不了——应当做成
> 「按部件主轴自动估计锚点」，或逐件设（`setRigSemantics` 的 `proximal`/`distal` 已支持）。

### 动画：从「两个旋钮」到「可编辑关键帧」

六个动画预设一开始只有两个旋钮——`amplitude`（统一缩放旋转与位移）和 `duration`（循环时长）。
这覆盖了「动作太大了」「这是慢节奏 NPC」这类诉求，但一旦有人想真的**改某一帧**，参数化就不够了。

所以「编辑」这个动作的定义是：**把参数化的预设固化成一份显式的关键帧数据**，从此以数据为准。

- 数据存在 `job.animations[id]`，结构就是简写时间轴
  `{duration, loop, bones: {骨骼名: {rotate|translate|scale: [{time, angle|x|y, curve}]}}}`。
  简写同时是 Spine 与 DragonBones 两条导出路径的**共同输入**，所以编辑器不需要任何格式转换。
- **一旦实例化，参数旋钮就不再影响这台动画**。刻意的：否则手调过的帧会被下一次调参悄悄改掉。
  「还原到预设」是唯一的回头路。
- 写盘前过一遍校验：时间非负、逐轨道时间严格递增、重合帧去重、每条轨道首帧必须是 0、
  **末帧 curve 强制清空**（Spine 的 curve 描述的是「以本帧为起点」的下一段，末帧没有下一段）、
  curve 只接受 4 个数或 `"stepped"`。丢掉的东西一定伴随一条 warning，不做静默修正。
- 界面上的时间轴可以：切换动画（标「已改」）、改时长/循环、点选关键帧、**拖动改时间**、
  双击空白处加帧、改数值、六个缓动预设、加/删轨道（含 scale）、删除关键帧。
  首帧（0 秒）不能删——它是每条轨道的锚；删掉它，0 → 首帧之间就是一段未定义的静默区。
- **拖动只改本地草稿、松手才提交**，与装配台一致（跟手，但提交少而完整）。
- 预览 iframe 的 `src` 带 `?v=${rig.updatedAt}`：少了它 React 认为 src 没变、不重新挂载，
  改完关键帧预览会一直是旧的。

> 顺手修掉两个真 bug：
>
> 1. `kf()` 给每帧都挂了默认缓动，**末帧也带了一个永远不会被读到的 curve**——导出不受影响，
>    但编辑器里用户会看到一个永远改不动的字段。
> 2. `invalidateFrom` 写成「让某个阶段**之后**的产物失效」，于是 `setRigBoneOffsets` /
>    `saveRigAnimation` 这类传 `"rig"` 的入口只清掉了「通过」标记，`rig.status` 仍是 `ready`
>    ——界面继续显示「已完成」，用户以为改动已经生效了。现在按阶段分开处理：
>    **`layout` 保留 `items`**（那是用户手工摆的劳动成果，不能因为改了一个先验就被抹掉），
>    **`rig`/`atlas` 置空**（纯派生物，重跑就有）。

### 导出两套格式：Spine 4.2 与 DragonBones 5.5

同一个骨架同时落两份产物，给不同的引擎用：

| 文件 | 给谁 |
|---|---|
| `rig/skeleton.json` | Spine 运行时 / Spine 编辑器 |
| `export/dragonbones/skeleton_ske.json` | DragonBones（Cocos / Egret / Laya 自带） |
| `atlas/skeleton.atlas` | Spine 的图集描述 |
| `atlas/skeleton_tex.json` | DragonBones 的图集描述（逐页一份） |
| `rig/preview.html` | 自带 Canvas 渲染器，零外部依赖，双击即播 |

两份是同**一次**推导、同**一次**装箱出来的——分开各算一次，坐标迟早对不上，而运行时的
表现只是「画错位」，不会有任何报错。

三处必须分开编码的差异（都对着 DragonBonesJS 的解析器逐行核过）：

1. **`tweenEasing` 缺省是 `-2`（阶跃）**，不是线性。所以每个补间帧都要显式写 `tweenEasing: 0`
   或真实缓动，否则动画一跳一跳。
2. **`curve` 是 0~1 归一化**的（紧凑式要求长度 `% 3 == 1`），而 Spine 4.2 是**绝对量**。
   所以简写动画被拆成 `buildAnimationShorthands`，两条路径各自编码一次。
3. **`duration` 是帧数**（`seconds × frameRate`，固定 30），Spine 那边是秒。

另外两处决定「画出来对不对」：图片落点靠 `pivot` + `frame*`（`_pivotX = pivot.x * frameWidth
+ frameX`），裁剪过的部件少给 `frame*` 会整体偏掉；坐标是 **y 向下**（`DragonBones.yDown`
默认 `true`），所以从 Spine 的Y向上坐标转换时，骨骼/挂点的Y与旋转、动画位移Y与旋转值
都必须取反；图片像素仍按原来的方向存进图集。

当前 DragonBones 导出覆盖刚体图片、骨骼与动画、IK。mesh降为刚体图片且不输出FFD，
Path约束与路径槽位不输出，并通过`exportWarnings`/校验warning明确报告降级；需保留蒙皮、
FFD与Path效果时使用Spine导出。不会给image挂一个看似存在但引擎不会生效的FFD时间轴。

### 预览为什么不用官方 Spine Web Player

官方播放器要从 CDN 拉 `spine-player.js`，而验收页可能在没有外网的环境里打开。所以
`preview.html` 把部件图片与骨架 JSON 全部 base64 内联、自带一个 Canvas 渲染器（含贝塞尔
插值、骨骼叠加显示、时间轴），双击就能看，零外部依赖。

开发自检另用固定版本 `@esotericsoftware/spine-core@4.2.120` 做真正的解析与求值。
它只在 `devDependencies`，不进入插件运行时依赖。`node scripts/verify-rig-runtime.mjs`
在内存中构造纹理，不联网也不调用生图；覆盖旋后的锚点/图片、mesh自身权重与动画跟随、
IK同弯曲方向加约束不跳姿态（含手工骨偏移）、开放/闭合Path实际摆骨、FFD时间轴实际加载与
顶点变形、预览与官方FFD顶点对照、IK和Path同架求值、官方图集解析。
`--preview` 可把免费带纹理的样例骨架与自包含预览输出到临时目录，供浏览器视觉验收。

IK目前只支持两根骨骼（`chain = 1`，不含末端自身的父级数量）。编辑接口拒绝其它长度且
不落盘，历史任务里的更长链在构建时整条跳过并明确告警。自动目标使用包含手工偏移的
实际装配骨尖；保持已有肘侧时须选同一弯曲方向，主动切换方向会得到另一侧的合法解。

原来的JSON/HTML字符串检查不能证明引擎会加载并播放。尤其FFD须写在
`animations[id].attachments.default[slot][attachment].deform`；加权网格每个骨骼影响各写一对
局部位移。mesh权重候选必须包含自身骨骼，否则骨骼动画旋转了而图片仍只跟父级走。
Path的target指向路径槽位，附件要写`vertexCount`与三次Bezier控制点；折线逐段转换为直线Bezier，
不能直接把折线点数组冒充Spine路径附件。

**2026-10-10绑定修复后的旧任务**：重新生成③骨骼与④图集，让产物采用修正后的骨轴、
旋后锚点、权重与FFD/Path格式。已有手工数值与动画数据会保留；因骨骼局部坐标系已经纠正，
旧任务的手工位移偏置与自定义`translate`轨道需要重新核对，尤其旋转过的部件。
这些修复保证输入布局与导出/播放遵守同一坐标约定，不替代真实关节识别。
自动生图拆件、部件语义与不同姿态下的手腕/脚踝定位仍为实验性，必要时调整近端/远端锚点。

本轮纯本地验证环境为Windows、Node 22.22.1、ffmpeg/ffprobe 8.1、官方Spine 4.2.120。
最终骨骼回归全部通过：`verify-rig` 281项、`verify-rig-module` 229项、`verify-rigsemantics`
58项、`verify-feedback` 161项、`verify-rig-runtime` 41项（包含重复路径端点/越界与官方求值对照）。

### 验收与重试

- **① 拆件**：部件卡片逐件「通过 / 改名 / 隐藏 / 删除 / 重新定位」；
- **② 装配**：整页是手动装配台（拖入 / 拖动 / 缩放 / 对齐吸附 / 撤销 / 图层 / 精确数值，
  见上一节）；自动没匹配上的部件会明确标出来，同时给出「只重试未命中的 N 个」按钮；
- **③ 骨骼**：六个动画按钮直接切换播放，可开骨骼叠加与网格；页面上同时给
  `skeleton.json` 与 DragonBones `skeleton_ske.json` 两个入口；
- **④ 图集**：图集整图预览 + `.atlas` 文本 + DragonBones `_tex.json`，区域尺寸与
  `skeleton.json` 里的挂点尺寸一致。

对话里也能全程驱动：`game_material({action:"call", method:'runRigLayout', payload:{jobId, names:['head']}})`
只重跑一个部件，不花钱。

---

## 界面语言：接 DSH 的 locale，而不是自己猜

界面文案跟随 **DSH 自己的语言设置**（设置 → 通用 → 语言），切换即时生效、不刷新页面。
这里没有第二条真相：插件不读 `navigator.language`，也不自己存一份偏好。

### 接线：可选依赖，缺了也要能用

DSH 的浏览器半区把 locale 服务挂在 `ctx.provide("locale", …)` 上
（`@deepseek-ai/dsh-client-locale`）。插件在 `apply()` 里 `attachI18n(ctx)`：

```ts
const locale = ctx.get("locale");
if (locale === undefined) return false;          // 服务不在 → 界面退回中文原文
ctx.effect(() => locale.register(I18N_NS, { zh: ZH, en: EN }), "…");
boundTranslate = locale.bind(I18N_NS);
rebuildStaticText();                             // ← 见下一节，漏了就永远停在旧语言
ctx.effect(() => locale.subscribe(() => { boundTranslate = locale.bind(I18N_NS); rebuildStaticText(); … }));
```

两个刻意的选择：

- **没有把 `"locale"` 写进 `inject` 列表**。写进去插件就会卡在这个服务上——宿主里少挂一个
  locale 插件，整个工作台就不出现了。现在的写法是「先试一次，没成就 `ctx.inject(["locale"], …)`
  等它可用」，两条路都失败也只是界面保持中文，功能一条不少。
- **注册失败一律吞掉**（`try/catch`）。locale 服务对同名 namespace 的重复注册会抛错，
  而插件卸载重挂是正常路径；为了一个文案表把整块界面搞崩不值得。

### key 就是中文原文

词条表长这样，key 是源码里那句中文本身：

```ts
const EN = { "正在装配定位…": "Running auto placement…", "第 {n0} 帧": "Frame {n0}" };
const ZH = Object.fromEntries(Object.keys(EN).map((key) => [key, key]));
```

两千多条 `T()` 调用点，如果改成人造 key（`rig.layout.busy`），就得同时维护一张
「代号 ↔ 中文」的对照表，且**每一处漏改都只有运行时才看得出来**。用中文原文当 key：

- 调用点写的就是文案，`T("正在装配定位…")` 一眼能读懂，code review 不需要查表；
- 漏翻**不会显示成 key**——locale 回退链是「当前语言 → en」，两边都没有时
  `translate()` 返回 key 本身，也就是中文。最坏情况只是「这一条没翻」；
- `verify-i18n.mjs` 靠「源码里的 `T("…")` 集合 ⊆ 词条表 key 集合」一次性把漏翻找齐。

英文可以换语序：插值走 `{n0}` 这类占位符（与 locale 服务内部同一套规则），
`T("第 {n0} 帧", { n0: i })` 的英文写成 `"Frame {n0}"` 完全没问题。

`ZH` 必须是**完整的恒等映射**。locale 的回退链是「当前语言 → en」，只注册 `en`
的话中文界面会一路落到英文——这个 bug 在中文环境下反而不容易发现（开发时看到的全是中文）。

### 坑：模块级常量把 `T()` 求值求早了

这是整套里唯一一个「不报错、只是不对」的地方，实测踩到：

```ts
const DIRECTIONS = [{ key: "front", compass: "S", label: T("南 · 正对镜头") }, …];  // ← 模块加载时就翻译完了
```

浏览器半区是经典脚本，模块顶层的 `T()` 在**插件 load 时**就跑完了，那时 locale 服务
还没挂上（`boundTranslate === null`），拿到的全是中文原文，而且此后永远是那一份。
表现是：切到英文后，标题、按钮、提示条全变英文了，**方向名 / 模块页签还是中文**。

修法是把这些表改成「工厂 + `let`」，由 `rebuildStaticText()` 在挂上服务和每次语言切换时重算：

```ts
function make_DIRECTIONS() { return [ … ]; }
let DIRECTIONS = make_DIRECTIONS();
const staticTextRebuilders = [() => { DIRECTIONS = make_DIRECTIONS(); }, …, () => { LABEL_OF = make_LABEL_OF(); }];
```

注意顺序：`LABEL_OF` 派生自 `DIRECTIONS`，重算表里必须排在它后面。
**新增模块级 `T()` 文案表时要同步加一条 rebuilder**，否则又会退化成「切了语言它不动」。
只写在函数体里（组件、渲染函数）的 `T()` 不受影响——那些每次渲染都重新求值。

### 批量包装老代码：词法级 codemod

800+ 条文案靠手改必漏，所以有一个纯词法的改写脚本：

```bash
node scripts/i18n-wrap.mjs src/client.ts --keys /tmp/keys.json   # 只出清单，不改文件
node scripts/i18n-wrap.mjs src/client.ts --write                 # 真正改写（幂等，可反复跑）
node scripts/i18n-wrap.mjs src/client.ts --dump /tmp/keys.json   # 从已包好的文件里回收 key
```

它不建语法树（TypeScript 7 是原生编译器，没有可用的 JS 编译器 API），只做
「字符串 / 模板 / 注释 / 正则」四态扫描——这里够用。三条规则值得知道：

1. 模板字面量会被拆成占位符：`` `第 ${i + 1} 帧` `` → `T("第 {n0} 帧", { n0: i + 1 })`，
   表达式原样搬进去，所以嵌套的字符串字面量会在下一轮被单独包上（**要跑 2~3 轮才收敛**）；
2. 已经是 `T(` 第一个实参的字面量会跳过，所以脚本幂等；
3. `i18n-ignore-start` / `i18n-ignore-end` 之间的整段不碰——**词条表本身必须划出去**，
   否则 `T("中文"): "English"` 会变成语法错误。

只有注释里出现中文的模板也跳过：内联 CSS（`const CSS = \`…\``）的注释是给开发看的，
不是 UI 文案。

### 自检

`node scripts/verify-i18n.mjs` 钉住五件事：**每个 `T()` 都有英文条目**、**没有没人用的死条目**、
**中英两侧 `{nN}` 占位符一一对应**（少一个界面上就少一段文字）、**译文里不残留汉字 / 全角标点**
（`·`、箭头、`▲▼`、`¥`、`≤` 这些故意保留的符号在白名单里）、**`lib/client.js` 与
`src/client.ts` 的词条表一致**（忘了 `npm run build` 就发版，界面会整体退回中文）。

---

### 内置默认提示词也跟着语言走

界面文案解决的是「用户看得懂按钮」，但**八方向生图 / 行走视频 / 转圈视频的默认提示词
会真的发给 Seedream 与 MiniMax**。英文界面下继续发中文提示词，模型照样能画，可用户读不懂
自己在调什么——所以它必须跟界面同语言。

真源在宿主：`src/directions.ts` 的 `defaultPrompts(lang)` 返回
`{ images, video, turn }`，中英各一份模板（`DEFAULT_*_PROMPT` 与 `DEFAULT_*_PROMPT_EN`），
方向段落另有 `facing` / `facingEn`、`visibility` / `visibilityEn`。**两版必须逐行对应**，
它们不是「翻译给界面看的」，是同一份提示词工程结论的两种语言写法。

宿主拿不到 locale 服务，语言只能由浏览器半区带过去：

| 调用 | 带 `lang` 干什么 |
|---|---|
| `getProject({ projectId, lang })` | 把**还是默认值**的提示词换成该语言的默认值，再返回 |
| `savePrompts({ …, lang })` | 「重置为默认」重置成**当前语言**的默认值，而不是永远重置成中文 |

「还是默认值」的判据是 `localizePrompts()`：**逐字等于另一语言的默认值**才算没改过。
所以切语言时只有从没动过的条目会换，用户写过的一个字都不动，而且来回切是可逆的
（英文默认值再切回中文，同样逐字匹配得上）。`videoPerDirection` 里的逐方向覆盖同理。

**坑（实测）**：`lang` 写进了方法入参、客户端也确实发了，界面却毫无变化。
原因是 typert 按 `src/wire.ts` 里声明的 `payload` schema 校验，**schema 里没写的键会被静默丢掉**——
`getProject` 当时用的是 `projectIdSchema`（只有 `projectId`），于是宿主读到的 `lang` 永远是
`undefined`，`localizePrompts` 一次都没跑过。现在拆出了 `getProjectSchema`，`promptsSchema`
也补了 `lang`。**往宿主方法加字段时，schema 必须同步改**，否则就是这种「不报错、只是不生效」。

验证走 `verify-host.mjs` 的 5b 段（14 项，真实 cordis 宿主）：默认值初始是中文 → 切英文后
未改过的变英文、改过的原样保留 → 切回中文还原 → 英文下「重置为默认」得到英文模板 →
`videoPerDirection` 的覆盖不受影响。

因为这是**宿主半区**的改动，跑真实界面要重启宿主：用 `scripts/dev-overlay.yml` 起一个
独立端口的测试宿主（见「开发时的宿主半区热重载」），并且**别用 `--profile desktop`**
（那个 profile 归 Electron 应用独占，命令行起不来）；临时 profile 的 `locale.preference`
也是独立的，不会动用户真正的语言设置。

### 没做的部分：宿主半区的文案

DSH 只把 `locale` 服务挂在**浏览器半区**（`ctx.provide("locale", …)`），宿主半区拿不到，
所以下面两类仍是中文：

| 位置 | 例子 | 为什么 |
|---|---|---|
| 运行日志里由宿主 `log()` / `appendJobLog()` 写入的行 | `开始生成「南 · 正对镜头」`、`「{方向}」生成完成，用时 12.3 秒` | 宿主编好字符串再落到项目 JSON 里，语言切换时已经定型 |
| 对话工具返回给模型的文本 | `game_material({action:"status"})` / `review` 的渲染、`intake` 的追问 | 面向模型，不是面向界面 |

要接着做的话，正确的路子不是把宿主字符串拖到客户端用正则猜，而是**让宿主写结构化日志**
（`{ key, params }`，`message` 保留为中文兜底），由客户端渲染时翻译——`LogEntry` /
`JobLogEntry` 加两个可选字段即可，旧日志没有 `key` 就原样显示，向后兼容。
注意方向名这类插值不能由宿主填：宿主手里的 `LABEL_OF` 是中文的，应该传**方向 key**，
由客户端经 `LABEL_OF` 解析，否则英文界面里会冒出中文方向名。


---

## 抠像是怎么做的（含「角色贴边被整片误抠」的坑）

主判据是**边界洪水填充**：从四边出发，只沿着「颜色像背景」且「与相邻背景像素接近」的方向生长，
所以绿幕、黄幕、被重新打光成渐变的背景都能整片吃掉。

**坑**：调色板是拿边框像素建的——角色一旦贴到画面边缘（尾巴 / 头发 / 裙摆被裁到边上），
它自己的颜色就混进了「背景色」。填充于是顺着同色的身体部位一路吃进去。
实测一张 438×768 的转圈帧：尾巴贴住左边缘，1.6% 的边框采样点是藏青，
默认容差下 **7.7% 的掩码变成了角色的裙子与头发**，半条裙子直接没了。

**修法**：边框采样点先按颜色**单链聚类**（格心距离 ≤ 2 格算连通），只让**背景主色簇**
（占比 ≥ 15%，或最大的那一簇）进调色板。平缓渐变因为一路相连会被完整保留（暖色渐变用例
仍然 92% 透明），而那一小撮角色色自成小簇、被挡在门外。同一张帧修好后掩码里
「不像绿色」的像素从 7.7% 降到 **0.00%**，角色的不透明像素数回到关掉填充时的基线。

诊断字段（`KeyResult`，会写进合成日志与 `game_material({action:"status"})` 的整图 cell）：
`backgroundFraction`（背景占比）、`borderSamples` / `borderSamplesDropped`（边框采样里被排除的点数，
> 0 通常意味着角色贴边）。`verify-pipeline.mjs` 第 12 节钉住了这一条：
贴边素材里角色的深蓝必须保住、干净素材一个采样点都不许排除、双色背景两块都要算背景。

## 抠像参数怎么调

| 旋钮 | 作用 | 什么时候动 |
|---|---|---|
| 背景分割容差 `bgTolerance` | 主判据：洪水填充的颜色容差 | 误抠成片 → 往小调；干净绿幕可以直接 0（= 只按绿色判据） |
| 抠像下限 / 上限 `keyLow` / `keyHigh` | 辅助判据 `绿色优势 = G − max(R,B)` | 角色身上偏绿的颜色被抠掉 → 两个值一起往下调（如 8 / 60） |
| 去绿溢出 `despill` | 只压绿色分量，不改透明度 | 抠完边缘发绿时才调大 |
| 边缘收缩 `edgeShrink` | 前景 alpha 向内腐蚀 n 像素 | 只剩一圈绿边时用 1~2；调大啃掉发丝 |

**为什么第 ③ 步抠过一次、第 ④ 步还要再抠**：③ 抠的是**每个方向的预览带**（顺手也合出了整图），
④ 在**同一份帧缓存**（`raw.bin`）上用**同一套参数**重抠一遍——目的是让 ④ 那十个参数
改完立刻生效，而不用重新解码视频重抽帧。两步结果必然一致，不是重复劳动。


三个模块共用同一套实现，判据分两条，**先空间、后颜色**：

1. **边界洪水填充**（主判据）。从画面四边出发，只沿着「与相邻已判定背景像素颜色接近」
   的方向生长。它跟随的是**局部连续性**而不是某个固定颜色，所以绿幕、黄幕、
   甚至被视频模型打光成整片渐变的背景都能整片吃掉。
2. **绿色优势值** `g - max(r, b)`（辅助判据）。只作用在未被判定为背景的像素上，
   清理轮廓残留的绿色，并按 `(1 - alpha)` 加权去绿溢出（不会改坏角色身上真正的绿色衣物）。

两个实测调出来的关键参数：

- **局部容差必须收得很紧（12）**。放宽到 16 就会顺着抗锯齿的软边缘渗进角色体内，
  把整个身体判成背景（白色围裙尤其容易中招）。背景的大范围变化由全局调色板负责，
  不需要局部判据承担。
- **全局调色板按球体标记**，不能只按格坐标扫一圈——那会标出一个立方体，
  角落到中心的距离可达容差的 √3 倍，于是离背景很远的角色颜色也会被误判成背景色。

### 像素量化

像素风来自**确定性的后处理**，不来自提示词。实测 Seedream 会忽略「像素画」这类风格指令
照旧输出平滑插画，所以量化放在了抽帧合成阶段：每个输出像素块单独做盒式平均
（按 alpha 预乘，背景色不会渗进边缘），再填满整块。生图和视频模型磨平了细节也不影响最终像素风。

默认 4px 方块在 256 格上是「能看出方块但仍保留细节」的平衡点；6px 以上开始丢细节。

---

## 产物位置

```
<DSH_HOME>/game-material-master/
├── config.json
├── projects/<项目 id>/          模块一：八方向图
│   ├── source/  images/  videos/  frames/  keyed/  preview/  out/
│   ├── turn/                    转圈截帧（阶段①的默认生成方式）
│   │   ├── raw.bin              候选帧的 RGBA 缓存（拖圆圈重切时只读它，不重新解码视频）
│   │   ├── frames/fNN.png       候选帧（整圈均匀取样）
│   │   └── strip.png            整圈缩略条带（界面上那八个圆圈对着它拖）
├── image-jobs/<任务 id>/        模块二：图片生成
│   ├── refs/  out/  keyed/
├── sequence-jobs/<任务 id>/     模块三：序列帧生成
│   ├── refs/  video-refs/  videos/  frames/  keyed/  out/
└── rig-jobs/<任务 id>/          模块四：骨骼动画生成
    ├── source/                  角色参考图（整图）
    ├── sheet/                   拆件摊平图（生图模型产出）
    ├── parts/                   分割后的部件透明 PNG（文件名即部件名）
    ├── layout/                  layout.json + composite.png + comparison.png
    ├── rig/                     skeleton.json + preview.html
    └── atlas/                   skeleton.png + skeleton.atlas
```

素材通过 `ctx.webServer` 注册的路由直接发给浏览器（支持 `Range`，视频能拖进度条）：

```
/dsh-game-material-master/assets/<项目 id>/<相对路径>
/dsh-game-material-master/image-assets/<任务 id>/<相对路径>
/dsh-game-material-master/sequence-assets/<任务 id>/<相对路径>
/dsh-game-material-master/rig-assets/<任务 id>/<相对路径>
/dsh-game-material-master/iso-assets/<项目 id>/<相对路径>
```

八个模块的 id 前缀不同（项目 `p…`、图片任务 `i…`、序列帧任务 `s…`、骨骼动画任务 `r…`、
45° 地图编辑器 `g…`、地图编辑器 `m…`、音乐 `a…`、音效 `f…`），路由会校验前缀并挡住目录穿越。

> ⚠️ **scope 白名单有两处，必须同步改：`AssetScope` 类型 + `handleAsset` 里的运行时判断。**
> 只改类型不会报错（`scope` 是从 path 断言出来的），新 scope 会静默掉进 404，
> 界面表现只是「图裂了」。`tile-assets` / `iso-assets` 这类 scope 都漏过一轮。
> 现在 `verify-host.mjs` 第 14 节会真起一台 server 走 HTTP 取一张素材图，
> 取不到就红。

---

## 开发

### 改了代码之后怎么生效

| 改了哪里 | 怎么生效 |
|---|---|
| `src/client.ts`（浏览器半区） | 刷新页面即可——客户端 bundle 由宿主按请求从磁盘读，带上 `rev` 指纹 |
| `src/*.ts` 的宿主半区（网关、路由、工具、流水线） | **正式环境必须重启 Harness**（菜单 `Harness → 重启 Harness`）。宿主半区是进程启动时冻结的模块图，改 YAML / 碰文件都不会让它重新 import |

#### 开发时的宿主半区热重载（不必重启）

重启 Harness 会掐断正在跑的 agent 会话，做插件开发时很难受。profile 声明了
`patchReload: live`，但**默认不生效**：启动时创建 `cordis-plugin-hmr` 用的是
`{ root: [] }`——也就是「不监听任何目录」，而且 `base` 会被
`new URL(base, ctx.baseUrl)` 解析，写成 `D:/...` 会被当成 `d:` scheme 抛
`ERR_INVALID_URL_SCHEME`（必须写 `file://` URL）。

起一个**独立端口的测试宿主**、并注入 `scripts/dev-overlay.yml`，就能拿到
「改完 `lib/*.js` 立即生效」的开发循环：

```bash
# 注意 --patch 是启动器的选项，要写在子命令前面
node "<DSH>/resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile web --patch scripts/dev-overlay.yml --port 43121 --no-open
```

判断「运行中的宿主到底吃到了哪一版代码」不用猜——有现成的探针：

```bash
curl http://127.0.0.1:43121/dsh-game-material-master/_health
# {"ok":true,"pid":29156,"bootedAt":...,"mtimeMs":...}
```

`mtimeMs` 是 `lib/index.js` **被 import 时**捕获的。重新 build 之后如果不手动刷新页面，
它就该跟着变；没变说明代码没生效，而不是功能坏了。

**每次 apply 都必须复位后台任务表。** 插件被重载（`patchReload: live`、plugin-manager 的
`pnpm importPackage` 重装等）时，`ctx.effect` 的清理会跑 `disposePipeline()` /
`disposeSequence()` / `disposeRig()`，把模块级的 `disposed` 置为 true；而 Node 的模块缓存
留着**同一个模块对象**，于是重载之后 `disposed` 永远停在 true，`kick()` 一律返回 false。
症状极具迷惑性：**所有生成类调用**（八方向图 / 转圈视频 / 抽帧 / 视频提交 / 手动选帧 /
序列帧 / 抠像 / 合成 / 骨骼）都只回一句「任务已在进行中」，按钮点了像没反应、项目里连
一条日志都不加；而 `uploadSource` / `getProject` / `testComfy` 不走 pipeline，全都正常。
所以 `src/index.ts` 的 `apply()` 开头必须依次调用 `activatePipeline()`、
`seqgen.activateSequence()`、`riggen.activateRig()`；`kick()` 失败时也要用
`kickFailure()` 把「实例已废」与「真的已经在跑」分开，前者要明说请重启 DSH ——
否则用户会一直等一个根本不存在的任务。（2026-10 实测：`[ERR_PNPM_EPERM] … rename
'…dsh-game-material-master_tmp_13920_10' -> '…dsh-game-material-master'` 之后，
界面就变成了这个样子。）

用 Playwright 驱动这个测试宿主时，需要先过 Web 认证（每个 Host RPC 都要求同一个
浏览器会话）：启动令牌只在进程内存里拿不到，但 cookie 的签名密钥是持久化的，
可以从本机凭据派生一份合法 cookie：

```bash
node scripts/dsh-web-cookie.mjs 127.0.0.1:43121 --json
```

这一点会真实地咬人：宿主半区是旧版而客户端是新版时，界面会以各种「读不到字段」的形式
坏掉（按钮一直是灰的、图片 404），而不是报一个明确的错。所以：

- 客户端在 `RigModule` 里对形状做了显式检查，版本对不上会直接提示「请重启 DSH Desktop」；
- `scripts/verify-rig-module.mjs` 有一条契约扫描 `RigModule` 读了哪些 `job.*` / `part.*`
  字段，逐条对着真实视图核对；
- `scripts/verify-client.mjs` 有一条契约核对 `REMOTE_METHODS` 里的**每个**方法都在
  `api` 对象上有实现——`REMOTE_METHODS` 只负责向宿主声明方法名，忘了挂实现时
  编译期完全看不出来（`api` 是隐式 any），一点就报 `api.xxx is not a function`。

### 真机视觉验证的四类盲区（每个都真的漏过 bug）

自检全绿**不代表**界面对。模块五连着三轮「自检全绿、真机坏」之后回头看，
漏掉的 bug 全部落在下面四类里。加新界面 / 改摆放口径时照着这张表自查。

| 盲区 | 这次的实例 | 为什么自检没拦住 |
|---|---|---|
| **拿自己的公式验自己** | 断言「装饰的 `top` = 格子的 `y` + `decorAnchorY`」。公式是我写的，断言也是照它写的 —— 两边一起错就一起绿 | 契约必须是「**和宿主的真实产出比**」，不是「和我的推导比」。`verify-map-client.mjs` 那条**黄金对照**（拿宿主 `measureAssemblyBounds` 的真实现比同一组输入）才是有效契约 |
| **只测了一个方向** | 装饰只断言了**垂直**落地线，**水平**位置一个字都没测 —— 于是「没居中、整排右移半格」一路绿到底 | 摆放口径是**二维**的。宿主居中而界面左对齐，垂直再准也没用 |
| **夹具选了「不暴露问题」的样本** | 树放在地图**中间**。中间全是草地，半格偏移看不出来；只有**贴边**的树才会飘出草地 | 夹具要选**边界情形**（顶边 / 左上角 / 最后一格），别总用正中 |
| **只在「已经存过」的状态试** | 房屋跳格只在「**刚放下、还没保存**」的建筑上复现：它不在 `preview.buildings` 里，包围盒只能按默认比例估。我拿已有建筑的项目试，每次都稳，就以为修好了 | 一条链路有几个**入口状态**（新建 / 已存 / 刚改未存 / 老数据缺字段）就要各试一遍。这次是「刚改未存」 |

还有两条通用教训：

- **「看得见的位移」不要靠读数值判断。** 保存前后我一直在比 `style.top` 这类字符串，
  它们看着一样但渲染出来的位置不同（`transform` + `naturalWidth` 参与定位）。
  真机验证要**量元素的实际 `getBoundingClientRect()`**，或者干脆截图逐像素比。
- **改摆放公式时，把宿主与界面的同一段几何各算一遍、打印出来对。**
  这一轮就是靠 `measureAssemblyBounds`（宿主）×2 与界面复刻逐字段对齐，
  才确认坐标口径真的修好了；光看截图只能看出「好像对了」。

### 另一类静默坏法：props 名字对不上

**组件照样渲染、界面看着完全正常，只是回调悄悄丢了。**

实测最坑的一例：`NumField` 解构的是 `onChange`，而地图地块界面的 5 个调用点
写成 `onCommit`。于是 `onChange` 是 `undefined`，**一失焦就抛
`onChange is not a function`，值永远同步不进草稿** —— 用户改了「变体数 / 占格」，
点保存看着成功、实际提交的还是旧值（真机表现：「改了草地变体数、保存后还是 2」）。

三条对策，都进了自检：

- **组件自己校验 props**：`NumField` 少了 `onChange` 会**当场抛错**并说明原因
  （"是不是写成了 onCommit？"）。静默失败比直接报错难查得多 ——
  这条例外一触发，`verify-map-client.mjs` 直接崩在渲染，比红色断言更硬。
- **源码契约**：断言「所有 `h(NumField` 调用点都只能用 `onChange`」。
  纯渲染断言拦不住它 —— 组件渲染得好好的，只是回调没人接。
- **给可断言元素加标记**：数字输入框渲染成 `data-num-field="1"`。
  `materialize` 会把函数组件的 `type`/`props` 换成渲染结果，
  物化之后就再也认不出 `NumField`，只能靠 DOM 上的标记找。

顺带记住这条**通用**判据：**「用户改了但没生效」优先怀疑回调没接上**，
而不是去查数据层。这次我先花时间验了宿主 `mergeTileItems` 与网关往返，
两边都是对的 —— 因为错的根本不在这两层。

### 自检脚本

| 脚本 | 覆盖 |
|---|---|
| `node scripts/verify-rigsemantics.mjs` | 模块四语义层：角色推断（含中文名与关键词优先级）、默认语义与 v1 的 `RIG_SLOTS` **逐条一致**、父级沿角色链回退、成环/悬空父级/锚点退化的校验与自动修复、确定性 |
| `node scripts/verify-rig.mjs` | 模块四算法层：拆件分割、装配定位精度、遮挡排序、骨骼初始姿态逐像素还原、Spine 4.2 wire format、**DragonBones 5.5 双格式导出（每个地雷都配了反例）**、语义成环时的无环保证、**拆件质检（重复件 / 镜像判别 / 装配质量）**、图集装箱、预览 HTML（合成图像素级断言） |
| `node scripts/verify-rig-runtime.mjs` | 模块四官方 Spine 4.2.120 解析与求值：旋后锚点、region四角/mesh UV、+X骨尖、mesh自身旋转、IK不跳与追目标、开放/闭合Path实际摆骨、FFD实际加载变形、图集解析；`--preview`免费生成本地视觉样例 |
| `node scripts/verify-rig-module.mjs` | 模块四端到端：建任务 → 上传 → **语义** → 装配 → **手工骨骼偏移（含「重跑骨骼后仍在」）** → **关键帧编辑（含「改动作废骨骼」「导出 JSON 里是改后的值」）** → 骨骼 → 图集 → 打标 → 删除级联（走真实模块代码，数据落在临时 DSH_HOME） |
| `node scripts/montage-parts.mjs <部件目录> <输出.png> <部件名…>` | 把若干部件拼成一张带分隔的对比图，用来人工核对「哪几块其实是同一个部位」。肉眼看蒙太奇小图分不清，放大并排才看得出来 |
| `node scripts/make-rig-fixtures.mjs <目录>` | 生成**免费**的合成部件 PNG（`--full` 出完整 16 件），让除拆件以外的整条链可以零成本测试 |
| `node scripts/probe-redraw.mjs <部件PNG> "<提示词>"` | **花钱**：直接调生图模型重绘一个部件并打印统计（与插件共用提示词构造器）。用于排查「是模型不行还是管线不行」 |
| `node scripts/e2e-rig-live.mjs <角色整图>` | 模块四真实链路：**真的调一次生图模型**拆件，再跑完装配/骨骼/图集（约 0.2 元） |
| `node scripts/verify-map-agent.mjs` | 地图编辑器 Agent 读模型与检查图（**35 项**）：`mapInspect` / `isoInspect` 的逐格文本、图例、预算截断与标记；`mapRender` / `isoRender` 的本机 PNG、区域裁切、标记叠加与清理；`dryRun` / `ifRevision`；标记 `kind/color/note/tags` 与 `@5` / `@2` 导出。 |
| `node scripts/verify-map.mjs` | 模块六几何 / 环绕 / 自动连接内核（**239 项**）：网格参数收口、布局与逐点命中、**环绕取模**（图外点折回、`inMap` 恒 true）、chunk 与脏块（**画第 0 行必须连带弄脏最后一行所在的 chunk**）、视口范围（起点可越界、各维最多一张地图）、整格 `corner16` 位序、A2 五形状表与四象限取邻、素材形态识别（A2 优先、`plain` 的 ≤32 降序试算）、`buildTiles` 按矩形 id 保留人工元数据、全局序号顺序、`cropTile` 像素、**AI 素材按形态规整 + 收口 + 无缝**（`fitFrameToCell` 中心等比裁切 + 最近邻缩放的逐像素对照、`stretchToSize` 的非等比映射、`sheetPlanOf` 三种形态的目标块阵、`capThicknessFor` 跟尺寸走、`shadeSide` / `shadeCorner` 的深度与「只动指定的那条边」、`corner16SheetFromTile`（满格块与砖逐像素相同 / 孤块四边都压暗 / **一排墙的拼接差 == 砖自身的环绕缝** / 整格多给一张必须抛错）、`a2SheetFromTiles`（满格行就是砖本身 / 形状 0/1/2/3 各自压哪几边 / 形状 3 的凹角）、`tileSeamRatios` 的比值与反向验证、`safeAssetStem` 的归一与边界、`parseAssetFps` 的边界、`parseClarity` / `parseAssetScale` 与 `resampleToSize` 三档（锐利 0 混色 / 平滑 256 混色、锐化对比更强、透明边缘预乘不拖黑）、`parseAssetLoop` / `applyLoop` 三种展开与边界、`trimUniformBorder` 六条正反用例（白框裁掉 / 纯色不裁 / 深色平底不裁 / 铺满纹理不裁 / 薄边裁掉 / 宽白边当背景）、`rotate90` / `joinCorner` 的像素级断言与「mask 5 真的换向、mask 10 保持横条纹」、整图的 `parseStampSpec`（含**下限 1**：1×1 合法、0 / 负数抛错）/ `stampSpan` / `stampBlocks` / `bakeStampSheet` 四档旋转像素断言）。含**反向验证**（把 wrap 关掉后那条脏块断言必须不再成立等）与**旧术语黑名单**（只扫 `模块六 · 地图编辑器` 到下一个分节注释之间的那一段；**全文件扫会误伤**模块④的「图集」与模块⑤的「等距」，所以那十个词在这两段里是有意保留的正确用词） |
| `node scripts/verify-map-pipeline.mjs` | 模块六数据层与流水线（**429 项**）：项目与素材 CRUD（导入 / 内置素材的 `known` 通道 / 换形态换格尺寸）、A2 **每格 4 条象限 op**、**翻页图的调色板每列只出一条**（内置道具 8 列 × 5 帧 → 8 条、自建 4 帧图 → 4 条，都落在第 0 帧）、动画 `cycle` 与 `frameCount`、**`dropKeys`**（客户端 `have` → 规范 chunk 映射，含环绕邻域）、**环绕接缝处全是「满格」形状**（8×8 全草地 + 跨左上边界视口 → 唯一 `t` 恰为 33/34/37/38；关掉 wrap 后 op 数远少于环绕那次，作反向验证）、`fill` / `rect` / `replace` 的格子数与 `stroke` **并成一条撤销**、**全量撤销重做回到逐项相同的计划**、防抖落盘与丢缓存重载、改尺寸丢格计数、单项目单地图（`map.json` 落在项目根）、一键生成三种算法**同种子逐字节一致**、预览与导出、**`map.json`（`dsh-gem-map@2`）逐字段校验 + 同文档两次导出逐字节一致**、改素材后的序号重排与引用保护、**AI 素材按形态规整**（`composeMapAsset`：普通竖排 + 逐像素帧序、整格用一块砖拼出 4 格 × 4 格并**真导入**验 16 块掩码 0..15、拼块每个变体一块砖拼成 N 列 × 5 行并**真导入**验变体数与 5×格子高、非方砖的 notes 比例提醒、**砖接不上自己时的接缝提醒 + 反向验证**、只整理不进 `tilesets`、空 files / 文件不存在 / 超上限 / 项目不存在 / **整格给多张**五条失败路径）、**素材自己的播放速度**（新增时带上 / `op.fps` 真进计划 / `fpsMax` 取最快那条 / 没设的素材不带 fps / 改与清 / 越界报错 / 内置不许改）、**清晰度**（合成留 4 倍 → 导入按三种清晰度缩到格子；1px 棋盘格锐利 0 混色、平滑 256 混色；波纹清晰比平滑对比更强；`scale=1` 逐字节原样；越界报错）、**循环方式**（第 19 节：三种方式下 `mapPlan` 的帧序真的不同、`frameCount` 跟着变、改完立刻生效、越界报错）、**自动裁边**（第 17 节：白框被裁掉且 `notes` 说清、没白框的不裁）、**一格多大**（第 20 节：16/64 网格下 AI 素材按网格出块、内置素材按比例缩放、忘填 cell 时有明确告警）、**原地重烘**（第 21 节：素材 id 与图块数不变、图片真换了、`map.json` 每格值一模一样、内置素材不许重烘、空 files 报错）、**整图**（第 22 节：导入规格 / 调色板一条 / 印一张 = 6 条 op / 转 90° 占格互换 / 帧序 / 区域三态 / **1×1 下限（compose 与导入都能走、只占 1 格）** / **属性窗口改通行区域（`saveMapTileset({stampPass})` 立刻生效、不动几何、长度 / 取值越界报错）** / 橡皮碰一格整张消失且撤销还原 / 导出 @4 的 cells / 删素材连带删整图 / 一键生成不铺整图）。导出这一段自带一个**真解包**的 ZIP 读取器：断言「多产物自动打包 / 条目 = 用户勾的那几项 / 与盘上那份逐字节一致 / 时间戳写死所以两次导出 zip 逐字节一致 / 只勾一项不打 zip / 每次导出先清空目录（上一轮的 map.json 不会留下）/ 勾了素材原图时包内路径与 `map.json` 的 `image` 同形」 |
| `node scripts/verify-map-gateway.mjs` | 模块六**走真实网关**（**228 项**）：wire 清单（24 个方法）与工具面覆盖、模块接线（`m` 前缀 / 阶段 / 上传槽位）、素材导入与形态切换、编辑 / 撤销 / `mapPlan({view, have})` 的差集、`runMapGenerate`、预览与导出的状态回流（含 zip 的可点 URL 与 `exportPath`）、并发提交只放行一个、`setMapApproved`、**资源路由真调一遍**（200 / 403 / 目录穿越 / 未知 scope / 非法 id / **zip 的 MIME 是 `application/zip`**；`maps/` 已不在白名单里、**`ai/` 在白名单里且 AI 素材图能 200 取回**）、`composeMapAsset` 走网关（文件路径与 `shape` 透传 / 三种形态的返回体 / 整格给多张报错 / 只整理不导入）、**工具面里 `composeMapAsset` 的 openUrl 带 `dialog=add&asset&frames&shape`**（形态是拼块时带的就是 a2quad）、`importMapTileset` / `saveMapTileset` 的 `fps` 不丢（schema 吞字段是这类「选了没反应」的经典成因）、`mapPlan.fpsMax`、`clarity` / `scale` / `loop` / `stampPass` 也不被 schema 吞（4 倍图 → 缩成 64×64 落盘；整图通行区域走网关真能改）、`createMapProject.grid` 不丢（建出来真的是 64 网格）、`revealMapProject` 与落盘结构、**整图**（`stamp` 规格不丢 / 调色板一条 / `stampPlace` 一次 6 格 / `stampMove` / `stampRotate` / `mapPlan({pass})` 三态 / 擦一格整张没了 / AI 那条路的 `composeMapAsset(shape:stamp)` 与回链 `cols`&`rows`）、`mapInspect` / `mapRender`（逐格 / 本机 PNG / 区域裁切 / 标记叠加）、`dryRun` / `ifRevision`、标记语义 `kind/color/note/tags` 与 `@5` 导出、`importMapTileset.path` |
| `node scripts/verify-map-client.mjs` | 模块六界面**真渲染 + 黄金对照**（**474 项**）：真加载 `lib/client.js` + **有状态会重渲染的迷你 React**，用**真宿主数据**渲染面板；顶栏项目名的「复制 ID」按钮会把 projectId 交给剪贴板。① 四个 `MAP_*` 坐标函数与宿主真实现逐点比对（环绕与非环绕两组 × 整张地图采样 + 边界点 + 图外点）；② **画布 `drawImage` 调用序列与宿主 `mapPlan` 计划逐项相等**（含 4 象限与动画帧，预览 = 导出），并按 `clearRect` 分帧收集、断言「挂载首帧 == 同一视口的计划」（增量缓存必须按**视口**失效，只按 key 判会让视口变大后新露出来的格子一直空着）；③ 在画布上点一下真的改了地图、撤销回得去、`dropKeys` 真的删掉了缓存；④ 空态、12 个工具格（6 列 × 2 行）、**调色板读宿主 `palette`**（A2 素材只出一个自动连接笔刷）；⑤ **导出卡片**：内容是多选、执行只有一个「导出」、倍率只在勾了 PNG 时出现、提交的 formats 就是勾的那几项、导完由 **busy 轮询**（`setInterval` 有真实现，由测试放出来）刷出新清单、主下载按钮指向 zip 且带 `download`、卡片写出本机绝对路径、「另存为…」先弹框再取字节（`pick>fetch>write>close`）；⑥ **源码与渲染文案两套黑名单**（源码那份只扫模块六切片，并放行唯一的协议字段 `"chunks"` —— 曾经为了骗过它写出过 `"chu" + "nks"`，那种写法比术语本身更坏）；⑦ **「模块⑥已转正」的反向验证**：产物里没有 `MapExperimentalDialog`、`MODULES` 条目没有 `experimental`、面板里没有角标与常驻提示条、`experimentalGateMuted` 里没有 `map` 这一格，同时反过来断言**模块⑤仍然带实验性标记**（别把转正顺手扩大化）；⑧ **工具小标签的层级**：`.SPR_mapEdTip` 的 z-index 必须高于对话框遮罩与看图遮罩（从 CSS 里取数比大小，配「旧值 60 判不过 / 没写 z-index 的选择器取不到数」的反向验证 —— 低了的话「新增素材」里的说明会被整片蒙层盖住，而 jsdom 看不见绘制顺序）；⑨ **「素材说明」三页**：三张示例图的 `src` 逐个字节等于 `renderGuideSheets()` 真产出的那张，网格的 `background-size` 等于**真实列数 / 行数 / 每块再分数**推出来的百分比（4×2 → `25% 50%`、4×4 → `25% 25%`、2×5 且每块再分 2×2 → `50% 20%` + `25% 10%`），图注里的数字跟着现算；页签 / 上一页 / 下一页 / 页码与「关掉说明窗口时草稿还在」「关掉「新增素材」时说明窗口一起消失」「草稿已选整格则直接翻到那一页」逐条验；网格动画则在 CSS 数值上钉 `infinite` 与「两层错开半拍」，并配「去掉 infinite 判不过」的反向验证；⑩ **「AI 生成素材」**：拼出来的提示词三种分岔（静态 / 生图多帧 / 视频抽帧）逐条断言、帧数越界夹到 1..16；**形态**按「自动（三种画法 + 判据都写进去、并把 shape 交给 `composeMapAsset`，含『不要分格 / 别自己先拼多格排布』）/ 指定（只写那一段、标明『用户已指定，不要改』）」分组断言；还钉住「notes 报接缝时不要自动重跑」这条；对话框四个控件与「帧数为 1 时视频模型点不动」；**新增素材的「动画速度」**：只对会动的素材显示这一项、可选值、点「确定」时 `fps` 真的交给宿主（假 `FileReader` + 假桥把 import 的属性原样转给宿主）、列表徽章，以及**拨 1 秒后 8 帧/秒的素材走 8 帧、跟全局 1 帧/秒的只走 1 帧**；**清晰度**（回链带 `scale=4` → 出现三个选项、默认平滑、点确定时 `clarity` / `scale` 一起发出去）、**循环方式**（静态素材不显示 / 三个选项 / 点「倒放」「来回」真的切过去 / 提交带上 `loop`）、**一格多大**（四档 + 说明 + 建出来真的是 64 网格，建完即删并切回 32）、**整图**（调色板整张缩略图 / 点一次一条 stampPlace / 拖动不连印 / 右键转 90° 且不擦除 / **切到标记·橡皮·油漆桶·吸管时悬停框回到 1×1、橡皮右键擦一格** / 橡皮碰一格提示整张 / 区域开关带 pass 与三色叠加 / 属性窗口的通行区域 / 对话框的占格与区域格子与提交）；点「生成」时用**假的 `sessions` / `uiWorkspace`** 断言「不带 workspaceId / cwd 地建会话 → 切到对话界面 → 以 queue 模式把拼好的正文发出去 → 引用用后即放」；回链 `dialog=add&asset&frames&shape` 走一遍：`fetch` 打桩返回真 PNG → 「新增素材」预填（名字 / 格子=项目网格 / **用法按回链里的 shape**：普通 → 普通、拼块 → 拼块且不预选翻页图、整格 → 整格；不认识的 shape 退回普通），图片 404 时仍打开空的「新增素材」并给提示 |
| `node scripts/verify-sfx.mjs` / `verify-sfx-gateway.mjs` / `verify-sfx-client.mjs` | 模块八：mock 火山引擎语音的请求 / 返回 / 错误 / 参考 / 导出 / 路由（**55 项**）、wire schema 不丢键 + 工具面 + 深链接 + 隐藏模块（**39 项**）、界面真渲染与草稿合并（**29 项**） |
| `node scripts/verify-ui.mjs` | 模块九「游戏 UI 生成」内核（**82 项**）：画布尺寸与画框校验（16 对齐 / 越界 / 面积为 0 / 文字框缺 text 全部抛错、不静默夹）、**两种 layout 格式的差异**（`compileUiLayout` 是 `abs_centralized`/`yxyx` 给 MOSS 文本编码、`draftUiLayout` 是 `abs`/`xyxy` 给切片节点，并反向断言两者对同一个框坐标确实不同 —— 混用会抛 `'dict' object has no attribute 'strip'` 或把框摆错）、**坐标换算与 Python 侧逐位黄金对照**（`y,x,y,x` 顺序、奇数尺寸用 `floor` 取中心）、背景板判定（≥50% 画布）、外扩裁切、MOSS 工作流（layout 直接进文本编码、**没有**编译节点、`type=moss_image`）、两种切图工作流（**WeVisOne 的 `model` 是字符串权重目录名、不是 MODEL 连线**，且没有 UNET/CLIP/VAE 节点、没有 `per_element`）、设置归一化（含 **`resolution=0` 不能被夹走** —— 夹成 256 会把裁片放大、切出来的图与画框对不上；**老数据的 `birefnet` 迁移成 `wevisone`**）、任务 id 前缀、PNG 尺寸解析，以及**界面静态契约**（画布必须同时覆盖 `backgroundSize` / `backgroundRepeat`、抠图下拉框必须绑宿主的 `sliceSettings.matte` 并真的存回去、不许有会漂移的本地 `sliceMode` state） |
| `node scripts/verify-ui-client.mjs` | 模块九界面**真渲染 + 静态契约**（**21 项**）：用迷你 React 真加载 `lib/client.js` 并渲染工作台，断言分发链里有 `ui` 分支、12 个远程方法都在 `api` 上；然后逐条钉住两个**只有真机才暴露**的 bug —— ① 画布有生成图时必须覆盖 `backgroundSize:contain` / `backgroundRepeat:no-repeat` / `backgroundPosition:center`（只设 `backgroundImage` 会被样式表里的 `background-size:20px` 当成图案平铺成「一堆小图的合图」），并有 `data-has-render` 与 CSS 兜底；② 抠图方案下拉框必须 `value: job.sliceSettings?.matte` 且 `onChange` 里调 `saveUiJob` 存回宿主（曾经是个纯本地 state，界面显示 BiRefNet、实际跑 Qwen，不报任何错）。生成 / 切图按钮都必须走 `BusyBtn` 带遮罩 |
| `node scripts/e2e-ui.mjs` | 模块九**真实链路端到端**（**会占显卡几分钟**，零计费）：真调本机 ComfyUI 跑 MOSS-Image 生图 → 按画框切图（默认 `wevisone`）→ 导出 zip，产物留在 `<DSH_HOME>/game-material-master/ui-jobs/` 并打印绝对路径。先跑 `testUiConnection` 确认节点包与权重都在，缺什么直接点名 |
| `node scripts/probe-ui-matte.mjs` + `probe-ui-matte-report.mjs` | 抠图方案 **A/B 对照工具**（不是自检；`probe` 会占显卡、`report` 只读）。`probe` 拿**同一张**已渲染的 MOSS 图，把 `wevisone` / `qwen` 各跑一遍落到 `output/gmm_ab_*/`；`report` 用内置 PNG 解码量 **alpha 分布 / 内部不透明度 / 与源图的 RGB 偏差**。⚠️ 这两个脚本存在的理由：曾用**两次不同的 MOSS 生图**分别跑两种抠图，把「源图本身模糊」误判成「WeVisOne 对大面板不行」—— 同一张清晰源图上 WeVisOne 的 RGB 偏差只有 **0.52**（逐像素忠实），Qwen 是 **30.11**（重绘并偏色）。**换抠图方案必须用同一张源图对照** |
| `node scripts/e2e-map.mjs` | 模块六**真实链路端到端**（不联网、不花钱）：内置素材（5 张，含 4 张 A2）→ 再合成导入一张 A2 与一张普通图 → 画满 24×24（自动连接长边）→ 叠一层普通图块 → 断言计划里「一格四条 op」→ 查一次跨边界的视口（环绕时 `visibleKeys` 会出现负数 key）→ 撤销 / 重做 → 一键生成三种地图 → 预览 → 导出，**故意留下产物**并打印绝对路径，方便人眼验收 |
| `node scripts/verify-custom-image.mjs` | **ComfyUI 生图后端**（**74 项**）：起一台本地假 ComfyUI，断言的重点不是「有没有返回字节」而是**请求真的长对了** —— 端点与顺序（上传参考图 → `/prompt` → `/history` → `/view`）、**占位符按 JSON 类型替换**（`{{width}}` 必须是数字）、参考图上传后文件名写进工作流（没写 `{{image}}` 时改 `LoadImage`）、四条失败路径（提交被拒 / 执行报错带节点名 / 空工作流 / 非法 JSON）、**参数发现与应用**（类型 / 范围 / 枚举候选来自节点定义，且**参数面板的值赢过占位符**），以及一条反向验证：**没给类型声明时会写错类型** —— 这条记录了「为什么必须传 declared」。另含多工作流六个纯函数（增 / 改名 / 删 / 删空补一份 / 丢非法 / 修重复 id）与配置归一化（老 `ark` / `custom` 归一到 `comfyui`、`customWorkflow` 迁移成列表一份）。 |
| `node scripts/verify-comfy.mjs` | 本地 ComfyUI 后端（**124 项**，纯本地、不联网、不花钱、**不需要真装 ComfyUI**）：脚本自己用 `node:http` 在随机端口起一个 mock，覆盖地址归一化与注入点解析、`parseComfyWorkflow` 的 **UI 格式自动转换**（官方 All-in-One 形状的夹具：控件值按 `widgets_values` 顺序取、`randomize` 不当种子、连线写成 `[来源节点, 槽位]`、没连的 `first` 留给探测、便签与静音节点丢掉、`droppedWidgets` 计数、新版对象形式的 `links`）、探测的**四级顺序**（显式覆盖回退 / 已有字面量量 / 已有 `LoadImage` / `object_info` 声明的 optional IMAGE）、两个 `LoadImage` 时首尾各用其一、注入的纯函数性与「插入节点只写 `image` 一个键」、`first_frame_reference` 自动打开、无首帧位置报错、以及 HTTP 层（`/system_stats`、`/queue` 排队中、`/history` 执行失败带出 node_type、上传 multipart、`node_errors` / `error` 两条失败路径、从 outputs 挑 mp4 而不挑 png、只有图片时判失败、Cookie 的归一化与「每个请求都真的带上了这个头」） |
| `node scripts/verify-host.mjs` | 宿主半区全链路（**387 项**）：六个模块的本地链路、**阶段①的转圈截帧（合成一段「转动」视频跑真实 ffmpeg，覆盖截帧位置、按比例换算、下游作废、切换生成方式）**、**换源图后由旧源图派生的产物整体作废（状态清空 + 磁盘文件真的删掉）**、**转圈首帧的时间兜底（正面图比源图旧时改用源图）**、**模块五的资源路由（真起一台 server 走 HTTP 取回 `iso-assets` 的素材图，并验证 403 与目录穿越）**、资源路由（含 `turn/` 白名单）、预览页的 `text/html`、目录穿越与 id 前缀校验、**本地自选视频（真实 ffmpeg 造的 MP4 走 `uploadVideo`：容器嗅探 / 槽位校验 / 下游作废 / 转圈导入后自动抽帧 / 摘掉在跑的远端任务号）与中间图片 zip（自检里带一个真解包的 ZIP 读取器：逐条比 CRC 与长度、断言八方向图 / 转圈候选帧 / 绿幕帧 / 抠像帧 / 整图都在包里，并真起一台 server 把 zip 下载回来）** |
| `node scripts/find-missing-i18n.mjs` | **工具**（不是断言）：列出所有还没进词条表的 `T("…")` 原文，直接输出可粘贴的条目 |
| `node scripts/verify-i18n.mjs` | 中英词条表契约：**每个 `T()` 都有英文条目 / 没有死条目 / `{nN}` 占位符两侧一致 / 译文不残留汉字与全角标点 / `lib/client.js` 与 `src/client.ts` 的词条表一致（忘了 build 就发版会整体退回中文）** |
| `node scripts/i18n-wrap.mjs` | 词法级 codemod：把 `src/client.ts` 里含中日韩字符的字面量包成 `T(...)`（模板字面量拆成 `{nN}` 占位符，幂等，`i18n-ignore-*` 区间不碰） |
| `node scripts/verify-tools.mjs` / `verify-client.mjs` / `verify-pipeline.mjs` | 对话调用面（**196 项**，含六个模块 status/review 的文字渲染与「隐藏的模块必须拒绝调用」、本地自选视频的槽位校验、**「AI 生成素材」回链的 dialog/asset/frames/shape 往返与坏值丢弃**）、浏览器半区契约（**362 项**，含「每个远程方法都有 api 实现」「本地自选视频与中间图片打包的调用点必须带 loading 反馈」「手动装配的四条回归」「功能管理 / 侧栏菜单的类名与接线」）、抠像回归（40 项） |



```bash
npm run build          # tsc → lib/，并剥掉浏览器束结尾的 export {}

# 纯本地测试（不联网、不花钱）
node scripts/verify-minimax.mjs    # MiniMax 协议层（85 项，含请求体逐字段断言）
node scripts/verify-comfy.mjs      # 本地 ComfyUI 后端（124 项，自起 mock ComfyUI，纯本地不花钱）
node scripts/verify-pipeline.mjs   # 抽帧/抠像/合成链路（40 项，含回归用例）
node scripts/verify-host.mjs       # 宿主冒烟（387 项，真实 cordis + 真实 HTTP；含内置默认提示词的语言切换、hiddenModules 落盘与收敛、生图后端两组配置与阻塞判断、模块五资源路由）
node scripts/verify-custom-image.mjs # ComfyUI 生图后端（74 项，本地假服务端；离线、零计费）
node scripts/verify-comfy.mjs      # 本地 ComfyUI 后端（124 项，自起 mock ComfyUI，纯本地、不用装 ComfyUI）
node scripts/verify-client.mjs     # 浏览器半区契约（362 项：阶段 ctx 键必须被转发、每个生成类调用点都带 loading 反馈、转圈时间轴与八圆圈、手动装配的四个坑、拆件质检 / IK 约束组件、功能管理 / 侧栏菜单的文本与样式契约）
node scripts/verify-feedback.mjs   # 浏览器半区渲染（203 项：真加载 lib/client.js，断言遮罩真的出现 / 空闲时真的不出现 / 转圈模式两种生成方式与八圆圈都在 / **「选择本地视频」入口真的在（label + 隐藏 file input，只收 video/*）与每一处「保存」链接（八方向图 / 条带 / 成片 / 预览带 / 整包出口），且没有产物时不渲染空链接** / 深链接点击真的切面板 / 隐藏模块后页签与菜单真的消失、设置页勾选真的写回宿主 / **生图后端：ark 与自定义两组同屏、协议下拉、ComfyUI 工作流文本框只在选中 ComfyUI 时出现、改工作流不立刻发请求** / 语义校验失败没有误报成功）
node scripts/verify-tools.mjs      # 对话调用面（196 项：工具 schema、方法覆盖、**客户端清单的 payload 标记与宿主 manifest 逐条一致**、返回值无损 JSON 审计、固定流程（含阶段①生成方式必问）、审核模式、深链接契约（含 AI 素材回链的 dialog / asset / frames / shape）、转圈模式的 status/review 渲染、**功能管理（每个方法都归了模块 / 隐藏后一律拒绝 / 可见性不许模型改）**）
node scripts/verify-i18n.mjs       # 中英词条表契约（9 项：覆盖 / 死条目 / 占位符 / 译文纯净度 / 产物同步）
node scripts/verify-live-bundle.mjs # 运行中的宿主是否已在提供新束（走 /plugins/events 拿真实 graph，再按图里的 URL 取回）

# 真实 API 端到端（会花钱）
node scripts/e2e-modules.mjs                                  # 图片 + 序列帧两个新模块（约 2.9 元）
node scripts/e2e-8dir.mjs --source hero.jpg --until images    # 八方向：先只出图，便宜
node scripts/e2e-8dir.mjs --source hero.jpg --mode turn --from turn   # 走默认的转圈截帧：一次视频调用 + 本机截帧
node scripts/e2e-8dir.mjs --project <id> --from videos        # 再续跑视频
node scripts/rerun-videos.mjs <项目 id> <方向,方向>            # 只重跑指定方向的视频
node scripts/retry-video.mjs <项目 id> <方向> [--soft]         # 单方向重试（审核拦截时用）
```

`verify-pipeline.mjs` 里有三个针对实测踩过的坑的回归用例：
**角色贴边**（边框采样混进角色的颜色 → 洪水填充把同色的身体部位整片吃掉，见「抠像是怎么做的」）、
**暖色渐变背景**（只认绿色的抠像会整片失效）与**软边缘渗漏**（局部容差放宽就会穿透）。

`verify-host.mjs` 除了走一遍四阶段，还钉住了「单方向重新生成视频」这条路：宿主的
`runVideos` 默认跳过已经 ready 的方向（防止重复提交把任务覆盖成无人认领的孤儿），
所以「重新生成」必须显式带 `regenerate` 让宿主先作废旧视频与它的帧——少一个都不行，
否则这次点击会被当成「已完成」过滤掉，界面转一圈就结束，失败原因只留在日志里
（实测报错：「没有可提交的方向：请先生成绿幕图，或先清掉已完成的视频」）。
这一段用**本地假网关**顶替 MiniMax：提交必然失败，但「有没有真的提交出去」一目了然，
且不联网、不花钱。

`verify-host.mjs` 里 `9c` 一段专门跑**转圈截帧**：本地 ffmpeg 合成一段「竖条扫过画面」
的视频当转圈素材（不同时刻画面不同，所以「不同方向切到不同的帧」可以按字节断言），
再真实走一遍 `runTurnFrames` → 抽候选帧 → 切八张方向图，逐条钉住：任务覆盖面（八个
方向，切完一个摘一个）、时间戳按 `i × 时长 / 张数` 分布、八个位置按**这次**张数等分、
拖动圆圈后**只有那一张**变、这一方向的行走视频与序列帧被作废、改候选帧数后位置按比例
换算。`turn/` 也在这条链路上顺带进资源路由的白名单——漏了它界面只表现为「轴上的条带
图裂了」，不报任何错。

`verify-client.mjs` 盯的是浏览器半区的另一类坑：阶段渲染函数从 `ctx` 里解构哪些键，
调用点就必须原样转发哪些键。漏传一个键**渲染完全看不出来**，只有点到那个按钮才会炸
（实测：第 2 步漏传 `api` → 点「生成视频」报 `Cannot read properties of undefined
(reading 'runVideos')`；第 3、4 步的 `runFrames` / `compose` 同样中招）。

后半段还钉住了「每个生成类调用点都必须带 loading 反馈」：文本层面确认
`start` / `run` / `kickAndWatch` 的实参里有 `{ key, label }`。

`verify-feedback.mjs` 再往前一步——它把 `lib/client.js` **真的加载起来**（假
`__ModuleLoader__` + 假 React + 假 document），用桩项目数据渲染出元素树，断言遮罩真的长出来了：
某个方向在跑时它的预览必须被 `SPR_ovl` 盖住、批量时还没轮到的方向也要盖住、
空闲时**一个遮罩都不能有**。这类问题肉眼极难发现：不盖遮罩时界面看着完全正常，
只是「点了没反应」，用户会以为按钮失效而反复点击——每次点击都是真实计费。

它还顺带钉住了两件事：**验收控件真的渲染出来**（三个模块都能看到审核模式下拉与「通过」按钮），
以及**深链接点击真的会切面板**——装上真的捕获阶段监听器，派发一次合成点击，
断言 `preventDefault` 被调用、`layout.selectPanel("gameStudio")` 被调用、意图被广播出来；
同时断言普通外链与 Ctrl+点击 / 中键**不被抢走**。

它的 React 桩是**按顺序喂 Hook 槽位**的（`EXPECTED_HOOKS` + `HOOK.slots` 数组），
所以**在组件顶部插一个 Hook 就会把后面所有 state 读串**。多语言那次在六个模块组件顶部
各插了一个 `useLocaleTick()`（一个 `useState`），表现就是 `usePendingTasks` 读到 `undefined`
直接抛错——桩里的槽位数组与 `EXPECTED_HOOKS` 要跟着一起加。数字对不上不是「测试太严」，
而是**Hook 顺序真的改了**：真实 React 下同样会读串，只是后果更隐蔽。
功能管理那次又踩了一次，而且更阴：**槽位是稀疏的**（`useRef` 也占下标却不读槽位），
把新的 `useState` 顺手 append 到数组末尾，它落到了 ref 槽上，测试表现是
「传了 `hidden: ["rig"]` 但页签一个都没少」——看起来像功能没生效。
新 Hook 必须**显式写它的下标**。

`verify-tools.mjs` 盯的是对话调用面这一类坑：工具 schema 必须落在 DSH 支持的关键字子集里、
`guide` 的 `methods` 目录必须**覆盖插件的每一个远程方法**、常驻工具面必须 **≤6,000 B**（少一个就是「某个功能对话里调不了」）、
固定流程第 0 步必须按真实状态算出要问什么（缺源图就问、已有源图就不问）、
审核模式必须只有 auto/manual 两个选项。**每一次 `run()` 还顺手审计一遍返回值能不能无损过
JSON**（`undefined` 键 / `NaN` / `Infinity` / `-0`）——新版 DSH 会对工具输出做这道校验，
不过就整次调用失败，而 `JSON.stringify` 自己会把这些问题抹掉，写成「stringify 之后没有
undefined」的断言永远为真（这里真踩过，见上面的坑）。它还把六个模块的 `status` / `review` 文字渲染
**真的跑一遍**——这几个渲染器按同一套字段写，而骨骼动画的阶段形状跟其它三个模块不一样
（没有 `cells`，只有 `status`），一律按 `cells` 迭代会让 `game_material({action:"review"})` 以
`stage.cells is not iterable` 整次失败，而按 `ready/total` 渲染 `status` 会印出一串
`undefined`；两种坏法都只在骨骼动画上出现，别的模块一条测试都不会红。
最后用**文本契约**把宿主 `links.ts` 与浏览器半区
`client.ts` 的深链接常量钉成一致——两边是两份实现（经典脚本不能 `import`），
参数名或模块名改单边会静默失效。

第 6.7 节是**功能管理**：先断言「每个 `TOOL_METHODS` 方法都归了模块」（归类表漏一个
就是「隐藏了但还能调」），再把 `hiddenModules` 写进配置，逐个工具验证被隐藏的模块
**一律被拒**（含只能按 payload 判断的 `setReviewMode`）、`status` 既不列清单也不给深链接、
`saveConfig({hiddenModules})` 被工具面拒绝，最后验证**取消隐藏后不需要重启就恢复可用**。

`verify-live-bundle.mjs` 回答的是另一个问题：「我改完了，运行中的宿主到底有没有换新束？」
自己拼 `/plugins/<id>/client.js` 一定 404（浏览器束是按模块图里带 rev 的 URL 提供的），
所以它先连 `/plugins/events` 拿真实 graph，再按图里的 URL 取回束并检查新标记。

### 调用接口时的反馈（loading）

三个模块里每一次「会出素材」的调用（生图 / 生视频 / 抽帧 / 抠像 / 合成 / 上传）
都必须让人一眼看见「正在跑」——否则按钮像是没生效，用户会反复点，而每次点击都是
真金白银。反馈分两层：

| 层 | 组件 | 用在哪 |
|---|---|---|
| 预览遮罩 | `LoadingOverlay` / `MediaBox` | 盖住缩略图、视频、序列条、整图、行走预览 |
| 按钮与徽章 | `BusyBtn` / `BusyBadge` | 按钮变转圈并置灰防重复提交；工具栏显示当前在跑什么 |

关键实现是 `usePendingTasks()` 这张按 key 记账的 pending 表，原因是**宿主把任务标成
running 落在下一次 `getProject` 里**：

- 点下去当场就把遮罩盖上（不等轮询回来），调用返回后还多留 700ms（`TASK_HOLD_MS`），
  避免「图已经变旧了但还没盖上」的闪一下；
- 判断条件是 `宿主状态 === "running" || tasks.has(key)`，两条路都能点亮遮罩；
- 批量操作有专属 key（`image:*all` 等），这样**还没轮到的方向**也能一并盖住，
  而不是只有正在跑的那一个变灰；
- 卸载后不再 `setState`（长任务可能几分钟才回来）。

### 批量任务跑多久，遮罩就得盖多久（`job.targets`）

上面那张 pending 表只活到**远程调用返回**为止，而批量任务是 kick 型调用：一提交就返回
`{started: true}`，真正的活在宿主后台一个方向一个方向地做（抽帧并发只有 2）。所以「还没
轮到」的判定不能只看本地 pending——实测的 bug 就出在这里：点「提取全部序列帧」后八个方向
先一起转圈，紧接着还没轮到的那几个变回「尚未抽帧」，过一阵才陆续出结果，看着像点击没生效。

因此宿主的运行表会公布**这次任务要负责哪些方向**（`project.jobs[].targets`，
见 `pipeline.ts` 的 `JobInfo`），界面按它决定盖不盖：

| 谁 | 什么时候 | 由谁负责 |
|---|---|---|
| `frames:extract` | 从任务登记（第一个 `await` 之前）到该方向的预览带写出来 | 抽帧节点自己的 running 状态；覆盖面负责「还没轮到」与「抽好了但预览带还没出」 |
| `videos:submit` | 逐方向提交的整段时间 | 提交成功后交给节点自己的 running 状态（覆盖面同时从该方向摘掉） |
| `images:all` | 整批生成期间 | 出图落地（成功或失败）后立刻摘掉，已通过验收、这次不重做的方向一开始就不在覆盖面里 |

两条硬约束（`verify-host.mjs` 钉住）：**覆盖面只包含真的有素材、这次真会做的方向**
（否则那个格子会一直转圈），**单方向操作只覆盖那一个方向**（否则其余方向被白白盖住）。
`verify-client.mjs` 用文本契约核对两边的任务 key：写错一个字不会有任何报错，
只是这条路静默失效。宿主半区是启动时装入的，**改完 `pipeline.ts` 要重启 DSH**；
浏览器半区刷新即可（旧宿主不带 `targets` 时这条路自动不生效，不会报错）。

`verify-client.mjs` 的文本契约与 `verify-feedback.mjs` 的真渲染断言一起保证：
新增调用点时忘了传反馈，或者遮罩在空闲时误开，都会在本地测试里直接失败。

### 工程结构

| 文件 | 作用 |
|---|---|
| `src/directions.ts` | 八方向定义、依赖关系、默认提示词 |
| `src/rigpose.ts` 的 `solveLayout` | 模块四的装配求解总入口（先验 → 匹配 → 冲突/遮挡/镜像消解） |
| `src/config.ts` | 全局配置、数据目录迁移 |
| `src/ark.ts` | 火山方舟生图客户端 |
| `src/minimax.ts` | MiniMax 视频客户端（v1/v2 双协议、首尾帧与多模态参考、优云智算版 `/minimax` 网关） |
| `src/comfy.ts` | 本地 ComfyUI 客户端（工作流解析、注入点探测、`/prompt` + `/history` + `/queue` + `/upload/image` + `/view`，内置 FreeVideo 模板） |
| `src/videogen.ts` | 视频后端分派：提交 / 查询 / 下载按**节点上记的** `backend` 走 MiniMax 或 ComfyUI |
| `src/media.ts` | ffmpeg / ffprobe 封装与路径查找（环境变量 → Windows 注册表 → 常见安装位置 → `PATH`） |
| `src/chroma.ts` | 背景分割、绿色抠像、裁剪、像素量化、合成 |
| `src/png.ts` | 极简 PNG 编码器（RGBA8，基于 node:zlib） |
| `src/jsonio.ts` | 新模块共用的 JSON 原子写与日志 |
| `src/store.ts` / `src/pipeline.ts` | 模块一：项目持久化与四阶段编排 |
| `src/imagegen.ts` | 模块二：图片生成任务 |
| `src/seqgen.ts` | 模块三：序列帧任务 |
| `src/spine.ts` | 模块四：骨骼层级推导、Spine 4.2 JSON、六个动画预设、图集文本 |
| `src/rigpose.ts` | 模块四：连通域分割、多尺度模板匹配、遮挡/镜像消解、合成与装箱 |
| `src/rigpreview.ts` | 模块四：自包含 Canvas 骨骼动画预览（零外部依赖） |
| `src/riggen.ts` | 模块四：任务持久化与四阶段流水线 |
| `src/wire.ts` | Typert 远程协议清单（**唯一真源**） |
| `src/links.ts` | 深链接：意图编解码、origin 记录、面板 key（与浏览器半区共用同一套约定） |
| `src/tools.ts` | 对话调用面：`game_material_*` 工具、固定流程第 0 步、系统提示词段 |
| `src/index.ts` | 宿主半区：远程服务 + 资源路由 + 工具注册 |
| `src/client.ts` | 浏览器半区：六个模块的界面（模块六是那个 `<canvas>` 地图编辑器） |

`src/client.ts` 由宿主直接以 `/plugins/dsh-game-material-master/client.js` 提供给浏览器，
因此**必须是经典脚本**（无 `import` / `export`），所有 React 元素用 `React.createElement` 构造。

---

## 已知取舍

- **像素风来自后处理，不来自提示词**（原因见上）。
- **视频提示词按任务共用，同时保留按方向覆盖位**（模块一的 `prompts.videoPerDirection`），
  目前界面只暴露共用那一份。
- **内容审核**：MiniMax 偶尔会以 `1026 content blocked by moderation` 拒绝（实测约 10% 概率）。
  换一版更中性的提示词重试通常就过——用 `scripts/retry-video.mjs <项目> <方向> --soft`。
- **整图行序与外部素材未必逐行一致**——各家行序不同，所以做成了可调项。
- **骨骼动画的自动装配依赖美术细节**。模板匹配在**平涂、低细节**的角色上会明显吃力：
  同色的一大片区域内部没有任何区分度，左右肢、同色衣料之间几乎不可分辨。实测一张
  256×256 的纯色矢量小人和一张有明暗细节的立绘，自动命中率差一倍以上。
  这种情况下插件不会硬猜：低相似度的部件会被标出来，没匹配上的先放在「待摆放」区，
  用户在合成图上直接拖、或者用数值输入微调即可——每一步都不花钱。
- **拆件质量由生图模型决定，而且这是目前最大的瓶颈**。提示词已经明确要求
  「方形画布、等分网格、一格一件、四肢必须断开、与原图完全同款」，实测
  Seedream 4.0 有时会**把角色换成另一个**：拿一张「戴发箍、深蓝连衣裙、白围裙、
  鲸鱼尾巴的女仆」去拆件，它交回来的是同一张脸配白短裤和光腿的一具裸身——
  服装、发型、体型全换了。这种拆件图**不可能**匹配回原图，再调匹配参数也没有意义。
  **换 Seedream 5.0 Pro 后角色设定守住了**（同一张立绘：4.0 交回来的是换掉
  服装 / 发型 / 体型的另一个角色，5.0 Pro 交回来的是同一个女仆，连围裙上的鲸鱼
  和尾巴都在），但它把角色拆成了**服装裁片**（裙摆、袖子、领子、袜腿、鞋），
  而不是整段肢体——这些裁片的外观只覆盖参考图的一小块，模板匹配依然摆不准。
  插件不会假装自己摆对了，两道检查会明确拦住：
  - **结构合理性**：头被摆到脚下面 / 大腿下面时直接判定「自动定位结果明显不合理」；
  - **平均相似度**：低于 0.32 时告警「拆件图与参考图很可能不是同一个角色」。
  两条都会给出同样的三条出路——① 用「部件 PNG」上传框传自己的部件
  （**文件名即部件名**，完全绕开生图，也是目前**唯一可靠**的路径）；
  ② 换生图模型重新拆件；③ 在合成图上手工拖到正确位置。
- **自动装配目前只对「部件是整段肢体、且与参考图外观一致」的素材可靠**。
  实测结论：合成素材（部件就是参考图上切下来的整块）能到 16/16 命中、包围盒重合；
  真实立绘走生图拆件时还不能指望——因为拆件图是**重画的**，裁片与参考图的
  局部外观差异足以让匹配摆错位置，而且相关系数依然不低（实测有 0.48），
  纯靠分数发现不了。所以两道结构检查（头在下、均分过低）是必要的兜底。
  想要立即可用，走「上传自己的部件 PNG」这条路径。
- 模块一的默认行序是**罗盘顺时针**（北→东北→东→东南→南→西南→西→西北）；
  早期版本的生成依赖顺序会被自动迁移一次，之后你手动设成任何顺序都会被尊重。
- 模块四的动画预设（`src/spine.ts` 的 `RIG_ANIMATIONS`）只对**标准人形骨骼名**生效：
  部件名对不上就没有对应的时间轴。表外名字的部件仍然会进骨架，只是不会动。

## 音乐生成编辑（模块七 · `music`）

### 为什么单开一个模块

八方向图 / 图片 / 序列帧都在做「视觉素材」，而音乐是**长时音频 + 外部生成平台 + 本地后期**：
生成要轮询几分钟、结果要下载成可变现的音频文件、后期要 ffmpeg、失败重试会重复计费。
把它塞进图片模块只会把两套状态机搅在一起。

### 数据与落盘

```
<DSH_HOME>/game-material-master/music-jobs/<a…>/
├── job.json
├── songs/<songId>.mp3|.m4a|.wav       平台返回的原曲（下载后本地播放/编辑）
├── songs/<songId>-cover.jpg|.png      封面
├── songs/<songId>-lrc.json            滚动歌词原始对齐数据
├── versions/<v…>.<ext>                每次编辑的新版本（永不覆盖原曲）
├── peaks/<hash>.json                  波形缓存（键含文件大小/mtime/桶数）
├── tools/<toolTaskId>/…               分轨 / MIDI / 乐谱 / 转码产物
└── out/<安全名>.<ext> / <任务名>.zip   导出
```

- 任务 id：`a` + base36 时间戳 + 6 位随机；`moduleForId("a…")` → `music`。
- **所有写 `job.json` 都走 `patchMusicJob()` 的按任务串行队列**。轮询器与用户改名/保存同时
  发生时，后写的不会覆盖前一次改动——这是「改了名字过一会儿又变回去」的唯一根因。
- 原曲与版本分开放：编辑失败 / 删除版本都不会伤到原曲；`versions/<id>` 只增不改。

### 状态机与计费闸门

`runMusicGeneration` 先落一条 `submitting` 的 generation，再启动后台任务：

`submitting → polling → succeeded | partial | failed | timeout | canceled`

- 同任务已有任务在跑 → 拒绝（`started:false`）。
- **已有歌曲后再提交必须 `regenerate:true`**；失败重试也会再计费，工具描述与对话提示词都要求
  先问用户。
- `cancelMusicGeneration` 只停本地轮询；已提交给平台的生成仍会完成并计费，返回文案必须写清。
- 查询 404（文档：未完成 / 不属于当前账号）按「还没完成」处理，继续等到 `musicPollTimeoutMs`；
  超时标 `timeout` 而不是 failed，`refreshMusicJob` 可继续查。
- 下载失败不判整首失败：歌曲保持 `succeeded`，记 `downloadError`，远程 URL 仍可播。
- **下载音频必须按文件头校验，不能只信 `Content-Type`**：Suno 的音频 URL 偶尔会先返回一段
  未完成 / 加密的临时对象，`Content-Type` 仍是 `audio/mpeg`；只信它就会把随机字节落成 `.mp3`，
  界面表现为「有歌名、但第一首放不了」。`downloadToFile({requireAudio:true})` 用 `sniffBinary`
  校验 mp3/m4a/wav/flac/ogg/aac；`ensureLocalSong` 对已存在但文件头无效的本地文件先删后重下
  （一次重试，必要时加 cache-bust）；`musicSnapshot` 对坏文件返回 `file:null` 并回退到远端
  `audioUrl`，刷新时再重新下载。`verify-music` 用「先返回伪音频」的 mock 钉住拒绝、回退与修复。
- `activateMusic()` 每次 `apply` 复位 `disposed` / 任务表；`resumeMusicJobs()` 只**查询和下载**，
  绝不重新提交。`resumeGeneration` 是重启后的接续入口。

### 谱乐 AI 客户端（`musicapi.ts`）

- Base URL + `Authorization: Bearer …`；错误体统一 `{error:{type,code,message,param,request_id}}`。
- 生成端点映射集中在 `buildGenerationRequest`：Suno（prompt/custom/cover/extend/mashup/sample/concat）、
  Mureka（prompt/custom/instrumental）、MiniMax（custom）、ACE-Step（prompt/custom）。
- **长度上限显式报错，不静默截断**：Suno prompt 500 / lyrics 5000 / tags 1000；Mureka lyrics 3000；
  MiniMax prompt 2000 / lyrics 3000。截断会把最后一段歌词悄悄吃掉。
- `assertDownloadUrl`：只接受 http(s)，公网 Base 时拒绝本机/私网（SSRF）；用户把 Base 配成本机
  mock/反代时放行本机。下载流式写 `.part` 再 rename，带大小上限。
- 工具接口（分轨/MIDI/乐谱/风格分析/转码）只接受**公开 URL**；本地编辑版本不能直接传。

### 本地音频（`musicaudio.ts`）

- 滤镜链：`atrim → asetpts → volume → afade(in) → afade(out) → loudnorm`；
  淡入淡出之和超过段长时按比例缩放；`loudnorm` 失败自动去掉它重试并写 warning。
- 格式：MP3 `libmp3lame`、WAV `pcm_s16le`、M4A `aac + faststart`；无有效操作且格式相同 → 直接复制。
- 版本以 `opsHash`（源文件 mtime/size + 规范化 ops）去重；`force:true` 才重跑。
- 波形：4kHz 单声道 s16 → 分桶取最大 → 全局归一化；缓存键含 mtime/size/桶数。
- 只用 `media.runFfmpeg`（内部 `ffmpegPath()`），参数数组、绝不拼 shell。

### 对话面

- `game_material({action:"call"})` 通过 guide 暴露全部音乐方法；`intake` 对 `music` 有专用问题（含「直接生成 / 谱曲模式」与谱曲依赖状态），缺谱乐 Key 不再硬阻塞谱曲；
  `status` 列表带 `musicJobs`；`review` / `wait` / `approve` 都有 music 分支。
- `runMusicGeneration` / `renderMusicEdit` / `exportMusic` 的 `openUrl` 自动带
  `stage=generate|edit|export`，用户点回就落在对应卡片。
- 系统提示词与 `buildMusicRequestPrompt` 都要求：先 `getMusicGuide` → 扩写/保存方案 →
  `runMusicGeneration` → `game_material({action:"wait"})` → 可选后期 → 把 `openUrl` 原样贴成 Markdown 链接。
- 创作指南（`musicguide.ts`）来自 **bitwize-music-studio/claude-ai-music-skills（CC0-1.0）**，
  只吸收方法论（风格提示词结构、歌词 13 点 QC、Suno 模型选择、母带响度目标）并改写为中英双语。

### 界面里的产物地址

宿主 `musicSnapshot` 里的 `url` / `coverUrl` 是绝对地址，依赖浏览器上报的 `location.origin`。
插件刚重载、或新宿主刚起来时上报可能还没到，`originForLinks()` 会退化成 `http://localhost` ——
真机上表现为**封面全裂、播放器 0:00、播放键没反应、下载链打不开**。

两条修法同时保留：

1. `reportClientOrigin` 失败时**退避重试**（最多 20 次、250ms），把真实 origin 补报上去；
2. 界面**优先用相对路径**：`musicAssetUrl(job, file, fallback)` 从 `job.assetBase` + `file` 拼，
   只有拿不到本地文件才退回平台远程地址。`song.coverUrl` / `song.url` / `version.url` /
   `export.url` 都不直接进 `src` / `href`。

### 资源路由

- `AssetScope` 加 `music-assets`；`resolveAssetTarget` 用 `musicgen.musicAssetPath`；
  `SCOPES` 数组加一项；`SERVABLE_MUSIC_DIRS` 唯一真源在 `musicgen.ts`。
- MIME 加 mp3/wav/m4a/aac/flac/ogg/mid/pdf/xml/musicxml/lrc；已有 Range 支持进度拖动；
  `?download=1` 加 `Content-Disposition`（ASCII 回退 + RFC 5987 中文名）。

### 自检

- `verify-music.mjs`：mock 谱乐 AI + 真 ffmpeg，86 项（端点映射、状态机、计费闸门、下载、
  编辑/淡入淡出/loudnorm、波形、工具、导出 zip、路由 200/206/403/下载头、402/429/坏 JSON）。
- `verify-music-score.mjs`：谱曲模式，46 项（方案归一化、假 Python 脚本、脚本报错/不产出 MIDI、
  MIDI 元数据、内置试听、逐版修改、波形、乐谱包、Suno mock 的音频上传/cover/confirm/regenerate/
  版权通道/scoreId、老任务迁移、深链接）。纯本地、零计费。
- `verify-music-gateway.mjs`：走真实网关，52 项（wire schema 逐键不丢、工具面、深链接、
  隐藏模块、谱曲字段与依赖状态）。
- `verify-music-client.mjs`：真渲染 + 假 sessions，65 项（创建卡、歌曲/编辑/版本/导出、
  谱曲创建卡 / 谱曲卡 / 提示词 / 深链接、新对话不挂靠项目、功能管理）。

### 谱曲模式（本地 MIDI）

- 数据：`music-jobs/<a…>/scores/<c…>/` 下 `plan.json` / `compose.py` / `score.mid` /
  `preview.mp3|wav` / `report.json` / `run.log`；`scores` 已加入
  `SERVABLE_MUSIC_DIRS`。`MusicStage` 增加 `compose`，老任务读出来自动补。
- 方案：`saveMusicScorePlan` 只存方案，不产生 MIDI；`runMusicScore` 要求已有方案
  （或本次内联 `plan`），先方案后谱曲。每版 `MusicComposition` 独立，旧版保留。
- 执行：`runMusicScore` 用**参数数组、无 shell** 的 `spawn` 跑 agent 写的
  `compose.py`；cwd = 该版目录；环境变量白名单，**不传任何 API Key**；180 秒超时
  杀进程组；stdout/stderr 各 1MB；必须产出 `score.mid`。报错原文（常带小节号）
  回给 agent，失败只把 `stages.compose` 标 error，不新增版本。
- 依赖：`detectScoreDeps` 探测 Python（能 `import scoremill`）、scoremill 版本、
  FluidSynth、SoundFont、ffmpeg；`testMusicScore` 强制刷新；配置项
  `musicPythonPath` / `musicFluidsynthPath` / `musicSoundfontPath`（空 = 自动探测）。
  设置页与工具面共用同一份状态。`GMM_SCORE_RENDERER=builtin` 可强制内置音源。
- 试听：FluidSynth + SF2 优先；缺任一用 `midipreview.ts` 的 GM 近似合成器
  （按 program family 选波形、通道 9 鼓、CC7/CC10、峰值归一 -1 dBFS，不压缩），
  再经 `media.runFfmpeg` 转 192k MP3；失败保留 WAV。`midifile.ts` 只解析 SMF 0/1。
- 交 Suno：**Suno 不接受 MIDI 原文件，但接受音频**。`submitMusicScoreToSuno` 先把这一版
  试听音频 `POST /v1/suno/audio/upload`（multipart；标准上传免费）拿参考 song id，再用
  `POST /v1/suno/generate/cover` 生成。标准通道被判定版权时返回 `needsCopyrightConsent`，
  用户确认后传 `copyrightAudio:true` 走付费版权通道（`copyright_audio_flag=1` + 轮询
  `GET /v1/suno/audio/upload/{taskId}`）。强制 `confirm:true`，已有歌曲必须
  `regenerate:true`；`MusicGeneration.scoreId` / `sourceClipId` 记录来源。超过 360 秒按
  360 秒提交并 warning。界面与提示词都要写明「不会逐音一致」。
- 界面：新建卡的两种工作流；谱曲卡（方案 / 逐版试听 / MIDI 下载 / 通过 / 交 Suno /
  导出乐谱包 / 查看 compose.py）；设置页依赖状态与路径；深链接
  `stage=compose&score=c…`。
- 自检：`verify-music-score.mjs`（46 项，假 Python + 手工 MIDI + 内置合成器 + mock
  上传/cover），`verify-music-gateway` 钉住所有新 payload 字段不丢，`verify-music-client`
  钉住谱曲卡与提示词。

## 音效生成（模块八 · `sfx`）

### 为什么是独立模块

音效与音乐不是同一类任务：音效走**火山引擎豆包语音**的生成式音频接口、同步返回、没有歌曲 / 歌词 /
版本编辑；音乐走谱乐 AI 的异步任务。认证、计费、产物模型都不同，混在一个模块里会让设置与任务模型都变复杂。

### 接口契约

```text
POST {sfxBaseUrl}/api/v3/tts/create
Content-Type: application/json
X-Api-Key: <语音控制台 API Key>
X-Api-Request-Id: <uuid>

{
  "model": "seed-audio-1.0",
  "text_prompt": "…",
  "audio_config": { "format": "wav", "sample_rate": 24000,
                    "speech_rate": 0, "loudness_rate": 0, "pitch_rate": 0 },
  "references": [{ "image_data": "<base64>" }] 或 [{ "audio_data": "<base64>" }, …],
  "watermark": { "aigc_watermark": true }
}
```

- **模型名是短名 `seed-audio-1.0`**，不是方舟的 `doubao-seed-audio-1-0`。
- **不发 `X-Api-Resource-Id`**；`/tts/create` 不需要它。
- 同步返回：`audio`（base64）/ `duration` / `original_duration` / `url`（2 小时临时地址）。
  计费按 `original_duration`；单次上限 120 秒。
- `text_prompt` 上限 2048 字符；没有 duration 参数，时长只能写进提示词。
- 参考：图 1 张（jpeg/png/webp），音频最多 3 条（wav/mp3/ogg_opus，每条 ≤30 秒 / 10MB）；
  图与音频**互斥**。音频在提示词里按 `@音频1…@音频3` 引用。
- 常见错误：401/403 → Key 不对（不是 Ark Key）；`resource not granted` / `10074` → 去语音控制台
  开通模型；429 → 限流；超时 → 调 `sfxTimeoutMs`，重试会再计费。

### 落盘与状态机

```text
<DSH_HOME>/game-material-master/sfx-jobs/<f…>/
├── job.json
├── refs/      参考图 / 参考音频
├── takes/     每次生成一条，永不覆盖
└── out/       导出（单条 / zip）
```

`runSfxGeneration` 先落 `status=running`，再起后台任务；成功追加一条 take，失败写 `status=error`
且**不新增 take、不自动重试**。`patchSfxJob` 是按任务串行队列，避免界面保存与后台收尾互相覆盖。
`activateSfx()` 每次 `apply` 复位 `disposed` / 任务表；`resumeSfxJobs()` 把重启前残留的 `running`
标失败（同步接口没有远端 taskId 可续查，只能提示可能已计费）。

### 静态资源

- `AssetScope` 加 `sfx-assets`、`resolveAssetTarget` 分支、`SCOPES` 数组、
  `SERVABLE_SFX_DIRS`（唯一真源 `sfxgen.ts`）四处同步；子目录 `refs` / `takes` / `out`。
- MIME 至少 `.mp3` / `.wav` / `.ogg` / `.opus`；`<audio>` 与 `?download=1` 都依赖它。
- 响应字节必须用 `musicapi.sniffBinary` 按文件头校验；`Content-Type` 不可信。

### 界面

- 左侧任务列表 + 「新建音效」；右侧提示词 / 格式 / 采样率 / 三档速率 / 水印 / 参考 / takes / 导出。
- 生成按钮带 `BusyBtn` 与 `LoadingOverlay`，文案写明每次真实计费；Key 未配置时禁用。
- 生成中每 2.5 秒拉一次 `getSfxJob`；提示词与参数用 `mergeDrafts()`，切任务才 `force`。
- 产物 URL 从 `job.assetBase` + 相对 `file` 拼（复用音乐模块的相对地址逻辑），不直接依赖绝对 URL。

### 自检

- `verify-sfx.mjs`（55 项）：mock 语音服务，请求路径 / Header / body、base64 与 URL 返回、
  伪音频拒绝、401 / 10074 / 空响应、并发闸门、取消、重启恢复、参考互斥与上限、导出、资源路由、
  以及「只重试握手前网络错误」的判据。
- `verify-sfx-gateway.mjs`（39 项）：wire schema 逐键不丢、工具面归类、深链接、隐藏模块、
  配置字段、intake / status / review / approve / upload。
- `verify-sfx-client.mjs`（29 项）：模块注册、设置页字段、远程方法清单、草稿合并、真渲染
  （新建卡 / 任务卡 / 参考 / takes / 生成 / 遮罩）。

## 游戏 UI 生成（模块九 · `ui`）

全本地零计费，但要占显卡、分钟级。三段固定顺序：**layout（画框）→ generate（生图）→ slice（切图）**。

### 两种 layout 格式，别混用

| 消费者 | 格式 | 由谁产出 |
|---|---|---|
| MOSS-Image 的文本编码 | `abs_centralized` / `yxyx` | `compileUiLayout()` |
| 切片节点（WeVisOne / Qwen-Edit） | `abs` / `xyxy` + `width`/`height` | `draftUiLayout()` |

给切片节点喂编译版会抛 `'dict' object has no attribute 'strip'`；给文本编码喂草稿版则会把框摆错。
`verify-ui.mjs` 对同一个框断言两者坐标确实不同，防止有人「统一」成一种。

### 抠图两方案的取舍（同一张源图的实测）

同一张 1024×1024 的 MOSS 渲染图，两个画框各跑一遍（`probe-ui-matte.mjs`）：

| 画框 | 方案 | 产物尺寸 | 内部不透明度 | RGB 与源图偏差 | 耗时 |
|---|---|---|---|---|---|
| 面板 800×696 | **WeVisOne-VL** | 791×683 | 249.2 | **0.52**（逐像素忠实） | 3 秒 |
| 面板 | Qwen-Image-Edit | 800×704 | 254.7 | 30.11（重绘） | 214 秒 |
| 标题文字 | **WeVisOne-VL** | 416×56 | — | **2.43** | 1 秒 |
| 标题文字 | Qwen-Image-Edit | 441×99 | — | 45.02（重绘） | 约 1500 秒 |

两处 Qwen 的毛病都不是「抠得不准」，而是**它会把元素重画一遍**：

- 面板：宝箱从浅蓝变成饱和蓝、按钮变成亮黄、外圈金边被吃掉一大半。
- 标题文字：**把标题下方那条金色分隔装饰一起画了进来**，产物比 WeVisOne 高一倍（99 vs 56）。

结论：**UI 切图要的是「原图那块像素 + 透明通道」，不是「重新画一遍」**，所以默认 WeVisOne。
Qwen-Edit 仍是可选项 —— 元素与背景颜色太接近、指代描述定位不到时，它的编辑式去底更稳。
另外 Qwen 明显更慢（两个框共 29.5 分钟，WeVisOne 4 秒），因为它每个框都要跑 25 步采样。

⚠️ **换抠图方案必须用同一张源图对照**。曾经用两次不同的 MOSS 生图分别跑两种抠图
（MOSS 有随机性），把「那张源图本身就糊」误判成「WeVisOne 对大面板不行」，差点改错默认值。
`scripts/probe-ui-matte.mjs`（跑，占显卡）+ `probe-ui-matte-report.mjs`（只读，量 alpha 与 RGB 偏差）
就是为这件事留的，`report` 里按 ±24px 搜最佳位移再比 RGB —— 产物是紧裁的，
按画框原点直接对齐会整体错位，量出来的偏差没有意义（曾把「文字抠得很准」量成 141）。

### WeVisOne 的三处接线特性

- `model` 是**字符串**（`models/wevisone/` 下的权重目录名），**不是** MODEL 连线；整个工作流没有 UNET / CLIP / VAE 节点。
- 没有 `per_element`（那是 BiRefNet 的参数）；也没有 `resolution` —— 指代定位走 VLM，不吃这个数。
- 首帧加载 4.6 GB 权重要 **9~10 分钟**，之后每框几秒。`keep_loaded:false` 是故意的：UI 是一次一批，留着白占显存。

### 两个上游坑（节点包自身的 bug，插件侧兜住）

1. **Qwen-Edit 写完 manifest 必崩**：`Object of type ModelPatcherDynamic is not JSON serializable`。
   此时 PNG **已经在盘上**，但 `/history` 的 `outputs` 是空的。所以切图走 `waitComfyHistory(..., { tolerateError: true })`
   + 扫盘兜底。
2. **扫盘时 prefix 的语义**：节点把 prefix 最后一段当**文件名前缀**、不是目录名，
   文件落在 `output/<prefix 去掉最后一段>/` 下、命名 `<最后一段>_NN_*.png`。按目录理解会一个都找不到。

### 界面两处踩过的坑

- 画布背景图被平铺成「一堆小图的合图」：只设 `backgroundImage` 会被样式表里给棋盘格写的
  `background-size:20px 20px` 当成图案铺满。有生成图时必须同时覆盖 `backgroundSize` / `backgroundRepeat` /
  `backgroundPosition`，并加 `data-has-render`。
- 抠图方案下拉框曾是纯本地 state，从没发给宿主，而 `runUiSlice` 读的是宿主的 `sliceSettings.matte` ——
  界面显示一个方案、实际跑另一个，不报任何错。现在直接绑 `job.sliceSettings.matte` 并在 `onChange` 里 `saveUiJob`。

### 自检

- `verify-ui.mjs`（82 项）：画框校验、两种 layout 格式差异、坐标与 Python 侧黄金对照、MOSS 与两种切图工作流、设置归一化（含 `resolution=0` 不能被夹走、`birefnet` 迁移）。
- `verify-ui-client.mjs`（21 项）：真渲染 + 两条反向验证（画布背景、下拉框绑定）。
- `e2e-ui.mjs`：真实链路，会占显卡。

## 许可

[MIT](LICENSE)













