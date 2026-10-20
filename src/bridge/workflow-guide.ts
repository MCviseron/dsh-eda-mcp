/**
 * Schematic working standard, in one place: the short form goes into the DSH system
 * prompt (guidance.ts) and the long form is served by the `eda_workflow_guide` tool,
 * so the agent can pull the full playbook without bloating every session prompt.
 *
 * DSH has no plugin-facing skill-registration API, so a prompt section plus this
 * on-demand document is the supported way to register a skill with a plugin.
 */
export const WORKFLOW_SUMMARY = [
  '原理图工作规范（默认全部手工，禁止图省事用自动布局/自动布线）：',
  '1) 布局：按 10 单位栅格对齐；信号从左到右、电源在上、地在下；同级器件等间距；不压字、不压标题栏；先看 eda_get_page_info 的安全区再摆位。',
  '2) 连线：只用 eda_draw_wire 走直线/45 度；**跨区域同名网络必须用网络端口（eda_place_net_port）或网络标签**，不能靠在两处画一条叫同名的导线——导线一旦接触引脚，net 会被连通性重算，指定名会被覆盖。',
  '3) 网络标签：先试 eda_place_net_label；若该构建的 createNetLabel 不响应，会自动降级为纯文本标签（无电气语义），此时靠 stub 导线承载网络；批量用 eda_place_net_labels 一次调用，不要串行上百次。',
  '4) 校验：eda_export_netlist 看每个网络的端点是否 ≥2；eda_run_drc 看逐条 DRC 明细；视觉检查优先导出 PNG 自行识别，而不是让 EDA 重排。',
  '5) 只有用户明确要求时才 eda_auto_layout / eda_auto_route（需 force:true 且设置里放行）。',
  '6) 引脚信息用 eda_get_pins 一次拿全（含 pinName/pinNumber），不要逐脚调 raw API。',
].join('\n')

export const WORKFLOW_GUIDE = WORKFLOW_SUMMARY + '\n\n' + [
  '## 布局细则是怎么落地的',
  '',
  '- 坐标单位是 0.01 英寸（MCP 单位）；A4 图框 0..1170 / 0..825，标题栏占 right 460..1160 / bottom 10..190，安全区见 eda_get_page_info。',
  '- 一页只放一个功能块；器件按信号流从左到右排，反馈元件放在放大器下方，去耦电容贴近电源脚。',
  '- 器件之间留出至少 20 单位用于走线和标签；网络端口放在模块边缘，左右各一列。',
  '- 摆好一个模块再摆下一个；每次摆完用 eda_get_components 检查没有重叠（包围盒相交）。',
  '',
  '## 网络与标签',
  '',
  '- eda_place_net_port 产生真正的网络端口图元，是跨区域连接的首选。',
  '- eda_place_net_label 优先调 sch_PrimitiveAttribute.createNetLabel；该 API 在 3.2.186 上不响应，探测结论按会话缓存，之后直接降级为文本标签（不再每次付 4 秒超时）。',
  '- 降级后的文本标签没有电气语义：连通性由 eda_place_net_label_at_pin 同时画的 stub 导线承担。',
  '- eda_get_net_labels 会同时列出属性图元（netlabel/netport/netflag）和文本标签，删除用 eda_delete_primitive 的对应 kind。',
  '- 批量放置用 eda_place_net_labels([{pinPrimitiveId, net}, ...])，一次调用完成并逐条回报成败。',
  '',
  '## 导线 net 被覆盖（务必知道）',
  '',
  'eda_draw_wire 传的 net 只对**悬空导线**有效；导线端点一旦落在引脚/网络上，EDA 会按连通性重算网络名（实测 TESTNET 并入了 LED_A）。所以“同名导线 = 同名网络”不成立，跨区域同名必须用网络标签或网络端口。',
  '',
  '## 校验顺序',
  '',
  '1. eda_get_active_document 确认在原理图页（不是 HOME/PCB）。',
  '2. eda_export_netlist（已解析成对象）检查每个网络 ≥2 端点、无悬空。',
  '3. eda_run_drc 看逐条明细（含 primitiveId 与坐标）。',
  '4. 需要人看效果就导出图片自行识别，不要用自动布局“修”版面。',
].join('\n')
