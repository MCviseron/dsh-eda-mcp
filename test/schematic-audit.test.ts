import { auditSchematicGeometry } from '../src/bridge/schematic-audit.ts'

let failed = 0
const report = (name: string, ok: boolean, detail: string) => {
  if (!ok) failed += 1
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' — ' + detail))
}
const frame = { left: 0, right: 1170, top: 825, bottom: 0 }
const titleBlock = { left: 460, right: 1160, top: 190, bottom: 10 }
const box = (x: number, y: number, w = 60, h = 40) => ({ left: x - w / 2, right: x + w / 2, bottom: y - h / 2, top: y + h / 2 })

const clean = auditSchematicGeometry({
  components: [
    { designator: 'U1', x: 300, y: 500, bounds: box(300, 500) },
    { designator: 'C1', x: 400, y: 500, bounds: box(400, 500) },
  ],
  frame, titleBlock,
})
report('clean sheet passes everything', clean.ok && clean.counts.fail === 0, JSON.stringify(clean.checks.filter(c => c.status === 'fail')))
report('clean sheet reports the component count', clean.componentCount === 2, String(clean.componentCount))

const outside = auditSchematicGeometry({
  components: [{ designator: 'U9', x: 1200, y: 500, bounds: box(1200, 500) }],
  frame, titleBlock,
})
report('symbol outside the frame fails', outside.checks.find(c => c.id === 'outside-frame')?.status === 'fail', '')

const inTitle = auditSchematicGeometry({
  components: [{ designator: 'R1', x: 800, y: 100, bounds: box(800, 100) }],
  frame, titleBlock,
})
report('symbol on the title block fails', inTitle.checks.find(c => c.id === 'title-block')?.status === 'fail', '')

const overlapping = auditSchematicGeometry({
  components: [
    { designator: 'U1', x: 300, y: 500, bounds: box(300, 500) },
    { designator: 'U2', x: 305, y: 505, bounds: box(305, 505) },
  ],
  frame, titleBlock,
})
report('overlapping symbols fail', overlapping.checks.find(c => c.id === 'symbol-overlap')?.status === 'fail', '')

const touching = auditSchematicGeometry({
  components: [
    { designator: 'U1', x: 300, y: 500, bounds: { left: 270, right: 330, bottom: 480, top: 520 } },
    { designator: 'U2', x: 360, y: 500, bounds: { left: 330, right: 390, bottom: 480, top: 520 } },
  ],
  frame, titleBlock,
})
report('edge-touching symbols do not fail', touching.checks.find(c => c.id === 'symbol-overlap')?.status === 'pass', '')

const offGrid = auditSchematicGeometry({
  components: [{ designator: 'C3', x: 303, y: 497, bounds: box(303, 497) }],
  frame, titleBlock, grid: 10,
})
report('off-grid warns', offGrid.checks.find(c => c.id === 'grid')?.status === 'warn', '')

const labelInside = auditSchematicGeometry({
  components: [{ designator: 'U1', x: 300, y: 500, bounds: box(300, 500) }],
  frame, titleBlock,
  labels: [{ text: 'GND', x: 300, y: 500 }, { text: 'PA1', x: 600, y: 500 }],
})
report('label inside a symbol warns', labelInside.checks.find(c => c.id === 'label-overlap')?.status === 'warn', '')
report('label outside symbols is fine', String(labelInside.checks.find(c => c.id === 'label-overlap')?.details?.length) === '1', JSON.stringify(labelInside.checks.find(c => c.id === 'label-overlap')))

const empty = auditSchematicGeometry({ components: [], frame, titleBlock })
report('empty sheet skips', empty.checks.length === 1 && empty.checks[0].status === 'skip', '')
report('missing bounds are tolerated', auditSchematicGeometry({ components: [{ designator: 'U1', x: 100, y: 100 }], frame, titleBlock }).checks.find(c => c.id === 'outside-frame')?.status === 'pass', '')

console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED')
if (failed > 0) process.exitCode = 1