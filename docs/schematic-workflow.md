<!-- 本文件由 scripts/gen-skill-doc.mjs 从 src/skills-content.ts 生成，请勿手工编辑。 -->
<!-- 同一份内容同时作为 DSH 技能 jlceda-schematic-workflow 的正文，以及系统提示精简版的来源。 -->

# 嘉立创EDA 项目全流程手册（dsh-eda-mcp）

覆盖「打开/新建工程 → 原理图 → 同步到 PCB → 布局布线 → 校验 → 出 Gerber」全链路，
以及每一步已经踩过的坑与处置办法。工具前缀统一是 mcp__jlceda__。

## 0. 适用范围与硬前提

- 原理图坐标单位 0.01 英寸，原点在 A4 图框左下角，y 向上；图框 x 0~1170 / y 0~825。
- 标题栏占 x 460~1160 / y 10~190，必须避让；先 eda_get_page_info 读图框与安全区。PCB 坐标单位 mil。
- 绝大多数原理图 API 只作用于「当前活动文档」：返回空先 eda_get_active_document，再 eda_open_document 切页。
- 线协议版本必须桥接与扩展一致：eda_status 的 extensionVersions 是每个页面连上来的版本；
  不一致说明装的是旧扩展，需重新导入 dsh-eda-bridge-extension-<版本>.zip 并重启应用（不是 reload）。
- 默认禁止 eda_auto_layout / eda_auto_route（需 force:true 且设置里放行）。
  版面检查用「导出图片自行识别」，不要让 EDA 自动重排。

## 0. 开工前：参数没问清就不要动手

"帮我画一块 X 板"不是规格。供电、接口、板框、层数、连接器朝向这些一旦猜错，板子可能电气正确但完全用不了（外部横评里 6 个模型全都在结果上翻车，多数不是画错线而是没问清前提）。

**第一动作**：调 `eda_design_intake`，拿到 6 个部分 22 个问题（其中 14 个 critical）。

| 部分 | critical 问题 |
|---|---|
| 供电与电流 | 电源来源、输入电压/电流、需要的电源轨 |
| 主控与固件 | 主控型号、时钟方案、烧写接口 |
| 接口与外设 | 对外接口清单、是否隔离/高压 |
| 机械与结构 | 板框尺寸形状、定位孔、连接器朝向 |
| 工艺与制造 | 层数、贴片方式 |
| 交付与验证 | 交付到什么程度（原理图/PCB/可下单） |

**怎么做**：

1. critical 项用 `ask_user_question` 一次问清（有 options 的直接给选项），**不要编造默认值当作已知**；
2. non-critical 项在用户没意见时用工具给的 fallback，并在回复里明说"按默认值处理"；
3. 拿到答复后用 `eda_design_intake({answers:{...}})` 记录，`ready:true` 才算参数齐全；
4. 参数齐了再开始摆器件；未记录参数时第一次 `eda_place_component` 会返回 `intakeWarning`（不阻断，但会点名缺哪些项）。

**反模式**（都真实发生过）：先摆一堆器件再问；把"最小系统板"当成"STM32+USB+晶振"直接开工；板框随手 60×40 导致连接器装不进外壳；默认 2 层却要求阻抗控制。

## 1. 项目层：列出 / 打开 / 新建 / 保存 / 导出

- 列工程：eda_list_projects。无过滤时遍历所有本地目录聚合，字段 friendlyName / teamUuid / uuid。
  半离线模式下每个本地工程目录就是一个 team，其 uuid 就是目录路径。
- 打开工程：eda_open_project({ name }) 支持中文工程名（精确优先，其次忽略大小写包含）。
  返回的 opened 是「已观察到的活动工程」，另有 openReturned 反映 API 原始布尔。
- 新建工程：createProject 在本机构建上无副作用，**用 eda_import_project 导入工程文件代替**：
  eda_import_project({ path, teamUuid, friendlyName, open:true })，teamUuid 取 eda_list_teams 的目录路径。
