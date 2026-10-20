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
import { SKILL_PLAYBOOK, SKILL_PLAYBOOK_LINES } from './skills-content.ts'
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

/**
 * The skill body: the full project playbook (project → schematic → PCB → rules →
 * troubleshooting → end-to-end scripts → delivery checklist), with the condensed
 * bridge guide appended so the skill and eda_workflow_guide never contradict each
 * other on the quick rules.
 */
export function skillBody(): string {
  return [
    SKILL_PLAYBOOK,
    '',
    '---',
    '',
    '## 附：精简版规范（与 eda_workflow_guide 同源）',
    '',
    WORKFLOW_SUMMARY,
    '',
    WORKFLOW_GUIDE,
  ].join(String.fromCharCode(10))
}

/** Line count of the playbook, surfaced for diagnostics and tests. */
export function skillLineCount(): number {
  return SKILL_PLAYBOOK_LINES.length
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
