# Changelog

## 未发布（unreleased）

### 覆铜调查结案（扩展 0.4.7 / 0.4.8 真机）

结论：**这台构建（EDA 3.2.186 / pro-api 0.3.18.0bc12bb0）无法通过 API 创建铜面图元**。不是参数问题，证据链如下。

| 尝试 | 结果 |
|---|---|
| `pcb_PrimitivePour.create` 静态入口 × 8 种组合（单/复杂多边形、原始源码数组、空网络、层 1/2/字符串、全参数显式、100×100 与 300×300 mil） | 全部 `无法创建覆铜边框图元` |
| 实例入口 `new IPCB_PrimitivePour(...).create()`（0.4.7 新增，验证构造器在运行时可取） | 同样报错 |
| 填充方式 `solid`/`45grid`/`90grid`/`0`/`1`/`2`/`SOLID`/`GRID45`/`45GRID` | 全部报错 |
| `pcb_PrimitiveFill.create`（文档说明它同样带 `net` 参数）× 4 种（对象/原始数组/复杂源码/显式 fillMode） | 全部 `无法创建填充图元` |
| **控制组**：同一多边形管线写丝印折线 `pcb_PrimitivePolyline` / `pcb_draw_polyline` | 也写不出来（`getAll` 0 条），而 `pcb_get_polylines` 内部路径能读到既有板框 1 条 |

外部资料也到此为止：`prodocs` 正文是前端渲染（HTML 只有导航），官方配方给的流程就是我们实现的那条（`createPolygon`/`createComplexPolygon` → pour → `rebuildCopperRegion`），搜 "无法创建覆铜边框图元" 无任何社区解法，应用 bundle 内也搜不到该字符串。

**因此撤掉 `pcb_create_copper_fill`**：它在这台构建上必然失败，留着就是给调用方挖坑。白名单里的 `pcb_MathPolygon.createComplexPolygon` 与 `pcb_PrimitiveFill.*` 保留（换构建可能有效），但不再包装成工具。

**正解**：覆铜在界面手工铺（GND → 顶层+底层 → 重新铺铜）；`eda_design_audit` 会持续把缺覆铜记成 `copper-pour` warn，`eda_delivery_checklist` 也会带上它。

## 1.0.1 — 2026-10-20

1.0.0 的真机回归修掉 4 个 bug（全部由"跑一遍"发现，不是靠读代码）：

1. **原理图几何审计误报 30 对重叠**（`eda_schematic_audit`）
   `sch_PrimitiveComponent.getAll` 的列表里混着图框/标题栏图元，其包围盒是整张页面（实测 `0..1170 × 0..825`），于是与每个符号"重叠"。现在**丢弃面积超过页面 40% 的图元**并在 `droppedSheetPrimitives` 里报数量；复测：30 对误报 → **0 fail**（31 器件 / 30 个有效包围盒 / 丢弃 1 个）。

2. **参数持久化"报成功但没写"**（`eda_design_intake`）
   ① `dmt_Project.modifyProjectDescription` 在本机构建上**返回 false、不生效**（与 create/delete/copyProject 同类）；② 我的调用还把文本当成 uuid 传。现在：先按官方签名 `(projectUuid, description)` 写并**回读校验**，失败则落到工程目录侧的**侧车文件** `.dsh-eda-spec/<uuid>.json`，`persisted` 只在真的读回成功后为 true，并新增 `persistVia`（`description` / `file` / `none`）与 `persistPath`。真机复测：`persisted=true via=file`。

3. **PCB 机械检查是死代码**（`eda_design_audit`）
   `pcb_PrimitiveComponent.getAll([undefined, undefined])` 在该构建上返回**空列表**（同样的 API 在 `pcb_get_components` 里能取到 29 个器件），导致器件重叠 / 出板框两项检查从未执行。改用与 `pcb_get_components` 相同的调用形态，并把 `counts.componentsRead` 暴露出来；复测：`componentsRead: 29`。

4. **交付清单挂死超时**（`eda_delivery_checklist`）
   自动切文档后紧接着调网表导出会被页面加载阻塞 → MCP 超时。现在切文档后等待 1.5 s；同时把**跳过**与**失败**分开：新增 `verdict`（`pass` / `incomplete` / `fail`）、`skippedSteps`、`failedSteps`、`next`，默认仍自动切文档。真机复测：**一次调用 7.5 s，四步全过 `verdict=pass`**；`switchDocuments:false` 时如实报 `incomplete` 并指出缺哪个文档。

### 回归结果（扩展 0.4.6 / 桥接 1.0.1）

| 项 | 结果 |
|---|---|
| `eda_schematic_audit` | ✅ 0 fail / 1 warn（12 个符号偏离 10 单位栅格）/ 1 skip（无标签锚点） |
| `eda_netlist_erc` | ✅ 15 项全执行，14 pass / 0 fail / 1 warn（USB-C SBU1/SBU2 未接） |
| `eda_design_intake` 持久化 | ✅ `persisted=true via=file` |
| `eda_design_audit`（PCB） | ✅ `componentsRead:29`、0 违规 / 4 警告（5V 线宽偏细、无覆铜、无丝印、无定位孔） |
| `eda_delivery_checklist` | ✅ `verdict=pass`、7.5 s、四步（ERC / BOM / PCB 审计 / Gerber 86.8 KB） |
| `eda_pcb_canvas_origin` | ✅ 偏移 `0,0`，画布↔数据坐标互转一致 |
| `eda_pcb_create_pour` | ❌ **仍失败**：单多边形与复杂多边形都被接受，但 `pcb_PrimitivePour.create` 对任何网络/层/填充方式一律拒绝 → 判定为**应用侧限制**（1.0.0 里我写"是我用错 API"，据此修正） |

### 已知遗留（需你决定）

