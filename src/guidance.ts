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
  '连接问题先调 eda_status：connectedClients=0 表示 EDA 未连接（确认 EDA 已打开、扩展已导入并开启「允许外部交互」、端口 39009 空闲）；extensionVersion 与 bridgeVersion 不一致或报 API method not allowed 表示扩展是旧版，需要重新导入 dsh-eda-bridge-extension.zip 并重启 EDA。',
].join('\n')