- 导出：eda_export_project({ outPath }) 落盘并返回字节数；不给 outPath 只回元数据，inline:true 才回 base64。
- 保存：eda_save_document（原理图）/ eda_pcb_save_document（PCB）。关应用前先保存。
- 不可用（实测）：createProject / deleteProject / copyProject 对本地工程无效；
  删除与复制请在应用内完成，复制也可「导出 + 导入」得到独立副本。

## 2. 原理图：先读清楚再动手

- eda_get_active_document → 确认 documentTypeName 是原理图页（HOME / PCB 都不行）。
- eda_get_page_info → 图框、标题栏、安全区（main / lowerLeft）。
- eda_get_components({ includeBounds:true }) → designator、value、x/y、包围盒，用来判断重叠。
- eda_get_pins({ componentPrimitiveId }) → 一次拿到 pinName / pinNumber / x / y / rotation / noConnected，
  不要逐脚调 raw sch_PrimitivePin.get。
- eda_get_wires / eda_get_nets → 现有连线与网络；eda_get_net_labels → 标签、网络端口、旗标与文本标签。
- eda_get_project → 工程结构（board → schematic / pcb 的 uuid），后面切页与 PCB 同步都要用。

## 3. 原理图：布局规范

- 栅格 10 单位对齐；同块内器件等间距（建议 ≥30 单位），块间留 ≥40 单位。
- 信号流左→右；电源旗标朝上、地旗标朝下；主控居中，去耦电容贴电源脚（≤20 单位），晶振贴芯片且周围净空。
- 器件之间留 ≥20 单位用于走线与标签，避免标签压住符号或引脚号。
- 分区用 eda_draw_functional_box（虚线框 + 文本标注）：电源 / 主控 / 接口 / 信号处理。
- 挪已有器件用 eda_move_component（保 designator/value），不要「删除 + 重放」。
- 摆完一屏回读 eda_get_components 检查包围盒相交，有重叠先调开再连线。
- 版面自查：导出画布图片交给模型识别，而不是让 EDA 自动重排（自动布局会把分好的区打散）。

## 4. 原理图：连线与网络

- 局部连接用 eda_draw_wire（直线或 45°），不要穿过器件符号，不要与其它导线重叠。
- **跨区域同名网络必须用 eda_place_net_port 或网络标签**：eda_draw_wire 的 net 只对悬空导线有效，
  端点一接触引脚，EDA 按连通性重算网络名（实测 TESTNET 被并入 LED_A）。「两处画同名导线」不成立。
- 网络标签：eda_place_net_label 先真实调 sch_PrimitiveAttribute.createNetLabel；该 API 在 3.2.186 上不响应，
  插件按会话缓存探测结论后自动降级为纯文本标签（无电气语义），连通性由 stub 导线承担。
- 引脚上放标签/旗标优先用 *_at_pin 变体：沿引脚方向外推 stubLength（默认 20）再放，避免压住符号。
- 差分对写成 USB_DP / USB_DM 两个网络，不要写 USB_DP/DM；网络名只允许字母数字下划线点加减号。
- 不用的引脚打未连接标记：eda_set_no_connect({ primitiveIds })。
- 删除图元：eda_delete_primitive 的 kind 支持 component / wire / text / netport / netflag / netlabel；
  网络端口不出现在 eda_get_components 中，只能用 eda_get_net_labels 审计后再删。

## 5. 原理图：批量操作与超时控制

- 批量放标签用 eda_place_net_labels([{ pinPrimitiveId, net } | { x, y, net }])：一次调用、逐条 ok/error、
  返回 done / failed / total。不要串行上百次（会打爆调用超时且没有进度可查）。
- 批量未连接标记用 eda_set_no_connect({ primitiveIds })，内部并发 8。
- 单次调用建议 ≤20 个变更，中间夹一次读取（eda_get_net_labels / eda_get_components）作为进度锚点；
  超时后凭锚点知道完成到哪，而不是全量重来。
- 探测类失败只付一次代价：net label 能力探测结果按会话缓存，probe:true 才重测。

## 6. 原理图：校验与交付

