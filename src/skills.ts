/**
 * Skill registration: dsh-eda-mcp exposes its schematic working standard as a DSH
 * skill, so it appears in the session skill catalog and the agent can load it on
 * demand with the `skill` tool instead of carrying the whole playbook in every
 * system prompt.
 *
 * DSH has no plugin-facing package to depend on here; the provider shape is
 * structural (ctx.skills.registerProvider), which keeps this build working across
 * DSH generations that ship the service under slightly different types.
 */
import { WORKFLOW_GUIDE, WORKFLOW_SUMMARY } from './bridge/workflow-guide.ts'

export const EDA_SKILL_NAME = 'jlceda-schematic-workflow'
export const EDA_SKILL_PROVIDER = 'dsh-eda-mcp'

/** DSH ranks project skills 100, custom dirs 300, user root 400, bundled 600. */
const EDA_SKILL_RANK = 500

const DESCRIPTION =
  'Draw or edit a JLCEDA Pro (EasyDraw Pro) schematic through the dsh-eda-mcp tools: grid-aligned manual placement, ' +
  'signal-flow layout, net ports/labels instead of same-named wires, batch net-label placement, and netlist/DRC verification. ' +
  'TRIGGER when: laying out or re-laying a schematic, connecting pins across a sheet, placing many net labels, ' +
  'checking a schematic (netlist endpoints, DRC detail), or moving parts without losing designators. ' +
  'DO NOT TRIGGER for PCB-only work (routing, copper pour, gerber) or for project/application control (launch, open, import, export).'

const WHEN_TO_USE =
  'Use before touching a schematic sheet, and again whenever a layout or connectivity decision has to be made.'

/** The skill body: rules first, then the reasoning and the known limits. */
export function skillBody(): string {
  return [
    '# 嘉立创EDA 原理图工作规范',
    '',
    WORKFLOW_SUMMARY,
    '',
    WORKFLOW_GUIDE,
    '',
    '## 批量与超时',
    '',
    '- 一次 MCP 调用里做多件事：eda_place_net_labels 支持整批标签；eda_set_no_connect 支持整批引脚。',
    '- 单次调用不要超过约 20 个变更，间隔着读一次状态（eda_get_net_labels / eda_get_components），这样超时后也知道完成到哪。',
    '',
    '## 失败先看返回值',
    '',
    '- copied / deleted / imported 为 false 时都带 hint，说明该构建是否根本不支持；不要盲目重试。',
    '- eda_api_call 被拒时调 eda_list_api_methods 看白名单，而不是换着名字猜。',
  ].join(String.fromCharCode(10))
}

interface SkillCandidateLike {
  name: string
  description: string
  whenToUse?: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  source: string
  provider: string
  rank: number
  locator?: unknown
  metadata?: Record<string, unknown>
}

function candidate(): SkillCandidateLike {
  return {
    name: EDA_SKILL_NAME,
    description: DESCRIPTION,
    whenToUse: WHEN_TO_USE,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'custom',
    provider: EDA_SKILL_PROVIDER,
    rank: EDA_SKILL_RANK,
    locator: { kind: 'inline', skill: EDA_SKILL_NAME },
    metadata: { plugin: 'dsh-eda-mcp', area: 'schematic' },
  }
}

/** The SkillProvider registered on ctx.skills (list + get, read-through). */
export function createEdaSkillProvider() {
  return {
    name: EDA_SKILL_PROVIDER,
    list: async (): Promise<SkillCandidateLike[]> => [candidate()],
    get: async (input: SkillCandidateLike) => {
      if (input?.name !== EDA_SKILL_NAME) return undefined
      return { ...candidate(), description: DESCRIPTION, content: skillBody() }
    },
  }
}
