/**
 * The plugin registers its schematic standard as a DSH skill. These assertions pin
 * the provider contract: a kebab-case name, an invocable candidate, a body, and a
 * clean miss for anything else.
 *
 * `node --experimental-strip-types test/skills.test.ts`
 */
import { EDA_SKILL_NAME, EDA_SKILL_PROVIDER, createEdaSkillProvider, skillBody } from '../src/skills.ts'

let failures = 0
function report(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === '' ? '' : ' — ' + detail))
}

const provider = createEdaSkillProvider()
const candidates = await provider.list()
const candidate = candidates[0]

report('provider name is stable', provider.name === EDA_SKILL_PROVIDER, provider.name)
report('exactly one skill is offered', candidates.length === 1, String(candidates.length))
report('skill name is kebab-case', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(EDA_SKILL_NAME), EDA_SKILL_NAME)
report('skill is model and user invocable', candidate.invocation.modelInvocable === true && candidate.invocation.userInvocable === true)
report('skill description states a trigger', candidate.description.includes('TRIGGER when'), 'has TRIGGER when')
report('skill description states a non-trigger', candidate.description.includes('DO NOT TRIGGER'), 'has DO NOT TRIGGER')
report('rank beats the user root (400)', candidate.rank > 400, String(candidate.rank))

const definition = await provider.get(candidate)
report('definition carries the body', typeof definition?.content === 'string' && definition.content.length > 500, String(definition?.content?.length ?? 0))
report('body covers batch placement', skillBody().includes('eda_place_net_labels'))
report('body warns about wire net override', skillBody().includes('连通性'))
report('unknown skill resolves to undefined', (await provider.get({ ...candidate, name: 'nope' })) === undefined)

if (failures === 0) console.log('ALL PASS')
else { console.log(failures + ' FAILED'); process.exitCode = 1 }
