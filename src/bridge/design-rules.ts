/**
 * JLCEDA / 嘉立创 design rules that this plugin can actually enforce.
 *
 * Normative text and rationale: `docs/design-rules.md`. Everything here is a
 * *default* the tools apply plus a check they report, never a silent rewrite:
 * a caller that really needs an off-rule value passes `force: true` and gets a
 * warning back.
 *
 * Units: PCB coordinates and sizes are **mil** (JLCEDA Pro), 1 mm = 39.3701 mil.
 */

export const MIL_PER_MM = 39.37007874015748

/** Convert millimetres to mil. */
export function mmToMil(mm: number): number {
  return mm * MIL_PER_MM
}

/** Convert mil to millimetres. */
export function milToMm(mil: number): number {
  return mil / MIL_PER_MM
}

/** Round a mil value to the nearest 0.05 mm step, as the rule set recommends. */
export function roundToFiveHundredthsMm(mil: number): number {
  const mm = milToMm(mil)
  return Math.round(mm / 0.05) * 0.05 * MIL_PER_MM
}

export interface RuleCheck {
  /** False only for values that would fail manufacturing / free prototyping. */
  ok: boolean
  errors: string[]
  warnings: string[]
}

function result(errors: string[], warnings: string[]): RuleCheck {
  return { ok: errors.length === 0, errors, warnings }
}

// ---------------------------------------------------------------------------
// Net naming (section 2.1: the backend matches net names as exact strings)
// ---------------------------------------------------------------------------

/** Hard limit from the JLCEDA backend. */
export const NET_NAME_MAX_LENGTH = 255

/**
 * Characters that survive the backend's parser. Space, `/`, `\`, brackets,
 * comma, semicolon and non-ASCII (Chinese) names can split a net or drop it.
 */
const NET_NAME_ALLOWED = /^[A-Za-z0-9_.+-]+$/

/**
 * Check a net name against the naming rules.
 *
 * Rejects what the backend cannot parse; warns about the "practical" advice
 * (uppercase + underscore only) because existing projects legitimately use
 * names such as `P0.1`.
 */
export function checkNetName(net: string): RuleCheck & { net: string } {
  const errors: string[] = []
  const warnings: string[] = []
  if (net === '') errors.push('net name is empty')
  if (net.length > NET_NAME_MAX_LENGTH) errors.push(`net name is longer than ${NET_NAME_MAX_LENGTH} characters`)
  if (net !== '' && !NET_NAME_ALLOWED.test(net)) {
    errors.push(`net name "${net}" contains characters the JLCEDA backend cannot parse (allowed: letters, digits, "_", ".", "+", "-")`)
  }
  if (/[a-z]/.test(net)) warnings.push(`net name "${net}" is not uppercase; the official advice is uppercase letters, digits and "_" only`)
  return { ...result(errors, warnings), net }
}

/** Throw on an unusable net name, so every net-taking tool fails identically. */
export function assertNetName(net: string, tool: string): void {
  const check = checkNetName(net)
  if (!check.ok) throw new Error(`${tool}: ${check.errors.join('; ')} (see docs/design-rules.md §2.1)`)
}

// ---------------------------------------------------------------------------
// Net roles and track width (section 5.1)
// ---------------------------------------------------------------------------

export type NetRole = 'ground' | 'power' | 'signal'

/** Track widths in mil for the four roles the rule set names. */
export const TRACK_WIDTH_MIL = {
  /** 0.15 mm — ordinary signals, also the free-prototyping lower bound. */
  signal: 6,
  /** 0.25 mm — device-to-decoupling branch power. */
  branchPower: 10,
  /** 0.4 mm — main power trunk. */
  mainPower: 16,
  /** 0.5 mm — more than ~500 mA. */
  highCurrent: 20,
} as const

/** Hard lower bound for a routed track (0.15 mm). */
export const MIN_TRACK_WIDTH_MIL = TRACK_WIDTH_MIL.signal

const GROUND_PATTERN = /^(?:A|D|P)?GND[A-Z0-9_]*$|^(?:VSS|EARTH|0V)/i
const POWER_PATTERN = /^(?:VCC|VDD|VEE|VBAT|VIN|VOUT|VBUS|PWR|VSYS|VCORE|AVDD|DVDD|3V3|5V|12V|24V|1V8|1V2|2V5)/i

/** Classify a net by name, for the default track width and the audit. */
export function classifyNet(net: string): NetRole {
  if (GROUND_PATTERN.test(net)) return 'ground'
  if (POWER_PATTERN.test(net)) return 'power'
  return 'signal'
}

/** Default track width (mil) for one net, following section 5.1. */
export function suggestTrackWidthMil(net: string): number {
  const role = classifyNet(net)
  if (role === 'ground') return TRACK_WIDTH_MIL.mainPower // routed GND: main-power class, pour preferred
  if (role === 'power') return TRACK_WIDTH_MIL.mainPower
  return TRACK_WIDTH_MIL.signal
}

/**
 * Validate a track width for a net.
 *
 * `lineWidth` undefined means "use the suggestion", which is what the drawing
 * tools do; a provided value below the hard bound is an error unless `force`.
 */
