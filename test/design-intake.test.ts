import { buildIntake, INTAKE_SECTIONS } from '../src/bridge/design-intake.ts'

let failed = 0
const report = (name: string, ok: boolean, detail: string) => {
  if (!ok) failed += 1
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' — ' + detail))
}

const empty = buildIntake()
report('six sections', empty.sections.length === 6, String(empty.sections.length))
report('has a useful number of questions', empty.questionCount >= 18, String(empty.questionCount))
report('nothing answered means not ready', empty.ready === false && empty.missingCritical.length > 0, '')
report('every question carries a why', empty.sections.every(s => s.questions.every(q => typeof q.why === 'string' && q.why.length >= 4)), '')
report('critical questions exist', empty.criticalCount >= 10, String(empty.criticalCount))
report('design choices offer options', empty.sections.some(s => s.questions.some(q => Array.isArray(q.options) && q.options.length >= 2)), '')
report('non-critical questions carry a fallback', empty.sections.every(s => s.questions.every(q => q.critical || typeof q.fallback === 'string' || q.id === 'constraints')), '')

const full = buildIntake({
  powerSource: 'USB-C', inputVoltage: '5V/1A', railNeeds: '3V3 300mA', mcu: 'STM32F103C8T6',
  clock: '8 MHz 晶振', programming: 'SWD 4 线', interfaces: 'USB, UART', isolation: '无',
  size: '60x40mm', mounting: '4x3.2mm', connectorFacing: 'USB 朝长边', layers: '2 层',
  assembly: '单面贴片', deliverable: '可下单（Gerber+BOM+坐标）',
})
report('complete answers are ready', full.ready === true, JSON.stringify(full.missingCritical))
report('answers land in the brief', full.brief.mcu === 'STM32F103C8T6', JSON.stringify(full.brief.mcu))

const partial = buildIntake({ mcu: 'ESP32-S3' })
report('partial answers stay not ready', partial.ready === false, '')
report('answered list tracks input', partial.answered.length === 1 && partial.answered[0] === 'mcu', JSON.stringify(partial.answered))
report('missing critical excludes answered', !partial.missingCritical.includes('mcu'), '')

const junk = buildIntake({ notAQuestion: 'x', mcu: '   ' })
report('unknown keys are reported', junk.unknownAnswerKeys.length === 1 && junk.unknownAnswerKeys[0] === 'notAQuestion', JSON.stringify(junk.unknownAnswerKeys))
report('blank answers do not count', junk.answered.length === 0, JSON.stringify(junk.answered))
report('null answers are tolerated', buildIntake(null).sections.length === 6, '')

report('question ids are unique', new Set(INTAKE_SECTIONS.flatMap(s => s.questions.map(q => q.id))).size === empty.questionCount, '')

console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED')
if (failed > 0) process.exitCode = 1