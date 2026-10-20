/**
 * Generate docs/schematic-workflow.md from src/skills-content.ts.
 *
 * The skill body, the system-prompt section and this document must never disagree:
 * the playbook lives in one module and the document is emitted from it.
 *
 * `node scripts/gen-skill-doc.mjs`
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const source = readFileSync(join(root, 'src', 'skills-content.ts'), 'utf8').split(/\r?\n/)
const start = source.findIndex(line => line.startsWith('export const SKILL_PLAYBOOK_LINES'))
if (start < 0) throw new Error('SKILL_PLAYBOOK_LINES not found in src/skills-content.ts')

const lines = []
for (const line of source.slice(start + 1)) {
  const trimmed = line.trim()
  // The array ends on the first bare closing bracket at statement level; entries are
  // JSON strings, so a markdown checkbox "[ ]" inside a string never matches.
  if (trimmed === ']') break
  if (!trimmed.startsWith('"')) continue
  lines.push(JSON.parse(trimmed.replace(/,$/, '')))
}
if (lines.length === 0) throw new Error('no playbook lines parsed')

const header = [
  '<!-- 本文件由 scripts/gen-skill-doc.mjs 从 src/skills-content.ts 生成，请勿手工编辑。 -->',
  '<!-- 同一份内容同时作为 DSH 技能 jlceda-schematic-workflow 的正文，以及系统提示精简版的来源。 -->',
  '',
]
writeFileSync(join(root, 'docs', 'schematic-workflow.md'), header.concat(lines).join('\n') + '\n')
console.log('wrote docs/schematic-workflow.md (' + lines.length + ' lines)')