- eda_export_netlist → 已解析对象（parsed:true, netlist）。逐网络检查端点数 ≥2、无悬空单脚网络。
- eda_run_drc → 逐条明细（type / message / primitiveId / x / y），按 primitiveId 回画布定位后修。
- eda_export_bom（csv 已自动从 UTF-16 解码）→ 位号连续、封装非空、无 DUMMY。
- 交付前把网络名清单与需求表比对（命名一致性比 DRC 更容易漏）。

## 7. PCB：从同步到出 Gerber

- 同步：eda_open_document 切到 PCB 页 → pcb_import_changes（默认异步，会弹应用自己的确认对话框）→
  eda_pcb_wait_for_components 判定「新器件出现了」；不要用长超时硬等对话框。
- 读现状：pcb_get_layers、pcb_get_nets({detail:true})、pcb_get_components({includePins:true})。
- 板框：pcb_draw_board_outline({ points }) 生成 layer 11 的闭合 polyline。
  不要用 pcb_draw_track 画板框（铜线，layer 11 被拒），也不要用 region（只支持铜层/MULTI）。
- 布局：pcb_place_component / pcb_move_component 手工摆放（安装孔 → 板边接口 → 主控 → 配套器件）；
  去耦电容距引脚 ≤2mm，晶振靠芯片且下方净空。
- 走线：pcb_draw_track（不传线宽按网络角色给默认值，低于 6mil 直接拒绝）；改线用 pcb_modify_track；
  整网加粗用 pcb_set_net_track_width。
- 过孔：pcb_draw_via（默认孔径按角色给标准值；焊环 <0.2mm 拒绝，孔径 <0.3mm 警告）。
- 铺铜：pcb_create_pour（points 为 mil 扁平数组，自动闭合）；先确认设计规则里铺铜间距 ≥6mil（建议 10mil）。
- 自动布线：eda_pcb_auto_route 默认不用；确需使用才 wait:true 或后台 + eda_pcb_job_status 轮询。
- 校验：eda_pcb_run_drc（includeVerboseError:true 拿逐条）+ eda_design_audit（线宽/过孔/网络名/板框/铺铜/DRC 只读体检）。
- 交付：eda_pcb_export_gerber（返回 zip 的 base64 data URL，大板可能几 MB）。

## 8. 设计规则速查（工具已强制）

- 网络名：字母/数字/下划线/点/加号/减号，≤255 字符；空格、斜杠、括号、中文会被拒绝。
- 线宽：普通信号 ≥6mil(0.15mm)、去耦分支 10mil、主干电源 16mil、>500mA 或 GND 20mil。
- 过孔：信号 0.2/0.4mm、电源/GND 0.3/0.6mm、大电流 0.4/0.8mm；焊环 ≥0.2mm 强制。
- 铺铜：顶/底层铺 GND，与其它网络间距 ≥6mil（建议 10mil），导出前移除孤岛。
- 丝印：字符高度/宽度有最小值限制（见 docs/design-rules.md），丝印不得压焊盘。

## 9. 故障与处置（现象 → 原因 → 动作）

