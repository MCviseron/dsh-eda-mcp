# dsh-eda-mcp

[![check](https://github.com/MCviseron/dsh-eda-mcp/actions/workflows/check.yml/badge.svg)](https://github.com/MCviseron/dsh-eda-mcp/actions/workflows/check.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/dsh-eda-mcp.svg)](https://www.npmjs.com/package/dsh-eda-mcp)
[![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](package.json)

把 DeepSeek Harness (DSH) 连接到 **嘉立创EDA专业版 / EasyEDA Pro**，让 Agent 通过 MCP 工具画原理图。

> English: [README.md](README.md) · 完整工具参考：[docs/tools.md](docs/tools.md) · 变更记录：[CHANGELOG.md](CHANGELOG.md)

## 工作原理

```
DSH Agent
  └─ mcp__jlceda__eda_* 工具
       └─ @deepseek-ai/dsh-mcp-client（stdio）
            └─ lib/bridge.mjs（本地 MCP + WebSocket 服务，127.0.0.1:39009）
                 └─ 嘉立创EDA专业版扩展 dsh-eda-bridge-extension.zip
                      └─ 官方扩展 API（eda.sch_*）
```

DSH 插件启动一个零第三方依赖的桥接子进程。桥接进程通过 stdio 对 DSH 说 MCP，通过 WebSocket 对嘉立创EDA扩展说 JSON-RPC。扩展只执行官方 EDA API 白名单，模型无法在 EDA 内执行任意代码。

## 坐标单位（重要）

- 嘉立创EDA专业版内部坐标显示单位是 inch。
- MCP 工具坐标单位是 0.01 inch：MCP 坐标 = inch * 100。
- 原点在 A4 图框左下角，y 轴向上为正。
- A4 图框范围（MCP 单位）：x 0 ~ 1170，y 0 ~ 825。
- 标题栏/信息框范围（MCP 单位）：x 460 ~ 1160，y 10 ~ 190，放置元件必须避让。
- 推荐安全区（MCP 单位）：信息框上方 x 40 ~ 1130，y 200 ~ 800；信息框左侧 x 40 ~ 440，y 40 ~ 180。
- `eda_get_page_info` 返回当前页、图框、标题栏和推荐安全区。
- `eda_place_component` 默认拒绝越出图框或压住标题栏的放置；符号实际包围盒超界时会自动删除并报错。确需越界时传 `allowOutsideFrame: true`。

## 安装

> 运行时要求：DSH `0.1.1-rc.x`、`0.1.5-rc.x`、`0.2.0-rc.x` 或 `0.2.1-rc.x`（Web GUI 与官方桌面端）。宿主端设置接缝与浏览器端依赖都已按各代适配，同一份构建在任意一代上都能加载。
>
> 已验证的代际：`0.1.5-rc.2`（本仓库开发用）与 `0.2.0-rc.2` / `0.2.1-rc.2`（桌面端运行时与 npm `next`）。出现新版本线时跑 `pnpm seam-check next` —— 它会把该代际的接缝包装到临时目录，逐条断言本插件依赖的契约：mcp-client 的 `inject: ['tools']` 与配置键、设置接缝、`systemPrompt.section({ name, order, text })`、`webServer.register({ kind: 'exact' })`、以及 `window.__ModuleLoader__.load({ id, factory })` 包装格式。

### 0. 从 npm 安装（推荐）

```sh
cd "$DSH_HOME/profiles/<profile>"
pnpm add dsh-eda-mcp            # 或用 Web GUI 的插件管理器安装
# 重启 DSH
```

发布包里已包含 `lib/` 与 `dsh-eda-bridge-extension.zip`，**不需要构建工具链**。扩展仍需手动导入
嘉立创EDA：zip 位于 `node_modules/dsh-eda-mcp/dsh-eda-bridge-extension.zip`（也可从设置卡片下载）。

### 1. 安装到 DSH Web profile

```sh
# 直接从 GitHub 安装（pnpm 会跑包里的 prepare 构建）
dsh plugin --profile web add "github:MCviseron/dsh-eda-mcp"

# 或本地克隆后用 link 安装，改完 pnpm build 重启 profile 即生效
git clone https://github.com/MCviseron/dsh-eda-mcp.git
cd dsh-eda-mcp && pnpm install && dsh plugin --profile web add "link:$PWD"
```

`dsh plugin` 会转发给 pnpm 并自动协调 `dsh.profile.bundles`。安装后请重启当前 DSH Web 进程。

### 2. 导入嘉立创EDA桥接扩展

构建会生成 `dsh-eda-bridge-extension.zip`。在嘉立创EDA专业版中：

1. 打开 **扩展 → 导入**。
2. 选择 `dsh-eda-bridge-extension.zip`。
3. 在扩展列表中找到 **DSH EDA MCP Bridge**。
4. 启用它，并务必开启 **允许外部交互**。

扩展会连接 `ws://127.0.0.1:39009/ws`。保持嘉立创EDA专业版运行，并打开一个原理图页。

### 3. 验证

DSH Web GUI 设置页的 **嘉立创EDA MCP** 卡片里有 **测试连接** 和 **重新连接** 按钮。MCP 工具名形如 `mcp__jlceda__eda_status`、`mcp__jlceda__eda_place_component`、`mcp__jlceda__eda_draw_wire`。

### 3b. 在官方桌面端（DeepSeek Harness 桌面应用）里运行

桌面端把插件宿主跑在 **Electron** 里（`D:\DeepSeek Harness\…\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host`），所以在桌面端 **`process.execPath` 是 `DeepSeek Harness.exe`，不是 Node**：直接拿它去 `spawn` bridge 脚本会启动（或被单实例锁挡掉）第二个应用进程，bridge 永远不会监听 39009，表现为「设置卡片在、但测试连接一直失败、Agent 也没有 `mcp__jlceda__*` 工具」。

插件现在按下面的顺序挑选**真正能跑 Node 脚本的可执行文件**（`src/node-runtime.ts`）：

1. `DSH_EDA_MCP_NODE` —— 显式覆盖，路径存在就用；
2. `DSH_NODE_EXECUTABLE` / `DSH_DESKTOP_NODE_EXECUTABLE` —— 桌面启动器导出的变量（指向应用二进制，因此额外注入 `ELECTRON_RUN_AS_NODE=1`）；
3. 宿主本身是 Node（`process.versions.electron === undefined`）→ `process.execPath`；
4. Electron 宿主 → 桌面负载自带的 Node：`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`（桌面端实测为 v24.21.0）；
5. `PATH` 里的 `node`；
6. 兜底：`process.execPath` + `ELECTRON_RUN_AS_NODE=1`（Electron 当 Node 用）。

`POST /api/dsh-eda-mcp/test` 的返回体现在带有 `launch` 字段，直接告诉你用的是哪个可执行文件、依据哪条规则：

```json
{"ok":true,"bridgePort":39009,"health":{"status":"ok","version":"0.3.5","clients":1},
 "launch":{"command":"D:\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe",
           "args":["…\\lib\\bridge.mjs"],"source":"desktop runtime Node"}}
```

排查顺序：`launch.source` 是否是 `process.execPath …`（说明没找到自带 Node）→ 手动跑一次 `launch.command launch.args[0]` 看 `http://127.0.0.1:39009/healthz` → 再点「重新连接」。

**如果命令正确但 bridge 还是没起来**，用这两条自检路由定位（都在宿主进程内部执行）：

```powershell
# 1) 挂载诊断：tools 服务是否可见、挂载次数、挂载异常、fiber 状态、健康探测
curl.exe -s -X POST http://127.0.0.1:19387/api/dsh-eda-mcp/diagnostics

# 2) 宿主自检：插件宿主自己 spawn 一次 bridge，回报 spawned/exited/exitCode/stderr/healthz
curl.exe -s -X POST http://127.0.0.1:19387/api/dsh-eda-mcp/self-test
```

- `diagnostics.toolsServiceSeen: false` → 工具注册表在该上下文不可见：0.2 的 `@deepseek-ai/dsh-mcp-client` 声明了 `inject = ["tools"]`，没有这个服务它就永远不会 apply（不会报错、也不会 spawn）。
- `diagnostics.mountError` 出现 `serverName "jlceda" is already in use` → 上一次挂载的 fiber 还没销毁完就重挂（`fiber.dispose()` 是异步的）。插件已改为串行挂载 + await 销毁来避免。
- `self-test` 里 `spawned: true` 但 `exited` 很快、`stderr` 有内容 → 宿主能启动 Node，问题在被启动的进程（看 stderr）；`spawnError` 非空 → 宿主进程被限制启动该可执行文件。

> 桌面端加载的是打包后的 `lib/index.js`，**改完 `src/` 必须重新 `node build.mjs` 并重启桌面应用**（插件重载不会重新 import 已缓存的 ESM 模块）。

### 4. 在嘉立创EDA里手动连接

DSH 桥接服务开着但 EDA 没有连上时，有三种入口：

1. **吐司按钮（最可靠）**：扩展加载后会弹出一条常驻提示「DSH MCP 未连接」，右侧有 **连接 DSH MCP** 按钮。这个按钮不依赖菜单系统，点它就会通过公共消息总线触发连接。
2. **扩展菜单**：`headerMenus` 同时注册了 `home` / `sch` / `pcb` 三个环境。
   - 扩展管理器里 **Show at header menu 关闭** 时：菜单位于 **高级 → DSH MCP**。
   - 开启时：菜单位于顶部菜单栏。
3. **DSH 设置页**：Web GUI 的 **测试连接** / **重新连接** 按钮。

菜单项：

- **连接 DSH MCP 服务器** — 重新发起 `ws://127.0.0.1:39009/ws` 连接。
- **断开 DSH MCP 连接** — 主动断开。
- **查看 DSH MCP 连接状态** — 吐司提示当前连接状态、端口和扩展版本。

连接按钮通过 `eda.sys_WebSocket.register` 工作；如果 EDA 未开启本扩展的 **允许外部交互**，连接会失败并给出提示。

**0.3.3 起扩展会自愈（0.3.4 同样）**：官方 `sys_WebSocket` 没有关闭回调、也不会自动重连，所以扩展每 10s 发一次 `ping`；只要超过 2.5 个心跳（约 25s）没收到 bridge 的 `pong`，就关闭并按 ≥5s 间隔重新 `register`。也就是说 DSH 侧点了「重连」导致 bridge 子进程重启后，EDA 会在半分钟内自己连回来；0.3.2 及更早版本必须手动点一次「连接 DSH MCP」。

用 `eda_status` 可以一眼看出问题：

- `connectedClients: 0` → EDA 没连上（看 `hint`）。
- `extensionVersion` 与 `bridgeVersion` 不一致 → 扩展还是旧的，重新导入 zip 并重启 EDA。
- 调用 PCB 新方法报 `API method not allowed: ...` → 扩展白名单是旧的，同样需要重新导入。

### 5. 菜单不显示时怎么排查

扩展加载时会弹一条 `DSH EDA MCP 扩展已加载 v0.3.5` 的吐司。

- **看到这条吐司**：说明扩展入口已经在运行，直接用常驻吐司上的「连接 DSH MCP」按钮即可，不必依赖菜单。
- **看不到这条吐司**：说明扩展入口没有执行，通常是扩展没有真正重新导入/重新加载。请：
  1. 在扩展管理器确认版本是 **0.3.5**；
  2. 关闭并重新打开嘉立创EDA专业版；
  3. 确认扩展处于启用状态，且开启 **允许外部交互**。
- 菜单是否显示还受嘉立创EDA当前 UI 模式影响：`Advanced` 菜单和扩展菜单只在高级模式下完整显示。

## MCP 工具

### 页面与查询

| 工具 | 用途 |
|---|---|
| `eda_status` | 桥接状态、端口、已连接 EDA 客户端数 |
| `eda_launch` | 启动嘉立创EDA（可直接打开 `.eprj2` 工程）并等待扩展连上 |
| `eda_get_page_info` | 当前页、A4 图框、标题栏、安全区 |
| `eda_get_schematic_pages` | 原理图图页列表 / 按 uuid 查询 |
| `eda_search_components` | 搜索嘉立创库器件 |
| `eda_get_components` | 列出器件（位号、Value、x/y、旋转、包围盒、宽高） |
| `eda_get_wires` | 列出导线 |
| `eda_get_nets` | 当前工程网络；`sch_Net.*` 为空时自动降级解析网表，返回 `source` 说明数据来源 |
| `eda_get_active_document` / `eda_open_document` | 查看/切换当前活动文档（原理图 API 只作用于活动文档） |
| `eda_get_net_labels` / `eda_place_net_label` | 列出/放置真正的网络标签；`eda_place_net_label_at_pin` 优先用 `createNetLabel` 并返回 `method` |
| `eda_get_pins` | 列出某个器件的所有引脚 |

### 放置与绘制

| 工具 | 用途 |
|---|---|
| `eda_place_component` | 放置器件/符号，可同时设置 designator、value、name |
| `eda_place_net_flag` / `eda_place_net_port` | 放置电源/地标识、网络端口 |
| `eda_place_net_flag_at_pin` | 读取引脚坐标并在引脚处放电源/地标识 |
| `eda_place_net_label_at_pin` | 读取引脚坐标并在引脚处放文本网络标签 |
| `eda_set_no_connect` | 给引脚设置/清除非连接标识 |
| `eda_draw_wire` | 画导线/折线 |
| `eda_draw_rectangle` | 画矩形（topLeftY 是上边 y，height 向下延伸） |
| `eda_draw_functional_box` | 按一组器件的包围盒自动画虚线功能框，可带标签 |
| `eda_draw_circle` / `eda_draw_text` | 画圆 / 文本 |
| `eda_delete_primitive` | 删除原理图图元 |

### 自动化与导出

| 工具 | 用途 |
|---|---|
| `eda_run_drc` | 原理图 DRC（返回详细结果数组） |
| `eda_auto_layout` / `eda_auto_route` | 原理图自动布局 / 自动布线 |
| `eda_export_netlist` | 导出网表文本 |
| `eda_export_bom` | 导出 BOM（csv 返回文本，xlsx 返回 data URL） |
| `eda_save_document` | 保存当前原理图 |
| `eda_zoom_to_fit` / `eda_zoom_to_region` | 缩放画布 |
| `eda_create_board` | 创建关联原理图和 PCB 的板子 |
| `eda_api_call` | 白名单通用 API 调用（可在设置中关闭） |

### PCB

所有 PCB 工具都有等价的 `eda_pcb_*` 别名（例如 `eda_pcb_get_components` = `pcb_get_components`），两套名字指向同一实现。

| 工具 | 用途 |
|---|---|
| `pcb_get_components` / `pcb_get_nets` / `pcb_get_layers` | 查询 PCB 器件 / 网络 / 图层 |
| `pcb_place_component` | 放置 PCB 器件/封装（`pcb_PrimitiveComponent.create`） |
| `eda_pcb_move_component` | 移动/旋转/改位号（`pcb_PrimitiveComponent.modify`，x/y 为绝对坐标） |
| `eda_pcb_delete_component` | 删除 PCB 器件 |
| `pcb_draw_track` | 画一段 PCB 走线（`pcb_PrimitiveLine.create`） |
| `eda_pcb_get_tracks` | 列出走线，可按 net / layer / locked 过滤 |
| `eda_pcb_modify_track` | 改走线：net、layer、startX/Y、endX/Y、lineWidth、locked |
| `eda_pcb_delete_track` | 删除走线 |
| `pcb_draw_via` | 放过孔（`pcb_PrimitiveVia.create`） |
| `eda_pcb_get_vias` / `eda_pcb_delete_via` | 列出 / 删除过孔 |
| `eda_pcb_create_region` | 建区域（`pcb_MathPolygon.createPolygon` + `pcb_PrimitiveRegion.create`） |
| `eda_pcb_get_regions` / `eda_pcb_delete_region` | 列出 / 删除区域 |
| `pcb_draw_board_outline` | 在板框层（11）创建一条闭合板框折线（`pcb_PrimitivePolyline`） |
| `pcb_draw_polyline` | 在任意线层创建闭合折线（3/4 丝印、9/10 装配、13 文档、14 机械、11 板框、1/2 铜层） |
| `eda_pcb_get_polylines` / `eda_pcb_delete_polyline` | 列出 / 删除折线（板框、丝印图形、机械图） |
| `eda_pcb_auto_place` | PCB 自动布局（`pcb_Document.autoLayout`） |
| `eda_pcb_auto_route` | PCB 自动布线（`pcb_Document.autoRouting`）。不传网络时自动枚举全部网络名再传入，见下 |
| `eda_pcb_clear_routing` | 清除布线（默认后台任务；旧扩展下自动分批，`batchSize`/`mode`/`net`/`layer` 可调） |
| `eda_pcb_job_status` | 轮询后台 PCB 任务（自动布线/布局）的 `running`/`elapsedMs`/`result`/`error` |
| `eda_pcb_create_pour` / `eda_pcb_get_pours` / `eda_pcb_delete_pour` | 覆铜创建/查询/删除（`pcb_PrimitivePour`，`45grid`/`90grid`/`solid`） |
| `eda_pcb_run_drc` / `eda_pcb_get_drc_rules` | PCB DRC 检查与规则配置查询 |
| `eda_pcb_set_net_track_width` | 按网络批量修改走线线宽（电源/GND 加粗） |
| `eda_pcb_export_gerber` | 导出 Gerber（`pcb_ManufactureData.getGerberFile`），返回 `{ name, size, dataUrl }` |
| `pcb_save_document` / `pcb_import_changes` | 保存 PCB / 从原理图导入变更 |
| `pcb_get_primitives_in_region` / `pcb_navigate_to_region` | 区域查询 / 画布导航 |

### 板框 = `pcb_PrimitivePolyline`（不是导线、也不是区域）

板框既不能用 `pcb_PrimitiveLine.create`（那是铜层导线图元，会被核心拒绝并报「无法创建直线图元」），也不能用 `pcb_PrimitiveRegion.create`（官方类型 `TPCB_LayersOfRegion = TPCB_LayersOfCopper | EPCB_LayerId.MULTI` 只允许铜层和 MULTI）。

JLCEDA 工程文件里真实的板框记录是：

```
["POLY", "e102", 0, "", 11, 10, ["R", 0, 0, 3149.6063, 2362.2047, 0, 0], 1]
```

也就是层 11 上的**折线（polyline）**，多边形源数组 + 线宽。`pcb_draw_board_outline` 就是按这个格式创建的：`createPolygon([x1,y1,'L',x2,y2,...])` + `PrimitivePolyline.create(net, 11, polygon, 10)`。

板框示例：

```json
{ "points": [0, 0, 3000, 0, 3000, 2000, 0, 2000], "lineWidth": 10 }
```

### 自动布线为什么要显式传网络

`pcb_Document.autoRouting` 不传网络时内部 `routingRange` 是 `[]`，**本版 EDA 核心会立刻返回 `success=false, duration=0`，把全部网络列为失败**；显式传网络名则正常工作（实测 `["GND"]` 288 ms 成功、`["VCC5","VCC3V3","LED_G"]` 3/3 成功）。所以本插件的 `eda_pcb_auto_route` 在不传网络时先调用 `pcb_Net.getAllNetsName` 枚举全部网络再传入。

另外：官方文档示例写 `nets`，但 0.3.18 的实现只读 `RoutingNets`（`nets` 会被静默忽略），插件现在两个键都接受。

**自动布线默认异步**：`eda_pcb_auto_route` 立刻返回（EDA 会在 PCB 编辑器里显示自己的进度条），然后用 `eda_pcb_job_status` 轮询 `running` 直到 `false`；不要用超时等待，也不要加大超时——整板或 GND 这类 35+ 引脚的大网络会远超任何合理超时，而 EDA 其实一直在正常布线。`wait: true` 仍可阻塞等待（只适合小任务）。

### 区域（keepout / 约束区域）

区域只支持铜层与 MULTI：`eda_pcb_create_region` 对非铜层（例如板框层 11）会直接报错。

区域示例：

```json
{
  "layer": "top",
  "points": [1000, 1000, 5000, 1000, 5000, 4000, 1000, 4000],
  "ruleType": [2, 9],
  "regionName": "keepout"
}
```

`ruleType` 取值：2 禁止器件、5 禁止导线、6 禁止填充、7 禁止覆铜、8 禁止内电层、9 约束区域（跟随区域规则）。点集是扁平数组、自动闭合，不需要重复首点。

原理图/符号坐标单位是 0.01 inch，PCB 坐标单位是 mil。角度取 `0/90/180/270`。导线 points 使用扁平数组 `[x1, y1, x2, y2, ...]`。

## 完整工具参考

`docs/tools.md` 由构建产物（bridge 的 MCP `tools/list`）自动生成（`pnpm docs`），共 **82 个工具**，是唯一权威清单：名称、描述、参数与必填项都在里面。下面只写流程与坑。

## 设计规范

规范正文见 **[docs/design-rules.md](docs/design-rules.md)**：原理图分区与放置、网络命名、PCB 布局、线宽/过孔/铺铜、DRC、丝印板框、制造输出、打样检查清单与推荐工作流。

其中**可量化**的部分由插件强制，而不只是写在文档里：

| 规则 | 落实方式 |
|---|---|
| 网络命名 | 只允许字母、数字、`_`、`.`、`+`、`-`，≤255 字符；空格、斜杠、括号、中文会被**拒绝**（后端按精确字符串匹配，`USB_DP/DM` 会被拆成两个网络） |
| 走线线宽 | `pcb_draw_track` 按网络角色给默认值（信号 6 mil / 电源 16 mil），**低于 6 mil（0.15 mm）直接报错**，确需越界用 `force: true` |
| 过孔 | `pcb_draw_via` 按角色给标准孔径（0.2/0.4 mm 信号、0.3/0.6 mm 电源）；焊环（盘径−孔径）≥0.20 mm，孔径 <0.2 mm 报错、<0.3 mm 警告 |
| 铺铜 / DRC | `eda_pcb_create_pour` 回传 6/10 mil 间距要求；`eda_design_audit` 汇总检查 |

**`eda_design_audit`** 是一次性只读体检：每个网络的最小线宽与角色建议、过孔几何、网络名、板框、铺铜、PCB DRC，返回 `violations` / `warnings` / `checklist`。布线前后各跑一次。

## 推荐工作流

### A. 画原理图（电气连接优先）

1. `eda_get_page_info` 拿 A4 图框、标题栏禁布区与安全区，再 `eda_search_components` + `eda_place_component` 放器件（越界会被拒绝并回滚）。
2. 连线用 `eda_draw_wire` 的 **net 参数**（同名网络自动合并），这是最可靠的电气连接方式；`eda_place_net_flag_at_pin` 放电源/地标识；`eda_place_net_flag_at_pin` / `eda_place_net_label_at_pin` 默认**不会把标识压在元件上**：先读引脚 `rotation`（指向离开元件本体的方向），再拉一条**带同名 net 的短导线**（`stubLength` 默认 20 单位 = 5.08 mm），标识放在导线末端——所以即使 `eda_place_net_label_at_pin` 返回 `method: "text"`（`createNetLabel` 不可用，官方标注 ADD since EDA v4），**电气连接也已由那条短导线建立**。想手动定位就传 `offsetX/offsetY`（自动禁用短导线），`stubLength: 0` 恢复旧的「压在引脚上」行为。
3. 空脚用 `eda_set_no_connect`，分组用 `eda_draw_functional_box`，最后 `eda_run_drc` + `eda_save_document`。

### B. 原理图 → PCB 同步（会弹确认框）

1. `eda_create_board` 关联原理图与 PCB（首次）。
2. `pcb_import_changes`：**默认异步**。`pcb_Document.importChanges` 会弹出 EDA 自己的确认对话框并一直阻塞，所以调用立刻返回并附带 `componentsBefore`，导入本身在后台跑。
3. 让用户在 EDA 里点 **确定**，然后 `eda_pcb_wait_for_components` 轮询：**默认每 5 秒一次（最小 3 秒）**，最长 45 秒（`pollIntervalMs` / `maxWaitMs` 可调）。判定规则就是「PCB 上出现了同步前不存在的元件」——有就是用户点了。
4. 返回 `confirmed: true` 后 `pcb_save_document` 保存。没确认就返回 `confirmed: false`，问用户再调一次即可。

### C. PCB 布局与布线（长任务一律轮询）

1. 板框：`pcb_draw_board_outline`（板框层 11 上一条闭合 `pcb_PrimitivePolyline`）。
2. 布局：`eda_pcb_get_components`（`includePins: true` 取准确 pad/net）+ `eda_pcb_move_component`；`eda_pcb_auto_place` 可自动布局（默认阻塞，`wait: false` 异步）。
3. 布线：`eda_pcb_auto_route` **默认异步启动**（EDA 自己显示进度条），然后 `eda_pcb_job_status` 轮询 `running` 直到 `false`。**不要等、也不要加大超时**——整板或 GND 这类 35+ 引脚的网络必然超过任何合理超时，而 EDA 其实一直在布。要重来先 `eda_pcb_clear_routing`。
4. 重来：`eda_pcb_clear_routing` 默认也是**后台任务**（旧扩展下自动降级为**分批删除**，`batchSize` 默认 200，返回 `remaining`/`done`，重复调用到 `done: true` 为止）——整板清除不会再超时。
5. 检查：`eda_pcb_run_drc`（`strict` 含警告、`includeVerboseError` 返回明细）+ `eda_pcb_get_drc_rules`。
6. 收尾：`eda_pcb_set_net_track_width` 给电源/GND 加粗；`eda_pcb_create_pour` 铺铜（`45grid`/`90grid`/`solid`，仅铜层）；`eda_pcb_export_gerber` 导出（返回 base64 data URL，大板可能几 MB）。

### D. 活动文档规则（很多 API 只作用于当前标签页）

`sch_Net.*`、网表导出（`eda_export_netlist`）、`sch_Primitive*` 的 get/getAll 都只认**当前活动文档**：PCB 在前台时它们返回 `[]` / `null`。`eda_get_nets` 因此会按 `getCurrentProjectAllNets → getAllNets → 解析 sch_Netlist.getNetlist` 降级并返回 `source`；返回空时用 `eda_get_active_document` 查看、`eda_open_document` 把原理图页切到前台再试。
## 配置

Web GUI 设置卡片提供：

- `enabled` — 挂载/卸载 MCP 桥接。
- `announceToAgent` — 向系统提示注入插件说明。
- `toolCallTimeoutMs` — 单次 EDA 调用超时。
- `allowRawApi` — 是否暴露通用 `eda_api_call`。

第一版 WebSocket 端口固定为 `39009`，请勿在该端口运行其它服务。

## 开发

环境要求：Node `^22.19.0 || >=24`、pnpm（由 `packageManager` 固定版本），打包扩展 zip 需要 **Windows**（用 PowerShell `Compress-Archive`）。

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # 单元测试
pnpm build       # 打入 lib/*.js 与扩展 zip
pnpm check       # 以上三步
```

构建产物：

- `lib/index.js` — DSH Host 插件。
- `lib/client.js` — DSH Web GUI 设置卡片。
- `lib/bridge.mjs` — 独立 MCP/WebSocket 桥接子进程。
- `dsh-eda-bridge-extension.zip` — 嘉立创EDA专业版扩展。

`lib/` 与 zip 都是构建产物（已 gitignore）；宿主加载的是打包后的 `lib/index.js`，所以改 `src/` 后必须 `pnpm build` **并重启 Host**（插件重载不会重新 import 已缓存的 ESM 模块）。仓库结构、发布打 tag 流程、bridge/扩展版本规则见 [CONTRIBUTING.md](CONTRIBUTING.md)；**发布到 npm** 的完整流程（首次手动发布，之后由 `v*` tag 经 trusted publishing/OIDC 自动发布）见 [docs/release.md](docs/release.md)。

## 安全

- 桥接只监听回环地址 `127.0.0.1`。
- EDA 扩展和桥接进程都执行同一套 API 白名单。
- 通用 `eda_api_call` 仅限白名单，且可关闭。
- 不暴露任意 JavaScript 执行。

## 已知限制

- `sch_Document.navigateToRegion` 在当前官方 API 版本（pro-api 0.3.18）里是空实现，始终返回 `false`；请改用 `dmt_EditorControl.zoomToRegion` 或 `sch_Document.navigateToCoordinates`。
- `dmt_Board.updateBoardFromSchematic` 在当前 API 版本不存在，暂时只有 `dmt_Board.createBoard`。
- 画布截图已能返回 data URL，但还没有接入 MCP 图片块。
- 修改桥接端口需要同时改桥接环境变量和 `jlc-extension/api-bridge.js`，再重新构建并重新导入扩展。
- 元件包围盒检查依赖 `sch_Primitive.getPrimitivesBBox`；个别图元若没有 BBox，会跳过超界检查。
- 扩展 `activationEvents` 已包含 onStartupFinished / onProjectOpened / onEditorSchematic / onEditorPcb；如果导入旧版扩展后切到 PCB 掉线，请重新导入新版 zip。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `src/index.ts`、`src/routes.ts`、`src/node-runtime.ts`、`src/config-values.ts`、`src/bridge-diagnostics.ts`、`src/guidance.ts` | DSH 宿主端 |
| `src/bridge/index.ts` | 独立 MCP/WebSocket 桥接子进程 |
| `src/bridge/design-rules.ts` | 可强制的设计限制：网络命名、线宽档位、过孔几何 |
| `src/client/` | Web 设置卡片 |
| `jlc-extension/` | 嘉立创EDA专业版扩展（打包进 zip） |
| `test/` | 单元测试 |
| `docs/design-rules.md` | 原理图 + PCB 设计规范正文 |
| `docs/tools.md` | 自动生成的完整工具参考（名称/描述/参数/必填项） |
| `docs/release.md` | 维护者发布手册（npm、trusted publishing、版本约定） |
| `scripts/gen-tools-doc.mjs` | 从构建产物重新生成 `docs/tools.md` |
| `build.mjs` | esbuild 打包（可复现）+ 扩展 zip |

## 许可证

Apache-2.0 © dsh-eda-mcp contributors，见 [LICENSE](LICENSE)。