- 侧车目录 `D:\文档\LCEDA-Pro\projects\.dsh-eda-spec\` 是回归测试写入的（1 个 json），清理需要你确认（它在你的工程目录内）。
- 覆铜只能手工：工具已把失败原因写准，`eda_design_audit` 持续报 `copper-pour` warn。

## 1.0.0 — 2026-10-20

第一个稳定版。0.7.4 之后这一轮把"能画"推进到"画得对、画得像参考设计、交付有证据"：工具 106 → **109**，单测 6 → **8 套**，线协议 0.4.2 → **0.4.6**。

### 新增工具

| 工具 | 作用 |
|---|---|
| `eda_design_intake` | 开工前参数问卷：6 个部分 22 问（14 个 critical），每问带 why/options/fallback；答复写进工程描述持久化（`[dsh-eda-spec]`），下次会话自动读回 |
| `eda_schematic_audit` | 原理图几何审计：符号出框、压标题栏、符号互相压住、偏离 10 单位栅格、标签落进符号体 |
| `eda_netlist_erc` | 网表级电气烟雾测试（12 → **15 项**）：位号重复、悬空脚、单端点网络、器件全脚同网、电源脚悬空、缺去耦、USB D± 成对、晶振负载电容、复位 RC、BOOT 下拉、Type-C CC 下拉，以及 **BOM 可下单性**（缺料号/排除出 PCB/缺封装） |
| `eda_delivery_checklist` | 交付检查：ERC + PCB 审计/DRC + Gerber + BOM 一次串完，逐步 PASS/FAIL，可 `outPath` 落 Markdown 报告 |
| `pcb_draw_text` | PCB 丝印/装配/文档层文本 |
| `pcb_draw_mounting_hole` | 非金属化定位孔/槽孔（`ELLIPSE` 焊盘 + `ROUND`/`SLOT` 钻孔） |
| `eda_capture` | 文档渲染成 PNG（可 `cleanup:true` 删除本会话写过的临时截图） |
| `eda_pcb_canvas_origin` | 画布坐标 ↔ 数据坐标（官方：界面显示画布、API 用数据），可 `align:true` 归零 |

### 修掉的真问题

- **能力边界错报**：`eda_list_api_methods` 报桥接本地副本却宣称是扩展白名单，`eda_api_call` 又被同一份副本前置拦截 → 改为**以扩展自报为准**（`dsh.internal.listApiMethods`），桥接不再预拦，永远不比扩展更严。
- **覆铜"无法创建"其实是 API 用错**：官方要求**复杂多边形**（`createComplexPolygon`）且建完必须 `rebuildCopperRegion()` 才计算铜皮；之前用单多边形，故一直失败（我一度误判为应用限制）。
- **定位孔创建失败**：`pcb_PrimitivePad.create` 必须给 `pad` 形状，且槽孔只能用 `ELLIPSE(长,宽)`（`OBLONG`/`RECTANGLE` 会被拒）。
- **网络标签降级时多余文本**：`createNetLabel` 不可用时过去同时放 stub 与纯文本；现在默认只留 stub，`textLabel:true` 才加文字。
- **PCB 网络校验**：未知网络的走线/过孔曾被接受（留下幽灵网络），现写入前用 `pcb_Net.getAllNetsName` 校验。
- **导出编码/分发门**：BOM 按 BOM 判编码（UTF-16LE 可读）；分发门同时接受 `FILE_METHODS`（Gerber/BOM/网表/截图原本全被挡）。
- **参考基线校准暴露我的两条误报**：EDA 自生成网络名 `$1N6954` 被判非法、官方示例标准的 15 mil 被判"不在 0.05 mm 步进"（另有 9.81 mil 舍入噪声）。

### 规则与文档

- 技能从 12 章扩到 **17 章**：第 0 章（开工前问参数）、9b（PCB 设计工艺）、9c（外部对照与失败模式）、9d（验证与交付三件套）、第 12 章（环境与生效范围）。
- **参考基线**（本地实测官方 `示例工程_快速入门`）：走线 98 条用 **15/25 mil**、覆铜 1、**丝印文本 19**；据此给 audit 增加 `silkscreen-text` 与 `mounting-hole` 检查，并把 12/15/25 mil 列为标准档。校准后官方示例 **0 违规 / 0 警告**，本机 STM32 板 0 违规 / 4 警告（5V 线宽偏细、无覆铜、无丝印、无定位孔）。
- 外部对照来源写进技能：HWE-Bench（执行驱动验证）、6 模型×嘉立创 EDA 横评、KiCad sch-api #104（标签落点）、ST AN4488/AN2586、TI USB Type-C 参考设计、IPC-2221/7351。
- 系统提示新增四条硬规则：开工先问参数、看图判据（4 个必看时机 + 看完清理）、布线/投板前跑 ERC、交付前跑 checklist。
- 截图是临时文件：`eda_capture` 记录本会话写过的路径，`cleanup:true` 只删这些路径。

### 门禁

typecheck 0 · **8 套单测全过**（node-runtime/config-values/design-rules/seams/eda-launch/skills/netlist-erc/schematic-audit/design-intake 中新增 3 套）· contract-check PASS（109 工具 / 109 schema / 103 API 调用面）· build 0 · `guard:bundle` PASS · `docs/tools.md` 109 工具 0 未分组 · `docs/schematic-workflow.md` 286 行 / 17 章。

### 未在真机验证（诚实记录）

线协议 0.4.5/0.4.6 的改动（覆铜复杂多边形 + `rebuildCopperRegion`、canvas-origin 四个方法）以及本轮四个新工具，发布时扩展处于断开状态，**未做真机回归**。使用前请导入 `dsh-eda-bridge-extension-0.4.6.zip` 并重启 EDA，然后按 9d 章跑一遍 `eda_delivery_checklist`。

## 0.7.4 — 2026-10-20

发布后补：v0.7.3 已上 npm，但它的两个流水线问题和两处诚实性问题是在 tag 之后才修的，这一版把它们发出去。

### 诚实性修复（宿主侧，线协议不变 = 0.4.2，**无需重导扩展**）

- **`opened` 必须表示"目标文档真的被激活了"**：导入新扩展会重启 EDA，应用回到 Start Page（`tab_page1`），旧实现靠"标签数 > 1"猜，于是又谎报 `opened: true`。现在要求 `activeDocumentUuid === documentUuid`，新增 `activated` 字段，提示里直接写"先 `eda_open_project` 再开文档"。
- **空 BOM 不再装成功**：PCB 活动时 `getBomFile` 返回 null，原来给 `{bom:"", encoding:"unknown"}`，看着像"BOM 是空的"。现在直接报错并给出修复动作（切到原理图页）。

### CI 两处真 bug（这就是 v0.7.3 一度没上 npm 的原因）

- **`publish.yml` 的守卫误杀自己的文档字符串**：守卫用 `Select-String -Path lib/*.js -Pattern 'node_modules/'`，而它命中我写进技能第 12 章的正确文案（`node_modules/dsh-eda-mcp/dsh-eda-bridge-extension-<版本>.zip`），于是 `exit 1`，`Publish` 步骤从未执行。已抽成 `scripts/guard-bundle-paths.mjs`（`pnpm guard:bundle`），只认**绝对路径形态**的构建机泄露（`D:/…/node_modules`、`/home/`、`/Users/`、`/root/`、`node_modules/.pnpm`），两个 workflow 共用；并做了负向验证（注入泄露 → exit 1 并报出文件与行号）。
- **`check.yml` 上传已被删除的别名 zip**：0.7.0 起构建只产出 `dsh-eda-bridge-extension-<版本>.zip`，而 workflow 仍指向 `dsh-eda-bridge-extension.zip` 且 `if-no-files-found: error`，导致 check 一直红。改为版本号通配，并把 `guard:bundle` 加进 check。
- **防复发**：`test/seams.test.ts` 新增 6 条断言 —— check.yml 必须用版本号通配、两个 workflow 都必须调用共享守卫、不得内联重写守卫、`guard:bundle` 必须在 `pnpm check` 链里。

### 仓库卫生

- `.tmp-*` 加入 `.gitignore`，并删掉之前误提交的临时文件（提交信息临时文件曾随 `git add -A` 进库）。

### 门禁

`pnpm check` = typecheck → 6 套单测（含 seams 新增断言）→ `contract-check` → `build` → **`guard:bundle`**；本次发布前全部复跑通过。

## 0.7.3 — 2026-10-20

本版把原理图与 PCB 两侧都跑了一遍真机，修掉 5 个真问题，并把「三层改动的生效范围」写进随包文档，避免新会话无从下手。

### 真机验证 0.7.2 时发现并修掉的 3 个问题（线协议 0.4.0 → **0.4.1**）

> 线协议升到 0.4.1（扩展版本只递增最小位，不跳 minor）：**需要重新导入 `dsh-eda-bridge-extension-0.4.1.zip`**（扩展代码有改动）。

**1. BOM CSV 仍乱码（真因在扩展）**

- 现象：`eda_export_bom` 返回 `��N\u0000o\u0000.`。
- 排查：桥接侧的 `decodeTextPayload` 没救回，因为字节在**扩展**里就按 UTF-8 解成替换字符了（`blobToFilePayload` 对所有 `text/*` 一律 `TextDecoder("utf-8")`）。
- 修复：扩展按**BOM 判定编码**（`FF FE`→utf-16le、`FE FF`→utf-16be、`EF BB BF`→utf-8），并在返回值里带 `encoding`；桥接侧解码保留为旧扩展兜底，返回值新增 `encoding` 字段。

**2. `eda_open_document` 静默不建标签页**

- 现象：应用刚启动停在 HOME 时，`dmt_EditorControl.openDocument(uuid)` 返回空且**不创建标签页**，随后所有 tab 相关调用读空——调用方以为页面已激活。
- 修复：调用后 600 ms 复查 `getSplitScreenTree` 与活动文档，返回 `opened` / `activeDocumentUuid` / `tabIds`；未建标签页时给 `hint`（"该构建不会从 HOME 程序化打开文档，请先在应用里点开页面，别假设已激活"）。真机复测：工程加载完成后 `opened:true`，标签列表含原理图页与 PCB 页。

**3. 构建会把旧版本 zip 一起打包**

- 现象：升版本后目录里同时存在新旧两个扩展 zip，而 `package.json files` 用的是 `dsh-eda-bridge-extension-*.zip` 通配 → 两个都会进 npm 包。
- 修复：构建前**清掉所有** `dsh-eda-bridge-extension*.zip`；`npm pack --dry-run` 现在只有 1 个 zip（40 files）。



### 真机验证 PCB 侧：又抓到一个拦截 bug（线协议 0.4.1 → **0.4.2**）

**1. 所有导出（BOM / 网表 / Gerber）本该被第二张白名单挡住**

- 现象：`eda_pcb_export_gerber` 报 `API method not allowed: pcb_ManufactureData.getGerberFile`。
- 真因：扩展的分发门只查 `ALLOWED_API`，而 `FILE_METHODS`（返回 File 的方法：BOM、网表、Gerber、截图）是**第二张表**，被门挡在外面 —— 上线以来所有 `FILE_METHODS` 导出其实都走不通（BOM/网表"能用"是因为它们同时也在 `ALLOWED_API` 里）。
- 修复：门改为 `!ALLOWED_API.has(m) && !FILE_METHODS.has(m)`，报错信息里给出两表合计数量；`contract-check` 增加一条断言：**分发门必须同时接受 FILE_METHODS**（之前只校验两表并集，所以漏了）。

**2. PCB 写入没有校验网络是否存在**

- 现象：`pcb_draw_track({ net: "NO_SUCH_NET" })` **被应用接受**，板上多出一条幽灵网络的线（DRC 会报 netlist error）。验证时实际留下了一条，已用 `eda_pcb_delete_track` 清掉（98 条线、0 条幽灵）。
- 修复：`pcb_draw_track` / `pcb_draw_via` 写入前用 `pcb_Net.getAllNetsName` 校验网络是否存在，不存在则拒绝并列出前 12 个已知网络；`force:true` 仍可强制。真机复测：两条都被拒绝，提示里带 17 个真实网络名。

### PCB 侧真机验证结论（EDA 3.2.186 / 扩展 0.4.1）

| 项 | 结果 |
|---|---|
| `eda_open_document(pcb)` | ✅ 活动文档 `documentType:3`，tabId 带 `@projectUuid` |
| `pcb_get_layers` | ✅ 289 个层（id/name/type/color） |
| `pcb_get_nets` | ✅ 17 个网络 |
| `pcb_get_components` | ✅ 33 个器件，含封装与 LCSC 料号 |
| `eda_pcb_get_drc_rules` | ✅ 返回完整规则配置（间距矩阵等） |
| `eda_pcb_run_drc({includeVerboseError:true})` | ✅ **2.8 s** 返回结构化违规（`name/errorType/ruleName/explanation`），本次 1 条：Netlist Error（PCB 与原理图不一致） |
| `eda_design_audit({drc:false})` | ✅ 返回 `counts/minWidthByNet/violations/warnings/checklist/rules`（1 violation、1 warning） |
| `pcb_draw_via`（孔径 0.1mm） | ✅ 拒绝：孔径低于 0.2mm 且焊环 0.1mm 低于 0.2mm |
| `pcb_draw_track`（未知网络） | ❌→✅ 修复后拒绝（见上） |
| `eda_pcb_export_gerber` | ❌ `API method not allowed` → 已修，需重导 **0.4.2** 复测 |
### 批量标签改用受控并发（实测 2.2 倍）

- `eda_place_net_labels` 原来是串行 for 循环：真机实测**每个标签约 2.1 s**（应用按图元落库），133 个仍需 ~4.6 分钟。
- 改为 `mapLimit` 受控并发（默认 4，可用 `concurrency` 调 1–8），结果仍按调用方顺序返回。
- 真机复测：**8 个标签 7.5 s = 938 ms/个**（串行 2.1 s/个），清理后计数 19 → 11。
### 真机验证结论（EDA 3.2.186 + 扩展 0.4.0）

| 项 | 结果 |
|---|---|
| `eda_status` / `eda_launch` | ✅ 走 explorer 启动，8.7 s 内 1 个客户端连上，版本一致 |
| `eda_list_projects` | ✅ 7 个工程（跨 2 个本地目录聚合） |
| `eda_open_project({name})` | ✅ 中文名解析并打开，`opened:true, openReturned:true` |
| `eda_export_project` | ✅ 1 056 444 字节 |
| `eda_export_netlist` | ✅ `parsed:true`，80 647 字节，返回真实 netlist 对象（含 `DC1` 等器件） |
| `eda_get_components` / `eda_get_pins` | ✅ 34 个器件；引脚返回 `pinNumber` / `pinName`（3/3 有值） |
| `eda_get_net_labels` | ✅ `count:11, attributeCount:0, textCount:11`（以前恒为 0） |
| `eda_place_net_labels`（批量 3 个） | ✅ 单次调用 7.0 s、`done:3 failed:0`、`method:"text"`；计数 11 → 14，`sessionTextLabels:3` |
| 批量标签清理 | ✅ `eda_delete_primitive(kind:"text")` ×3 后回到 11，未保存文档 |
| `eda_zoom_to_fit` | ✅ 应用返回的越界 bounds（-121…1776 / -2.5…1172）被裁剪为 `0..1170 / 0..825` 并重新应用 |
| `eda_run_drc` | ⚠️ 只能拿到聚合项 `{type:"warn",count:1}`：即使 `includeVerboseError:true`，该构建也不返回 primitiveId/坐标。工具说明与 hint 已按实情改写 |
| `eda_export_bom`（真机） | ❌ → 已修（见上），需重导 0.4.1 后复测 |


### 发布流水线修掉两个 CI bug（v0.7.3 因此没上 npm）

**1. `publish.yml` 的"无构建机路径"守卫误杀**

- 守卫用 `Select-String -Pattern 'node_modules/'` 扫 `lib/*.js`，命中了我自己写的**文档字符串**`扩展 zip 位置：node_modules/dsh-eda-mcp/dsh-eda-bridge-extension-<版本>.zip`（这是要告诉用户的正确信息，不是泄露的构建机路径），守卫直接 `exit 1`，**publish 步骤从没执行**。
- 修复：守卫抽成 `scripts/guard-bundle-paths.mjs`（`pnpm guard:bundle`），只认**绝对路径**形态的泄露（`D:/…/node_modules`、`/home/`、`/Users/`、`/root/`、`node_modules/.pnpm`），两个 workflow 共用同一实现。
- 真机验证：注入 `D:/Program/…/node_modules/.pnpm/x.js` → 守卫 `exit 1` 并报出文件与行号；恢复后 PASS。

**2. `check.yml` 上传的是已被移除的别名 zip**

- `path: dsh-eda-bridge-extension.zip` + `if-no-files-found: error`，但构建自 0.7.0 起只产出**带版本号**的 zip（别名是故意删掉的）→ 上传步骤失败，整个 check workflow 红。
- 修复：改成 `dsh-eda-bridge-extension-*.zip`，并把 `pnpm guard:bundle` 也加进 check。

> 影响：`v0.7.3` 的 tag 已推，但 npm 上仍只有 `0.7.2`。补法：在 Actions 里手动运行 `publish` 工作流并勾选 `publish`（`workflow_dispatch` 从 main 取代码，自动带上这两个修复），无需重打 tag。
## 0.7.2 — 2026-10-20

本版把原理图批量落地的 15 个问题全部处理完（13 修、2 记为限制），并把工作规范正式注册成 DSH 技能、扩成完整项目手册。

### 技能内容补全：从「原理图规范」升级为「项目全流程手册」

技能正文从 2513 字符扩到 **9262 字符 / 12 章 / 149 行**，覆盖一个嘉立创项目从打开到出 Gerber 的完整链路：

| 章 | 内容 |
|---|---|
| 0 | 适用范围与硬前提（坐标/单位/图框、活动文档语义、版本一致性、禁止自动布局） |
| 1 | 项目层：列出 / 按名打开 / **导入即新建** / 保存 / 导出，以及本构建不可用项与替代 |
| 2 | 原理图读取顺序（活动文档 → 页信息 → 器件包围盒 → 引脚一次拿全 → 连线/网络/标签 → 工程结构） |
| 3 | 布局规范（10 单位栅格、信号左→右、电源上/地下、间距、功能框、挪件保标注、导出图片自查） |
| 4 | 连线与网络（wire 语义、跨区域必须用端口/标签、标签降级与 stub、`*_at_pin`、差分对命名、未连接标记、删除 kind） |
| 5 | 批量与超时控制（`eda_place_net_labels`、≤20/批、进度锚点、探测结果按会话缓存） |
| 6 | 原理图校验（网表端点、DRC 明细、BOM 解码、命名比对） |
| 7 | PCB 全流程（同步与对话框、读层/网络/焊盘、板框、布局、走线/过孔/铺铜、自动布线策略、DRC+审计、Gerber） |
| 8 | 设计规则速查（网络名、线宽档位、过孔尺寸、铺铜间距、丝印） |
| 9 | **故障与处置表**：14 类现象 → 原因 → 动作（未连接、版本不匹配、白名单拒绝、60s 超时、空返回、createNetLabel 不响应、标签查不到、导线 net 被改、重叠、导入 uuid 冲突、工程 API 无效、命令行被忽略、强制关闭丢改动、read 截断） |
| 10 | 三段端到端剧本（改已有原理图 / 新建工程出板 / 只做 PCB） |
| 11 | 交付前 8 项检查清单 |

配套改动：`src/skills-content.ts` 成为**唯一内容源**（技能正文 + 系统提示精简版 + 文档都由它派生）；新增 `scripts/gen-skill-doc.mjs` 生成 `docs/schematic-workflow.md`（并入 `pnpm docs`），杜绝文档与技能漂移；`test/skills.test.ts` 扩到 **37 条断言**（12 章齐全、正文 >6000 字符、14 个关键工具名、故障表头）。
### 技能（skill）正式注册 + 自动布局拒绝后的引导

- **技能通过 `ctx.skills.registerProvider()` 注册**（不是只有系统提示）：新增 `src/skills.ts`，提供 `jlceda-schematic-workflow` 技能（kebab-case、rank 500 优先于用户根 400、`TRIGGER when` / `DO NOT TRIGGER` 齐全，正文 2513 字符 = 布局规范 + 网络/标签规则 + 批量与超时 + 失败先看返回值）。宿主没有 skills 服务时（旧版本）自动跳过，不报错。
- 新增 `test/skills.test.ts`（11 条断言：provider 名、单一技能、kebab-case、可被模型/用户调用、trigger 文案、rank、正文长度与关键段落、未知技能返回 undefined），已加入 `pnpm test`。
- **`eda_auto_layout` / `eda_auto_route` 的拒绝消息改成可执行的引导**：不再只说"被禁用"，而是列出 7 步替代流程（确认活动原理图 → 读图框安全区 → 盘已有器件 → 10 单位栅格 `eda_place_component`/`eda_move_component` → `eda_draw_wire` 局部连线 + 跨区域用网络端口/标签 → `eda_export_netlist` + `eda_run_drc` 校验并导出图片自查 → `eda_workflow_guide`），并明确"除非用户明确要求，不要用 force:true 重试"。

注：技能注册在**宿主重启**后生效（插件重新加载），桥接 reconnect 不够。
### 原理图批量落地暴露的 15 个问题：修了 13 个，2 个只能记为限制

全部来自一次真实的 45 网络原理图绘制（EDA 3.2.186、已登录、半离线）。**本轮没有改动扩展白名单，线协议仍是 0.4.0，已装扩展无需重导。**

#### 网络标签 / 可用性（影响最大的三项）

- **createNetLabel 探测不再每次都付 4 秒**：探测结论按**会话缓存**（`netLabelSupport`），首次失败后直接走文本降级；`probe:true` 可强制重测。133 个标签从 ≈15 分钟降到一次批量调用。
- **新增 `eda_place_net_labels([…])`**：一次 MCP 调用放多枚标签（按引脚或坐标），逐条返回 `ok/error` 并给出 `done/failed/total`，不再"超时前无进度、只能重来推断"。
- **`eda_get_net_labels` 现在真能列出标签**：同时枚举 `sch_PrimitiveAttribute.getAll`（netlabel/netport/netflag）与 `sch_PrimitiveText.getAll`（文本降级标签），并报告 `attributeCount/textCount/sessionTextLabels`；之前放置后仍 `count:0`。

#### 静默失败与不可审计图元

- **`eda_copy_project` 不再静默**：底层返回值原样透出（`raw`），异常包装成可读错误，`copied:false` 时给 `hint`（该构建对本地工程无效，建议应用内复制或导出+导入生成独立副本）。
- **`eda_delete_primitive` 支持 `netport` / `netflag` / `netlabel`**（走 `sch_PrimitiveAttribute.delete`）：网络端口不再只能靠记住放置时的 id 才能删。
- **新增 `eda_move_component`**（`sch_PrimitiveComponent.modify`）：原理图挪器件不必删除重放，designator/value 不丢。

#### 往返次数与返回值规范

- **`eda_get_pins` 一次返回 `pinName`/`pinNumber`**（`getAllPinsByPrimitiveId` 的完整记录，不再被 `summarizePrimitive` 削掉）：20 器件 135 引脚从 135 次额外往返降到 20 次。
- **`eda_run_drc` 返回逐条明细**：改用 `includeVerboseError:true`，给出 `type/message/primitiveId/x/y` 加原始记录；之前只有 `[{type:"warn",count:4}]`。
- **`eda_export_netlist` 单层结构**：结果是已解析对象（`{parsed:true, netlist}`），不再需要二次 `JSON.parse`；`format:"text"` 保留原始字符串。
- **`eda_export_bom` CSV 解码 UTF-16LE**：不再出现 `N\u0000o\u0000.` 这种不可读文本。
- **`eda_open_project` / `eda_import_project` 的 `opened` 可信了**：改为轮询 `getCurrentProjectInfo` 直到 uuid 匹配（默认 4 秒），同时保留 `openReturned` 反映 API 原始布尔；首次返回 false 但实际已切换的问题不再误导调用方。

#### 自动布局/布线策略（按你的要求）

- **默认禁止**：`eda_auto_layout` / `eda_auto_route` 现在需要 `force:true` **且**设置里开启「允许原理图自动布局/自动布线」（新配置项 `allowAutoLayoutRouting`，默认关；环境变量 `DSH_EDA_ALLOW_AUTO_LAYOUT`）。
- 新增 `eda_workflow_guide` 工具与 `docs/schematic-workflow.md`：栅格对齐、信号流向、跨区域走网络端口、版面用导出图片核对；系统提示同步加了 4 条规范（含"同名导线不成立"的实测结论）。

#### 其他

- `eda_zoom_to_fit` 返回的越界 bounds 现在**按图框裁剪**并重新应用（之前 `left:-340 / bottom:-772.9`）。
- `eda_api_call` 报 `API method not allowed` 时给出白名单规模与指引；新增 **`eda_list_api_methods`** 直接列出全部 166 条方法。
- `eda_import_project` 增加 **uuid 碰撞检查**：导入后对比其它工程的 internal ids（schematic/page/pcb），在 `collisions` 里报告（`checkCollisions:false` 关闭）。

#### 只能记为限制（无法在插件内修复）

- **原理图元件与网络端口不在 `eda_get_components` / BOM / 网表里**：属应用行为。已提供 `eda_get_net_labels` 枚举 + `kind:"netport"` 删除来替代审计。
- **导入 `.epro2` 不重生成内部 uuid**：属应用导入实现。插件只能检测并告警（见上）。

#### 附录（已写进工具说明与文档）

- `eda_draw_wire` 的 `net` 只对**悬空导线**有效：端点一旦接触引脚，EDA 会按连通性重算网络名（实测 `TESTNET` 并入 `LED_A`）；跨区域同名网络必须用网络端口/网络标签。

## 0.7.1 — 2026-10-20

构建产物修正：**扩展 zip 只保留带版本号的那一个**。

- 0.7.0 里为了不打破旧引用，同时产出了 `dsh-eda-bridge-extension-0.4.0.zip` 和同内容的 `dsh-eda-bridge-extension.zip`（SHA256 完全一致）。两个同内容文件摆在一起只会让人分不清哪份是当前版本，属于多余的冗余，删掉。
- 现在只生成 `dsh-eda-bridge-extension-<线协议版本>.zip`。所有引用改为**按版本解析**：
  - `src/index.ts`：从 `jlc-extension/extension.json` 读版本号拼出文件名（找不到时回退旧的固定名，兼容旧布局）；
  - `src/routes.ts`：下载响应头用实际文件名的 `basename`，浏览器另存下来自带版本号；
  - 设置卡片的下载链接去掉固定的 `download` 属性，改由响应头决定文件名；
  - 桥接里所有提示语改成 `dsh-eda-bridge-extension-' + VERSION + '.zip`；
  - README（中/英）、CONTRIBUTING、`docs/release.md`、扩展头部注释同步。
- `package.json files` 去掉固定名条目，只保留 `dsh-eda-bridge-extension-*.zip`。

线协议仍是 **0.4.0**，扩展内容未变——已导入 0.4.0 的机器**无需重新导入**。

## 0.7.0 — 2026-10-20

主题：把「操作嘉立创EDA」从**画图**扩展到**应用与工程**层面，并把这一路真机联调暴露的 bug 全部修掉。

> **线协议 0.3.5 → 0.4.0**：扩展白名单有变动，**必须重新导入** `dsh-eda-bridge-extension-0.4.0.zip`，否则新工具会返回 `API method not allowed`。用 `eda_status` 的 `extensionVersions` 核对。

### 新增工具（83 → 97）

- **应用控制**：`eda_launch`（启动 EDA，可选带工程，并等扩展连上；Windows 上把启动交给 `explorer.exe`，见下）、`eda_close`（先优雅后强制，返回关闭前后进程数）。
- **工程**：`eda_list_projects`（无过滤时跨本地目录聚合）、`eda_get_project`、`eda_open_project`（uuid 或**中文工程名**）、`eda_create_project`、`eda_delete_project`、`eda_modify_project`（改名/描述）、`eda_copy_project`、`eda_import_project`（**导入即建工程**，需目标团队）、`eda_export_project`（给 `outPath` 直接落盘）、`eda_close_document`。
- **工作区**：`eda_get_workspace`（当前工作区 + 团队）、`eda_list_teams`、`eda_list_folders`。
- **设置卡片**新增「嘉立创EDA 可执行文件（可选）」输入框（`edaExecutable`，留空自动探测）。

### 真机验证过的能力（EDA 3.2.186、已登录、半离线）

| 能力 | 结果 |
|---|---|
| 启动 / 关闭 EDA | ✅ `eda_launch` 走 explorer 交接，5 个进程 + 窗口，扩展 9 s 内连上；`eda_close` 5 → 0 进程（强制路径） |
| 列出全部本地工程 | ✅ 跨目录聚合，7 → 8 个 |
| 按中文工程名打开工程 | ✅ 两次成功 |
| 打开原理图页并读取 | ✅ 页 `P1`、器件 `DC1`、板卡 `波形变换电路` |
| 导出工程文件 | ✅ 1 056 450 字节 / 1.9 s |
| **导入工程（= 变相新建）** | ✅ 新建出 `DSH-IMPORT-TEST`（4.7 s） |
| `createProject` / `deleteProject` | ❌ 该构建无副作用（详见已知限制） |

### 修掉的真 bug（全部由真机暴露，不是推测）

1. **扩展硬编码版本常量**：`api-bridge.js` 里手写的 `var VERSION = '0.3.5'` 不随清单更新，导致「清单显示 0.3.6、运行时永远报 0.3.5」。改为构建时从 `extension.json` 注入 `__EXTENSION_VERSION__`，并有 3 条单测禁止再出现硬编码。
2. **僵尸客户端吞调用**：`firstReadyClient()` 取第一个 `ready` socket，页面跳转留下的半开连接照样 `ready`，调用进黑洞直到 60 s 超时（就是那次 `MCP error -32001`）。改为「每条数据刷新 lastSeenAt + 优先最活跃 + 静默 >60 s 只作兜底 + 只读方法超时才换客户端重试一次」。
3. **连接状态会撒谎**：`connectedClients`、`waitForExtensionConnection`、`/healthz` 全用原始 `ready` → 改用活跃客户端。
4. **`optional is not defined`**：`optional()` 只定义在 `dsh.internal.pcbCreateRegion` 内部，导出/导入助手看不见 → 提升为共享函数并清掉 `optional2/optional3`。
5. **团队/工程/文件夹被摘要成空对象**：`summarizePrimitive` 字段名不匹配 → 这些结构改为原样返回。
6. **按名字找不到工程**：`getAllProjectsUuid()` 在半离线模式恒为空（本地目录才是 "team"）→ 无过滤时遍历团队聚合。
7. **`reg query` 不带 `/s` 只返回默认值**，列不出 `OpenWithProgids`；拼键时少了分隔符；probe 缓存把「列全部值」和「默认值」当同一键。
8. **GBK 解码**：`reg.exe` 按控制台代码页输出、progid 名是中文，UTF-8 解码出替换字符就拼不回注册表键 → 新增 `decodeRegistryOutput()`。
9. **直接 spawn 起不来 GUI**：`lceda-pro.exe` 直接 spawn（含 ShellExecute）以退出码 0 立刻退出，只有交给 `explorer.exe` 才行 → `eda_launch` 在 Windows 固定走 explorer + 临时 `.cmd`。
10. **`eda_close` 在非 Windows 把进程数当 -1**（等于谎报已关闭）→ 改用 `pgrep -f` 真实计数。

### 可执行契约检查（新增）

`scripts/contract-check.mjs`（接入 `pnpm check` 与 CI）机械校验四类**已真实发生过**的错配：工具声明 ↔ handler（自动解析 11 个别名）、桥接调用的每个 API ↔ 扩展白名单（`ALLOWED_API` + `FILE_METHODS`，160 条）、`dsh.internal.*` ↔ 扩展实现、`objectSchema` 的 required ↔ properties（94+ 个 schema）。

### 构建与发布

- zip 包名带版本号：`dsh-eda-bridge-extension-0.4.0.zip`，同时保留 `dsh-eda-bridge-extension.zip` 别名（内容一致；分发放带版本号的那个）。
- 工具总数 **97**，单测 **110** 条全通过，`docs/tools.md` 自动重生成（0 未分组）。


## 0.6.2

> **已发布到 npm**（`dsh-eda-mcp@0.6.2`，首个版本）。下面 0.6.1 的内容从未发布过，同批一起带上。

### 设置页：勾选框改为官方开关组件

- 三个布尔项（`enabled` / `announceToAgent` / `allowRawApi`）由 `<input type="checkbox">` 改为
  **官方设置页同款开关**：直接复用 `@deepseek-ai/dsh-client-ui-primitives` 导出的 `Switch`
  （官方 `dsh-client-ui-settings-general` 等页面的布尔开关就是它），因此外观、动效、键盘与无障碍行为
  与内置设置完全一致，不再自定义。
- 该包作为 `devDependencies`（取 0.1.5-rc.2 类型/构建）与**可选 peer**（`^0.1.1-rc.2 || ^0.1.5-rc.2 ||
  ^0.2.0-rc.2 || ^0.2.1-rc.2`）声明；`build.mjs` 的浏览器端 `external` 增加
  `@deepseek-ai/dsh-client-ui-primitives`，由外壳的模块加载器提供，不打进我们的 bundle。
- 依据：官方三条线（0.1.1 / 0.1.5 / 0.2.1）都发布了该包，且官方的 `dsh-client-locale`、
  `dsh-client-ui-settings-general`、插件管理器等客户端在运行时都 `require` 它 —— 也就是说该模块在
  设置页可用的宿主里必然已被模块加载器注册。
- 顺带去掉硬编码的「开/关」文字（只有中文，卡片是中英双语），状态由开关位置与 `aria-checked` 表达。
- 仅客户端产物变化（`lib/client.js`），桥接与 EDA 扩展不变；**刷新/重启 DSH 后生效**。

## 0.6.1

### 发布准备：npm 包元数据、CI 自动发布与可复现构建

尚未发布到 npm（账号侧暂不可用）；仓库侧准备工作已全部完成，恢复后按
[`docs/release.md`](docs/release.md) 走一遍即可。

- `package.json`
  - `publishConfig.registry` 写死 `https://registry.npmjs.org` —— 本机默认 registry 常是国内只读镜像，
    之前这一项会让 `npm publish` 直接 403；
  - `files` 增加 `docs`、`CHANGELOG.md`、`CONTRIBUTING.md`、`LICENSE`：README 里链到
    `docs/design-rules.md` / `docs/tools.md`，npm 页面同样可读；
  - 新增 `prepublishOnly: pnpm check`（发布前必定跑 typecheck + 单测 + build）。
- **可复现构建**：esbuild 会把 `// node_modules/.pnpm/<pkg>_<peer-hash>/…` 这类注释写进 bundle，
  其中的 peer 哈希随机器/pnpm 布局变化 → 同源码在不同机器上字节不同。`build.mjs` 现在构建后剥离这些注释
  （本次 451 B），并把 `node_modules/` 残留检查作为构建输出的一部分。
- 新增 `.github/workflows/publish.yml`：推 `v*` tag 时校验 tag 与 `package.json` 版本一致 →
  `pnpm check` → `npm publish --provenance`，走 **npm trusted publishing（OIDC）**，仓库里没有任何 npm token；
  `workflow_dispatch` 默认只 `npm pack --dry-run`。工作流带两个守卫：bundle 里不得含构建机路径、tag/版本必须一致。
- 新增 [`docs/release.md`](docs/release.md)：首次手动发布、**staged publishing（`0.0.0-stage` 占位版）** 的识别与批准
  （`npx npm@12 stage list/approve`）、trusted publisher 配置表、npmmirror 同步、版本约定（插件版本 vs 线协议版本对）、
  失败模式速查，以及「账号不可用期间不要打 tag」的操作约定。
- `npm pack --dry-run` 实测：**33 文件 / 162.5 kB**（解压 560.6 kB），含 `lib/index.js`、`lib/client.js`、
  `lib/bridge.mjs`、`dsh-eda-bridge-extension.zip`、`cordis.patch.yml`、`docs/`；包名 `dsh-eda-mcp`
  在官方与国内 registry 均未被占用。
- 依赖可解析性已核对：`@deepseek-ai/dsh-mcp-client`、`dsh-settings`、`dsh-system-prompt`、
  `dsh-host-webserver`（均含 `0.1.5-rc.2`）与 `@deepseek-ai/schemastery`（3.18.x）都在公共 registry 上。
- **2FA 两种形态都写进手册**：`npm config get auth-type` 为 `web` 时（本机即是）发布只会打印
  `https://www.npmjs.com/auth/cli/<uuid>` 并在浏览器用安全密钥/设备验证完成，**不需要 6 位码**；
  只有 TOTP 账号才需要 `--otp` 或改用 `--auth-type=web`。
- `publish.yml` 增加 `Is this version already on the registry?` 步骤：版本已存在时跳过 `npm publish`，
  因此**手动发布之后再推 tag 也不会让 CI 变红**（会打印「already published」并正常结束）。

### 跨版本兼容：适配 DSH `0.2.1-rc.x`，并把接缝校验固化成脚本

- **版本事实（2026-10-17 实测）**：npm 上 `@deepseek-ai/dsh` 的 `latest` = `0.2.0-rc.2`（= 桌面端内置运行时），
  `next` = **`0.2.1-rc.2`**（0.2.1-alpha.2→rc.2 一整条线）。本机全局 CLI 为 `0.1.5-rc.2`。
- **0.2.0-rc.2 → 0.2.1-rc.2 的接缝差异（逐个包比对，不是推测）**：

  | 包 | 体积变化 | 结论 |
  |---|---|---|
  | `dsh-mcp-client` | 35041 → 35041（0%） | 字节一致：`inject: ["tools"]`、`serverName`/`command`/`args`/`env`/`cwd`/`toolCallTimeoutMs`/`failOnStartupError`/`reconnect`、`already in use` 守卫全未变 |
  | `dsh-settings` | 22636 → 22636（0%） | 字节一致：`configure` / `installSection` / `register` 三张面孔与 `isVolatile`/`plainConfig` 未变 |
  | `dsh-system-prompt` | 17395 → 19817（+13.9%） | `section({ name, order, text })` 单对象签名未变 |
  | `dsh-host-webserver` | 13284 → 21436（+61.4%） | `register(route)` 与 `route.kind === "exact"` 逐行相同（增长在 IP 校验等安全部分） |
  | `dsh-client-ui-slots` / `dsh-client-locale` | 23461 / 64372（0%） | 字节一致：`slots.inject/register`、`locale.register/bind` 未变 |
  | `dsh-client-ui-settings` | 60010 → 58624（−2.3%） | 有变化，但**本插件的设置卡片不使用它的运行时 API**（卡片用结构化的 `SettingsScope` 走自己的回环路由），因此无影响 |

  另外核对：`dsh-tools` 仍是 `super(ctx, "tools")`（服务名不变）、`dsh-plugin-manager` 仍读 `bundle?.patch`
  （`cordis.patch.yml` 插入机制不变）、`window.__ModuleLoader__.load({ id, factory })` 包装格式在 0.2.1 的客户端产物里逐字相同。
- **因此 0.2.1-rc.x 无需改任何代码**，只需把版本区间补上：`dependencies` 与 `peerDependencies` 现在都是
  `^0.1.5-rc.2 || ^0.2.0-rc.2 || ^0.2.1-rc.2`（注意 semver 的预发布规则：`^0.2.0-rc.2` **不覆盖** `0.2.1-rc.x`，
  比较器元组必须落在同一 major.minor.patch 上）。
- **新增 `test/seams.test.ts` + `scripts/seam-check.mjs`**：把上述每一条契约写成断言，可对任意代际运行 ——
  `pnpm seam-check next` 会把该代际的 7 个接缝包装进临时目录再跑断言，输出每个契约的 PASS/FAIL 与实际版本号。
  实测：`0.1.5-rc.2`（本地）**ALL PASS**、`0.2.1-rc.2`（npm `next`）**ALL PASS**；`pnpm test` 现在包含这套接缝测试。

## 0.6.0

### 设计规范落地：可量化部分改为工具强制，另加只读审计

新增规范正文 [`docs/design-rules.md`](docs/design-rules.md)（原理图分区/放置、网络命名、PCB 布局、
线宽/过孔/铺铜、DRC、丝印板框、制造输出、打样检查清单与推荐工作流），并把其中**能判定的部分**做成代码：

- 新增 `src/bridge/design-rules.ts`（14 个单测，`test/design-rules.test.ts`）：
  - `checkNetName` / `assertNetName`：允许字母、数字、`_`、`.`、`+`、`-`，最长 255 字符；空格、斜杠、括号、中文等
    JLC 后端无法解析的字符**直接拒绝**（后端按精确字符串匹配，`USB_DP/DM` 会被拆成两个网络）；非大写只给警告。
  - `classifyNet` / `suggestTrackWidthMil`：按网络名分 ground / power / signal，给出 6 / 16 mil 的角色默认线宽。
  - `checkTrackWidth`：低于 **6 mil（0.15 mm）** 报错（`force:true` 可越过）；低于角色建议值给警告；
    不在 0.05 mm 步进上的线宽给圆整提示（四个档位值 6/10/16/20 mil 豁免）。
  - `checkVia`：焊环按 **盘径−孔径 ≥ 0.20 mm** 判定（0.2/0.4、0.3/0.6、0.4/0.8 三组标准尺寸均满足），
    孔径 <0.2 mm 报错、<0.3 mm（免费打样下限）警告，非标尺寸警告。
- 工具接线：
  - `pcb_draw_track` 的 `lineWidth` 变为**可选**（按角色取默认值），并回传 `rules` 说明实际用了哪个宽度；
  - `pcb_draw_via` 的 `holeDiameter`/`diameter` 变为**可选**（按角色取标准孔径）；
  - 所有带 `net` 的工具（`eda_draw_wire`、`eda_place_net_flag/port/label(_at_pin)`、`pcb_draw_track/via`、
    `eda_pcb_create_pour`）统一走网络名校验；`eda_pcb_set_net_track_width` 同样校验线宽；
  - `eda_pcb_create_pour` 回传铺铜间距要求（≥6 mil / 建议 10 mil）与「去孤岛」提醒（间距属于板级规则，API 写不了）。
- **新增只读审计工具 `eda_design_audit`**：一次调用返回 `violations` / `warnings` / `checklist`，
  逐项检查每个网络的走线线宽（含 `minWidthByNet` 与角色建议值）、过孔孔径与焊环、网络名合法性、板框、
  铺铜、PCB DRC（可 `drc:false` 跳过）。布线前后各跑一次即可对照 `docs/design-rules.md` §9 清单。
- 系统提示（`src/guidance.ts`）改为**规范优先**的紧凑版本：网络命名、线宽档位、过孔标准尺寸、铺铜与 DRC、
  分区/布局/丝印流程、长任务轮询、活动文档规则；细则留在 `docs/design-rules.md`，避免每轮 prompt 过长。
- 工具总数 81 → **82**；`docs/tools.md` 由新增的 `scripts/gen-tools-doc.mjs`（`pnpm docs`）重新生成。

### 未改动

- bridge 与 EDA 扩展的线协议版本仍为 **0.3.5**（白名单与内部助手未变，**无需重新导入 zip**）。
- 平台相关能力（丝印尺寸、布局评分、铺铜间距）API 不暴露，因此只写进规范与提示，不做自动判定。

## 0.5.1

### 修复：官方桌面端（DSH 0.2.0-rc.2）里 bridge 子进程根本起不来

- **根因**：桌面端把插件宿主跑在 Electron 里，`process.execPath` 是 `D:\DeepSeek Harness\DeepSeek Harness.exe` 而不是 Node。旧代码 `command: process.execPath` 等于让应用二进制去执行 `lib/bridge.mjs`——要么启动第二个实例、要么被单实例锁挡掉后立刻退出，于是 39009 从来没有监听：设置卡片在、`/test` 恒 503、Agent 也拿不到 `mcp__jlceda__*` 工具。
- **修复**：新增 `src/node-runtime.ts`，按六级顺序挑真正能跑 Node 脚本的可执行文件：
  1. `DSH_EDA_MCP_NODE` 显式覆盖；
  2. `DSH_NODE_EXECUTABLE` / `DSH_DESKTOP_NODE_EXECUTABLE`（+ `ELECTRON_RUN_AS_NODE=1`）；
  3. 宿主是 Node → `process.execPath`；
  4. Electron 宿主 → 桌面负载自带 `resources/runtime/primary-runtime/dependencies/node/bin/node.exe`；
  5. `PATH` 里的 `node`；
  6. 兜底 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`。
- 子进程 `cwd` 从 `process.cwd()`（GUI 应用里可能是 `C:\Windows\System32`）改为 bridge 脚本所在目录。
- `/api/dsh-eda-mcp/test` 与 `/reconnect` 的响应新增 `launch: { command, args, source }`，直接暴露「用的哪个可执行文件、依据哪条规则」，不用再靠猜。

### 修复（第二轮）：可执行文件选对之后，MCP 客户端仍然没有 spawn

桌面端重启后 `launch` 已证明命令正确（`desktop runtime Node` + `lib/bridge.mjs`），但 `/test` 依旧 503；用进程监视盯住整次 `/reconnect`，**没有任何 `node.exe` 子进程被创建过** —— 问题在挂载，不在命令。

- **0.2.0-rc.2 的契约**（从 `app.asar` 提取真实 runtime 读出）：`@deepseek-ai/dsh-mcp-client` 的 `inject = ["tools"]`（`tools` 由根级行 `@deepseek-ai/dsh-tools` 的 `super(ctx, "tools")` 提供），所以它只会在「工具注册表可达」的上下文里 apply；此外它给 `serverName` 加了一把唯一性守卫——同一个 owner 作用域里 `jlceda` 还没随旧 fiber 释放就被再次占用，就直接抛 `serverName "jlceda" is already in use`。而 `fiber.dispose()` 是**异步**的，插件的 `sync()` 在启动阶段会跑两次 `remountClient()`，第二次完全可能撞上守卫；再叠加 `failOnStartupError: false`，错误只进 host logger（桌面端不落盘），于是表现为「什么都没发生」。
- **修复**：`remountClient()` 改为**串行队列 + await 上一次 fiber 销毁**；MCP 客户端改到 `ctx.inject(['tools'], …)` 内挂载（既等待服务可见，又能记录它是否出现）；所有挂载异常写入诊断记录，不再静默。
- **新增自检路由**（这次排查缺的就是它）：
  - `POST /api/dsh-eda-mcp/diagnostics` → `{ launch, diagnostics, config }`，其中 `diagnostics` 记录 `toolsServiceSeen` / `mountAttempts` / `mountError` / `clientFiberState` / `bridgeHealth` / `probeError` / `probedAt`；
  - `POST /api/dsh-eda-mcp/self-test` → **从插件宿主进程内部**直接 spawn bridge（`spawned`/`exited`/`exitCode`/`stderr`/`stdout`/`healthz`/`spawnError`/`pid`），用来区分「宿主不能启动该可执行文件」和「MCP 客户端没去启动它」。

### 修复（第三轮，真正的根因）：0.2 的 `volatile` 配置字段是「活值句柄」，不是值

打开 `failOnStartupError: true` 并捕获 fiber 的 reject 之后，终于拿到被吞掉的错误：

```
ValidationError: invalid config
  ... but got {"transport":"stdio","serverName":"jlceda","command":"…\\node.exe","args":["…\\bridge.mjs"],
              "env":{"DSH_EDA_MCP_ALLOW_RAW_API":"1","DSH_EDA_MCP_TOOL_TIMEOUT_MS":"[object Object]"},
              "cwd":"…\\lib","toolCallTimeoutMs":{},"failOnStartupError":true,…}
```

- **根因**：DSH ≥ 0.2 把标了 `.volatile()` 的配置字段交给 `apply()` 时**不是普通值**，而是活值引用。`@deepseek-ai/cosmokit` 的定义是 `const write = Symbol.for("cosmokit.volatile.write")`、句柄为 `Object.freeze({ get: () => current, [write]: (v) => … })`，判定函数是 `isVolatile(v) = typeof v === "object" && v !== null && write in v`（**Symbol 键**）；`@deepseek-ai/dsh-settings` 用 `isVolatile(v) ? v.get() : v` 拆包。插件直接当值用 → 数字字段变成 `{}`、字符串化成 `"[object Object]"` → **mcp-client 的配置校验失败，连接从头到尾没有发起**；`failOnStartupError: false` 又把这个错误只写进 host logger（桌面端不落盘），于是一直表现为「重连失败: bridge-unreachable」而没有任何提示。这也解释了 `/diagnostics` 里 `config` 四个字段全是 `{}`。
- **修复**：新增 `src/config-values.ts` —— 标记用 `Symbol.for('cosmokit.volatile.write')` 从**全局符号注册表**取（因此不依赖 cosmokit 包本身，也不依赖宿主导入的是哪一份）；提供 `isLiveValue` / `readConfigValue` / `unwrapConfig` 以及带默认值的 `booleanField` / `numberField`。`apply()` 的 `current()` 与 `setSource` 两条路径统一解包，`bridgeLaunchFor()` 与 `sync()` 改用带默认值的读取器——即使将来设置代际再换包装，也只会退回默认值，而不会把一个对象塞进会做类型校验的消费者。`/diagnostics` 新增 `launchConfig`，直接暴露交给 mcp-client 的那份配置。
- **中途踩的坑（已修）**：第一版判定写成 `'write' in value`（字符串键），对 Symbol 键恒为 false，于是解包没生效 —— 重启后 `/diagnostics.launchConfig` 仍是 `toolCallTimeoutMs: {}`，这才定位到 Symbol。`test/config-values.test.ts` 现在按 cosmokit 的真实构造（`Object.freeze` + `Symbol.for` 键）造句柄。
- `failOnStartupError` 保持 `true`：bridge 是本插件自己的脚本，启动失败就该抛出（而不是静默重试到放弃）。

### 验证

- **单测**：`test/config-values.test.ts` 14 例全过（含「有 `get` 但没有协议 Symbol 的普通对象不得误拆」「`booleanField`/`numberField` 对不可读包装退回默认值」）；`test/node-runtime.test.ts` 7 例全过（Node 宿主 / Electron 找自带 Node / 覆盖变量 / 启动器变量 / 不存在的覆盖值 / PATH 回退 / Electron 兜底）；按真实桌面布局（`execPath = D:\DeepSeek Harness\DeepSeek Harness.exe`）解析出 `…\primary-runtime\dependencies\node\bin\node.exe`，`source = desktop runtime Node`。
- **真实启动**：用该可执行文件跑 `lib/bridge.mjs` → `http://127.0.0.1:39009/healthz` 返回 `{"status":"ok","version":"0.3.5","clients":0}`，进程结束后端口关闭。
- **0.2.0-rc.2 接缝逐条核对**（从 `app.asar` 提取真实运行时确认）：`SystemPrompt.section({ name, order, text })` 仍是单对象签名；`SettingsForms` 的 `configure({ auto:false })` + `describe`/`mutate` 可用（实测 `POST /api/dsh-eda-mcp/settings/describe` 返回 `writable: true`，`mutate` 提交成功）；`dsh-mcp-client` 的子进程环境是 `{ ...scrubbedParentEnv(), ...config.env }`（合并，不是替换）；客户端 inject 的 `@deepseek-ai/dsh-client-ui-settings@0.2.0-rc.2`、`dsh-client-locale@0.2.0-rc.2` 都在桌面负载里。
- `tsc --noEmit` 与 `node build.mjs` 通过。
- **桌面端实测（用户重启后）**：`POST /api/dsh-eda-mcp/test` → `{"ok":true,"health":{"status":"ok","version":"0.3.5","clients":1}}`；`/diagnostics` → `config` 为明文 `{enabled:true, announceToAgent:true, toolCallTimeoutMs:60000, allowRawApi:true}`、`launchConfig.toolCallTimeoutMs=60000`、`env.DSH_EDA_MCP_TOOL_TIMEOUT_MS="60000"`、`bridgeHealth:"ok"`、`clientFiberState:2`（active）；插件管理器 `/failures` 为空、`dsh-eda-mcp` 行 `enabled:true @0.5.1`；会话内 `mcp__jlceda__*` 命名空间（81 个工具）已注册。
- 收尾小修（下次重启自然生效）：`beginMount()` 现在会清掉上一轮的 `clientStartupError`（否则启动期重挂竞争会留下一条与当前健康连接并存的旧错误，例如 `cannot create effect on inactive context`）；`apply()` 末尾的兜底 `sync()` 只在设置接缝没有回调过时才执行，避免启动时多做一次重挂。

### 已知限制

- **宿主模块热重载不会重新 import 已缓存的 ESM**：试过两条路都不行 —— 插件管理器 `set-enabled` 停用/启用（会写 profile patch 并让宿主重挂载该行，但模块仍走缓存），以及把 `package.json` 的入口换成新文件名（换 URL 本应触发重新 import，实测宿主仍执行旧模块）。改了 `src/` 必须 `node build.mjs` + **重启桌面应用**。
- 第二轮挂载修复（`inject(['tools'])` + 串行销毁）**尚未在运行中的应用里验证**，需要一次重启；重启后 `/diagnostics` 与 `/self-test` 会直接给出结论。
- 本版只改宿主端；bridge（0.3.5）与 EDA 扩展（0.3.5）不变。扩展侧仍缺 `clearRouting` 后台任务类型的那一版需要重新导入 zip 才能拿到「异步清布线」。

## 0.5.0

### 兼容 DSH 0.2.0-rc.x 与官方桌面端（同一份构建继续支持 0.1.1-rc.x / 0.1.5-rc.x）

- **设置接缝三代表探测**：0.2 起 `ctx.settings` 是 `SettingsForms`，插件的命名空间就是它在 profile 里的 entry Config，`installSection`/`register` 都已移除。现在按 0.2 `configure({ auto: false })` → 0.1.5 `installSection` → 0.1.1 `register` 依次探测；0.2 下关掉自动生成的设置页，插件自带的卡片仍是唯一入口。
- **Config 字段标记 `.volatile()`**：0.2 只把标了 `volatile` 的字段投影成可编辑表单（`SettingsForms.describe()` 会跳过其余字段），四个设置项全部标记；该标记在旧接缝上只是 schema 元数据。
- **schema 依赖换成 `@deepseek-ai/schemastery`**：与各代运行时加载插件 Config 所用的包一致（原为不带 scope 的 `schemastery`）。
- **桥接路由改为结构类型**：`@deepseek-ai/dsh-settings` 的 `SettingsProvider` 类型在 0.2 已不存在，`src/routes.ts` 改用本地 `SettingsBridge`/`SettingsBridgeView`（`describe`/`mutate`/`writable`），`ctx.settings` 在调用点显式转型——一份代码同时通过两代类型检查。
- **设置冲突判定跨副本安全**：插件自带的 `@deepseek-ai/dsh-settings` 副本与宿主实际抛错的副本不是同一份，`instanceof` 恒为 false；现在同时检查 `error.code === 'SETTINGS_CONFLICT'`。
- **客户端类型本地化**：`SettingsScope`/`SettingsScopeSnapshot` 在 0.2 已改名 `ConfigForm`/`ConfigFormSnapshot`，卡片改用 `src/client/settings-scope.ts` 内声明的结构类型（成员与两代一致）。
- 对等依赖范围扩到 `^0.1.1-rc.2 || ^0.1.5-rc.2 || ^0.2.0-rc.2`；构建设置新增 `zustand@4.4.7`、`immer@10.2.0`（内联快照存储的构建期依赖，不进入运行时外部清单）。

### 未改动（刻意保持）

- 工具集（69 个）、MCP/bridge 协议、WebSocket 端口 39009、扩展白名单、设置卡片字段与交互全部与 0.4.1 相同；bridge 与 EDA 扩展版本号仍为 **0.3.5**，**无需重新导入 zip**。

### 验证

- 0.1.5-rc.2 与 0.2.0-rc.2 两套 `tsc --noEmit` 与构建全部通过；客户端 bundle 的运行时依赖仍只有 `react`/`react/jsx-runtime`。
- 在隔离 `DSH_HOME` 里用 0.2 运行时启动 web profile：插件加载无任何报错，`POST /api/dsh-eda-mcp/settings/describe` 正确返回 `schema`/`value`/`base`/`user`/`secrets`/`writable`；`/api/dsh-eda-mcp/test` 正常响应。
- 跨代 mcp-client 兼容性已核对：0.1.5 与 0.2 的 `ctx.tools.register(definition)` 签名、`ToolDefinition` 形状一致（0.2 仅新增可选 `projectContent`），因此插件自带的 0.1.5 `dsh-mcp-client` 副本在 0.2 宿主上可用。

### 升级注意

- 0.2 上本插件设置由 **profile entry Config** 承载；旧 `~/.dsh/settings.yaml` 会在 0.2 首次启动时被迁移/改名（`settings.yaml.imported`），`eda-mcp` 一节会迁进当时运行的那个 profile。

## 0.4.1

bridge 与 EDA 扩展版本：**0.3.4 → 0.3.5**（扩展白名单与内部助手有新增，需要重新导入 zip 并重启嘉立创EDA专业版）。

### 自动布线/自动布局：改为「启动 + 轮询」，不再用超时硬等

- 之前 `eda_pcb_auto_route` 会一直等到布线结束，整板或大网络（GND 35+ 引脚）必然撞上 MCP 工具超时——而 EDA 侧其实还在正常布线并显示进度条，只是调用方已经超时放弃了。
- 现在默认**异步启动**：扩展内部用 `dsh.internal.jobStart` 发起 `pcb_Document.autoRouting` 但**不 await**，把 promise 状态存起来立刻返回；新增 `eda_pcb_job_status`（`dsh.internal.jobStatus`）轮询 `{running, elapsedMs, result, error}`。
- `eda_pcb_auto_route`：默认异步（返回 `started`/`running`/`requestedNets`/`props` 与提示），`wait: true` 才阻塞；`eda_pcb_auto_place` 默认阻塞、`wait: false` 异步。
- 因此**不需要再加大超时**；长任务用轮询。`timeoutMs` 参数保留给 DRC/Gerber 等同步调用。
- 任务结束时 `hint` 会给出下一步（`success=false`/`duration=0` 的解释、未布通网络列表、建议跑 DRC 与加宽电源网络）。

### 网络标签：createNetLabel + 文本回退

- 新增 `eda_place_net_label`（`sch_PrimitiveAttribute.createNetLabel(x, y, net)`）与 `eda_get_net_labels`；`eda_place_net_label_at_pin` 改为**优先创建真正的网络标签图元**，返回 `method: 'netLabel' | 'text'`。
- `createNetLabel` 官方标注「ADD since EDA v4」，当前 EDA 3.2.186 上可能不存在；不存在时自动回退到文本标签，并在结果里明确警告「文本标签不建立电气连接，请改用 eda_draw_wire 的 net 参数」。

### eda_get_nets 返回空的定位与修复

- 实测：`sch_Net.getCurrentProjectAllNets` / `sch_Net.getAllNets` / `sch_Net.getAllNetsName` 在**当前活动文档不是原理图**时全部返回 `[]`（`sch_ManufactureData.getNetlistFile` 同时返回 `null`）。这是「查询作用于当前活动文档」造成的，不是网表坏了。
- 新增 `eda_get_active_document`（`dmt_SelectControl.getCurrentDocumentInfo`，返回 `documentTypeName`）与 `eda_open_document`（`dmt_EditorControl.openDocument`），可以在调用前把原理图/PCB 切到前台。
- `eda_get_nets` 现在按 getCurrentProjectAllNets → getAllNets → 解析 `sch_Netlist.getNetlist` 依次降级，并返回 `source` 与提示；`eda_export_netlist` 为 `null` 的说明也写进了工具描述。

### 覆铜 / PCB DRC / 电源线宽

- `eda_pcb_create_pour` / `eda_pcb_get_pours` / `eda_pcb_delete_pour`：`pcb_MathPolygon.createPolygon` + `pcb_PrimitivePour.create`（内部助手 `dsh.internal.pourCreate`），`pourFillMethod` 支持 `45grid` / `90grid` / `solid`，铜层 1/2/15-44。
- `eda_pcb_run_drc`（`pcb_Drc.check`，strict / userInterface / includeVerboseError）、`eda_pcb_get_drc_rules`（当前规则配置名与内容、实时 DRC 状态）。
- `eda_pcb_set_net_track_width`：按网络批量改线宽（遍历 `pcb_PrimitiveLine.getAll` 再逐条 `modify`），用于布完线给电源/GND 加粗。

### 器件引脚网络一致性

- `pcb_get_components` 新增 `includePins`：额外调用 `pcb_PrimitiveComponent.getAllPinsByPrimitiveId`（准确来源）返回 `pins` 与 `padNets`；器件对象自带的那份 pad/net 在网表导入后可能滞后。

### 设计流程知识（写入系统提示）

- 在插件注入的说明里补充 PCB 设计流程：先闭合板框 → 功能分区布局（连接器靠板边、去耦电容贴近电源引脚、晶振/敏感模拟远离开关电源）→ 导入网表 → 布线（长任务轮询）→ DRC → 电源/GND 加粗与铺铜；并说明原理图 API 依赖活动文档。

### 原理图→PCB 同步：异步触发 + 低频轮询确认

- `pcb_Document.importChanges` 会弹出 EDA 自己的同步确认对话框并**一直阻塞**，所以 `pcb_import_changes` 默认改为**异步触发**：调用立刻返回 `componentsBefore`，导入在后台跑（`dsh.internal.jobStart` 新增 `importChanges` 类型）。`wait: true` 保留旧的阻塞行为。
- 新增 `eda_pcb_wait_for_components`：**低频轮询**（默认 5 s、最小 3 s、最长 45 s，可调），判定规则是「PCB 上出现了同步前不存在的元件」——出现即说明用户点了确认。返回 `confirmed` / `waitedMs` / `newComponentIds`；未确认则返回 `confirmed: false` 让调用方去问用户再调一次。

### 文档

- 新增 `docs/tools.md`：由构建产物的 MCP `tools/list` **自动生成**的完整工具参考（名称/描述/参数/必填项），避免文档与代码漂移。
- `README.md` / `README.zh.md` 增加「推荐工作流」：原理图电气连接（net 参数 vs 文本标签）、同步确认轮询、异步布线轮询、DRC、电源加宽与铺铜、活动文档规则。

### 网络标识不再压住元件（引脚方向 + 短导线）

- 旧行为把电源标识/网络标签**正好放在引脚连接点**上，直接盖住元件本体与引脚，原理图看不清。
- 现在两个 at_pin 工具先读引脚的 `rotation`（实测语义：0=+x、90=+y、180=-x、270=-y，且指向**离开元件本体**的方向），再从引脚沿该方向拉一条**带同名 net 的短导线**（`stubLength`，默认 20 MCP 单位 = 5.08 mm），把标识/标签放在导线末端：
  - `eda_place_net_flag_at_pin`：`createNetFlag` 放在末端，rotation 默认跟随引脚方向；
  - `eda_place_net_label_at_pin`：`createNetLabel`（或文本回退）放在末端。
- 因为短导线本身带 net，即使标签是文本回退（`method: "text"`）**电气连接也已经由导线建立**，不再依赖标签图元。
- `offsetX/offsetY` = 手动定位（自动禁用短导线，保持旧语义）；`stubLength: 0` = 完全旧行为；落点同样做图框/标题栏避让检查，越界直接报错而不是画到框外。
- 已在用户原理图上实测（J3 的 rotation=270 与 90 两个引脚）：落点分别在引脚下方 20 与上方 20，短导线与标识创建成功，测试图元已全部删除。

### 清除布线超时：后台任务 + 分批回退

- 现象：`eda_pcb_clear_routing`（type=all）在整板上必然超时。实测你的板子现在 **0 条走线、4 个过孔**——也就是说 MCP 侧早就超时放弃了，EDA 内部其实**已经把布线清完了**，和自动布线是同一类问题。
- 现在 `pcb_Document.clearRouting` 默认走**后台任务**（`dsh.internal.jobStart` 新增 `clearRouting` 类型）：调用立刻返回，用 `eda_pcb_job_status` 轮询直到 `running=false`（布尔结果会给出「已清除/失败」的说明）。
- 导入的还是旧扩展时**自动降级为分批删除**（`pcb_PrimitiveLine.getAll` + 逐条 delete，`batchSize` 默认 200、上限 2000）：每次调用都在超时内返回 `{matched, deleted, remaining, done, failed}`，重复调用直到 `done: true`。所以清整板不再会超时。
- `mode: "batched"` 强制分批；`wait: true` 保留旧的阻塞调用（可用 `timeoutMs`）；`net`/`layer` 可只清某个网络/层。
- 顺带加固：PCB 图元列表读取遇到「当前活动文档不是 PCB」导致的 `null` 异常时，不再抛出 EDA 内部错误，而是明确提示「请把 PCB 页切到前台」。
- **实机验证**（用户板子上画 12 条走线再清除）：`batchSize: 5` 共 4 轮，每轮 11–48 ms，`matched` 16→11→6→1（含 4 个过孔）、`deleted` 每轮 5、末轮 `done: true`，清除后走线数归零。整板清除不会再超时。
- 兼容性补强：扩展有 `jobStart` 但不支持该 kind 时会抛 `unsupported job kind`，该错误现在同样触发分批回退（此前会直接失败）。

### createNetLabel 实测：函数存在但永不 resolve

- 实测 `eda.sch_PrimitiveAttribute.createNetLabel(0, 0, 'X')` 在 JLCEDA Pro 3.2.186 上**对 MCP 调用一直挂住直到 60 s 超时**（扩展能解析到该函数，所以不是 `API method not found`）。
- 因此 `eda_place_net_label` / `eda_place_net_label_at_pin` 对它的探测改为 **4 s 短超时**并把超时也视为降级信号，立刻回退到文本标签；电气连接由 at_pin 工具同时画出的**带 net 短导线**保证。
### 工具数量

- 69 → 81。

## 0.4.0

### 兼容 DSH 0.1.5-rc.x（同一份构建同时支持 0.1.1-rc.x 与 0.1.5-rc.x）

- 浏览器端不再依赖 DSH 客户端运行时：快照存储 `createSnapshotStore` 改为随插件打包，`lib/client.js` 的运行时依赖只剩 Web 外壳内置的 `react` 与 `react/jsx-runtime`。原 `@deepseek-ai/dsh-client-runtime` 自 DSH 0.1.2 起被上游移除，`@deepseek-ai/dsh-client-store` 是 0.1.5 才有的平台模块，内联后两代外壳都能加载。
- 宿主端设置接缝改为运行时探测：DSH 0.1.5 走 `settings.installSection(owner, ns, schema, entry, hooks)`；旧版回退到 `settings.register(ns, schema, { base })` 的等价接线——与上游已移除的自由函数 `installSettingsSection` 行为一致（同样的 `setSource` 时机、`onChange` 触发点与卸载保护）。
- 设置命名空间常量 `EDA_MCP_SETTINGS_NAMESPACE` 改为普通字符串 `'eda-mcp'`（上游移除了 `settingsNamespace()`）。
- 客户端类型来源迁移：`ClientContext` 改用 `@deepseek-ai/cordis`；`SettingsScope` / `SettingsScopeSnapshot` 改用 `@deepseek-ai/dsh-client-ui-settings/client`；`ctx.slots` 的类型增补由 `@deepseek-ai/dsh-client-ui-renderer/client` 提供。
- 浏览器端设置作用域补齐 0.1.5 契约新增的 `mutate(ops, expectedRevision)`，直接复用既有桥接写路径；`set` / `unset` 行为不变。
- 依赖声明：`dsh.client.inject` 收敛为两代都存在的 `@deepseek-ai/dsh-client-ui-settings` 与 `@deepseek-ai/dsh-client-locale`；`@deepseek-ai/dsh-*` 对等依赖范围为 `^0.1.1-rc.2 || ^0.1.5-rc.2`，`@deepseek-ai/cordis` 为 `^4.0.1`。

### 未改动（刻意保持）

- **工具集与工具数量不变（69 个）**，MCP/bridge 协议、WebSocket 端口（39009）、扩展白名单、设置卡片字段、坐标与单位约定全部与 0.3.4 相同；本次只做运行时接缝适配。
- **bridge 与嘉立创EDA 扩展的版本号仍为 0.3.4**：`src/bridge/index.ts` 的 `VERSION` 与 `jlc-extension/extension.json` 的 `version` 参与 `eda_status.versionMismatch` 比对，二者代码未变就不该抬版本——否则会误报「版本不一致」并要求重新导入 zip。因此**本次升级无需重新导入扩展、也无需重启嘉立创EDA**。

### 升级注意

- 插件包版本（0.4.0）与 bridge/扩展版本（0.3.4）本就不要求一致，`eda_status` 只比对 bridge 与扩展。
- 若从 DSH 0.1.1-rc.x 升到 0.1.5-rc.x，插件无需重装；反之回退 DSH 版本同样可用。

## 0.3.4

### 板框：改用 `pcb_PrimitivePolyline`（根因已定位）

- **0.3.3 的板框实现是错的**：`pcb_PrimitiveLine` 是「导线」（铜层 + 网络）图元，板框层 11 会被核心拒绝，报「无法创建直线图元，可能是传入的参数不正确」（线宽 1/5/10/20/50 都一样）。
- 根因证据来自 JLCEDA 自己的工程文件格式（`assets/db/example-projects.zip` 里的 `.eprj2` 是 SQLite，PCB 文档在 `documents.dataStr`）。真实板框记录长这样：

  ```
  ["POLY", "e102", 0, "", 11, 10, ["R", 0, 0, 3149.6063, 2362.2047, 0, 0], 1]
  ```

  即 **`POLY`（折线 = `pcb_PrimitivePolyline`）**，层 11，多边形源数组；而 `LINE` 记录全部是带网络的铜层导线。
- 因此 `pcb_draw_board_outline` / `eda_pcb_draw_board_outline` 现在改为：`pcb_MathPolygon.createPolygon([x1,y1,'L',x2,y2,...])` + `pcb_PrimitivePolyline.create(net, 11, polygon, lineWidth)`，一次调用创建 **一条闭合折线**（默认线宽 10 mil，与官方文件一致）。
- 新增扩展内部助手 `dsh.internal.polylineCreate`：多边形对象无法走 WebSocket 序列化，必须把两次官方调用合并到一次扩展往返里完成。
- 新增 PCB 折线工具：`pcb_draw_polyline`（板框 11 / 丝印 3、4 / 装配 9、10 / 机械 14 / 文档 13 / 铜层 1、2）、`eda_pcb_get_polylines`、`eda_pcb_delete_polyline`，扩展白名单同步放开 `pcb_PrimitivePolyline.*`。

### 自动布线：根因是「不传网络 = 全部」在这版 EDA 里不成立

- 实测：`pcb_Document.autoRouting` 不传网络时 `routingRange` 为 `[]`，本版 EDA 核心会立刻返回 `success=false, duration=0` 并把 48 个网络全部列为失败；显式传网络（如 `RoutingNets: ["GND"]`）则 `success=true`（288 ms，1/1 成功），`["VCC5","VCC3V3","LED_G"]` 也 3/3 成功。
- 所以 bridge 侧 `eda_pcb_auto_route` 现在：不传网络时先枚举 `pcb_Net.getAllNetsName` 并把**全部网络名显式传入**；空数组同样按「全部」处理。
- 官方文档示例写的是 `nets`，但 0.3.18 的实现只读 `RoutingNets`，`nets` 会被静默忽略。现在两个键都接受（`nets` → `RoutingNets`）。
- 参数补齐：`ignoreNets`、`layers`、`cornerStyle`(0=45°/1=90°)、`optimization`(1=布通率/0=更快)、`existingPrimitiveMode`(keep/remove) 可直接传顶层键；返回值附带 `requestedNets`、`props` 和 `hint`（`duration=0` 时说明路由器根本没启动及排查方向）。
- 新增 `eda_pcb_clear_routing`（`pcb_Document.clearRouting`，all / net / connection）。

### 其它

- 工具总数 65 → 69。
- 版本统一为 **0.3.4**（插件包、bridge、EDA 扩展）。板框/折线需要在嘉立创EDA里**重新导入 zip 并重启 EDA**；自动布线修复只在 bridge 侧，点一次设置页「重连」即可生效。

## 0.3.3

### 新增 PCB 写操作 / 查询工具（bridge + 扩展白名单）

- 器件：`eda_pcb_move_component`（`pcb_PrimitiveComponent.modify`）、`eda_pcb_delete_component`（`.delete`）。
- 走线：`eda_pcb_get_tracks`（`pcb_PrimitiveLine.getAll`）、`eda_pcb_modify_track`（`.modify`）、`eda_pcb_delete_track`（`.delete`）。
- 过孔：`eda_pcb_get_vias`（`pcb_PrimitiveVia.getAll`）、`eda_pcb_delete_via`（`.delete`）。
- 区域：`eda_pcb_create_region`（`pcb_MathPolygon.createPolygon` + `pcb_PrimitiveRegion.create`）、`eda_pcb_get_regions`、`eda_pcb_delete_region`。
- 自动布局/布线：`eda_pcb_auto_place`（`pcb_Document.autoLayout`）、`eda_pcb_auto_route`（`pcb_Document.autoRouting`）。
- Gerber：`eda_pcb_export_gerber`（`pcb_ManufactureData.getGerberFile`），返回 `{ name, size, dataUrl }`（zip 为 base64，大板可能很大）。
- 别名：`eda_pcb_get_components` / `eda_pcb_get_nets` / `eda_pcb_get_layers` / `eda_pcb_place_component` / `eda_pcb_draw_track` / `eda_pcb_draw_via` / `eda_pcb_save_document` / `eda_pcb_import_changes` / `eda_pcb_get_primitives_in_region` / `eda_pcb_navigate_to_region` / `eda_pcb_draw_board_outline` 统一映射到同名 `pcb_*` 工具。
- 工具总数 41 → 65。

### 修正

- **板框不能用区域 API**：官方类型是 `TPCB_LayersOfRegion = TPCB_LayersOfCopper | EPCB_LayerId.MULTI`，即只允许 top(1)/bottom(2)/内层(15-44)/MULTI(12)；板框层 11 调用 `pcb_PrimitiveRegion.create` 会失败。因此 `pcb_draw_board_outline` / `eda_pcb_draw_board_outline` 仍按**板框层 11 上的闭合线段**绘制，并在文档与工具描述里写清；`eda_pcb_create_region` 对非铜层直接报错。
- `pcb_draw_board_outline` 增加入参校验（至少 3 个点、有限数值、自动去掉重复的收尾点）、线段明细与失败计数，不再静默产生零长度线段。
- 区域创建走扩展内部助手 `dsh.internal.pcbCreateRegion`：先用 `pcb_MathPolygon.createPolygon` 把 `[x1,y1,'L',x2,y2,...]` 源数组转成 `IPCB_Polygon`（高层 API 不接受原始数组），并把 JSON 里的 `null` 还原为 `undefined`（可选参数）。
- bridge 监听端口被占用时不再抛出未捕获异常崩溃：输出可读的 stderr 提示（含 `netstat -ano | findstr 39009` 排查建议）。

### 嘉立创EDA扩展

- 新增心跳自愈：官方 `sys_WebSocket` 既没有关闭回调也不会自动重连，原实现一旦 DSH 桥接子进程重启（例如点设置页「重连」）就永久掉线，只能手动点菜单。现在每 10s 发一次 `ping`，超过 2.5 个心跳没有 `pong` 就关闭并重新 `register`，未连接时也会以 ≥5s 间隔自动重试。
- 白名单补齐上述 PCB 方法；`pcb_ManufactureData.getGerberFile` 走文件返回通道（返回 base64 data URL + 文件名 + 大小）。

### DSH Host / bridge 诊断

- `eda_status` 新增 `extensionVersion`、`versionMismatch`、`hint`：能直接看出「桥接进程在跑但 EDA 扩展没连上 / 扩展版本与 bridge 不一致」。
- 版本号统一为 **0.3.3**（插件包、bridge、EDA 扩展）。

### 升级注意

- 重新导入 `dsh-eda-bridge-extension.zip` 并重启嘉立创EDA专业版，否则新 PCB 方法会被旧扩展的白名单拒绝（`API method not allowed`）。
- 点一次 DSH 设置页的「重连」即可让 bridge 子进程加载新代码，无需重启 DSH。

## 0.3.2

### 嘉立创EDA扩展

- 修复扩展菜单不显示的问题：
  - `extension.json` 的 `headerMenus` 改为 `home` / `sch` / `pcb` 三个 key，与本机能正常显示菜单的 `JLCEDA-MCP` 扩展保持一致。
  - `activationEvents` 简化为 `{ "onStartupFinished": true }`。
  - `entry` 改为 `"./api-bridge.js"`，并补上 `engines`、`dependentExtensions`、`categories`。
- 新增扩展加载诊断吐司：扩展入口执行时提示 `DSH EDA MCP 扩展已加载 v0.3.2`。
- 新增不依赖菜单的连接入口：
  - 扩展通过 `eda.sys_MessageBus.subscribePublic('dsh-eda-mcp/connect', ...)` 监听连接请求。
  - 未连接时弹出常驻吐司，右侧按钮 **连接 DSH MCP** 执行 `eda.sys_MessageBus.publishPublic('dsh-eda-mcp/connect', {})`。
- DSH 插件包版本、bridge 版本、EDA 扩展版本统一为 **0.3.2**。
- README 增加「菜单不显示时怎么排查」。

### DSH Host

- 无功能变化（仅版本号对齐）。

## 0.3.1

### 嘉立创EDA扩展

- 把菜单直接写进 `extension.json` 的 `headerMenus`，不再只依赖运行时 `insertHeaderMenus`。
- 运行时菜单注册增加重试（最多 5 次）和 `console.error` 日志。
- `dshEdaMcpConnect` / `dshEdaMcpDisconnect` / `dshEdaMcpStatus` 同时挂到 global，保证 `registerFn` 可被解析。

## 0.3.0

### 嘉立创EDA扩展

- 新增手动连接菜单：
  - **连接 DSH MCP 服务器**
  - **断开 DSH MCP 连接**
  - **查看 DSH MCP 连接状态**
- 扩展从原理图切到 PCB 时不再掉线：`activationEvents` 覆盖启动和编辑器事件。
- 修正重复激活时的定时器累积问题。

### DSH Host

- 设置卡片新增 **重新连接** 按钮和固定端口显示。
- 新增 `/api/dsh-eda-mcp/reconnect` 路由，会重启 MCP 桥接子进程并返回健康状态。

## 0.2.0

### 坐标与页面边界

- 新增 MCP 工具 `eda_get_page_info`：返回当前页、A4 图框、标题栏避让范围、推荐安全区。
- A4 常量落地：图框 `x 0~1170, y 0~825`；标题栏 `x 460~1160, y 10~190`（MCP 单位 0.01 inch）。
- `eda_place_component` 默认拒绝越出图框或压住标题栏的放置；放置后按实际包围盒二次检查，越界自动删除并报错。
- `eda_draw_rectangle` 明确 `topLeftY` 是上边 y，height 向下延伸。

### 查询修复

- 修复 `eda_get_components`：`sch_PrimitiveComponent.getAll` 固定传 `['part', false]`。
- 返回内容增加 designator、value、x/y、rotation、bbox、width、height。

### 白名单扩展

- 新增 `dmt_Schematic.*`、`sch_Document.autoLayout/autoRouting`、`sch_Drc.check`、`sch_Net.*`、`sch_PrimitivePin.get/modify`、`sch_Primitive.getPrimitivesBBox`、`sch_ManufactureData.getNetlistFile/getBomFile`。
- 新增 PCB 相关：`pcb_Document.*`、`pcb_PrimitiveComponent.*`、`pcb_PrimitiveLine.create`、`pcb_PrimitiveVia.create`、`pcb_Net.*`、`pcb_Layer.*`、`dmt_Board.createBoard`。

### 新工具

- `eda_get_schematic_pages`、`eda_get_nets`、`eda_get_pins`
- `eda_place_net_flag_at_pin`、`eda_place_net_label_at_pin`
- `eda_set_no_connect`
- `eda_draw_functional_box`
- `eda_run_drc`、`eda_auto_layout`、`eda_auto_route`
- `eda_export_netlist`、`eda_export_bom`
- `eda_create_board`
- PCB：`pcb_get_components`、`pcb_get_nets`、`pcb_get_layers`、`pcb_place_component`、`pcb_draw_track`、`pcb_draw_via`、`pcb_draw_board_outline`、`pcb_save_document`、`pcb_import_changes`、`pcb_get_primitives_in_region`、`pcb_navigate_to_region`

### 其他

- EDA 扩展支持返回文件类结果（网表/BOM）的文本或 data URL。
- 系统提示补充坐标单位、A4 图框和标题栏避让说明。

## 0.1.0

- 首个版本：DSH Host 插件 + 零依赖 MCP/WebSocket bridge + 嘉立创EDA扩展 + Web GUI 设置卡片。
- 原理图工具：放置器件、网络标识/端口、画导线/矩形/圆/文本、保存、缩放、查询、删除、白名单通用 API。

## 已知限制

- `sch_Document.navigateToRegion` 在 pro-api 0.3.18 是空实现，始终返回 `false`；请用 `dmt_EditorControl.zoomToRegion` 或 `sch_Document.navigateToCoordinates`。
- 当前 API 版本没有 `dmt_Board.updateBoardFromSchematic`，只有 `dmt_Board.createBoard`。
- 画布截图已能返回 data URL，但还没接入 MCP 图片块。
- 元件包围盒检查依赖 `sch_Primitive.getPrimitivesBBox`；个别没有 BBox 的图元会跳过越界检查。
- WebSocket 端口固定为 `39009`。