| 现象 | 原因 | 动作 |
|---|---|---|
| connectedClients=0 / 报未连接 | EDA 没开、扩展没导入或没点「连接」、端口被占 | 先 eda_status 看 hint；必要时 eda_launch 起应用并等扩展连上 |
| extensionVersions 与 bridgeVersion 不一致 | 装的是旧扩展 | 重新导入对应版本 zip（文件名带版本号）并重启应用 |
| API method not allowed | 该 API 不在扩展白名单 | 调 eda_list_api_methods 看清单；优先用包装好的工具 |
| open_document 返回 opened:false / activated:false | 应用停在 Start Page（tab_page1），该构建无法从 HOME 程序化打开文档 | 先 eda_open_project 打开工程，再 eda_open_document；用 activeDocumentUuid 确认，别假设已激活 |
| 调用 60s 超时 | 页面切走留下僵尸 socket，或单次改太多 | 只读调用会自动换页面重试一次；把批量拆到 ≤20/批 |
| 读图返回空 / null | 活动文档不是原理图页 | eda_get_active_document → eda_open_document 切页 |
| createNetLabel 无响应 | 3.2.186 该 API 不 resolve | 自动降级文本标签 + stub 导线；批量用 eda_place_net_labels |
| eda_get_net_labels 曾返回 0 | 以前只查属性图元 | 现在同时列文本标签（kind:text），可直接删 |
| 导线 net 被改掉 | 连通性重算覆盖指定名 | 跨区域改用网络端口 / 网络标签 |
| 器件位置重叠 | 没按栅格、没留间距 | eda_move_component 重排；摆完回读包围盒 |
| 导入 .epro2 后 uuid 冲突 | 应用原样复制内部 id | 看返回 collisions；避免同时打开源工程与新工程 |
| createProject / copyProject / deleteProject 空或 false | 该构建对本地工程不支持 | 用 eda_import_project 建；删除/复制在应用内做 |
| eda_launch 带 project 没打开工程 | 命令行路径被应用忽略 | 用 eda_open_project({ name }) 打开 |
| 关应用后改动丢失 | eda_close 走了强制路径 | 关前先保存；看返回的 forced |
| run_code 读大 JSON 被截断 | 宿主 read 有单行上限 | 用 node:fs 读盘或分片读 |
| 覆铜/填充一律被拒（无法创建覆铜边框图元 / 无法创建填充图元） | 应用侧限制：静态+实例入口、单/复杂多边形、原始源码数组、6 种填充枚举、全参数组合全部被拒；同一多边形管线在本构建上连丝印折线都写不出来 | 不要在 API 层反复试：覆铜请在界面手工铺（GND、顶层+底层）；design_audit 持续记 copper-pour warn |
| pcb_draw_mounting_hole 报“无法创建焊盘图元” | pad 形状必填，且槽孔只能用 ELLIPSE | 已内建：圆孔 ELLIPSE(d,d)，槽孔 ELLIPSE(长,宽)+hole[SLOT,宽,长]；OBLONG/RECTANGLE 焊盘会被拒 |
| pcb_PrimitiveString.getAll / pcb_PrimitivePad.getAll 返回 0 | 这两个 API 按层查询 | 传 layer：丝印 3/4，多层焊盘 12；不传参恒为 0 |
| 按坐标算的越界没被发现 | 图框/原点假设与真实页面不一致 | 用 eda_get_page_info 的真实值 + eda_capture 导 PNG 看实际版面 |
| dmt_Project.* / 任意方法报 not allowed | 装的是旧扩展；或旧桥接用本地副本误拦 | eda_list_api_methods 看 source:extension 的真实清单；桥接已不再预拦，直接调用让扩展裁决 |
- 能力边界以**扩展自报**为准：eda_list_api_methods 的 source 为 extension 时是运行中扩展的真实白名单（含 fileCount）；bridge-local-copy 仅表示装的是旧 zip。eda_api_call 不再用桥接本地副本预拦，未知方法直接转发并由扩展裁决。

## 9b. PCB 设计与工艺规则（真机踩出来的）

- 布线顺序：先信号线 → 再电源线（按角色线宽）→ 最后打 GND 缝合孔 → 铺 GND 铜。反序会让铜把信号围死。
- 板框：圆角/倒角用 pcb_draw_polyline 折线近似；定位孔与槽口用 pcb_draw_mounting_hole（非金属化 ROUND/SLOT），不要靠挖板框制造孔。
- 丝印层放信息：pcb_draw_text 写引脚功能、接口名、版号、制版信息；丝印不得压焊盘。
- 元件方向：连接器/USB/DC 座插口朝板边，IC 的 pin1 统一朝向，极性元件（电解、二极管、LED）方向一致；镜像前先核对引脚顺序。
- 晶振：紧贴 MCU 时钟脚，负载电容就近，时钟走线短且等长；晶振下方用 pcb_create_region(ruleType:7 noPours) 禁铺铜。无晶振的板跳过。
- 地：信号地与功率地在单点用 0Ω 电阻（或磁珠）连接，电源层级差大时必做；铺铜按地类型分区。
- 未使用引脚：原理图用 eda_set_no_connect 打未连接标记，不要留悬空。
- 位置不能只靠算：eda_get_page_info 取真实图框，eda_capture 导 PNG 看实际版面与越界。
| PCB 坐标“算不准/越界判错” | EDA 界面显示画布坐标，API 用数据坐标，二者有偏移 | eda_pcb_canvas_origin 查偏移；align:true 调 setCanvasOrigin(0,0) 让两者一致 |
| 场景 | 是否截图 | 看什么 |
|---|---|---|
| 布局完成、待布线 | **必须** | 器件越界/互相压住、连接器朝向、安装孔与器件冲突 |
| 布线完成、待 DRC | **必须** | 跨网络贴合、天线 stub、绕远长线、GND 孤岛 |
| 丝印/工艺文字放完 | **必须** | 压焊盘、被板边裁切、方向反了（原理图看标签重叠、框线穿器件） |
| 坐标结果与直觉冲突 | **必须** | 图是唯一裁决者，别和算术争 |
| 每改一个图元 | 不要 | 单次约 2.7 s / 0.4 MB，还会挤占上下文；批量改完再截 |
| 确认返回值/属性 | 不要 | 用 eda_get_* 读数据，比图准 |
| DRC 已给 primitiveId | 不要 | 直接定位 |

