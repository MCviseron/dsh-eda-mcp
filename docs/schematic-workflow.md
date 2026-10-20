# 原理图工作规范（插件内置）

这份文档与插件里的两份实现同源：系统提示的精简版（src/guidance.ts）和 eda_workflow_guide 工具的完整版（src/bridge/workflow-guide.ts）。

DSH 目前没有对插件开放的 skill 注册接口，因此「把工作规范注册给 agent」用两条通道实现：

1. 系统提示段（announceToAgent 开启时每轮注入）：栅格对齐、信号流向、禁止自动布局/布线、网络标签降级行为、引脚一次拿全、跨区域用网络端口。
2. eda_workflow_guide 工具：按需拉取完整手册（不占用每轮上下文）。

## 1. 布局

- 单位 0.01 英寸；A4 图框 0..1170 / 0..825，标题栏 right 460..1160 / bottom 10..190。
- 先 eda_get_page_info 看安全区，再摆位；按 10 单位栅格对齐。
- 信号左→右；电源在上、地在下；主控居中；去耦电容贴电源脚，晶振贴芯片。
- 器件之间留 ≥20 单位用于走线与标签；模块用虚线框 + 文本标注分区。
- 摆完用 eda_get_components（含包围盒）检查无重叠；挪动用 eda_move_component（保 designator/value）。
- 不要用 eda_auto_layout / eda_auto_route：默认被拒绝（需 force:true 且设置里开启「允许原理图自动布局/自动布线」）。版面检查优先「导出图片自行识别」。

## 2. 连线与网络

- 走线用 eda_draw_wire 的直线/45°，不要重叠、不要穿过器件符号。
- 跨区域同名网络：用 eda_place_net_port（真网络端口）或网络标签；不要靠在两处画同名导线。原因：eda_draw_wire 的 net 只对悬空导线有效，端点一旦接触引脚，EDA 会按连通性重算网络名（实测 TESTNET 被并入 LED_A）。
- 引脚身份：eda_get_pins 一次返回 pinName/pinNumber（内部一条 sch_PrimitiveComponent.getAllPinsByPrimitiveId），不要逐脚调 raw sch_PrimitivePin.get。

## 3. 网络标签的正确用法

- 真实 API 是 sch_PrimitiveAttribute.createNetLabel；EDA 3.2.186 上它会永不 resolve。插件按会话缓存探测结论：第一次失败后直接降级为纯文本标签，不再每次付 4 秒超时。
- 降级后的文本标签没有电气语义：连通性由 eda_place_net_label_at_pin 同时画的 stub 导线承担。
- 批量用 eda_place_net_labels([{ pinPrimitiveId, net }, ...])：一次调用完成并逐条回报 ok/error，不要再串行上百次（既会打爆 run_code 超时，也没有进度可查）。
- 标签可以审计与清理：eda_get_net_labels（属性图元 + 文本标签都列）配合 eda_delete_primitive(kind: netlabel|netport|netflag|text)。
- 网络端口图元不会出现在 eda_get_components/BOM/网表里，这是应用行为；要删除请用上面的 kind。

## 4. 校验顺序

1. eda_get_active_document 确认在原理图页（不是 HOME / PCB）。
2. eda_export_netlist（已解析成对象，不再双重编码）检查每个网络 ≥2 端点、无悬空。
3. eda_run_drc 看逐条明细（type / message / primitiveId / 坐标）。
4. 需要人看效果就导出图片，让模型识别版面，而不是让 EDA 重排。

## 5. 已知不可用（实测，非插件 bug）

- dmt_Project.createProject / deleteProject / copyProject 在 EDA 3.2.186（登录 + 半离线）上无副作用；新建工程用 eda_import_project（导入即建工程），删除/复制请在应用内完成。
- lceda-pro.exe 直接 spawn 会立刻退出，eda_launch 在 Windows 上固定走 explorer.exe 交接。
- 命令行带工程路径被应用忽略：eda_launch({ project }) 只保证把参数传下去，打开工程请用 eda_open_project。
- 导入 .epro2 会原样复制内部 uuid（schematic/page/pcb），可能与源工程冲突；eda_import_project 会做一次碰撞检查并在 collisions 里报告（checkCollisions:false 可关）。
