/**
 * Design-rule test: net naming, track-width tiers and via geometry.
 *
 * `node --experimental-strip-types test/design-rules.test.ts`
 */
import {
  ANNULUS_MIN_MM, MIN_TRACK_WIDTH_MIL, TRACK_WIDTH_MIL, VIA_HOLE_MIN_MM, VIA_SIZES_MM,
  checkNetName, checkTrackWidth, checkVia, classifyNet, milToMm, mmToMil, suggestTrackWidthMil,
} from '../src/bridge/design-rules.ts'

let failures = 0
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) console.log(`     got      ${JSON.stringify(actual)}\n     expected ${JSON.stringify(expected)}`)
}

// --- unit conversion -------------------------------------------------------
check('mmToMil(0.15) ~ 5.91', Math.round(mmToMil(0.15) * 100) / 100, 5.91)
check('milToMm(6) ~ 0.1524', Math.round(milToMm(6) * 10000) / 10000, 0.1524)

// --- net naming (§2.1) -----------------------------------------------------
check('USB_DP is valid', checkNetName('USB_DP').ok, true)
check('P0.1 (existing projects) is valid', checkNetName('P0.1').ok, true)
check('lowercase gives a style warning only', { ok: checkNetName('vcc5').ok, warnings: checkNetName('vcc5').warnings.length }, { ok: true, warnings: 1 })
check('slash is rejected', checkNetName('USB_DP/DM').ok, false)
check('space is rejected', checkNetName('A B').ok, false)
check('Chinese is rejected', checkNetName('电源').ok, false)
check('bracket is rejected', checkNetName('X[1]').ok, false)
check('empty is rejected', checkNetName('').ok, false)
check('over 255 chars is rejected', checkNetName('A'.repeat(256)).ok, false)
check('exactly 255 chars is accepted', checkNetName('A'.repeat(255)).ok, true)

// --- net roles and width tiers (§5.1) --------------------------------------
check('GND is ground', classifyNet('GND'), 'ground')
check('AGND is ground', classifyNet('AGND'), 'ground')
check('VCC3V3 is power', classifyNet('VCC3V3'), 'power')
check('3V3 is power', classifyNet('3V3'), 'power')
check('LCD_BL is signal', classifyNet('LCD_BL'), 'signal')
check('signal default is 6 mil', suggestTrackWidthMil('LCD_BL'), 6)
check('power default is 16 mil', suggestTrackWidthMil('VCC5'), 16)
check('ground default is 16 mil (pour preferred)', suggestTrackWidthMil('GND'), 16)
check('min track width is 6 mil', MIN_TRACK_WIDTH_MIL, 6)

check('signal with no width gets 6 mil', checkTrackWidth('LCD_BL', undefined).widthMil, 6)
check('6 mil is accepted', checkTrackWidth('LCD_BL', 6).ok, true)
check('4 mil is rejected', checkTrackWidth('LCD_BL', 4).ok, false)
check('4 mil with force is accepted', checkTrackWidth('LCD_BL', 4, true).ok, true)
check('thin power track warns', checkTrackWidth('VCC5', 6).warnings.length > 0, true)
check('tier widths are exempt from the grid warning', checkTrackWidth('VCC5', 16).warnings.length, 0)
check('odd mil width warns about the 0.05 mm grid', checkTrackWidth('LCD_BL', 7).warnings.some(w => w.includes('0.05 mm')), true)

// --- vias (§5.2) -----------------------------------------------------------
const standard = VIA_SIZES_MM.map(size => ({ hole: size.hole, pad: size.pad }))
check('standard size pairs', standard, [{ hole: 0.2, pad: 0.4 }, { hole: 0.3, pad: 0.6 }, { hole: 0.4, pad: 0.8 }])
check('0.3/0.6 mm via is clean', checkVia('GND', mmToMil(0.3), mmToMil(0.6)).warnings, [])
check('0.2/0.4 mm via is allowed with a free-prototyping warning', (() => {
  const via = checkVia('SIG', mmToMil(0.2), mmToMil(0.4))
  return { ok: via.ok, warned: via.warnings.some(w => w.includes(String(VIA_HOLE_MIN_MM))) }
})(), { ok: true, warned: true })
check('annular ring below 0.2 mm is rejected', checkVia('SIG', mmToMil(0.3), mmToMil(0.3)).ok, false)
check('hole below 0.2 mm is rejected', checkVia('SIG', mmToMil(0.1), mmToMil(0.4)).ok, false)
check('non-standard pair warns', checkVia('SIG', mmToMil(0.25), mmToMil(0.55)).warnings.some(w => w.includes('standard')), true)
check('annulus constant', ANNULUS_MIN_MM, 0.2)
check('computed annulus for 0.3/0.6', Math.round(checkVia('GND', mmToMil(0.3), mmToMil(0.6)).annulusMm * 1000) / 1000, 0.15)

// --- width tiers are the documented four -----------------------------------
check('width tiers', TRACK_WIDTH_MIL, { signal: 6, branchPower: 10, mainPower: 16, highCurrent: 20 })

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
