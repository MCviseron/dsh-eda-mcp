/** Order of the announcement section within the tool-guidance band. */
export const SECTION_ORDER = 211

/**
 * Injected into every request when `announceToAgent` is on.
 *
 * It is a system-prompt section, so it stays short: the normative rule set lives
 * in `docs/design-rules.md`, and the numeric limits are enforced by the tools
 * themselves (see `src/bridge/design-rules.ts`), which is why this text names the
 * behaviour instead of repeating every table.
 */
export const EDA_MCP_GUIDANCE = [
  '本机已安装 dsh-eda-mcp 插件（DSH ↔ 嘉立创EDA专业版 MCP 画图），工具名形如 mcp__jlceda__eda_place_component / mcp__jlceda__pcb_draw_track。',
  '必须遵守的设计规范：docs/design-rules.md（仓库内），可量化部分由工具强制：',
  '· 网络名只允许字母、数字、下划线、点、加号、减号，最长 255 字符；出现空格、斜杠、括号、中文会被拒绝（JLC 后端按精确字符串匹配，特殊字符会把网络拆散或丢失）。差分对写成 USB_DP / USB_DM 两个网络，不要写 USB_DP/DM。',
  '· PCB 走线线宽：普通信号 ≥6mil（0.15mm），器件到去耦电容的分支电源 10mil，主干电源 16mil，>500mA 或 GND 走线 20mil。pcb_draw_track 不传 lineWidth 时按网络角色给默认值，低于 6mil 直接报错（确需用 force:true）。',
  '· 过孔：常规信号 0.2/0.4mm、电源/GND 0.3/0.6mm、大电流 0.4/0.8mm；焊环 ≥0.2mm 强制，孔径 <0.3mm 会警告（免费打样下限）。pcb_draw_via 不传尺寸时按角色给标准孔径，不要自造非标尺寸。',
  '· 铺铜：顶层/底层铺 GND 铜，铺铜与其它网络间距 ≥6mil（建议 10mil，在 设计→设计规则 里设置），导出前移除孤岛。',
  '· 流程：原理图分区（电源/主控/接口/信号处理，左输入右输出、上电源下地，主控居中、去耦与晶振贴芯片、区域用折线框+文本标注）→ 原理图 DRC → 布局传递/布局（安装孔→板边接口→主控→配套器件，去耦电容距引脚 ≤2mm，晶振靠芯片且区域净空，模拟/数字分开）→ 设置线宽线距过孔规则 → 布线 → 铺铜 → PCB DRC → 丝印（高度 ≥1mm、线宽 ≥0.15mm、方向统一不压焊盘）与锁定板框 → 导出 Gerber/BOM/装配文件。',
  '· 布线前先调 eda_design_audit 做只读体检（线宽/过孔/网络名/板框/铺铜/DRC 逐项给结论），布线后再调一次；eda_pcb_run_drc 是真 DRC，不能跳过。',
  '绘制细节：原理图坐标为 0.01inch，原点在 A4 图框左下角，y 向上，图框 x 0~1170、y 0~825，标题栏 x 460~1160、y 10~190 必须避让（先 eda_get_page_info）。PCB 坐标为 mil。板框用 pcb_draw_board_outline（板框层 11 的一条 pcb_PrimitivePolyline，线宽默认 10mil）；区域只能用铜层 top/bottom/内层(15–44)/MULTI(12)。',
  '长任务：eda_pcb_auto_route 默认异步启动（EDA 自己显示进度条），必须用 eda_pcb_job_status 轮询 running 直到 false，不要加大超时；eda_pcb_clear_routing 同理（旧扩展自动分批，按 done 继续调用）。',
  '原理图 API（sch_Net.*、网表导出）只作用于当前活动文档：返回空时先用 eda_get_active_document 查、eda_open_document 切到原理图页。',
  '生效范围（改动不热更新）：插件源码 src/ 改动要 node build.mjs 后重启 DSH，当前会话不会生效；扩展 jlc-extension/ 改动要重新导入 dsh-eda-bridge-extension-<版本>.zip 并重启嘉立创EDA（eda_status 的 extensionVersions 必须与 bridgeVersion 一致）；只有重启桥接子进程能由 agent 自己做（POST /api/dsh-eda-mcp/reconnect）。排查出口：/api/dsh-eda-mcp/diagnostics 的 clientStartupError / skills / bridgeHealth。扩展版本只递增最小位。',
  '开工前先问参数：用户说"画一块 X 板"时不要直接摆器件——先调 eda_design_intake 拿问卷（供电/电流、主控与时钟、烧写接口、对外接口与隔离、板框尺寸与定位孔、连接器朝向、层数与铜厚、贴片方式、交付程度），critical 项用 ask_user_question 一次问清（有 options 就给选项），不要自己编默认值当作已知；只有 non-critical 项可用 fallback。eda_place_component 在未确认参数时会返回 intakeWarning 提醒。',
  '电气正确性不要指望 DRC：原理图 DRC 在这台构建上只回聚合计数。布线/投板前跑 eda_netlist_erc（网表级只读烟雾测试：位号重复、悬空脚、单端点网络、器件短路、电源脚/去耦、USB D± 成对、晶振负载电容、复位 RC、BOOT 下拉、Type-C CC 下拉），它挡住的是"DRC 干净但电路错"这一类事故（公开横评里 AI 画板的典型翻车点）。',
  '原理图工作规范（默认手工，禁止为省事用自动布局/自动布线）：按 10 单位栅格对齐；信号左→右、电源在上、地在下；器件间留 ≥20 单位走线与标签空间；先 eda_get_page_info 看安全区再摆位；摆完用 eda_get_components 检查包围盒不重叠。eda_auto_layout / eda_auto_route 默认被拒绝（需 force:true 且设置里放行），仅当用户明确要求时使用；版面检查优先"导出图片自行识别"而不是让 EDA 重排。',
  '跨区域同名网络必须用 eda_place_net_port / 网络标签：eda_draw_wire 的 net 只对悬空导线有效，导线一旦接触引脚，EDA 会按连通性重算网络名（实测 TESTNET 被并入 LED_A），所以"同名导线 = 同名网络"不成立。',
  '网络标签：eda_place_net_label 先真实调 createNetLabel，该 API 在 3.2.186 上不响应 → 探测结论按会话缓存后自动降级为纯文本标签（无电气语义，靠 stub 导线承载网络）；批量务必用 eda_place_net_labels 一次调用，不要串行上百次（会打爆 run_code 超时且没有进度）。标签可枚举/清理：eda_get_net_labels + eda_delete_primitive(kind: netlabel|netport|netflag|text)。',
  '看图判据（eda_capture + 图片读取）：只在 4 个时刻必看——布局完成待布线、布线完成待 DRC、丝印/工艺文字放完、坐标结果与直觉冲突时；不要每改一个图元截一次，也不要为确认返回值/属性看图（用 eda_get_* 更准）。单次约 2.7 s、0.4 MB；PNG 属临时文件，看完立刻 eda_capture({cleanup:true}) 删除，不在磁盘留截图。',
  '引脚身份用 eda_get_pins 一次拿全（含 pinName/pinNumber），不要逐脚调 raw sch_PrimitivePin.get；原理图挪器件用 eda_move_component（保 designator/value），不要删了重放。完整工作手册：调 eda_workflow_guide。',
  '连接问题先调 eda_status：connectedClients=0 表示 EDA 未连接（确认 EDA 已打开、扩展已导入并开启「允许外部交互」、端口 39009 空闲）；extensionVersion 与 bridgeVersion 不一致或报 API method not allowed 表示扩展是旧版，需要重新导入 dsh-eda-bridge-extension.zip 并重启 EDA。',
  'PCB 坐标有两套：EDA 界面显示的是画布原点坐标，而所有 API 用的是数据原点坐标，两者差一个偏移（官方 API 注释原文）。按界面读出的坐标直接喂给工具会偏 —— 先用 eda_pcb_canvas_origin 查偏移，或 align:true 调 setCanvasOrigin(0,0) 让显示与 API 一致；原理图侧没有这个偏移。',
].join('\n')