- **看图要顺手清理**：`eda_capture` 的 PNG 是临时文件 —— 读完立刻 `eda_capture({cleanup:true})`，它只删本会话自己写过的路径；不要在磁盘上留截图。

## 9c. 外部对照：AI 画板已知失败模式（来自公开基准与实测）

来源：HWE-Bench（arXiv 2603.18102，300 个板级任务 + 2914 份数据手册，结论是硬件零容错、必须执行驱动验证而非文本比对）；6 个模型通过 MCP 在嘉立创 EDA 里画 STM32 核心板的横评（DRC 干净但 MCU 电源脚接错；USBLC6 地未连、D+ 缺 1.5k 上拉、CH340G 缺 12MHz、Type-C 只接一个方向、去耦不足）；KiCad sch-api issue #104（LLM 放标签“靠近但不在导线上”，根因是缺摆放指引/栅格对齐/引脚坐标数学）。

本插件对应的做法：标签一律引脚派生（*_at_pin）、批量放置、跨区域用网络端口；DRC 只当辅助信号，真正的电气判定交给 `eda_netlist_erc`。

### eda_netlist_erc：网表级电气烟雾测试（只读，不依赖应用 DRC）

| 检查 | 判据 |
|---|---|
| duplicate-designator | 位号重复 → fail |
| unconnected-pin | 引脚不在任何网络 → warn（未用脚请打 no-connect） |
| dangling-net | 网络只有 1 个端点 → fail |
| ground-net | 无 GND/VSS/AGND → fail；端点 < 3 → warn |
| shorted-component | 某器件所有脚在同一网络（如串阻两端同名）→ fail |
| power-rail | IC 电源脚（VDD/VCC/VBAT/VDDA…）悬空 → fail |
| decoupling | 某条电源轨没有任何电容到地 → warn |
| usb-data-pair | 只有 D+ 或只有 D- → fail |
| crystal | 晶振两脚同网、缺负载电容、或不通向 MCU → warn |
| reset | NRST 缺电容或电阻 → warn |
| boot | BOOT0 无下拉/上拉电阻 → warn |
| type-c-cc | CC1/CC2 缺 5.1k 下拉 → warn |

用法：布线/投板前跑一次 `eda_netlist_erc`，`includeOk:true` 看全量；这不是仿真，不能替代 DRC 与人工复核。

### 参考基线：拿官方示例工程当尺子（本地实测，非传闻）

`D:\文档\LCEDA-Pro\example-projects\示例工程_*.eprj2` 是随安装包分发的官方工程，可以直接打开量。实测 `示例工程_快速入门`：

| 指标 | 官方示例 | 本机 STM32 板 | 结论 |
|---|---|---|---|
| 板框 | 2362×3150 mil | 2400×1400 mil | 尺寸不同，不可比 |
| 走线数 / 线宽 | 98 条，**15 mil(67) + 25 mil(31)** | 502 条，6–16 mil | 官方示例没有 6 mil 细线：**15 mil 才是它的常规信号宽度** |
| 过孔 | 0（示例板未用） | 52 | 视密度而定 |
| 覆铜 | **1** | **0** | 官方示例确实铺铜 |
| 丝印文本图元 | **19** | **0** | 差距最大的一项：官方示例写了 19 段丝印说明 |
| design_audit | **0 违规 / 0 警告** | 0 违规 / 4 警告（5V 线宽偏细、无覆铜、无丝印、无定位孔） | 规则已用参考设计校准 |

