/**
 * Netlist-level electrical smoke test.
 *
 * DRC only reports geometry/rule problems and, on EDA 3.2.186, hands back
 * aggregated counts for the schematic. A generated circuit can pass DRC and still be
 * electrically wrong (measured in public LLM-vs-EDA comparisons: USB ESD ground left
 * floating, D+ missing its pull-up, CH340G without a 12 MHz crystal, Type-C wired for
 * one insert direction only, too few decoupling caps). Those all show up in the
 * netlist, so they are checked here without any application support.
 */

export interface ErcPin {
  designator: string
  number: string
  name: string
  net: string
}

export interface ErcComponent {
  designator: string
  part: string
  footprint: string
  pins: Array<{ number: string; name: string; net: string }>
}

export type ErcStatus = 'pass' | 'fail' | 'warn' | 'skip'

export interface ErcCheck {
  id: string
  status: ErcStatus
  message: string
  details?: string[]
}

export interface ErcReport {
  ok: boolean
  counts: { pass: number; fail: number; warn: number; skip: number }
  componentCount: number
  netCount: number
  checks: ErcCheck[]
}

const POWER_NET = /^(?:\+?\d+V\d*|V?(?:CC|DD|BAT|IN|BUS|SYS|MOTOR)|AVDD|DVDD|VBUS|VUSB|VBAT|3V3|5V|12V)$/i
const GROUND_NET = /^(?:GND|AGND|DGND|PGND|GNDA|GNDD|VSS|0V|EARTH)$/i
const USD_DP = /(?:^|_)(?:USB_?D\+?P|D\+|USB_?DP|DP)$/i
const USD_DM = /(?:^|_)(?:USB_?D-?M|D-|USB_?DM|DM)$/i
const CRYSTAL_HINT = /crystal|xtal|osc|谐振|晶振|5032|3225/i
const MCU_PART = /STM32|GD32|ATmega|ATMEGA|ESP32|ESP8266|CH32|HC32|MM32|APM32|N76|PIC\d|RP2040|MSP430/i

