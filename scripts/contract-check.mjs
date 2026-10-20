/**
 * Contract check: the bridge, the extension and the tool table must agree.
 *
 * Every failure class below has already been a real bug:
 *  - a tool declared without a handler (fails at runtime)
 *  - a handler with no declaration (dead code, docs drift)
 *  - callExtension('X') where X is missing from the extension allow-list or has no
 *    internal helper ("API method not allowed" at runtime)
 *
 * `node scripts/contract-check.mjs`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const bridge = readFileSync(join(root, 'src', 'bridge', 'index.ts'), 'utf8')
const extension = readFileSync(join(root, 'jlc-extension', 'api-bridge.js'), 'utf8')
const problems = []

// --- tool table vs handlers ------------------------------------------------
const declared = new Set()
// Duplicates are fatal at runtime: the MCP client refuses a server that lists the
// same tool twice ("server listed tool X more than once — invalid tool list") and the
// whole plugin then disappears from the session. Catch it here instead.
const seenNames = new Map()
for (const match of bridge.matchAll(/\{ name: '([a-z0-9_]+)'/g)) {
  seenNames.set(match[1], (seenNames.get(match[1]) ?? 0) + 1)
  declared.add(match[1])
}
for (const [name, count] of seenNames) if (count > 1) problems.push('tool declared ' + count + ' times: ' + name)

// Aliases are resolved before the switch, so they need no case of their own.
const aliases = new Map()
const aliasBlock = bridge.slice(bridge.indexOf('const PCB_TOOL_ALIASES = {'))
for (const match of aliasBlock.slice(0, aliasBlock.indexOf('\n}')).matchAll(/'?([a-z0-9_]+)'?:\s*'([a-z0-9_]+)'/g)) {
  aliases.set(match[1], match[2])
}

// Only the tool switch matters here: `case 'component':` belongs to a primitive-kind
// switch and must not be mistaken for a tool.
const handled = new Set()
for (const match of bridge.matchAll(/^ {4}case '((?:eda|pcb)_[a-z0-9_]+)':/gm)) handled.add(match[1])

for (const name of declared) {
  const target = aliases.get(name) ?? name
  if (!handled.has(target)) problems.push('declared without handler: ' + name + (target === name ? '' : ' (alias -> ' + target + ')'))
}

// --- declared schemas ------------------------------------------------------
// A required name that is not among the properties makes every call fail client
// side with a validation error, so check it mechanically.
function matchBrace(text, openIndex) {
  let depth = 0
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}
let schemaCount = 0
for (const match of bridge.matchAll(/\{ name: '([a-z0-9_]+)',[\s\S]*?inputSchema: objectSchema\(\{/g)) {
  const tool = match[1]
  const openIndex = match.index + match[0].length - 1
  const closeIndex = matchBrace(bridge, openIndex)
  if (closeIndex < 0) {
    problems.push('unbalanced schema object: ' + tool)
    continue
  }
  schemaCount += 1
  const properties = bridge.slice(openIndex + 1, closeIndex)
  const tail = bridge.slice(closeIndex + 1, closeIndex + 400)
  const requiredMatch = tail.match(/^\s*,\s*\[([^\]]*)\]/)
  if (!requiredMatch) continue
  for (const raw of requiredMatch[1].split(',')) {
    const name = raw.trim().replace(/'/g, '')
    if (name === '') continue
    if (!new RegExp('(^|[^A-Za-z0-9_])' + name + '\\s*:').test(properties)) {
      problems.push('required field "' + name + '" is not a property of ' + tool)
    }
  }
}

// --- called methods vs extension surface -----------------------------------
// Two sets gate the wire: ALLOWED_API for plain calls and FILE_METHODS for the
// ones that hand a File back. Both count as callable.
const allowed = new Set()
for (const setName of ['var ALLOWED_API = new Set([', 'var FILE_METHODS = new Set([']) {
  const start = extension.indexOf(setName)
  if (start < 0) continue
  const lines = extension.slice(start).split(/\r?\n/)
  for (const line of lines.slice(1)) {
    if (line.trim() === ']);') break
    const match = line.match(/'([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_]+)'/)
    if (match) allowed.add(match[1])
  }
}

const internalHandlers = new Set()
for (const match of extension.matchAll(/message\.method === '(dsh\.internal\.[A-Za-z0-9]+)'/g)) internalHandlers.add(match[1])

// The runtime gate must accept BOTH sets: an earlier version only checked
// ALLOWED_API, so every FILE_METHODS export (BOM/netlist/Gerber) was refused.
const gate = extension.match(/if \(!(?:[^)]*)ALLOWED_API\.has\(message\.method\)([^)]*)\)/)
if (gate === null || !gate[1].includes('FILE_METHODS')) {
  problems.push('the dispatch gate must accept FILE_METHODS as well as ALLOWED_API')
}

const called = new Set()
for (const match of bridge.matchAll(/callExtension\('([A-Za-z_][A-Za-z0-9_.]*)'/g)) called.add(match[1])

for (const method of called) {
  if (method.startsWith('dsh.internal.')) {
    if (!internalHandlers.has(method)) problems.push('internal helper not implemented: ' + method)
    continue
  }
  if (!allowed.has(method)) problems.push('API not in extension allow-list: ' + method)
}

// The extension own allow-list is the authority: eda_list_api_methods reports it and
// eda_api_call forwards instead of pre-gating on the bridge copy, which drifted and
// once rejected methods the extension actually accepted.
if (!extension.includes('dsh.internal.listApiMethods')) problems.push('extension does not implement dsh.internal.listApiMethods')
const apiCallStart = bridge.indexOf("case 'eda_api_call'")
const apiCallBody = apiCallStart < 0 ? '' : bridge.slice(apiCallStart, apiCallStart + 1200)
if (apiCallBody.includes('ALLOWED_API.has(')) problems.push('eda_api_call still pre-gates on the bridge copy')

console.log('tools declared: ' + declared.size + ' (' + aliases.size + ' aliases), handled: ' + handled.size)
console.log('allow-list entries: ' + allowed.size + ', internal helpers: ' + internalHandlers.size)
console.log('API methods called by the bridge: ' + called.size + ', input schemas: ' + schemaCount)
if (problems.length === 0) {
  console.log('PASS contract check: no violations')
} else {
  for (const problem of problems) console.log('FAIL ' + problem)
  process.exitCode = 1
}