**建立基线的过程本身修掉了我两条误报**（这是对照的直接收益）：

1. `$1N6954` 这类 EDA 自生成的隐藏电源网络名被我的字符集规则判为非法 → 现在放行 `$` 开头的自动名；
2. 15 mil 被我的“0.05 mm 步进”规则报警 → 15/25/12 mil 视为标准档位；另有 9.81 mil 的舍入噪声（0.2492 mm）改为按“距最近 0.05 mm 档 0.01 mm 容差”判断。

### 其它权威来源（读它就能画得更准）

| 来源 | 提供什么 |
|---|---|
| ST **AN4488 / AN2586**（STM32 硬件设计指南） | 去耦电容取值与摆位、晶振负载电容与地平面、BOOT0/NRST 上拉、VDD/VDDA 分离 |
| USB-IF / TI USB Type-C 参考设计（tiduc55） | CC1/CC2 各 5.1k 下拉、D+/D- 90Ω 差分、ESD 器件接地回路、双方向接法 |
| IPC-2221 / IPC-7351 | 走线间距与载流、焊盘与丝印外扩、孔环要求 |
| 官方 `easyeda/extension-dev-skill` 38 份配方 + `easyeda-pro-file-format-v2` | API 正确用法与文件格式（本插件已全面对照，见第 9 章末） |

用法：新板开工前先把 `example-projects` 里最接近的一块打开，`eda_design_audit` + `eda_capture` 各跑一次，把它的走线宽度分布、覆铜、丝印量当作自己的下限。

## 9d. 验证与交付：三件套把"做完了"变成证据

| 工具 | 检查什么 | 什么时候跑 |
|---|---|---|
| `eda_schematic_audit` | 原理图**几何**：符号出框、压标题栏、符号互相压住、偏离 10 单位栅格、标签落进符号体 | 布局完成后 |
| `eda_netlist_erc` | **电气**：位号重复、悬空脚、单端点网络、器件全脚同网、电源脚悬空、缺去耦、USB D± 不成对、晶振缺负载电容、复位/BOOT 缺上下拉、Type-C CC 缺下拉、**缺料号**、**Convert to PCB = no**、**缺封装** | 布线前、投板前 |
| `eda_delivery_checklist` | 一次串完 ERC + PCB 审计/DRC + Gerber + BOM，逐步 PASS/FAIL；`outPath` 落 Markdown 报告 | 交付前，代替"我说做完了" |

**交付口径**：`eda_delivery_checklist` 返回 `ok:true` 才算可以下单；任何一步 FAIL 都要先修，不许口头绕过。报告里带时间戳与计数，可直接给人复核。
### 交付清单怎么读（1.0.1 起）

- 一次调用会**自己切到原理图再切到 PCB**（`switchDocuments:false` 改按当前文档跑一半，另一半标注跳过原因）；
- 返回 `verdict`：`pass`（四步全过）/ `incomplete`（有步骤因文档不对被跳过）/ `fail`（有步骤真失败）；`ok` 等价于 `verdict==='pass'`；
- `skippedSteps` 与 `failedSteps` 分开列 —— **别把"没跑"当成"通过"**；四步全过实测约 **7.5 s**；
- 投板前最后一条命令就用它，`outPath` 落 Markdown 存档。


**参数持久化**：`eda_design_intake({answers})` 会把答复写进**工程描述**（`[dsh-eda-spec] {...}`），下次会话调用 `eda_design_intake` 会自动读回，不用重新猜；`reset:true` 清空。

## 10. 端到端剧本

A. 在已有工程里改原理图：
   eda_list_projects → eda_open_project({name}) → eda_get_project（取 schematic uuid）→ eda_open_document
   → eda_get_page_info → eda_get_components / eda_get_pins → 摆位（eda_place_component / eda_move_component）
   → 连线 eda_draw_wire + 跨区域 eda_place_net_labels → eda_export_netlist 查端点 → eda_run_drc 看明细
   → eda_save_document。