function normNet(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Reads the JLCEDA netlist shape: netlist.components[key].pinInfoMap[pinKey]. */
export function parseNetlist(raw: any): { components: ErcComponent[]; pins: ErcPin[] } {
  const source = raw && typeof raw === 'object' && raw.components ? raw : {}
  const map = source.components ?? {}
  const components: ErcComponent[] = []
  const pins: ErcPin[] = []
  for (const key of Object.keys(map)) {
    const entry = map[key] ?? {}
    const props = entry.props ?? {}
    const designator = String(props.Designator ?? props.designator ?? key)
    const pinInfoMap = entry.pinInfoMap ?? {}
    const own: Array<{ number: string; name: string; net: string }> = []
    for (const pinKey of Object.keys(pinInfoMap)) {
      const pin = pinInfoMap[pinKey] ?? {}
      const number = String(pin.number ?? pin.props?.['Pin Number'] ?? pinKey)
      const name = String(pin.name ?? '')
      const net = normNet(pin.net)
      own.push({ number, name, net })
      pins.push({ designator, number, name, net })
    }
    components.push({
      designator,
      part: String(props['Manufacturer Part'] ?? props.Device ?? ''),
      footprint: String(props.Footprint ?? ''),
      pins: own,
    })
  }
  return { components, pins }
}

function netsOf(pins: ErcPin[]): Map<string, ErcPin[]> {
  const nets = new Map<string, ErcPin[]>()
  for (const pin of pins) {
    if (pin.net === '') continue
    const list = nets.get(pin.net)
    if (list) list.push(pin)
    else nets.set(pin.net, [pin])
  }
  return nets
}

function capsBridging(net: string, groundNet: string, components: ErcComponent[]): number {
  let count = 0
  for (const component of components) {
    if (!/^C\d*$/i.test(component.designator)) continue
    const onNet = component.pins.some(pin => pin.net === net)
    const onGround = component.pins.some(pin => pin.net === groundNet)
    if (onNet && onGround) count++
  }
  return count
}

function resistorsOn(net: string, components: ErcComponent[], otherNet?: string): string[] {
  const found: string[] = []
  for (const component of components) {
    if (!/^R\d*$/i.test(component.designator)) continue
    const onNet = component.pins.some(pin => pin.net === net)
    if (!onNet) continue
    if (otherNet === undefined) { found.push(component.designator); continue }
    const others = component.pins.filter(pin => pin.net !== net).map(pin => pin.net)
    if (others.some(name => name === otherNet)) found.push(component.designator)
  }
  return found
}

export function runNetlistErc(rawNetlist: any): ErcReport {
  const { components, pins } = parseNetlist(rawNetlist)
  const nets = netsOf(pins)
  const checks: ErcCheck[] = []
  const add = (id: string, status: ErcStatus, message: string, details?: string[]) => {
    checks.push(details && details.length > 0 ? { id, status, message, details } : { id, status, message })
  }

  if (components.length === 0) {
    add('netlist', 'skip', 'netlist has no components: open a schematic page first (eda_open_document)')
    return { ok: false, counts: { pass: 0, fail: 0, warn: 0, skip: 1 }, componentCount: 0, netCount: 0, checks }
  }

  // 1. duplicate designators
  const seen = new Map<string, number>()
  for (const component of components) seen.set(component.designator, (seen.get(component.designator) ?? 0) + 1)
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([name, n]) => name + ' x' + n)
  add('duplicate-designator', duplicates.length === 0 ? 'pass' : 'fail',
    duplicates.length === 0 ? 'every designator is unique' : duplicates.length + ' duplicated designator(s)', duplicates)

  // 2. unconnected pins
  const floating = pins.filter(pin => pin.net === '').map(pin => pin.designator + '.' + pin.number + (pin.name ? ' (' + pin.name + ')' : ''))
  add('unconnected-pin', floating.length === 0 ? 'pass' : 'warn',
    floating.length === 0 ? 'every pin is on a net' : floating.length + ' pin(s) are on no net (mark unused pins with eda_set_no_connect or wire them)',
    floating.slice(0, 25))

  // 3. single-endpoint nets
  const dangling = [...nets.entries()].filter(([, list]) => list.length < 2)
    .map(([name, list]) => name + ' <- ' + list.map(p => p.designator + '.' + p.number).join(','))
  add('dangling-net', dangling.length === 0 ? 'pass' : 'fail',
    dangling.length === 0 ? 'every net has at least two endpoints' : dangling.length + ' net(s) have a single endpoint',
    dangling.slice(0, 25))

  // 4. ground
  const groundNet = [...nets.keys()].find(name => GROUND_NET.test(name)) ?? ''
  add('ground-net', groundNet === '' ? 'fail' : (nets.get(groundNet)!.length >= 3 ? 'pass' : 'warn'),
    groundNet === ''
      ? 'no ground net (GND/VSS/AGND) found'
      : 'ground net ' + groundNet + ' has ' + nets.get(groundNet)!.length + ' pins')

  // 5. shorted component: a part whose every pin sits on one net
  const shorted = components.filter(component => {
    const names = new Set(component.pins.map(pin => pin.net).filter(name => name !== ''))
    return component.pins.length >= 2 && names.size === 1
  }).map(component => component.designator)
  add('shorted-component', shorted.length === 0 ? 'pass' : 'fail',
    shorted.length === 0 ? 'no component has all pins on one net' : shorted.length + ' component(s) have every pin on one net',
    shorted)

  // 6. power rails feed the ICs; each rail that an IC draws from needs decoupling
  const powerNets = [...nets.keys()].filter(name => POWER_NET.test(name) && !GROUND_NET.test(name))
  if (powerNets.length === 0) {
    add('power-rail', 'warn', 'no power net recognised (3V3/5V/VCC/VDD/VBAT)')
  } else {
    const icPowerPins = pins.filter(pin => /^(?:VDD|VCC|VBAT|VDDA|AVDD|DVDD|VIN|V\+)/i.test(pin.name) && !GROUND_NET.test(pin.net))
    const unpowered = icPowerPins.filter(pin => pin.net === '').map(pin => pin.designator + '.' + pin.number)
    add('power-rail', unpowered.length === 0 ? 'pass' : 'fail',
      unpowered.length === 0
        ? powerNets.length + ' power net(s) (' + powerNets.slice(0, 4).join(', ') + ') feed ' + icPowerPins.length + ' IC power pin(s)'
        : unpowered.length + ' IC power pin(s) are not on any net',
      unpowered)
    if (groundNet !== '') {
      const thin = powerNets.filter(name => capsBridging(name, groundNet, components) === 0)
      add('decoupling', thin.length === 0 ? 'pass' : 'warn',
        thin.length === 0
          ? 'every power rail has a capacitor to ' + groundNet
          : thin.length + ' power rail(s) have no capacitor to ' + groundNet + ' (decoupling missing)',
        thin)
    } else {
      add('decoupling', 'skip', 'no ground net, decoupling cannot be judged')
    }
  }

  // 7. USB data pair + series resistors
  const dp = [...nets.keys()].filter(name => USD_DP.test(name))
  const dm = [...nets.keys()].filter(name => USD_DM.test(name))
  if (dp.length === 0 && dm.length === 0) {
    add('usb-data-pair', 'skip', 'no USB D+/D- net, skipped')
  } else {
    const missing = dp.length === 0 ? 'D+ net missing' : (dm.length === 0 ? 'D- net missing' : '')
    const halves = dp.length === 0 || dm.length === 0 ? ['D+/D- are not a pair: ' + (dp.concat(dm).join(', ') || 'none')] : []
    add('usb-data-pair', missing === '' ? 'pass' : 'fail',
      missing === '' ? 'D+ (' + dp.join(',') + ') and D- (' + dm.join(',') + ') both exist' : missing, halves)
  }

  // 8. crystal: two distinct nets, a load cap on each, and an MCU clock pin
  const crystals = components.filter(component =>
    /^[XY]\d*$/i.test(component.designator) || CRYSTAL_HINT.test(component.part) || CRYSTAL_HINT.test(component.footprint))
  const realCrystals = crystals.filter(component => {
    const names = new Set(component.pins.map(pin => pin.net).filter(name => name !== ''))
    return component.pins.length === 2 || (component.pins.length >= 2 && names.size === 2)
  })
  if (realCrystals.length === 0) {
    add('crystal', 'skip', 'no crystal found, skipped (an RC oscillator design is fine)')
  } else if (groundNet === '') {
    add('crystal', 'skip', 'crystal present but no ground net, load caps cannot be judged')
  } else {
    const problems: string[] = []
    for (const crystal of realCrystals) {
      const own = crystal.pins.map(pin => pin.net).filter(name => name !== '')
      if (new Set(own).size < 2) problems.push(crystal.designator + ': both pins are on ' + (own[0] ?? 'no net'))
      for (const net of new Set(own)) {
        if (capsBridging(net, groundNet, components) === 0) problems.push(crystal.designator + ': ' + net + ' has no load capacitor to ' + groundNet)
      }
      const touchesMcu = pins.some(pin => own.includes(pin.net) && MCU_PART.test(components.find(c => c.designator === pin.designator)?.part ?? ''))
      if (!touchesMcu) problems.push(crystal.designator + ': neither pin reaches an MCU clock pin')
    }
    add('crystal', problems.length === 0 ? 'pass' : 'warn',
      problems.length === 0 ? realCrystals.length + ' crystal(s) have two nets, load caps and an MCU connection' : problems.length + ' crystal problem(s)',
      problems)
  }

  // 9. reset + boot strapping
  const resetNet = [...nets.keys()].find(name => /^(?:N?RST|RESET|RESET_N|MCLR)$/i.test(name))
  if (resetNet === undefined) {
    add('reset', 'skip', 'no reset net, skipped')
  } else if (groundNet === '') {
    add('reset', 'skip', 'reset net present but no ground net')
  } else {
    const cap = capsBridging(resetNet, groundNet, components)
    const pullup = resistorsOn(resetNet, components).length
    const problems: string[] = []
    if (cap === 0) problems.push(resetNet + ' has no capacitor to ' + groundNet)
    if (pullup === 0) problems.push(resetNet + ' has no series/pull resistor')
    add('reset', problems.length === 0 ? 'pass' : 'warn',
      problems.length === 0 ? resetNet + ' has a capacitor and a resistor' : problems.length + ' reset problem(s)', problems)
  }

  const bootNet = [...nets.keys()].find(name => /^BOOT\d$/i.test(name))
  if (bootNet === undefined) {
    add('boot', 'skip', 'no BOOT0 net, skipped')
  } else {
    const resistors = resistorsOn(bootNet, components)
    add('boot', resistors.length > 0 ? 'pass' : 'warn',
      resistors.length > 0 ? bootNet + ' has resistor(s): ' + resistors.join(',') : bootNet + ' has no pull resistor (floating boot pin)')
  }

  // 10. USB Type-C CC resistors
  const ccPins = pins.filter(pin => /^CC[12]$/i.test(pin.name))
  if (ccPins.length === 0) {
    add('type-c-cc', 'skip', 'no CC1/CC2 pins, skipped')
  } else {
    const missing = ccPins.filter(pin => pin.net === '' || (groundNet !== '' && resistorsOn(pin.net, components, groundNet).length === 0))
      .map(pin => (pin.designator + '.' + pin.name + ' on ' + (pin.net || '<no net>') + ' without a resistor to GND'))
    add('type-c-cc', missing.length === 0 ? 'pass' : 'warn',
      missing.length === 0 ? 'CC1/CC2 each have a resistor to ground' : missing.length + ' CC pin(s) lack a 5.1k pull-down', missing)
  }

  const counts = { pass: 0, fail: 0, warn: 0, skip: 0 }
  for (const check of checks) counts[check.status] += 1
  return { ok: counts.fail === 0, counts, componentCount: components.length, netCount: nets.size, checks }
}