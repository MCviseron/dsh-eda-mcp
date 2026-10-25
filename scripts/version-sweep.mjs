import { readFileSync } from 'node:fs'

/**
 * Weekly DSH sweep, one command: report what is published, what this repo supports, and what
 * the next action is. Read-only; it never installs, edits or publishes anything.
 *
 *   node scripts/version-sweep.mjs
 *
 * Why it exists: judging by the dsh dist-tags alone reported "nothing new" while a same-line
 * build (0.2.1-rc.3) had never been probed, and the seam packages keep a placeholder
 * latest=0.0.1-rc.1 that makes per-package "latest" meaningless. See docs/dsh-version-sweep.md.
 */
const META = '@deepseek-ai/dsh'
const SEAMS = [
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-locale',
]

async function registryDoc(name) {
  const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(name), { signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error(name + ': HTTP ' + response.status)
  return response.json()
}

/** Newest published version by publish time, not by tag. */
async function newestPublished(name) {
  const doc = await registryDoc(name)
  const time = doc.time ?? {}
  let newest = ''
  let newestAt = ''
  for (const version of Object.keys(doc.versions ?? {})) {
    const at = typeof time[version] === 'string' ? time[version] : ''
    if (at > newestAt) { newest = version; newestAt = at }
  }
  return { newest, newestAt: newestAt.slice(0, 10), latest: doc['dist-tags']?.latest ?? '-' }
}

/** "0.2.1-rc.3" -> "0.2.1" (the tuple a caret range on that line covers). */
function tuple(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  return match === null ? version : match[1] + '.' + match[2] + '.' + match[3]
}

function declaredTuples() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const ranges = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) }
  const lines = new Set()
  for (const [name, range] of Object.entries(ranges)) {
    if (!name.startsWith('@deepseek-ai/dsh')) continue
    for (const part of String(range).split('||')) {
      const version = part.trim().replace(/^[\^~>=]+/, '').trim()
      if (version !== '') lines.add(tuple(version))
    }
  }
  return lines
}

const meta = await registryDoc(META)
const tags = meta['dist-tags'] ?? {}
const covered = declaredTuples()

console.log('meta dist-tags   latest=' + tags.latest + '  next=' + tags.next + '  alpha=' + tags.alpha)
console.log('declared tuples  ' + [...covered].join(', '))
console.log('')
const rows = []
for (const name of SEAMS) {
  try { rows.push({ name, ...(await newestPublished(name)) }) } catch (error) { rows.push({ name, newest: 'ERR', newestAt: String(error.message).slice(0, 40), latest: '-' }) }
}
for (const row of rows) {
  console.log(row.name.replace('@deepseek-ai/', '').padEnd(28) + 'newest=' + String(row.newest).padEnd(14) + '(' + row.newestAt + ')  latest-tag=' + row.latest)
}
console.log('')

const candidates = [...new Set([tags.latest, tags.next, ...rows.map(row => row.newest)].filter(v => typeof v === 'string' && /^\d/.test(v)))]
const unknownTuples = [...new Set(candidates.map(tuple).filter(line => !covered.has(line)))]
const newest = rows.map(row => row.newest).filter(v => /^\d/.test(v)).sort().at(-1) ?? ''

// "Covered by a range" is not the same as "verified": the READMEs list the generations this
// repo actually probed, and a same-tuple build can be missing from that list.
function verifiedGenerations() {
  const text = readFileSync('README.md', 'utf8')
  const marker = text.indexOf('Verified generations:')
  if (marker < 0) return []
  const line = text.slice(marker).split('\n').slice(0, 2).join(' ')
  return [...new Set(line.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/g) ?? [])]
}

const verified = verifiedGenerations()
const newestVerified = verified.includes(newest)
console.log('NEW TUPLES (need a dependency line): ' + (unknownTuples.length === 0 ? 'none' : unknownTuples.join(', ')))
console.log('NEWEST PUBLISHED BUILD:            ' + newest + '  (tuple ' + tuple(newest) + ', ' +
  (covered.has(tuple(newest)) ? 'inside the supported range' : 'OUTSIDE the supported range') + ')')
console.log('VERIFIED GENERATIONS (README):     ' + (verified.length === 0 ? '(none parsed)' : verified.join(', ')))
console.log('')

if (unknownTuples.length > 0) {
  const target = [...candidates].filter(v => !covered.has(tuple(v))).at(-1) ?? newest
  console.log('VERDICT: new version line — probe it before touching dependencies.')
  console.log('Next:   node scripts/seam-check.mjs ' + target)
  console.log('        if ALL PASS: add the tuple to dependencies/peerDependencies (keep the old lines),')
  console.log('        typecheck + test + build, then CHANGELOG + README verified list.')
} else if (newestVerified) {
  console.log('VERDICT: nothing to do — the newest published build is already verified in the READMEs.')
  console.log('Next:   none (no code change, no dependency change).')
} else {
  console.log('VERDICT: same line, unverified build — this is the case that was wrongly reported as "nothing new".')
  console.log('Next:   node scripts/seam-check.mjs ' + newest)
  console.log('        ALL PASS -> no dependency change; add ' + newest + ' to the README verified list and')
  console.log('        record the evidence in CHANGELOG. Then check the two manual contracts by unpacking')
  console.log('        @deepseek-ai/dsh-tools@' + newest + ' and @deepseek-ai/dsh-plugin-manager@' + newest + '')
  console.log('        (expected: super(ctx,"tools") and manifest.dsh?.bundle?.patch). See docs/dsh-version-sweep.md.')
}
