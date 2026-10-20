/**
 * The plugin registers its JLCEDA project playbook as a DSH skill. These assertions
 * pin the provider contract AND the completeness of the manual: every section has to
 * be there, because an incomplete playbook is what makes an agent improvise.
 *
 * `node --experimental-strip-types test/skills.test.ts`
 */
import { EDA_SKILL_NAME, EDA_SKILL_PROVIDER, createEdaSkillProvider, skillBody, skillLineCount } from '../src/skills.ts'
import { SKILL_SECTIONS } from '../src/skills-content.ts'

let failures = 0
function report(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === '' ? '' : ' — ' + detail))
}

const provider = createEdaSkillProvider()
const candidates = await provider.list()
const candidate = candidates[0]
const body = skillBody()

report('provider name is stable', provider.name === EDA_SKILL_PROVIDER, provider.name)
report('exactly one skill is offered', candidates.length === 1, String(candidates.length))
report('skill name is kebab-case', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(EDA_SKILL_NAME), EDA_SKILL_NAME)
report('skill is model and user invocable', candidate.invocation.modelInvocable === true && candidate.invocation.userInvocable === true)
report('description states a trigger', candidate.description.includes('TRIGGER when'))
report('description states a non-trigger', candidate.description.includes('DO NOT TRIGGER'))
report('rank beats the user root (400)', candidate.rank > 400, String(candidate.rank))
report('playbook has every section (intake + 13 base + PCB rules + external failure modes)', SKILL_SECTIONS.length === 16, String(SKILL_SECTIONS.length))
report('playbook is a real manual, not a summary', body.length > 6000 && skillLineCount() > 120, body.length + ' chars / ' + skillLineCount() + ' lines')

const definition = await provider.get(candidate)
report('definition carries the body', definition?.content === body)

for (const section of SKILL_SECTIONS) {
  report('section present: ' + section.replace('## ', ''), body.includes(section))
}

const required = [
  'mcp__jlceda__',
  'eda_import_project',
  'eda_place_net_labels',
  'eda_move_component',
  'eda_export_netlist',
  'eda_run_drc',
  'pcb_import_changes',
  'pcb_draw_board_outline',
  'pcb_create_pour',
  'eda_design_audit',
  'eda_pcb_export_gerber',
  'eda_get_net_labels',
  'eda_list_api_methods',
  '| 现象 | 原因 | 动作 |',
  '## 12. 环境与生效规则（全新会话必读）',
  '重启 DSH',
  '重新导入',
  '/api/dsh-eda-mcp/diagnostics',
  'activated:false',
  '只递增最小位',
]
for (const token of required) {
  report('manual mentions ' + token, body.includes(token))
}

report('unknown skill resolves to undefined', (await provider.get({ ...candidate, name: 'nope' })) === undefined)

if (failures === 0) console.log('ALL PASS')
else { console.log(failures + ' FAILED'); process.exitCode = 1 }
