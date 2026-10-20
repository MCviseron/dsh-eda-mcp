/**
 * Schematic geometry audit.
 *
 * The netlist ERC judges connectivity; it cannot see that two symbols sit on top of
 * each other, that a part hangs outside the A4 frame, or that half the sheet is off the
 * 10-unit grid. Those make a sheet unreviewable while remaining electrically correct,
 * so they are checked here from the bounding boxes the app reports.
 */

export interface Bounds { left: number; right: number; top: number; bottom: number }

export interface AuditComponent {
  designator: string
  x: number
  y: number
  bounds?: Bounds
}

export interface SchematicAuditInput {
  components: AuditComponent[]
  frame: Bounds
  titleBlock?: Bounds
  /** Text/label anchor points, when the caller can read them. */
  labels?: Array<{ text: string; x: number; y: number }>
  grid?: number
}

export type AuditStatus = 'pass' | 'fail' | 'warn' | 'skip'

export interface AuditCheck { id: string; status: AuditStatus; message: string; details?: string[] }

export interface SchematicAuditReport {
  ok: boolean
  counts: { pass: number; fail: number; warn: number; skip: number }
  componentCount: number,
  checks: AuditCheck[]
}

const EPS = 0.5

function intersects(a: Bounds, b: Bounds): boolean {
  return a.left < b.right - EPS && b.left < a.right - EPS && a.bottom < b.top - EPS && b.bottom < a.top - EPS
}

function area(b: Bounds): number {
  return Math.max(0, b.right - b.left) * Math.max(0, b.top - b.bottom)
}

function inside(inner: Bounds, outer: Bounds): boolean {
  return inner.left >= outer.left - EPS && inner.right <= outer.right + EPS && inner.bottom >= outer.bottom - EPS && inner.top <= outer.top + EPS
}

export function auditSchematicGeometry(input: SchematicAuditInput): SchematicAuditReport {
  const grid = input.grid === undefined ? 10 : input.grid
  const checks: AuditCheck[] = []
  const add = (id: string, status: AuditStatus, message: string, details?: string[]) => {
    checks.push(details && details.length > 0 ? { id, status, message, details } : { id, status, message })
  }
  const withBounds = input.components.filter(component => component.bounds !== undefined) as Array<AuditComponent & { bounds: Bounds }>

  if (input.components.length === 0) {
    add('sheet', 'skip', 'no component on the active schematic page')
    return { ok: false, counts: { pass: 0, fail: 0, warn: 0, skip: 1 }, componentCount: 0, checks }
  }
  add('sheet', 'pass', input.components.length + ' component(s) read from the active page, ' + withBounds.length + ' with bounds')

  // 1. outside the frame
  const outside = withBounds.filter(component => !inside(component.bounds, input.frame))
    .map(component => component.designator)
  add('outside-frame', outside.length === 0 ? 'pass' : 'fail',
    outside.length === 0 ? 'every symbol sits inside the frame' : outside.length + ' symbol(s) stick out of the frame',
    outside.slice(0, 20))

  // 2. title block keep-out
  if (input.titleBlock === undefined) {
    add('title-block', 'skip', 'no title block range supplied')
  } else {
    const block = input.titleBlock
    const intruding = withBounds.filter(component => intersects(component.bounds, block)).map(component => component.designator)
    add('title-block', intruding.length === 0 ? 'pass' : 'fail',
      intruding.length === 0 ? 'nothing overlaps the title block' : intruding.length + ' symbol(s) overlap the title block',
      intruding.slice(0, 20))
  }

  // 3. overlapping symbols
  const overlaps: string[] = []
  for (let i = 0; i < withBounds.length; i++) {
    for (let j = i + 1; j < withBounds.length; j++) {
      const a = withBounds[i]
      const b = withBounds[j]
      if (!intersects(a.bounds, b.bounds)) continue
      const sharedW = Math.min(a.bounds.right, b.bounds.right) - Math.max(a.bounds.left, b.bounds.left)
      const sharedH = Math.min(a.bounds.top, b.bounds.top) - Math.max(a.bounds.bottom, b.bounds.bottom)
      const shared = Math.max(0, sharedW) * Math.max(0, sharedH)
      const smaller = Math.min(area(a.bounds), area(b.bounds))
      // Touching edges are normal; only a real body-on-body overlap is a defect.
      if (smaller > 0 && shared / smaller > 0.08) overlaps.push(a.designator + ' x ' + b.designator)
    }
  }

  add('symbol-overlap', overlaps.length === 0 ? 'pass' : 'fail',
    overlaps.length === 0 ? 'no two symbols overlap' : overlaps.length + ' overlapping symbol pair(s)',
    overlaps.slice(0, 20))

  // 4. grid alignment
  const offGrid = input.components.filter(component =>
    Math.abs(component.x / grid - Math.round(component.x / grid)) > 0.01 ||
    Math.abs(component.y / grid - Math.round(component.y / grid)) > 0.01)
    .map(component => component.designator + ' @' + component.x + ',' + component.y)
  add('grid', offGrid.length === 0 ? 'pass' : 'warn',
    offGrid.length === 0 ? 'every symbol sits on the ' + grid + '-unit grid' : offGrid.length + ' symbol(s) are off the ' + grid + '-unit grid',
    offGrid.slice(0, 20))

  // 5. labels sitting on top of a symbol body
  const labels = input.labels ?? []
  if (labels.length === 0) {
    add('label-overlap', 'skip', 'no label anchors supplied')
  } else {
    const crowded = labels.filter(label => withBounds.some(component =>
      label.x > component.bounds.left && label.x < component.bounds.right &&
      label.y > component.bounds.bottom && label.y < component.bounds.top))
      .map(label => label.text + ' @' + label.x + ',' + label.y)
    add('label-overlap', crowded.length === 0 ? 'pass' : 'warn',
      crowded.length === 0 ? 'no label anchor lands inside a symbol' : crowded.length + ' label(s) anchored inside a symbol body',
      crowded.slice(0, 20))
  }

  const counts = { pass: 0, fail: 0, warn: 0, skip: 0 }
  for (const check of checks) counts[check.status] += 1
  return { ok: counts.fail === 0, counts, componentCount: input.components.length, checks }
}