// Generates docs/tools.md from the built bridge's MCP `tools/list`.
//
//   node build.mjs && node scripts/gen-tools-doc.mjs
//
// The bridge is spawned over stdio exactly like DSH spawns it, so the document
// always matches what the agent can actually call.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bridge = join(root, 'lib', 'bridge.mjs')
const outFile = join(root, 'docs', 'tools.md')

const child = spawn(process.execPath, [bridge], { stdio: ['pipe', 'pipe', 'ignore'] })
let buffer = ''
const pending = new Map()
let nextId = 1

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() === '') continue
    const message = JSON.parse(line)
    const resolve = pending.get(message.id)
    if (resolve !== undefined) { pending.delete(message.id); resolve(message) }
  }
})

function rpc(method, params) {
  const id = nextId
  nextId += 1
  return new Promise((resolve) => {
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

function paramsOf(schema) {
  const props = schema?.properties ?? {}
  const required = Array.isArray(schema?.required) ? schema.required : []
  return Object.entries(props).map(([key, spec]) => {
    const type = Array.isArray(spec.type) ? spec.type.join('|') : (spec.type ?? 'any')
    return key + (required.includes(key) ? '' : '?') + ': ' + type
  }).join(', ')
}

function escapeCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|')
}

const GROUPS = [
  ['Project', /^(eda_list_projects|eda_get_project|eda_open_project|eda_create_project|eda_delete_project|eda_modify_project|eda_copy_project|eda_import_project|eda_export_project|eda_close_document)$/],
  ['Workspace', /^(eda_get_workspace|eda_list_teams|eda_list_folders)$/],
  ['App control', /^(eda_launch|eda_close)$/],
  ['Schematic: query', /^(eda_capture|eda_delivery_checklist|eda_design_intake|eda_netlist_erc|eda_schematic_audit|eda_pcb_canvas_origin|eda_status|eda_get_page_info|eda_get_schematic_pages|eda_get_components|eda_get_wires|eda_get_nets|eda_get_pins|eda_get_net_labels|eda_get_active_document|eda_open_document|eda_search_components|eda_list_api_methods|eda_workflow_guide)$/],
  ['Schematic: place & draw', /^(eda_place_component|eda_place_net_flag|eda_place_net_label|eda_place_net_port|eda_place_net_flag_at_pin|eda_place_net_label_at_pin|eda_place_net_labels|eda_move_component|eda_set_no_connect|eda_draw_wire|eda_draw_rectangle|eda_draw_functional_box|eda_draw_circle|eda_draw_text|eda_delete_primitive|pcb_draw_text|pcb_draw_mounting_hole)$/],
  ['Schematic: automation & export', /^(eda_run_drc|eda_auto_layout|eda_auto_route|eda_export_netlist|eda_export_bom|eda_save_document|eda_zoom_to_fit|eda_zoom_to_region|eda_create_board)$/],
  ['Design rules', /^(eda_design_audit)$/],
  ['PCB: query', /^(pcb_get_components|pcb_get_nets|pcb_get_layers|pcb_get_primitives_in_region|eda_pcb_get_tracks|eda_pcb_get_vias|eda_pcb_get_polylines|eda_pcb_get_regions|eda_pcb_get_pours|eda_pcb_run_drc|eda_pcb_get_drc_rules|eda_pcb_job_status)$/],
  ['PCB: place & draw', /^(pcb_place_component|pcb_draw_track|pcb_draw_via|pcb_draw_board_outline|pcb_draw_polyline|eda_pcb_move_component|eda_pcb_delete_component|eda_pcb_modify_track|eda_pcb_delete_track|eda_pcb_delete_via|eda_pcb_delete_polyline|eda_pcb_create_region|eda_pcb_delete_region|eda_pcb_create_pour|eda_pcb_delete_pour|eda_pcb_set_net_track_width)$/],
  ['PCB: sync, automation & export', /^(pcb_import_changes|eda_pcb_wait_for_components|eda_pcb_auto_place|eda_pcb_auto_route|eda_pcb_clear_routing|eda_pcb_export_gerber|pcb_save_document|pcb_navigate_to_region)$/],
  ['eda_pcb_* aliases', /^eda_pcb_(get_components|get_nets|get_layers|place_component|draw_track|draw_via|draw_board_outline|save_document|import_changes|get_primitives_in_region|navigate_to_region)$/],
  ['Generic allow-listed API', /^(eda_api_call)$/],
]

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'docs', version: '0.0.0' } })
const listed = await rpc('tools/list', {})
const tools = listed.result.tools

const seen = new Set()
const lines = [
  '# Tool reference (generated)',
  '',
  'Generated from the built bridge\'s MCP `tools/list` by `node scripts/gen-tools-doc.mjs` — this is the',
  'authoritative list of what the agent can call. Coordinates: schematic/symbol = **0.01 inch**',
  '(MCP units), PCB = **mil**. Rotation = 0/90/180/270 for schematic primitives.',
  '',
  'Design limits enforced by these tools (track widths, via sizes, net naming) are documented in',
  '[design-rules.md](design-rules.md).',
  '',
]

for (const [title, pattern] of GROUPS) {
  const picked = tools.filter(tool => pattern.test(tool.name))
  if (picked.length === 0) continue
  lines.push('## ' + title, '', '| Tool | Description | Parameters |', '|---|---|---|')
  for (const tool of picked) {
    seen.add(tool.name)
    lines.push('| `' + tool.name + '` | ' + escapeCell(tool.description) + ' | `' + paramsOf(tool.inputSchema) + '` |')
  }
  lines.push('')
}

const rest = tools.filter(tool => !seen.has(tool.name))
if (rest.length > 0) {
  lines.push('## Other', '', '| Tool | Description | Parameters |', '|---|---|---|')
  for (const tool of rest) {
    lines.push('| `' + tool.name + '` | ' + escapeCell(tool.description) + ' | `' + paramsOf(tool.inputSchema) + '` |')
  }
  lines.push('')
}

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, lines.join('\n') + '\n', 'utf8')
console.log('wrote ' + outFile + ' (' + tools.length + ' tools, ' + rest.length + ' ungrouped)')
child.kill()
process.exit(0)
