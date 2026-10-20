import { parseNetlist, runNetlistErc } from '../src/bridge/netlist-erc.ts'

let failed = 0
const report = (name: string, ok: boolean, detail: string) => {
  if (!ok) failed += 1
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' — ' + detail))
}

const component = (designator: string, part: string, pins: Array<[string, string, string]>) => ({
  props: { Designator: designator, 'Manufacturer Part': part, Footprint: designator + '-fp' },
  pinInfoMap: Object.fromEntries(pins.map(([number, name, net]) => ['p' + number, { number, name, net }])),
})
const netlist = (components: any[]) => ({ components: Object.fromEntries(components.map((c, i) => ['u' + i, c])) })

// 1. a healthy minimal design passes
const good = netlist([
  component('U1', 'STM32F103C8T6', [['1', 'VDD', '3V3'], ['2', 'VSS', 'GND'], ['5', 'OSC_IN', 'OSC_IN'], ['6', 'OSC_OUT', 'OSC_OUT'], ['7', 'NRST', 'NRST'], ['8', 'BOOT0', 'BOOT0']]),
  component('Y1', '8MHz', [['1', 'X1', 'OSC_IN'], ['2', 'X2', 'OSC_OUT']]),
  component('C1', '100nF', [['1', '1', '3V3'], ['2', '2', 'GND']]),
  component('C2', '22pF', [['1', '1', 'OSC_IN'], ['2', '2', 'GND']]),
  component('C3', '22pF', [['1', '1', 'OSC_OUT'], ['2', '2', 'GND']]),
  component('C4', '100nF', [['1', '1', 'NRST'], ['2', '2', 'GND']]),
  component('R1', '10k', [['1', '1', 'NRST'], ['2', '2', '3V3']]),
  component('R2', '10k', [['1', '1', 'BOOT0'], ['2', '2', 'GND']]),
  component('U2', 'LDO', [['1', 'VIN', '5V'], ['2', 'VOUT', '3V3'], ['3', 'GND', 'GND']]),
  component('C5', '10uF', [['1', '1', '5V'], ['2', '2', 'GND']]),
])
const goodReport = runNetlistErc(good)
report('healthy design has no failures', goodReport.ok, JSON.stringify(goodReport.checks.filter(c => c.status === 'fail')))
report('healthy design finds no dangling nets', goodReport.checks.find(c => c.id === 'dangling-net')?.status === 'pass', '')
report('crystal check passes', goodReport.checks.find(c => c.id === 'crystal')?.status === 'pass', String(goodReport.checks.find(c => c.id === 'crystal')?.details))
report('reset check passes', goodReport.checks.find(c => c.id === 'reset')?.status === 'pass', '')
report('boot check passes', goodReport.checks.find(c => c.id === 'boot')?.status === 'pass', '')
report('component and net counts', goodReport.componentCount === 10 && goodReport.netCount >= 7, goodReport.componentCount + '/' + goodReport.netCount)

// 2. dangling net (single endpoint) fails
const dangling = runNetlistErc(netlist([
  component('U1', 'STM32F103C8T6', [['1', 'VDD', '3V3'], ['2', 'VSS', 'GND'], ['3', 'PA1', 'PA1']]),
  component('C1', '100nF', [['1', '1', '3V3'], ['2', '2', 'GND']]),
]))
report('single-endpoint net fails', dangling.checks.find(c => c.id === 'dangling-net')?.status === 'fail', '')
report('report ok=false when a net dangles', dangling.ok === false, '')

// 3. a part shorted onto one net (the measured 'series resistor with the same net on both ends')
const shorted = runNetlistErc(netlist([
  component('U1', 'STM32F103C8T6', [['1', 'VDD', '3V3'], ['2', 'VSS', 'GND']]),
  component('R1', '22R', [['1', '1', 'USB_DP'], ['2', '2', 'USB_DP']]),
  component('U2', 'USB', [['1', 'D+', 'USB_DP'], ['2', 'D-', 'USB_DM'], ['3', 'GND', 'GND']]),
  component('C1', '100nF', [['1', '1', '3V3'], ['2', '2', 'GND']]),
]))
report('shorted component fails', shorted.checks.find(c => c.id === 'shorted-component')?.status === 'fail', '')

// 4. USB pair missing D-
const usb = runNetlistErc(netlist([
  component('U1', 'STM32F103C8T6', [['1', 'VDD', '3V3'], ['2', 'VSS', 'GND'], ['5', 'PA12', 'USB_DP']]),
  component('C1', '100nF', [['1', '1', '3V3'], ['2', '2', 'GND']]),
  component('J1', 'USB-C', [['1', 'D+', 'USB_DP'], ['2', 'CC1', 'CC1']]),
]))
report('USB pair check fails without D-', usb.checks.find(c => c.id === 'usb-data-pair')?.status === 'fail', '')
report('Type-C CC warns without a pull-down', usb.checks.find(c => c.id === 'type-c-cc')?.status === 'warn', '')

// 5. decoupling gap
const noDecoupling = runNetlistErc(netlist([
  component('U1', 'STM32F103C8T6', [['1', 'VDD', '3V3'], ['2', 'VSS', 'GND']]),
]))
report('decoupling warns when a rail has no capacitor', noDecoupling.checks.find(c => c.id === 'decoupling')?.status === 'warn', '')

// 6. crystal without load cap
const crystal = runNetlistErc(netlist([
  component('U1', 'STM32F103C8T6', [['1', 'VDD', '3V3'], ['2', 'VSS', 'GND'], ['5', 'OSC_IN', 'OSC_IN'], ['6', 'OSC_OUT', 'OSC_OUT']]),
  component('Y1', '8MHz', [['1', 'X1', 'OSC_IN'], ['2', 'X2', 'OSC_OUT']]),
  component('C1', '100nF', [['1', '1', '3V3'], ['2', '2', 'GND']]),
]))
report('crystal warns without load caps', crystal.checks.find(c => c.id === 'crystal')?.status === 'warn', String(crystal.checks.find(c => c.id === 'crystal')?.details))

// 7. unconnected pin + duplicate designator
const messy = runNetlistErc(netlist([
  component('U1', 'STM32F103C8T6', [['1', 'VDD', '3V3'], ['2', 'VSS', 'GND'], ['3', 'PA1', '']]),
  component('U1', 'STM32F103C8T6', [['1', 'VDD', '3V3'], ['2', 'VSS', 'GND']]),
]))
report('unconnected pin warns', messy.checks.find(c => c.id === 'unconnected-pin')?.status === 'warn', '')
report('duplicate designator fails', messy.checks.find(c => c.id === 'duplicate-designator')?.status === 'fail', '')

// 8. empty netlist is a skip, not a crash
const empty = runNetlistErc({})
report('empty netlist skips', empty.checks.length === 1 && empty.checks[0].status === 'skip', JSON.stringify(empty.checks))
report('parseNetlist survives junk', parseNetlist(null).components.length === 0, '')

console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED')
if (failed > 0) process.exitCode = 1