B. 新建工程并出板：
   准备空白/模板工程文件 → eda_import_project({ path, teamUuid, friendlyName, open:true })
   → 原理图流程（同 A）→ eda_get_project 取 pcb uuid → eda_open_document(pcb) → pcb_import_changes
   → eda_pcb_wait_for_components 等确认 → 板框/布局/走线/过孔/铺铜 → eda_pcb_run_drc + eda_design_audit
   → eda_pcb_save_document → eda_pcb_export_gerber → eda_export_project 备份。

C. 只做 PCB：
   eda_open_project → eda_get_project → eda_open_document(pcb) → pcb_get_nets(detail) / pcb_get_components(includePins)
   → 板框与布局 → 走线（按角色线宽）→ 铺铜 → eda_pcb_run_drc + eda_design_audit → Gerber。

## 11. 交付前检查清单

- [ ] eda_status：connectedClients ≥1 且版本一致。
- [ ] 网表：每个网络 ≥2 端点、无悬空；差分对成对；电源/地命名统一。
- [ ] DRC：原理图与 PCB 都跑过，明细逐条清零或已确认豁免。
- [ ] 设计规则：线宽/过孔/铺铜间距/丝印符合第 8 节。
- [ ] BOM：位号连续、封装非空、无 DUMMY。
- [ ] 视觉：导出图片自查，标签不压符号、器件不重叠、功能框清晰。
- [ ] 保存：文档已保存，工程已 eda_export_project 备份。
- [ ] Gerber 已导出且层数与板层一致。

## 12. 环境与生效规则（全新会话必读）

这套工具分三层，改动生效范围完全不同——不确定时先看这张表，不要凭直觉重试。

| 改了什么 | 谁来做 | 怎么生效 | 怎么确认 |
|---|---|---|---|
| 插件源码 `src/`（宿主侧：配置、路由、技能注册、MCP 工具表） | 开发者 | `node build.mjs` 后**重启 DSH**（桌面端关掉重开） | 会话里能看到新工具；`/api/dsh-eda-mcp/diagnostics` 的 `skills` 字段 |
| 扩展 `jlc-extension/`（白名单、内部助手、编码处理） | 用户 | 嘉立创EDA 里**重新导入** `dsh-eda-bridge-extension-<版本>.zip` 并**重启应用** | `eda_status` 的 `extensionVersions` 与 `bridgeVersion` 一致 |
| 只需重启桥接子进程（改了 `lib/bridge.mjs`、换端口、卡住） | agent 可自行 | `POST /api/dsh-eda-mcp/reconnect` | 返回 200 且 `eda_status.connectedClients ≥ 1` |
| 没改任何东西但工具莫名消失 | agent | 先 reconnect；仍不行看 `/diagnostics` 的 `clientStartupError` | 工具重新出现在会话里 |

- **插件代码改动对当前会话完全不生效**：宿主在启动时把 `lib/index.js` 载入内存，之后改文件、重新 build 都不会热更新。
- 版本纪律：扩展线协议**只递增最小位**（`0.4.1 → 0.4.2`），每次改动必须同时改 `jlc-extension/extension.json` 的 `version` 与桥接的 `VERSION`；不一致时 `eda_status.versionMismatch` 为 true。
- 新会话开工顺序：`eda_status`（连没连、版本对不对）→ 本技能（怎么干）→ 再动手；不要先假设环境就绪。
| 需要扩展 zip（换机器/给别人） | 不清楚该给哪一份 | `eda_extension_package` 报路径+sha256；`download:true` 从服务器取回并逐字节比对（`verified`），一致才落盘 |
- 扩展 zip 位置：`node_modules/dsh-eda-mcp/dsh-eda-bridge-extension-<版本>.zip`，或设置卡片下载（文件名自带版本号）。
- 排查顺序：`eda_status` → `/api/dsh-eda-mcp/diagnostics`（`clientStartupError` / `skills` / `bridgeHealth`）→ `eda_list_api_methods`（白名单）→ 应用侧 DRC 面板。