export function checkTrackWidth(net: string, lineWidth: number | undefined, force = false): RuleCheck & { widthMil: number; role: NetRole; suggestedMil: number } {
  const errors: string[] = []
  const warnings: string[] = []
  const role = classifyNet(net)
  const suggestedMil = suggestTrackWidthMil(net)
  const widthMil = lineWidth === undefined ? suggestedMil : lineWidth

  if (!Number.isFinite(widthMil) || widthMil <= 0) {
    errors.push(`track width must be a positive number of mil (got ${String(lineWidth)})`)
  } else if (widthMil < MIN_TRACK_WIDTH_MIL && !force) {
    errors.push(`track width ${widthMil} mil is below the ${MIN_TRACK_WIDTH_MIL} mil (0.15 mm) design minimum; pass force:true to override`)
  }
  if (widthMil > 0 && widthMil < suggestedMil && Number.isFinite(widthMil) && !force) {
    warnings.push(`track width ${widthMil} mil is below the ${suggestedMil} mil suggested for ${role} net "${net}"`)
  }
  // The tier values (6/10/16/20 mil) are the practical mil targets, so they are
  // exempt from the "round to a 0.05 mm step" advice.
  const isTierValue = (Object.values(TRACK_WIDTH_MIL) as number[]).includes(widthMil)
  if (widthMil > 0 && !isTierValue && milToMm(widthMil) % 0.05 > 0.001) {
    warnings.push(`track width ${Math.round(widthMil * 100) / 100} mil (${milToMm(widthMil).toFixed(3)} mm) is not on a 0.05 mm step; ${Math.round(roundToFiveHundredthsMm(widthMil) * 100) / 100} mil aligns better with JLC parameters`)
  }
  return { ...result(errors, warnings), widthMil, role, suggestedMil }
}

// ---------------------------------------------------------------------------
// Vias (section 5.2)
// ---------------------------------------------------------------------------

/** Standard drill/pad pairs in mm — prefer these over custom sizes. */
export const VIA_SIZES_MM = [
  { hole: 0.2, pad: 0.4, role: 'signal' },
  { hole: 0.3, pad: 0.6, role: 'power' },
  { hole: 0.4, pad: 0.8, role: 'highCurrent' },
] as const

/** Free-prototyping common lower bound for the drill diameter. */
export const VIA_HOLE_MIN_MM = 0.3
/** Below this the drill is not manufacturable at the standard process at all. */
export const VIA_HOLE_ABSOLUTE_MIN_MM = 0.2
/** Minimum annular ring: pad diameter minus hole diameter (the rule's 0.20 mm). */
export const ANNULUS_MIN_MM = 0.2

/** Validate via geometry (mil in, mm rules). */
export function checkVia(net: string, holeDiameterMil: number, diameterMil: number, force = false): RuleCheck & { holeMm: number; padMm: number; annulusMm: number; ringMm: number; suggestedMm: { hole: number; pad: number } } {
  const errors: string[] = []
  const warnings: string[] = []
  const holeMm = milToMm(holeDiameterMil)
  const padMm = milToMm(diameterMil)
  // The rule's "焊环 ≥0.20mm" is the radial ring measured across the pad, i.e.
  // pad minus hole; the standard pairs (0.2/0.4, 0.3/0.6, 0.4/0.8) all satisfy it.
  const ringMm = padMm - holeMm
  const annulusMm = ringMm / 2
  const role = classifyNet(net)
  const suggestedMm = role === 'signal' ? { hole: 0.2, pad: 0.4 } : { hole: 0.3, pad: 0.6 }

  if (!Number.isFinite(holeMm) || !Number.isFinite(padMm) || holeMm <= 0 || padMm <= 0) {
    errors.push('via hole and pad must be positive numbers of mil')
  } else {
    if (holeMm < VIA_HOLE_ABSOLUTE_MIN_MM) {
      errors.push(`via hole ${holeMm.toFixed(2)} mm is below the ${VIA_HOLE_ABSOLUTE_MIN_MM} mm manufacturable minimum`)
    } else if (holeMm < VIA_HOLE_MIN_MM) {
      warnings.push(`via hole ${holeMm.toFixed(2)} mm is below the ${VIA_HOLE_MIN_MM} mm free-prototyping lower bound; confirm the capability on the order page`)
    }
    if (ringMm < ANNULUS_MIN_MM - 0.001) {
      errors.push(`via annular ring ${ringMm.toFixed(2)} mm (pad ${padMm.toFixed(2)} - hole ${holeMm.toFixed(2)}) is below the ${ANNULUS_MIN_MM} mm minimum`)
    }
    const standard = VIA_SIZES_MM.find(size => Math.abs(size.hole - holeMm) < 0.01 && Math.abs(size.pad - padMm) < 0.01)
    if (standard === undefined) {
      warnings.push(`via ${holeMm.toFixed(2)}/${padMm.toFixed(2)} mm is not one of the standard sizes (0.2/0.4, 0.3/0.6, 0.4/0.8 mm)`)
    }
    if (role !== 'signal' && holeMm < 0.3 && !force) {
      warnings.push(`power/ground net "${net}" uses a ${holeMm.toFixed(2)} mm hole; 0.3/0.6 mm is recommended for current-carrying vias`)
    }
  }
  return { ...result(errors, warnings), holeMm, padMm, annulusMm, ringMm, suggestedMm }
}

// ---------------------------------------------------------------------------
// Copper pour (section 5.4) and board outline (section 7.2)
// ---------------------------------------------------------------------------

/** Minimum clearance the fabricator requires between a pour and other nets. */
export const POUR_CLEARANCE_MIN_MIL = 6
/** Recommended clearance for real designs (0.254 mm). */
export const POUR_CLEARANCE_RECOMMENDED_MIL = 10

/** Default board-outline line width (10 mil), as the rule set specifies. */
export const BOARD_OUTLINE_WIDTH_MIL = 10

/** Silkscreen lower bounds (documented; the API cannot set them per primitive). */
export const SILKSCREEN_HEIGHT_MIN_MM = 1.0
export const SILKSCREEN_WIDTH_MIN_MM = 0.15
