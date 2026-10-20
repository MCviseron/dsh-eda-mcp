/**
 * Requirement intake for a new board.
 *
 * "Draw me an X board" is not a specification. Guessing the supply, the connector
 * orientation, the layer count or the fabrication process produces a board that is
 * electrically fine and practically wrong, so the parameters that actually change the
 * drawing are listed here and must be confirmed with the user before placement.
 */

export interface IntakeQuestion {
  id: string
  question: string
  why: string
  critical: boolean
  options?: string[]
  fallback?: string
}

export interface IntakeSection {
  id: string
  title: string
  questions: IntakeQuestion[]
}

export const INTAKE_SECTIONS: IntakeSection[] = [
  {
    id: 'power',
    title: '供电与电流',
    questions: [
      { id: 'powerSource', question: '板子怎么供电？（USB-C / USB-A / DC 座 / 电池 / 外部端子）', why: '决定接口器件、连接器朝向和 ESD 保护', critical: true, options: ['USB-C', 'USB-A', 'DC 座', '锂电池', '外部端子', '多种'] },
      { id: 'inputVoltage', question: '输入电压范围与最大电流是多少？', why: '决定稳压方案、线宽、铜厚与散热', critical: true, fallback: '5 V / < 500 mA' },
      { id: 'railNeeds', question: '需要哪些电源轨（3V3 / 5V / 1V8 / 模拟轨）？各自负载多大？', why: '决定 LDO 还是 DC-DC、去耦数量', critical: true },
      { id: 'battery', question: '是否需要电池充电/切换？', why: '充电 IC 与路径管理会改变布局', critical: false, fallback: '不需要' },
    ],
  },
  {
    id: 'core',
    title: '主控与固件约束',
    questions: [
      { id: 'mcu', question: '主控型号（或必须兼容的系列）？', why: '引脚、时钟、封装决定布局与走线', critical: true },
      { id: 'clock', question: '时钟来源：内部 RC / 外部晶振（频率）？', why: '晶振要贴脚、负载电容要配、下方禁铺铜', critical: true, options: ['内部 RC', '8 MHz 晶振', '16 MHz 晶振', '32.768 kHz', '其它'] },
      { id: 'programming', question: '烧写/调试接口（SWD / JTAG / USB DFU / 串口）？', why: '决定排针与 USB 数据线', critical: true, options: ['SWD 4 线', 'SWD 2 线', 'JTAG', 'USB DFU', '串口 ISP', '不需要'] },
      { id: 'boot', question: '启动方式是否需要可切换（BOOT0 跳线/按键）？', why: '决定下拉电阻与跳线排针', critical: false, fallback: '固定从 Flash 启动，BOOT0 下拉' },
    ],
  },
  {
    id: 'io',
    title: '接口与外设',
    questions: [
      { id: 'interfaces', question: '需要哪些对外接口？（USB / UART / I2C / SPI / CAN / 以太网 / 显示屏 / 传感器）', why: '每一种都带连接器、保护器件和布线约束', critical: true },
      { id: 'isolation', question: '是否有隔离/高压/强电部分？安全距离要求？', why: '需要爬电间距、开槽、隔离器件', critical: true, options: ['无', '有低压隔离', '有市电/高压'] },
      { id: 'esd', question: '对外接口是否要 ESD/浪涌保护？', why: 'USBLC6 之类器件的地必须单独回流', critical: false, fallback: '对外接口都加 ESD' },
    ],
  },
  {
    id: 'mechanical',
    title: '机械与结构',
    questions: [
      { id: 'size', question: '板框尺寸限制（长×宽 mm）与形状（矩形/带缺口/圆角半径）？', why: '决定布局密度与连接器位置', critical: true },
      { id: 'mounting', question: '定位孔数量、孔径、位置？', why: '非金属化孔要避开走线与器件', critical: true, fallback: '4 个 φ3.2 mm，四角内缩 3 mm' },
      { id: 'connectorFacing', question: '各连接器的朝向/位置（USB 朝板边哪一侧）？', why: '插口必须朝板外，否则装不进外壳', critical: true },
      { id: 'enclosure', question: '是否有外壳/装配限制（高度、干涉区）？', why: '限制器件高度与摆放', critical: false, fallback: '无外壳，仅裸板' },
    ],
  },
  {
    id: 'process',
    title: '工艺与制造',
    questions: [
      { id: 'layers', question: '层数（2 层 / 4 层）？', why: '决定地平面、阻抗与布线策略', critical: true, options: ['2 层', '4 层'] },
      { id: 'copper', question: '铜厚（1 oz / 2 oz）？', why: '影响载流与最小线宽', critical: false, fallback: '1 oz' },
      { id: 'assembly', question: '贴片还是手焊？双面贴片？', why: '决定封装选型、丝印标注与焊盘外扩', critical: true, options: ['单面贴片', '双面贴片', '手工焊接'] },
      { id: 'quantity', question: '打样数量与预算区间？', why: '影响工艺选择（拼板、阻抗、沉金）', critical: false, fallback: '5 片打样' },
    ],
  },
  {
    id: 'delivery',
    title: '交付与验证',
    questions: [
      { id: 'deliverable', question: '要交付到什么程度？（原理图 / PCB / Gerber+BOM+坐标 / 全流程可下单）', why: '决定验证深度与文档量', critical: true, options: ['仅原理图', '原理图+PCB', '可下单（Gerber+BOM+坐标）'] },
      { id: 'validation', question: '要哪些验证？（DRC / 网表 ERC / 设计审计 / 实机点亮）', why: '决定交付前必须跑的检查', critical: false, fallback: 'DRC + 网表 ERC + 设计审计' },
      { id: 'constraints', question: '还有其它硬约束（禁用的器件、必须复用已有工程、认证要求）？', why: '避免返工', critical: false },
    ],
  },
]

export interface IntakeReport {
  sections: IntakeSection[]
  questionCount: number
  criticalCount: number
  answered: string[]
  missingCritical: string[]
  unknownAnswerKeys: string[]
  ready: boolean
  brief: Record<string, string>
}

/** Answers are keyed by question id; unknown ids are reported instead of dropped. */
export function buildIntake(answers?: Record<string, unknown> | null): IntakeReport {
  const provided = answers !== null && typeof answers === 'object' ? answers : {}
  const known = new Set<string>()
  for (const section of INTAKE_SECTIONS) for (const question of section.questions) known.add(question.id)
  const brief: Record<string, string> = {}
  const answered: string[] = []
  const unknownAnswerKeys: string[] = []
  for (const [key, value] of Object.entries(provided)) {
    if (!known.has(key)) { unknownAnswerKeys.push(key); continue }
    const text = String(value ?? '').trim()
    if (text === '') continue
    brief[key] = text
    answered.push(key)
  }
  const missingCritical: string[] = []
  let criticalCount = 0
  let questionCount = 0
  for (const section of INTAKE_SECTIONS) {
    for (const question of section.questions) {
      questionCount += 1
      if (!question.critical) continue
      criticalCount += 1
      if (brief[question.id] === undefined) missingCritical.push(question.id)
    }
  }
  return {
    sections: INTAKE_SECTIONS,
    questionCount,
    criticalCount,
    answered,
    missingCritical,
    unknownAnswerKeys,
    ready: missingCritical.length === 0,
    brief,
  }
}