// @ts-nocheck -- the bridge is authored as dependency-free JS and bundled by esbuild; runtime tests cover it.
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { buildLaunchArgs, buildLaunchScript, decodeRegistryOutput, resolveExecutable, type LaunchProbe } from './eda-launch.ts'
import {
  ANNULUS_MIN_MM, BOARD_OUTLINE_WIDTH_MIL, MIN_TRACK_WIDTH_MIL, POUR_CLEARANCE_MIN_MIL,
  POUR_CLEARANCE_RECOMMENDED_MIL, SILKSCREEN_HEIGHT_MIN_MM, SILKSCREEN_WIDTH_MIN_MM,
  TRACK_WIDTH_MIL, VIA_HOLE_ABSOLUTE_MIN_MM, VIA_HOLE_MIN_MM, VIA_SIZES_MM,
  assertNetName, checkNetName, checkTrackWidth, checkVia, classifyNet, milToMm, suggestTrackWidthMil,
} from './design-rules.ts'
import { WORKFLOW_GUIDE, WORKFLOW_SUMMARY } from './workflow-guide.ts'

const VERSION = '0.4.4'
const WS_PORT = Number(process.env.DSH_EDA_MCP_WS_PORT ?? 39009)
const WS_HOST = '127.0.0.1'
const ALLOW_RAW_API = (process.env.DSH_EDA_MCP_ALLOW_RAW_API ?? '1') !== '0'
// Automatic layout/routing is opt-in: placing parts and routing by hand is the
// default working style (visual PNG check beats letting the app rearrange a sheet).
const ALLOW_AUTO_LAYOUT = (process.env.DSH_EDA_ALLOW_AUTO_LAYOUT ?? '0') === '1'
const TOOL_TIMEOUT_MS = Number(process.env.DSH_EDA_MCP_TOOL_TIMEOUT_MS ?? 60000)

const MCP_UNITS_PER_INCH = 100

const PAPER_SIZES = {
  A4: {
    name: 'A4',
    widthInch: 11.7,
    heightInch: 8.25,
    frame: { left: 0, bottom: 0, right: 1170, top: 825 },
    titleBlock: { left: 460, bottom: 10, right: 1160, top: 190 },
  },
}

const DEFAULT_PAPER = 'A4'

function paperOf(name) {
  const key = String(name ?? DEFAULT_PAPER).toUpperCase()
  return PAPER_SIZES[key] ?? PAPER_SIZES[DEFAULT_PAPER]
}

function safeAreas(paperName) {
  const paper = paperOf(paperName)
  return {
    main: { left: 40, bottom: 200, right: paper.frame.right - 40, top: paper.frame.top - 25 },
    lowerLeft: { left: 40, bottom: 40, right: paper.titleBlock.left - 20, top: paper.titleBlock.top - 10 },
  }
}

/** Decode a text payload that may arrive as UTF-16LE (BOM or interleaved NULs). */
function decodeTextPayload(value) {
  const text = typeof value === 'string' ? value : ''
  if (text === '') return text
  // Three shapes reach us: an already-decoded string with a U+FEFF prefix, the raw
  // BOM bytes mangled into the characters 0xFF 0xFE, and a null-interleaved UTF-16
  // body without a BOM. Measured on EDA 3.2.186 the CSV BOM arrives mangled, which
  // the first version of this helper missed.
  if (text.charCodeAt(0) === 0xfeff) return text.slice(1)
  if (text.charCodeAt(0) === 0xff && text.charCodeAt(1) === 0xfe) {
    return Buffer.from(text.slice(2), 'latin1').toString('utf16le')
  }
  if (text.length > 3 && text.charCodeAt(1) === 0 && text.charCodeAt(3) === 0) {
    return Buffer.from(text, 'latin1').toString('utf16le')
  }
  return text
}

function checkPointInFrame(x, y, paperName, margin = 0) {
  const paper = paperOf(paperName)
  const f = paper.frame
  if (x < f.left + margin || x > f.right - margin || y < f.bottom + margin || y > f.top - margin) {
    return 'point (' + x + ', ' + y + ') is outside the ' + paper.name + ' frame ' + f.left + '..' + f.right + ' x ' + f.bottom + '..' + f.top + ' (MCP units, 0.01 inch)'
  }
  return undefined
}

function checkPointAgainstTitleBlock(x, y, paperName, margin = 0) {
  const paper = paperOf(paperName)
  const t = paper.titleBlock
  if (x > t.left - margin && x < t.right + margin && y > t.bottom - margin && y < t.top + margin) {
    return 'point (' + x + ', ' + y + ') overlaps the title block ' + t.left + '..' + t.right + ' x ' + t.bottom + '..' + t.top + ' (MCP units)'
  }
  return undefined
}

function checkBBoxInFrame(bbox, paperName, margin = 0) {
  const paper = paperOf(paperName)
  const f = paper.frame
  if (bbox.minX < f.left + margin || bbox.maxX > f.right - margin || bbox.minY < f.bottom + margin || bbox.maxY > f.top - margin) {
    return 'bounding box [' + bbox.minX + ',' + bbox.minY + ']..[' + bbox.maxX + ',' + bbox.maxY + '] is outside the ' + paper.name + ' frame'
  }
  const t = paper.titleBlock
  if (bbox.maxX > t.left - margin && bbox.minX < t.right + margin && bbox.maxY > t.bottom - margin && bbox.minY < t.top + margin) {
    return 'bounding box [' + bbox.minX + ',' + bbox.minY + ']..[' + bbox.maxX + ',' + bbox.maxY + '] overlaps the title block'
  }
  return undefined
}

const ALLOWED_API = new Set([
  'sch_Document.save',
  'sch_Document.navigateToCoordinates',
  'sch_Document.navigateToRegion',
  'sch_Document.getPrimitiveAtPoint',
  'sch_Document.getPrimitivesInRegion',
  'sch_Document.autoLayout',
  'sch_Document.autoRouting',
  'sch_Drc.check',
  'sch_Net.getAllNets',
  'sch_Net.getCurrentProjectAllNets',
  'sch_Net.getAllNetsName',
  'sch_Net.getNet',
  'sch_ManufactureData.getNetlistFile',
  'sch_ManufactureData.getBomFile',
  'sch_Primitive.getPrimitivesBBox',
  'sch_PrimitiveComponent.create',
  'sch_PrimitiveComponent.createNetFlag',
  'sch_PrimitiveComponent.createNetPort',
  'sch_PrimitiveComponent.createShortCircuitFlag',
  'sch_PrimitiveComponent.delete',
  'sch_PrimitiveComponent.modify',
  'sch_PrimitiveComponent.get',
  'sch_PrimitiveComponent.getAll',
  'sch_PrimitiveComponent.getAllPrimitiveId',
  'sch_PrimitiveComponent.getAllPinsByPrimitiveId',
  'sch_PrimitiveComponent.getAllPropertyNames',
  'sch_PrimitiveWire.create',
  'sch_PrimitiveWire.delete',
  'sch_PrimitiveWire.modify',
  'sch_PrimitiveWire.get',
  'sch_PrimitiveWire.getAll',
  'sch_PrimitiveWire.getAllPrimitiveId',
  'sch_PrimitiveRectangle.create',
  'sch_PrimitiveRectangle.delete',
  'sch_PrimitiveRectangle.modify',
  'sch_PrimitiveRectangle.get',
  'sch_PrimitiveRectangle.getAll',
  'sch_PrimitiveRectangle.getAllPrimitiveId',
  'sch_PrimitiveCircle.create',
  'sch_PrimitiveCircle.delete',
  'sch_PrimitiveCircle.modify',
  'sch_PrimitiveCircle.get',
  'sch_PrimitiveCircle.getAll',
  'sch_PrimitiveCircle.getAllPrimitiveId',
  'sch_PrimitiveArc.create',
  'sch_PrimitiveArc.delete',
  'sch_PrimitiveArc.modify',
  'sch_PrimitiveArc.get',
  'sch_PrimitiveArc.getAll',
  'sch_PrimitiveArc.getAllPrimitiveId',
  'sch_PrimitivePolygon.create',
  'sch_PrimitivePolygon.delete',
  'sch_PrimitivePolygon.modify',
  'sch_PrimitivePolygon.get',
  'sch_PrimitivePolygon.getAll',
  'sch_PrimitivePolygon.getAllPrimitiveId',
  'sch_PrimitiveText.create',
  'sch_PrimitiveText.delete',
  'sch_PrimitiveText.modify',
  'sch_PrimitiveText.get',
  'sch_PrimitiveText.getAll',
  'sch_PrimitiveText.getAllPrimitiveId',
  'sch_PrimitivePin.get',
  'sch_PrimitivePin.modify',
  'lib_Device.search',
  'lib_Device.getByLcscIds',
  'lib_Symbol.search',
  'lib_Footprint.search',
  'dmt_Schematic.getCurrentSchematicInfo',
  'dmt_Schematic.getCurrentSchematicPageInfo',
  'dmt_Schematic.getCurrentSchematicAllSchematicPagesInfo',
  'dmt_Schematic.getSchematicInfo',
  'dmt_Schematic.getSchematicPageInfo',
  'dmt_Schematic.getAllSchematicPagesInfo',
  'dmt_Board.createBoard',
  'dmt_Board.getAllBoardsInfo',
  'dmt_Board.getCurrentBoardInfo',
  'dmt_EditorControl.getSplitScreenTree',
  'dmt_EditorControl.getTabsBySplitScreenId',
  'dmt_EditorControl.openDocument',
  'dmt_EditorControl.activateDocument',
  'dmt_EditorControl.zoomToRegion',
  'dmt_EditorControl.zoomToAllPrimitives',
  'dmt_EditorControl.getCurrentRenderedAreaImage',
  'dmt_EditorControl.generateIndicatorMarkers',
  'dmt_EditorControl.removeIndicatorMarkers',
  'pcb_Document.save',
  'pcb_Document.importChanges',
  'pcb_Document.getPrimitivesInRegion',
  'pcb_Document.navigateToRegion',
  'pcb_Document.navigateToCoordinates',
  'pcb_Document.zoomToBoardOutline',
  'pcb_Document.getCanvasOrigin',
  'pcb_Primitive.getPrimitivesBBox',
  'pcb_PrimitiveComponent.create',
  'pcb_PrimitiveComponent.getAll',
  'pcb_PrimitiveComponent.getAllPrimitiveId',
  'pcb_PrimitiveComponent.getAllPinsByPrimitiveId',
  'pcb_PrimitiveLine.create',
  'pcb_PrimitiveVia.create',
  'pcb_Net.getAllNets',
  'pcb_Net.getAllNetsName',
  'pcb_Layer.getAllLayers',
  'pcb_Layer.getCurrentLayer',
  'pcb_PrimitiveComponent.modify',
  'pcb_PrimitiveComponent.delete',
  'pcb_PrimitiveLine.getAll',
  'pcb_PrimitiveLine.getAllPrimitiveId',
  'pcb_PrimitiveLine.modify',
  'pcb_PrimitiveLine.delete',
  'pcb_PrimitiveVia.getAll',
  'pcb_PrimitiveVia.getAllPrimitiveId',
  'pcb_PrimitiveVia.modify',
  'pcb_PrimitiveVia.delete',
  'pcb_PrimitivePolyline.create',
  'pcb_PrimitivePolyline.modify',
  'pcb_PrimitivePolyline.delete',
  'pcb_PrimitivePolyline.getAll',
  'pcb_PrimitivePolyline.getAllPrimitiveId',
  'pcb_Document.clearRouting',
  'pcb_PrimitiveRegion.create',
  'pcb_PrimitiveRegion.getAll',
  'pcb_PrimitiveRegion.getAllPrimitiveId',
  'pcb_PrimitiveRegion.modify',
  'pcb_PrimitiveRegion.delete',
  'pcb_MathPolygon.createPolygon',
  'pcb_PrimitivePour.create',
  'pcb_PrimitivePour.modify',
  'pcb_PrimitivePour.delete',
  'pcb_PrimitivePour.getAll',
  'pcb_PrimitivePour.getAllPrimitiveId',
  'pcb_Drc.check',
  'pcb_Drc.getCurrentRuleConfiguration',
  'pcb_Drc.getCurrentRuleConfigurationName',
  'pcb_Drc.getRealTimeDrcStatus',
  'pcb_Drc.startRealTimeDrc',
  'pcb_Drc.stopRealTimeDrc',
  'sch_PrimitiveAttribute.createNetLabel',
  'sch_PrimitiveAttribute.modify',
  'sch_PrimitiveAttribute.delete',
  'sch_PrimitiveAttribute.getAll',
  'sch_Netlist.getNetlist',
  'dmt_SelectControl.getCurrentDocumentInfo',
  'pcb_PrimitiveComponent.getAllPinsByPrimitiveId',
  'pcb_Document.autoLayout',
  'pcb_Document.autoRouting',
  'pcb_ManufactureData.getGerberFile',
])

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

const TOOLS = [
  { name: 'eda_status', description: 'Get the dsh-eda-mcp bridge status and how many JLCEDA Pro bridge extensions are connected.', inputSchema: objectSchema({}) },
  { name: 'eda_list_projects', description: 'List project UUIDs in the workspace (dmt_Project.getAllProjectsUuid). resolveNames=true (default) also reads getProjectInfo per project so callers can match by friendly name.', inputSchema: objectSchema({ teamUuid: { type: 'string' }, folderUuid: { type: 'string' }, workspaceUuid: { type: 'string' }, resolveNames: { type: 'boolean' }, limit: { type: 'integer' } }) },
  { name: 'eda_get_project', description: 'Read the current project (dmt_Project.getCurrentProjectInfo): uuid, friendly name, folder/team and other brief fields.', inputSchema: objectSchema({}) },
  { name: 'eda_open_project', description: 'Open a project by uuid, or by friendly name when only a name is known (the name is resolved through getAllProjectsUuid + getProjectInfo, exact match first, then case-insensitive substring).', inputSchema: objectSchema({ uuid: { type: 'string' }, name: { type: 'string' } }) },
  { name: 'eda_create_project', description: 'Create a project (dmt_Project.createProject) and return its uuid; open=true (default false) also opens it. friendlyName is required; name and folder/team default to the app defaults.', inputSchema: objectSchema({ friendlyName: { type: 'string' }, name: { type: 'string' }, teamUuid: { type: 'string' }, folderUuid: { type: 'string' }, description: { type: 'string' }, open: { type: 'boolean' } }, ['friendlyName']) },
  { name: 'eda_get_workspace', description: 'Read the current workspace and team (dmt_Workspace.getCurrentWorkspaceInfo / dmt_Team.getCurrentTeamInfo). Needed before creating a project, which requires a team (and usually a folder) uuid.', inputSchema: objectSchema({}) },
  { name: 'eda_list_teams', description: 'List teams (dmt_Team.getAllTeamsInfo), optionally including the teams this account is involved in.', inputSchema: objectSchema({ involved: { type: 'boolean' } }) },
  { name: 'eda_list_folders', description: 'List folder uuids of one team (dmt_Folder.getAllFoldersUuid), optionally resolved through getFolderInfo.', inputSchema: objectSchema({ teamUuid: { type: 'string' }, resolveNames: { type: 'boolean', } }) },
  { name: 'eda_delete_project', description: 'Delete a project (dmt_Project.deleteProject) by uuid or friendly name.', inputSchema: objectSchema({ uuid: { type: 'string' }, name: { type: 'string' } }) },
  { name: 'eda_modify_project', description: 'Rename a project or change its description (dmt_Project.modifyProjectFriendlyName / modifyProjectDescription), addressed by uuid or current friendly name.', inputSchema: objectSchema({ uuid: { type: 'string' }, name: { type: 'string' }, friendlyName: { type: 'string' }, description: { type: 'string' } }) },
  { name: 'eda_copy_project', description: 'Copy a project (dmt_Project.copyProject), optionally into another team/folder and with a new friendly name; returns the new uuid.', inputSchema: objectSchema({ sourceUuid: { type: 'string' }, sourceName: { type: 'string' }, targetTeamUuid: { type: 'string' }, targetFolderUuid: { type: 'string' }, newFriendlyName: { type: 'string' }, newName: { type: 'string' } }) },
  { name: 'eda_close_document', description: 'Close one editor tab (dmt_EditorControl.closeDocument).', inputSchema: objectSchema({ tabId: { type: 'string' } }, ['tabId']) },
  { name: 'eda_export_project', description: 'Export a project file (sys_FileManager.getProjectFile / getProjectFileByProjectUuid). With outPath the bridge writes the bytes to disk and returns the path; without it the base64 payload is returned only when inline=true.', inputSchema: objectSchema({ uuid: { type: 'string' }, fileName: { type: 'string' }, fileType: { type: 'string', enum: ['epro', 'epro2'] }, outPath: { type: 'string' }, inline: { type: 'boolean' } }) },
  { name: 'eda_import_project', description: 'Import a local project file (.eprj2/.epro/...) into a team (sys_FileManager.importProjectByProjectFile with a saveTo target). teamUuid is required in local mode: without a target team the app imports nothing. Returns whether the import actually landed.', inputSchema: objectSchema({ path: { type: 'string' }, teamUuid: { type: 'string' }, folderUuid: { type: 'string' }, friendlyName: { type: 'string' }, fileType: { type: 'string' }, open: { type: 'boolean' } }, ['path']) },
  { name: 'eda_close', description: 'Close JLCEDA Pro gracefully (taskkill /T on Windows, SIGTERM elsewhere), then force-kill if it is still running after waitMs (default 8000). Returns the remaining process count.', inputSchema: objectSchema({ force: { type: 'boolean' }, waitMs: { type: 'integer' } }) },
  { name: 'eda_launch', description: 'Launch JLCEDA Pro (EasyEDA Pro), optionally opening a .eprj2/.eprj project, then wait until the bridge extension connects. The executable is resolved from DSH_EDA_EXECUTABLE/JLCEDA_EXECUTABLE, the registry handler the installer registered, conventional install directories, then PATH - so it works on any machine without configuration.', inputSchema: objectSchema({ project: { type: 'string' }, executable: { type: 'string' }, waitForExtension: { type: 'boolean' }, timeoutMs: { type: 'integer' } }) },
  { name: 'eda_get_page_info', description: 'Return the current schematic page, the A4 frame range, the title-block keep-out range, and the recommended safe placement areas. All coordinates are MCP units (0.01 inch).', inputSchema: objectSchema({ paper: { type: 'string' } }) },
  { name: 'eda_get_schematic_pages', description: 'List the schematic pages of the current schematic, or fetch one page by uuid.', inputSchema: objectSchema({ pageUuid: { type: 'string' } }) },
  { name: 'eda_search_components', description: 'Search JLCEDA library devices by keyword. Returns candidate components with uuid/libraryUuid needed by eda_place_component.', inputSchema: objectSchema({ keyword: { type: 'string' }, limit: { type: 'integer' } }, ['keyword']) },
  { name: 'eda_place_component', description: 'Place a JLCEDA library component on the active schematic page. Coordinates are MCP units (0.01 inch), origin at the lower-left of the A4 frame. Placement is rejected when the symbol leaves the frame or overlaps the title block unless allowOutsideFrame is true.', inputSchema: objectSchema({
    libraryUuid: { type: 'string' }, uuid: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' },
    subPartName: { type: 'string' }, rotation: { type: 'integer', enum: [0, 90, 180, 270] }, mirror: { type: 'boolean' },
    addIntoBom: { type: 'boolean' }, addIntoPcb: { type: 'boolean' },
    designator: { type: 'string' }, value: { type: 'string' }, name: { type: 'string' },
    paper: { type: 'string' }, allowOutsideFrame: { type: 'boolean' },
  }, ['libraryUuid', 'uuid', 'x', 'y']) },
  { name: 'eda_place_net_flag', description: 'Place a power/ground net flag (VCC/GND etc.) on the active schematic page.', inputSchema: objectSchema({ identification: { type: 'string', enum: ['Power', 'Ground', 'AnalogGround', 'ProtectGround'] }, net: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, rotation: { type: 'integer', enum: [0, 90, 180, 270] }, mirror: { type: 'boolean' }, paper: { type: 'string' }, allowOutsideFrame: { type: 'boolean' } }, ['identification', 'net', 'x', 'y']) },
  { name: 'eda_place_net_port', description: 'Place a net port on the active schematic page.', inputSchema: objectSchema({ direction: { type: 'string', enum: ['IN', 'OUT', 'BI'] }, net: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, rotation: { type: 'integer', enum: [0, 90, 180, 270] }, mirror: { type: 'boolean' }, paper: { type: 'string' }, allowOutsideFrame: { type: 'boolean' } }, ['direction', 'net', 'x', 'y']) },
  { name: 'eda_get_pins', description: 'List pins of one schematic component in a single round trip, including pinName and pinNumber (no per-pin sch_PrimitivePin.get needed). Use the returned primitiveId with eda_place_net_flag_at_pin, eda_place_net_label_at_pin, or eda_set_no_connect.', inputSchema: objectSchema({ componentPrimitiveId: { type: 'string' } }, ['componentPrimitiveId']) },
  { name: 'eda_place_net_flag_at_pin', description: 'Place a power/ground net flag at a pin WITHOUT covering the symbol: the pin direction is read from the pin rotation, a stub wire of stubLength MCP units (default 20) is drawn outwards from the pin with the net name, and the flag is placed at its end. Pass offsetX/offsetY to place it manually (that disables the stub) or stubLength=0 for the old on-pin behaviour.', inputSchema: objectSchema({ pinPrimitiveId: { type: 'string' }, identification: { type: 'string', enum: ['Power', 'Ground', 'AnalogGround', 'ProtectGround'] }, net: { type: 'string' }, stubLength: { type: 'number' }, offsetX: { type: 'number' }, offsetY: { type: 'number' }, rotation: { type: 'integer', enum: [0, 90, 180, 270] }, mirror: { type: 'boolean' }, color: { type: 'string' }, lineWidth: { type: 'integer' }, lineType: { type: 'integer' }, paper: { type: 'string' }, allowOutsideFrame: { type: 'boolean' } }, ['pinPrimitiveId', 'identification', 'net']) },
  { name: 'eda_place_net_label_at_pin', description: 'Place a REAL net label at a pin (sch_PrimitiveAttribute.createNetLabel; falls back to text and reports method) WITHOUT covering the symbol: a stub wire of stubLength MCP units (default 20) is drawn outwards along the pin direction and the label goes at its end. offsetX/offsetY place it manually (disables the stub); stubLength=0 keeps the old on-pin behaviour.', inputSchema: objectSchema({ pinPrimitiveId: { type: 'string' }, net: { type: 'string' }, stubLength: { type: 'number' }, offsetX: { type: 'number' }, offsetY: { type: 'number' }, rotation: { type: 'integer', enum: [0, 90, 180, 270] }, fontSize: { type: 'number' }, color: { type: 'string' }, lineWidth: { type: 'integer' }, lineType: { type: 'integer' }, paper: { type: 'string' }, allowOutsideFrame: { type: 'boolean' } }, ['pinPrimitiveId', 'net']) },
  { name: 'eda_set_no_connect', description: 'Set or clear the no-connect flag on one or more schematic pins via sch_PrimitivePin.modify.', inputSchema: objectSchema({ primitiveIds: { type: 'array', items: { type: 'string' } }, noConnected: { type: 'boolean' } }, ['primitiveIds']) },
  { name: 'eda_draw_wire', description: 'Draw a schematic wire (polyline). Coordinates are MCP units (0.01 inch). IMPORTANT: the net argument only sticks on a floating wire — as soon as an endpoint touches a pin, EDA recomputes the net from connectivity and the name you passed is overwritten (measured: TESTNET merged into LED_A). To join same-named nets across regions use eda_place_net_port or a net label; do not rely on two distantly drawn wires sharing a name.', inputSchema: objectSchema({ points: { type: 'array', items: { type: 'number' } }, net: { type: 'string' }, color: { type: 'string' }, lineWidth: { type: 'integer', minimum: 1, maximum: 10 }, lineType: { type: 'integer', enum: [0, 1, 2, 3] } }, ['points']) },
  { name: 'eda_draw_rectangle', description: 'Draw a rectangle. topLeftY is the UPPER y coordinate (max y); height extends downward. Coordinates are MCP units.', inputSchema: objectSchema({ topLeftX: { type: 'number' }, topLeftY: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, cornerRadius: { type: 'number' }, rotation: { type: 'integer', enum: [0, 90, 180, 270] }, color: { type: 'string' }, fillColor: { type: 'string' }, lineWidth: { type: 'integer', minimum: 1, maximum: 10 }, lineType: { type: 'integer', enum: [0, 1, 2, 3] }, fillStyle: { type: 'string' } }, ['topLeftX', 'topLeftY', 'width', 'height']) },
  { name: 'eda_draw_functional_box', description: 'Draw a dashed functional-group box around one group of components, with an optional label. Margins and coordinates are MCP units; default margin 1 unit (about 0.254 mm).', inputSchema: objectSchema({ componentIds: { type: 'array', items: { type: 'string' } }, label: { type: 'string' }, margin: { type: 'number' }, color: { type: 'string' }, lineWidth: { type: 'integer', minimum: 1, maximum: 10 }, lineType: { type: 'integer', enum: [0, 1, 2, 3] } }) },
  { name: 'eda_draw_circle', description: 'Draw a circle. Coordinates are MCP units.', inputSchema: objectSchema({ centerX: { type: 'number' }, centerY: { type: 'number' }, radius: { type: 'number' }, color: { type: 'string' }, fillColor: { type: 'string' }, lineWidth: { type: 'integer', minimum: 1, maximum: 10 }, lineType: { type: 'integer', enum: [0, 1, 2, 3] }, fillStyle: { type: 'string' } }, ['centerX', 'centerY', 'radius']) },
  { name: 'eda_draw_text', description: 'Draw text. Coordinates are MCP units.', inputSchema: objectSchema({ x: { type: 'number' }, y: { type: 'number' }, content: { type: 'string' }, rotation: { type: 'integer', enum: [0, 90, 180, 270] }, textColor: { type: 'string' }, fontName: { type: 'string' }, fontSize: { type: 'number' }, bold: { type: 'boolean' }, italic: { type: 'boolean' }, underLine: { type: 'boolean' }, alignMode: { type: 'integer', minimum: 1, maximum: 9 } }, ['x', 'y', 'content']) },
  { name: 'eda_save_document', description: 'Save the active schematic document.', inputSchema: objectSchema({}) },
  { name: 'eda_zoom_to_fit', description: 'Zoom to fit all primitives in the active document.', inputSchema: objectSchema({ tabId: { type: 'string' } }) },
  { name: 'eda_zoom_to_region', description: 'Zoom to a region. Schematic coordinates are MCP units.', inputSchema: objectSchema({ left: { type: 'number' }, right: { type: 'number' }, top: { type: 'number' }, bottom: { type: 'number' }, tabId: { type: 'string' } }, ['left', 'right', 'top', 'bottom']) },
  { name: 'eda_get_components', description: 'List components on the active schematic page (or all pages). Returns designator, value, x, y, rotation and bounding box when available.', inputSchema: objectSchema({ allSchematicPages: { type: 'boolean' }, includeBounds: { type: 'boolean' } }) },
  { name: 'eda_get_wires', description: 'List wires on the active schematic page.', inputSchema: objectSchema({}) },
  { name: 'eda_get_nets', description: 'List nets of the current schematic project. Uses sch_Net.* first; when the schematic is not the active document those APIs return [] and this tool falls back to parsing sch_Netlist.getNetlist, reporting which source was used.', inputSchema: objectSchema({ name: { type: 'string' }, parseNetlist: { type: 'boolean' } }) },
  { name: 'eda_get_active_document', description: 'Return the document/tab that is currently active (documentType, uuid, tabId, parent project). Most tab-dependent APIs (sch_Net.*, netlist export, DRC) only work when the matching document is active - use eda_open_document to switch.', inputSchema: objectSchema({}) },
  { name: 'eda_open_document', description: 'Open/activate a document tab by uuid (dmt_EditorControl.openDocument). Works for a schematic page or a PCB, so tab-dependent APIs can run.', inputSchema: objectSchema({ documentUuid: { type: 'string' }, splitScreenId: { type: 'string' } }, ['documentUuid']) },
  { name: 'eda_get_net_labels', description: 'List every label-like primitive on the active schematic page: attribute primitives (netlabel/netport/netflag) PLUS plain texts left by the createNetLabel fallback, so they can be audited and deleted. Reports kind/primitiveId/net per entry.', inputSchema: objectSchema({ parentPrimitiveId: { type: 'string' } }) },
  { name: 'eda_place_net_label', description: 'Place a net label at x/y. The real API (sch_PrimitiveAttribute.createNetLabel) is probed once per session; when the build never answers, a plain TEXT label is placed instead, which carries no electrical meaning and must be paired with a stub wire. Pass probe:true to re-check.', inputSchema: objectSchema({ x: { type: 'number' }, y: { type: 'number' }, net: { type: 'string' }, fontSize: { type: 'number' }, rotation: { type: 'integer', enum: [0, 90, 180, 270] }, probe: { type: 'boolean' }, textLabel: { type: 'boolean' } }, ['x', 'y', 'net']) },
  { name: 'eda_place_net_labels', description: 'Place many net labels in ONE call (per-pin or by coordinate) and report done/failed per item: a 133-label schematic used to exceed the caller timeout with no progress. items: [{ pinPrimitiveId, net, stubLength?, offsetX?, offsetY? }] or [{ x, y, net, fontSize? }].', inputSchema: objectSchema({ items: { type: 'array', items: { type: 'object', additionalProperties: true } }, probe: { type: 'boolean' }, textLabel: { type: 'boolean' }, concurrency: { type: 'integer', minimum: 1, maximum: 8 } }, ['items']) },
  { name: 'eda_run_drc', description: 'Run schematic DRC with includeVerboseError. On EDA 3.2.186 the app still returns AGGREGATED entries ({type:"warn",count:N}) with no primitiveId/coordinates, so entries are reported as-is and raw keeps the untouched payload; expect counts plus a hint until the app exposes details.', inputSchema: objectSchema({ strict: { type: 'boolean' } }) },
  { name: 'eda_auto_layout', description: 'Run schematic auto-layout (sch_Document.autoLayout). DISABLED by default: automated layout is not used unless the user asks for it. Pass force:true only then.', inputSchema: objectSchema({ uuids: { type: 'array', items: { type: 'string' } }, force: { type: 'boolean' } }) },
  { name: 'eda_auto_route', description: 'Run schematic auto-routing (sch_Document.autoRouting). DISABLED by default: route by hand unless the user explicitly asks. Pass force:true only then.', inputSchema: objectSchema({ uuids: { type: 'array', items: { type: 'string' } }, force: { type: 'boolean' } }) },
  { name: 'eda_export_netlist', description: 'Export the schematic netlist as text (default JLCEDA format). Returns null when no schematic is active - check eda_get_active_document / open the schematic page first.', inputSchema: objectSchema({ type: { type: 'string' } }) },
  { name: 'eda_export_bom', description: 'Export the schematic BOM. csv is decoded from UTF-16 to readable text; xlsx returns a base64 data URL.', inputSchema: objectSchema({ format: { type: 'string', enum: ['csv', 'xlsx'] } }) },
  { name: 'eda_move_component', description: 'Move/rotate/mirror a schematic component (sch_PrimitiveComponent.modify) without deleting and re-placing it, so the designator and value survive.', inputSchema: objectSchema({ primitiveId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, rotation: { type: 'number' }, mirror: { type: 'boolean' } }, ['primitiveId']) },
  { name: 'pcb_draw_text', description: 'Put text on a PCB layer - silkscreen by default (3 top silk / 4 bottom silk). Use it for pin functions, board markings, version and fabrication notes; silkscreen text must not cover pads.', inputSchema: objectSchema({ x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' }, layer: { type: 'string' }, fontSize: { type: 'number' }, lineWidth: { type: 'number' }, rotation: { type: 'number' }, mirror: { type: 'boolean' }, alignMode: { type: 'integer' }, locked: { type: 'boolean' } }, ['x', 'y', 'text']) },
  { name: 'pcb_draw_mounting_hole', description: 'Place a NON-plated mounting hole or a slot (pcb_PrimitivePad with metallization:false). shape "round" is a drill-sized hole, shape "slot" an oval cut-out. Use this for mounting holes and connector slots instead of hacking the board outline.', inputSchema: objectSchema({ x: { type: 'number' }, y: { type: 'number' }, diameter: { type: 'number' }, shape: { type: 'string', enum: ['round', 'slot'] }, slotLength: { type: 'number' }, rotation: { type: 'number' }, plated: { type: 'boolean' }, layer: { type: 'string' } }, ['x', 'y', 'diameter']) },
  { name: 'eda_capture', description: 'Render the active document to a PNG (dmt_EditorControl.getCurrentRenderedAreaImage) and write it to outPath or return a data URL. Use it to LOOK at the sheet/board instead of trusting coordinate math; read the file back with the image reader.', inputSchema: objectSchema({ outPath: { type: 'string' }, inline: { type: 'boolean' } }) },
  { name: 'eda_workflow_guide', description: 'Return the schematic working standard: grid-aligned manual placement, signal flow, when net labels/ports are required (a wire net name is overridden by connectivity), net-label fallback behaviour, batch placement and the verification order. Read it before laying out a sheet.', inputSchema: objectSchema({}) },
  { name: 'eda_list_api_methods', description: 'Ask the CONNECTED EXTENSION for the API methods it accepts right now (dsh.internal.listApiMethods) and report source/version/counts. Falls back to the bridge copy with stale:true only when the extension is an older zip. Use refresh:true to re-query.', inputSchema: objectSchema({ refresh: { type: 'boolean' } }) },
  { name: 'eda_delete_primitive', description: 'Delete a schematic primitive by kind and primitive id. Net ports, net flags and net labels are attribute primitives and need kind "netport"/"netflag"/"netlabel"; the text fallback labels are kind "text".', inputSchema: objectSchema({ kind: { type: 'string', enum: ['component', 'wire', 'rectangle', 'circle', 'arc', 'polygon', 'text', 'netport', 'netflag', 'netlabel'] }, primitiveId: { type: 'string' } }, ['kind', 'primitiveId']) },
  { name: 'eda_create_board', description: 'Create a board linking a schematic and a PCB (dmt_Board.createBoard).', inputSchema: objectSchema({ schematicUuid: { type: 'string' }, pcbUuid: { type: 'string' } }) },
  { name: 'eda_api_call', description: 'Call an allow-listed JLCEDA Pro extension API method directly.', inputSchema: objectSchema({ method: { type: 'string' }, args: { type: 'array' } }, ['method', 'args']) },
  { name: 'pcb_get_components', description: 'List PCB components (mil). includePins=true also reads pcb_PrimitiveComponent.getAllPinsByPrimitiveId per component, which is the accurate pad/net source; the fast summary pad list can be stale.', inputSchema: objectSchema({ layer: { type: ['string', 'integer'] }, locked: { type: 'boolean' }, includeBounds: { type: 'boolean' }, includePins: { type: 'boolean' } }) },
  { name: 'pcb_get_nets', description: 'List PCB nets. Set detail=true for full net info.', inputSchema: objectSchema({ detail: { type: 'boolean' }, name: { type: 'string' } }) },
  { name: 'pcb_get_layers', description: 'List PCB layers.', inputSchema: objectSchema({}) },
  { name: 'pcb_place_component', description: 'Place a PCB component/footprint. Coordinates are mil.', inputSchema: objectSchema({ libraryUuid: { type: 'string' }, uuid: { type: 'string' }, layer: { type: ['string', 'integer'] }, x: { type: 'number' }, y: { type: 'number' }, rotation: { type: 'number' } }, ['libraryUuid', 'uuid', 'layer', 'x', 'y']) },
  { name: 'pcb_draw_track', description: 'Draw a PCB track segment. Coordinates are mil. lineWidth defaults to the role-based rule value (signal 6 mil / power 16 mil / GND 16 mil) and is rejected below the 6 mil (0.15 mm) design minimum unless force=true.', inputSchema: objectSchema({ net: { type: 'string' }, layer: { type: ['string', 'integer'] }, startX: { type: 'number' }, startY: { type: 'number' }, endX: { type: 'number' }, endY: { type: 'number' }, lineWidth: { type: 'number' }, force: { type: 'boolean' } }, ['net', 'layer', 'startX', 'startY', 'endX', 'endY']) },
  { name: 'pcb_draw_via', description: 'Place a PCB via. Coordinates and sizes are mil. holeDiameter/diameter default to a standard drill pair (0.2/0.4 mm signal, 0.3/0.6 mm power); the annular ring must be >= 0.2 mm and the hole >= 0.2 mm, and a hole below 0.3 mm (free-prototyping bound) is reported as a warning.', inputSchema: objectSchema({ net: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, holeDiameter: { type: 'number' }, diameter: { type: 'number' }, viaType: { type: 'integer', enum: [0, 1, 2] }, force: { type: 'boolean' } }, ['net', 'x', 'y']) },
  { name: 'pcb_draw_board_outline', description: 'Create a closed board outline on the BoardOutline layer (layer 11) from a flat [x1,y1,x2,y2,...] point list in mil. Implemented as ONE pcb_PrimitivePolyline built from a pcb_MathPolygon polygon - the primitive JLCEDA itself stores for a board outline. pcb_PrimitiveLine cannot create it (that API is a copper track and rejects layer 11).', inputSchema: objectSchema({ points: { type: 'array', items: { type: 'number' } }, lineWidth: { type: 'number' }, net: { type: 'string' }, locked: { type: 'boolean' } }, ['points']) },
  { name: 'pcb_draw_polyline', description: 'Create a closed polyline (pcb_PrimitivePolyline) on any line layer: board outline 11, silkscreen 3/4, assembly 9/10, mechanical 14, document 13, copper 1/2. points is a flat [x1,y1,x2,y2,...] array in mil and is closed automatically.', inputSchema: objectSchema({ points: { type: 'array', items: { type: 'number' } }, layer: { type: ['string', 'integer'] }, net: { type: 'string' }, lineWidth: { type: 'number' }, locked: { type: 'boolean' } }, ['points', 'layer']) },
  { name: 'pcb_save_document', description: 'Save the active PCB document.', inputSchema: objectSchema({}) },
  { name: 'pcb_import_changes', description: 'Import schematic changes into the active PCB (pcb_Document.importChanges). DEFAULT IS ASYNCHRONOUS because the call opens EDA own sync-confirmation dialog and blocks until the user answers it: the import runs as a background job, the tool returns immediately with componentsBefore, and the answer is detected by eda_pcb_wait_for_components. wait=true blocks instead (only when no dialog appears).', inputSchema: objectSchema({ schematicUuid: { type: 'string' }, wait: { type: 'boolean' }, timeoutMs: { type: 'integer' } }) },
  { name: 'eda_pcb_wait_for_components', description: 'Low-frequency poll (default every 5 s, minimum 3 s) that treats "new PCB components appeared" as "the user clicked OK in the schematic-sync confirmation dialog". Returns confirmed/waitedMs/newComponentIds, or confirmed=false after maxWaitMs (default 45 s) so the caller can ask the user and call again.', inputSchema: objectSchema({ pollIntervalMs: { type: 'integer', minimum: 3000 }, maxWaitMs: { type: 'integer' }, baseline: { type: 'array', items: { type: 'string' } } }) },
  { name: 'pcb_get_primitives_in_region', description: 'List PCB primitives inside a region. Coordinates are mil.', inputSchema: objectSchema({ left: { type: 'number' }, right: { type: 'number' }, top: { type: 'number' }, bottom: { type: 'number' }, leftToRight: { type: 'boolean' } }, ['left', 'right', 'top', 'bottom']) },
  { name: 'pcb_navigate_to_region', description: 'Navigate the PCB canvas to a region. Coordinates are mil.', inputSchema: objectSchema({ left: { type: 'number' }, right: { type: 'number' }, top: { type: 'number' }, bottom: { type: 'number' } }, ['left', 'right', 'top', 'bottom']) },
  // ---- eda_pcb_* aliases and new PCB tools ----
  { name: 'eda_pcb_get_components', description: 'Alias of pcb_get_components. List PCB components (mil).', inputSchema: objectSchema({ layer: { type: ['string', 'integer'] }, locked: { type: 'boolean' }, includeBounds: { type: 'boolean' } }) },
  { name: 'eda_pcb_get_nets', description: 'Alias of pcb_get_nets.', inputSchema: objectSchema({ detail: { type: 'boolean' }, name: { type: 'string' } }) },
  { name: 'eda_pcb_get_layers', description: 'Alias of pcb_get_layers.', inputSchema: objectSchema({}) },
  { name: 'eda_pcb_place_component', description: 'Alias of pcb_place_component.', inputSchema: objectSchema({ libraryUuid: { type: 'string' }, uuid: { type: 'string' }, layer: { type: ['string', 'integer'] }, x: { type: 'number' }, y: { type: 'number' }, rotation: { type: 'number' } }, ['libraryUuid', 'uuid', 'layer', 'x', 'y']) },
  { name: 'eda_pcb_move_component', description: 'Move/rotate/modify an existing PCB component (pcb_PrimitiveComponent.modify). Coordinates are mil.', inputSchema: objectSchema({ primitiveId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, rotation: { type: 'number' }, layer: { type: ['string', 'integer'] }, locked: { type: 'boolean' }, designator: { type: 'string' }, name: { type: 'string' } }, ['primitiveId']) },
  { name: 'eda_pcb_delete_component', description: 'Delete a PCB component (pcb_PrimitiveComponent.delete).', inputSchema: objectSchema({ primitiveId: { type: 'string' } }, ['primitiveId']) },
  { name: 'eda_pcb_draw_track', description: 'Alias of pcb_draw_track.', inputSchema: objectSchema({ net: { type: 'string' }, layer: { type: ['string', 'integer'] }, startX: { type: 'number' }, startY: { type: 'number' }, endX: { type: 'number' }, endY: { type: 'number' }, lineWidth: { type: 'number' } }, ['net', 'layer', 'startX', 'startY', 'endX', 'endY']) },
  { name: 'eda_pcb_get_tracks', description: 'List PCB tracks (pcb_PrimitiveLine.getAll). Optional net/layer/locked filters.', inputSchema: objectSchema({ net: { type: 'string' }, layer: { type: ['string', 'integer'] }, locked: { type: 'boolean' } }) },
  { name: 'eda_pcb_modify_track', description: 'Modify a PCB track (pcb_PrimitiveLine.modify). Coordinates are mil.', inputSchema: objectSchema({ primitiveId: { type: 'string' }, net: { type: 'string' }, layer: { type: ['string', 'integer'] }, startX: { type: 'number' }, startY: { type: 'number' }, endX: { type: 'number' }, endY: { type: 'number' }, lineWidth: { type: 'number' }, locked: { type: 'boolean' } }, ['primitiveId']) },
  { name: 'eda_pcb_delete_track', description: 'Delete a PCB track (pcb_PrimitiveLine.delete).', inputSchema: objectSchema({ primitiveId: { type: 'string' } }, ['primitiveId']) },
  { name: 'eda_pcb_draw_via', description: 'Alias of pcb_draw_via.', inputSchema: objectSchema({ net: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, holeDiameter: { type: 'number' }, diameter: { type: 'number' }, viaType: { type: 'integer', enum: [0, 1, 2] } }, ['net', 'x', 'y', 'holeDiameter', 'diameter']) },
  { name: 'eda_pcb_get_vias', description: 'List PCB vias (pcb_PrimitiveVia.getAll). Optional net/locked filters.', inputSchema: objectSchema({ net: { type: 'string' }, locked: { type: 'boolean' } }) },
  { name: 'eda_pcb_delete_via', description: 'Delete a PCB via (pcb_PrimitiveVia.delete).', inputSchema: objectSchema({ primitiveId: { type: 'string' } }, ['primitiveId']) },
  { name: 'eda_pcb_create_region', description: 'Create a PCB region (pcb_PrimitiveRegion.create). points is a flat [x1,y1,x2,y2,...] array in mil and is closed automatically. Allowed layers are copper only: top(1), bottom(2), inner(15-44) and multi(12) - the official API type is TPCB_LayersOfRegion = copper | MULTI, so the board-outline layer (11) is rejected. ruleType uses EPCB_PrimitiveRegionRuleType: 2 noComponents, 5 noWires, 6 noFills, 7 noPours, 8 noInnerElectricalLayers, 9 followRegionRule.', inputSchema: objectSchema({ layer: { type: ['string', 'integer'] }, points: { type: 'array', items: { type: 'number' } }, ruleType: { type: 'array', items: { type: 'integer' } }, regionName: { type: 'string' }, lineWidth: { type: 'number' }, locked: { type: 'boolean' } }, ['layer', 'points']) },
  { name: 'eda_pcb_draw_board_outline', description: 'Alias-style name for pcb_draw_board_outline: draws a closed board outline as line segments on layer 11 (mil).', inputSchema: objectSchema({ points: { type: 'array', items: { type: 'number' } }, lineWidth: { type: 'number' } }, ['points']) },
  { name: 'eda_pcb_get_polylines', description: 'List PCB polylines (pcb_PrimitivePolyline.getAll) - board outline, silkscreen shapes, mechanical drawings. Optional net/layer/locked filters.', inputSchema: objectSchema({ net: { type: 'string' }, layer: { type: ['string', 'integer'] }, locked: { type: 'boolean' } }) },
  { name: 'eda_pcb_delete_polyline', description: 'Delete a PCB polyline (pcb_PrimitivePolyline.delete).', inputSchema: objectSchema({ primitiveId: { type: 'string' } }, ['primitiveId']) },
  { name: 'eda_pcb_clear_routing', description: 'Clear PCB routing. DEFAULT IS A BACKGROUND JOB (pcb_Document.clearRouting): clearing a whole board easily exceeds the MCP timeout while EDA keeps working, so the tool returns immediately and you poll eda_pcb_job_status until running=false. With an older EDA extension it automatically degrades to bounded batches (see batchSize) that you repeat until done=true. type: all | net | connection (net/connection act on the current selection). mode=batched forces the batched path; net/layer filter it.', inputSchema: objectSchema({ type: { type: 'string', enum: ['all', 'net', 'connection'] }, wait: { type: 'boolean' }, mode: { type: 'string', enum: ['native', 'batched'] }, net: { type: 'string' }, layer: { type: ['string', 'integer'] }, batchSize: { type: 'integer', minimum: 1, maximum: 2000 }, timeoutMs: { type: 'integer' } }) },
  { name: 'eda_pcb_create_pour', description: 'Create a copper pour (覆铜, pcb_MathPolygon.createPolygon + pcb_PrimitivePour.create). points is a flat [x1,y1,x2,y2,...] array in mil, closed automatically. layer must be a copper layer (top 1 / bottom 2 / inner 15-44). pourFillMethod: 45grid | 90grid | solid.', inputSchema: objectSchema({ net: { type: 'string' }, layer: { type: ['string', 'integer'] }, points: { type: 'array', items: { type: 'number' } }, pourFillMethod: { type: 'string', enum: ['45grid', '90grid', 'solid'] }, preserveSilos: { type: 'boolean' }, pourName: { type: 'string' }, pourPriority: { type: 'integer' }, lineWidth: { type: 'number' }, locked: { type: 'boolean' } }, ['net', 'layer', 'points']) },
  { name: 'eda_pcb_get_pours', description: 'List PCB copper pours (pcb_PrimitivePour.getAll). Optional net/layer/locked filters.', inputSchema: objectSchema({ net: { type: 'string' }, layer: { type: ['string', 'integer'] }, locked: { type: 'boolean' } }) },
  { name: 'eda_pcb_delete_pour', description: 'Delete a copper pour (pcb_PrimitivePour.delete).', inputSchema: objectSchema({ primitiveId: { type: 'string' } }, ['primitiveId']) },
  { name: 'eda_pcb_run_drc', description: 'Run PCB DRC (pcb_Drc.check). includeVerboseError=true returns the verbose error array (strict=true also reports warnings). Set userInterface=true only if the user should see the DRC panel.', inputSchema: objectSchema({ strict: { type: 'boolean' }, userInterface: { type: 'boolean' }, includeVerboseError: { type: 'boolean' } }) },
  { name: 'eda_pcb_get_drc_rules', description: 'Return the current PCB DRC rule configuration name and content.', inputSchema: objectSchema({}) },
  { name: 'eda_pcb_set_net_track_width', description: 'Set the track width of every existing track of one net (iterates pcb_PrimitiveLine.getAll + pcb_PrimitiveLine.modify). Use it to thicken power/GND nets after auto-routing.', inputSchema: objectSchema({ net: { type: 'string' }, lineWidth: { type: 'number' }, layer: { type: ['string', 'integer'] } }, ['net', 'lineWidth']) },
  { name: 'eda_design_audit', description: 'Read-only audit of the active PCB against docs/design-rules.md: per-net track widths (min 6 mil, role suggestions), via drill/annular ring, net-name legality, board outline, copper pour, and PCB DRC. Returns violations, warnings, a checklist, the per-net minimum widths, and the rule values used. drc=false skips the DRC run.', inputSchema: objectSchema({ net: { type: 'string' }, drc: { type: 'boolean' } }) },
  { name: 'eda_pcb_get_regions', description: 'List PCB regions (pcb_PrimitiveRegion.getAll). layer must be a copper layer (top 1 / bottom 2 / inner 15-44) or MULTI 12.', inputSchema: objectSchema({ layer: { type: ['string', 'integer'] }, ruleType: { type: 'array', items: { type: 'integer' } }, locked: { type: 'boolean' } }) },
  { name: 'eda_pcb_delete_region', description: 'Delete a PCB region (pcb_PrimitiveRegion.delete).', inputSchema: objectSchema({ primitiveId: { type: 'string' } }, ['primitiveId']) },
  { name: 'eda_pcb_auto_place', description: 'Run PCB auto-layout (pcb_Document.autoLayout). Blocking by default (layout is fast); pass wait=false to start it as a background job and poll eda_pcb_job_status.', inputSchema: objectSchema({ wait: { type: 'boolean' }, timeoutMs: { type: 'integer' } }) },
  { name: 'eda_pcb_job_status', description: 'Poll the background PCB job started by eda_pcb_auto_route (or eda_pcb_auto_place with wait=false): running, elapsedMs, result, error. EDA keeps its own progress bar while running.', inputSchema: objectSchema({}) },
  { name: 'eda_pcb_auto_route', description: 'Start PCB auto-routing (pcb_Document.autoRouting). DEFAULT IS ASYNCHRONOUS: the call returns as soon as EDA starts routing (EDA shows its own progress bar) and you poll eda_pcb_job_status until running=false - a long routing job must NOT be awaited, otherwise the MCP call times out while EDA keeps working. Without nets/RoutingNets the bridge enumerates every net, because this EDA build fails every net (success=false, duration=0) when routingRange is empty. wait=true blocks until done (only for small jobs). cornerStyle: 0=45deg, 1=90deg; optimization: 1=completion, 0=faster; existingPrimitiveMode: keep|remove.', inputSchema: objectSchema({ nets: { type: 'array', items: { type: 'string' } }, RoutingNets: { type: ['array', 'string'] }, ignoreNets: { type: 'array', items: { type: 'string' } }, layers: { type: 'array', items: { type: 'integer' } }, cornerStyle: { type: 'integer', enum: [0, 1] }, optimization: { type: 'integer', enum: [0, 1] }, existingPrimitiveMode: { type: 'string', enum: ['keep', 'remove'] }, wait: { type: 'boolean' }, timeoutMs: { type: 'integer' }, props: { type: 'object' } }) },
  { name: 'eda_pcb_export_gerber', description: 'Export PCB Gerber (pcb_ManufactureData.getGerberFile). Returns { name, size, dataUrl } - the zip is base64 encoded, so large boards can produce a big payload.', inputSchema: objectSchema({ fileName: { type: 'string' }, colorSilkscreen: { type: 'boolean' }, unit: { type: 'string', enum: ['mm', 'inch'] }, integerNumber: { type: 'integer' }, decimalNumber: { type: 'integer' }, other: { type: 'object' }, layers: { type: 'array' }, objects: { type: 'array' } }) },
  { name: 'eda_pcb_save_document', description: 'Alias of pcb_save_document.', inputSchema: objectSchema({}) },
  { name: 'eda_pcb_import_changes', description: 'Alias of pcb_import_changes.', inputSchema: objectSchema({ schematicUuid: { type: 'string' } }) },
  { name: 'eda_pcb_get_primitives_in_region', description: 'Alias of pcb_get_primitives_in_region.', inputSchema: objectSchema({ left: { type: 'number' }, right: { type: 'number' }, top: { type: 'number' }, bottom: { type: 'number' }, leftToRight: { type: 'boolean' } }, ['left', 'right', 'top', 'bottom']) },
  { name: 'eda_pcb_navigate_to_region', description: 'Alias of pcb_navigate_to_region.', inputSchema: objectSchema({ left: { type: 'number' }, right: { type: 'number' }, top: { type: 'number' }, bottom: { type: 'number' } }, ['left', 'right', 'top', 'bottom']) },
]

function toolResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true }
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function parseFrame(buffer) {
  if (buffer.length < 2) return undefined
  const fin = (buffer[0] & 0x80) !== 0
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < offset + 2) return undefined
    length = buffer.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    if (buffer.length < offset + 8) return undefined
    const big = buffer.readBigUInt64BE(offset)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('websocket frame too large')
    length = Number(big)
    offset += 8
  }
  let maskKey
  if (masked) {
    if (buffer.length < offset + 4) return undefined
    maskKey = buffer.subarray(offset, offset + 4)
    offset += 4
  }
  if (buffer.length < offset + length) return undefined
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (maskKey !== undefined) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]
  }
  return { fin, opcode, payload, consumed: offset + length }
}

function encodeFrame(opcode, payload, fin = true) {
  const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10)
  header[0] = (fin ? 0x80 : 0) | opcode
  if (payload.length < 126) header[1] = payload.length
  else if (payload.length < 65536) { header[1] = 126; header.writeUInt16BE(payload.length, 2) }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2) }
  return Buffer.concat([header, payload])
}

class WsConnection {
  constructor(socket) {
    this.socket = socket
    this.ready = false
    this.buffer = Buffer.alloc(0)
    this.fragments = []
  }
  sendText(text) {
    if (this.socket.destroyed) return
    this.socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8')))
  }
  sendControl(opcode, payload) {
    if (this.socket.destroyed) return
    this.socket.write(encodeFrame(opcode, payload))
  }
  close() {
    try { this.sendControl(0x8, Buffer.alloc(0)) } catch { /* ignore */ }
    this.socket.destroy()
  }
  handleData(chunk) {
    // Liveness: a page that navigates away leaves a half-open socket that still
    // looks ready, so every timestamp counts, not just pongs.
    this.lastSeenAt = Date.now()
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const frame = parseFrame(this.buffer)
      if (frame === undefined) return
      this.buffer = this.buffer.subarray(frame.consumed)
      this.handleFrame(frame)
    }
  }
  handleFrame(frame) {
    if (frame.opcode === 0x8) { this.close(); return }
    if (frame.opcode === 0x9) { this.sendControl(0xa, frame.payload); return }
    if (frame.opcode === 0xa) return
    if (frame.opcode === 0x0 || frame.opcode === 0x1 || frame.opcode === 0x2) {
      this.fragments.push(frame.payload)
      if (!frame.fin) return
      const payload = Buffer.concat(this.fragments)
      this.fragments = []
      if (frame.opcode === 0x1 || frame.opcode === 0x0) this.emitText(payload.toString('utf8'))
    }
  }
  emitText(text) {
    let message
    try { message = JSON.parse(text) } catch { return }
    if (message === null || typeof message !== 'object') return
    if (message.type === 'hello') {
      this.ready = true
      if (typeof message.version === 'string') this.extensionVersion = message.version
      return
    }
    if (message.type === 'ping') { this.sendText(JSON.stringify({ type: 'pong' })); return }
    if (typeof message.id === 'number' && typeof message.ok === 'boolean') {
      const pending = pendingCalls.get(message.id)
      if (pending === undefined) return
      pendingCalls.delete(message.id)
      clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error(message.error && message.error.message ? message.error.message : 'JLCEDA bridge call failed'))
    }
  }
}

const clients = new Set()
const pendingCalls = new Map()
// Baseline for the schematic -> PCB sync confirmation flow: the import triggers
// EDA's own confirmation dialog, so "did the user confirm?" is answered by
// watching whether new PCB components appear (low-frequency polling).
let pcbComponentBaseline = null
// Net-label capability, probed once per session (null = unknown), plus the plain
// texts placed while the real net-label API was unavailable: without this registry
// those labels could not be listed or cleaned up.
let netLabelSupport = null
const placedTextLabels = []

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function pcbComponentIds(timeoutMs) {
  const raw = await callExtension('pcb_PrimitiveComponent.getAllPrimitiveId', [], timeoutMs)
  return Array.isArray(raw) ? raw.map(String) : []
}
let nextCallId = 1

/**
 * The extension's own allow-list, cached per connected extension version.
 *
 * The bridge holds a copy (ALLOWED_API) for documentation and offline hints, but
 * that copy drifts: gating eda_api_call on it rejected methods the extension
 * actually accepts (dmt_Project.* among them) and eda_list_api_methods then
 * reported the wrong capability boundary. Ask the extension instead.
 */
let extensionApiCache = null

async function extensionApiMethods(timeoutMs, refresh = false) {
  if (!refresh && extensionApiCache !== null) return extensionApiCache
  try {
    const raw = await callExtension('dsh.internal.listApiMethods', [], Math.min(timeoutMs, 5000))
    const record = asRecord(raw)
    const allowed = Array.isArray(record.allowed) ? record.allowed.map(String) : []
    const files = Array.isArray(record.files) ? record.files.map(String) : []
    if (allowed.length === 0 && files.length === 0) return undefined
    extensionApiCache = {
      version: typeof record.version === 'string' ? record.version : null,
      allowed,
      files,
      all: [...allowed, ...files].sort(),
      allowedSet: new Set(allowed),
      fileSet: new Set(files),
    }
    return extensionApiCache
  } catch {
    // Older extension without the helper: fall back to the local copy, flagged.
    return undefined
  }
}

/** A socket that has been silent this long is treated as dead even if it never closed. */
const CLIENT_STALE_MS = 60000

/** Ready clients, freshest first. Stale sockets are used only as a last resort. */
function pickClients() {
  const now = Date.now()
  const ready = [...clients].filter(client => client.ready)
  const fresh = ready.filter(client => now - (client.lastSeenAt ?? 0) < CLIENT_STALE_MS)
  const pool = fresh.length > 0 ? fresh : ready
  return pool.sort((left, right) => (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0))
}

/** Read-only calls may be repeated on another page; a write must never be. */
function isIdempotentRead(method) {
  const fn = method.slice(method.lastIndexOf('.') + 1).toLowerCase()
  return fn.startsWith('get') || fn.startsWith('is') || fn.startsWith('has') || fn.startsWith('list') || fn.startsWith('search')
}

function sendToClient(client, method, args, timeoutMs) {
  const id = nextCallId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(id)
      reject(new Error('JLCEDA bridge call timed out after ' + timeoutMs + 'ms: ' + method))
    }, timeoutMs)
    pendingCalls.set(id, { resolve, reject, timer })
    client.sendText(JSON.stringify({ id, method, args }))
  })
}

async function callExtension(method, args, timeoutMs) {
  const pool = pickClients()
  if (pool.length === 0) {
    throw new Error('JLCEDA bridge extension is not connected. Open JLCEDA Pro, import dsh-eda-bridge-extension-' + VERSION + '.zip, enable "Allow interactive with external", and keep a schematic or PCB page open.')
  }
  const deadline = Date.now() + timeoutMs
  let lastError
  for (const client of pool) {
    const remaining = deadline - Date.now()
    if (remaining <= 100) break
    try {
      return await sendToClient(client, method, args, remaining)
    } catch (error) {
      lastError = error
      // A different error means the page answered; retrying would only repeat it.
      if (!isIdempotentRead(method) || !/timed out/.test(String((error as Error)?.message))) throw error
    }
  }
  throw lastError ?? new Error('JLCEDA bridge call timed out after ' + timeoutMs + 'ms: ' + method)
}

function asRecord(value) {
  if (value === null || typeof value !== 'object') return {}
  return value
}

function flattenPoints(points) {
  const flat = []
  if (!Array.isArray(points)) return flat
  for (const item of points) {
    if (Array.isArray(item)) flat.push(...item.map(Number))
    else flat.push(Number(item))
  }
  return flat
}

function primitiveKindToClass(kind) {
  switch (kind) {
    case 'component': return 'sch_PrimitiveComponent'
    case 'wire': return 'sch_PrimitiveWire'
    case 'rectangle': return 'sch_PrimitiveRectangle'
    case 'circle': return 'sch_PrimitiveCircle'
    case 'arc': return 'sch_PrimitiveArc'
    case 'polygon': return 'sch_PrimitivePolygon'
    case 'text': return 'sch_PrimitiveText'
    default: throw new Error('unknown primitive kind: ' + kind)
  }
}

function pickValue(raw, ...keys) {
  for (const key of keys) {
    if (raw && raw[key] !== undefined && raw[key] !== null) return raw[key]
  }
  return undefined
}

function summarizePrimitive(raw) {
  if (raw === null || typeof raw !== 'object') return { value: raw }
  const summary = {}
  const primitiveId = pickValue(raw, 'PrimitiveId', 'primitiveId', '$id')
  const primitiveType = pickValue(raw, 'PrimitiveType', 'primitiveType')
  const x = pickValue(raw, 'X', 'x', 'CenterX', 'centerX', 'StartX', 'startX')
  const y = pickValue(raw, 'Y', 'y', 'CenterY', 'centerY', 'StartY', 'startY')
  const rotation = pickValue(raw, 'Rotation', 'rotation')
  if (primitiveId !== undefined) summary.primitiveId = primitiveId
  if (primitiveType !== undefined) summary.primitiveType = primitiveType
  if (x !== undefined) summary.x = x
  if (y !== undefined) summary.y = y
  if (rotation !== undefined) summary.rotation = rotation
  for (const key of ['Designator', 'Name', 'Content', 'Net', 'ComponentType', 'Layer', 'LayerId']) {
    const value = raw[key]
    if (value !== undefined) summary[key.charAt(0).toLowerCase() + key.slice(1)] = value
  }
  const other = raw.OtherProperty ?? raw.otherProperty
  if (other !== undefined) summary.otherProperty = other
  const value = (other && (other.Value ?? other.value)) ?? raw.Value
  if (value !== undefined) summary.value = value
  return summary
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function extractPrimitiveId(result) {
  if (result === null || typeof result !== 'object') return undefined
  return pickValue(result, 'PrimitiveId', 'primitiveId')
}

async function bboxOf(primitiveIds, timeoutMs) {
  if (primitiveIds.length === 0) return undefined
  const raw = await callExtension('sch_Primitive.getPrimitivesBBox', [primitiveIds], timeoutMs)
  if (raw === null || typeof raw !== 'object') return undefined
  const minX = Number(raw.minX)
  const minY = Number(raw.minY)
  const maxX = Number(raw.maxX)
  const maxY = Number(raw.maxY)
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return undefined
  return { minX, minY, maxX, maxY }
}

const PCB_LAYERS = {
  top: 1, bottom: 2, topSilkscreen: 3, bottomSilkscreen: 4,
  topSolderMask: 5, bottomSolderMask: 6, topPasteMask: 7, bottomPasteMask: 8,
  topAssembly: 9, bottomAssembly: 10, boardOutline: 11, multi: 12, document: 13, mechanical: 14,
}

function resolvePcbLayer(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const key = value.trim()
    if (/^[0-9]+$/.test(key)) return Number(key)
    const lower = key.charAt(0).toLowerCase() + key.slice(1)
    if (PCB_LAYERS[lower] !== undefined) return PCB_LAYERS[lower]
    const upper = key.toUpperCase()
    if (upper === 'TOP') return 1
    if (upper === 'BOTTOM') return 2
    if (upper === 'BOARD_OUTLINE') return 11
  }
  return undefined
}

const PCB_TOOL_ALIASES = {
  eda_pcb_get_components: 'pcb_get_components',
  eda_pcb_get_nets: 'pcb_get_nets',
  eda_pcb_get_layers: 'pcb_get_layers',
  eda_pcb_place_component: 'pcb_place_component',
  eda_pcb_draw_track: 'pcb_draw_track',
  eda_pcb_draw_via: 'pcb_draw_via',
  eda_pcb_save_document: 'pcb_save_document',
  eda_pcb_import_changes: 'pcb_import_changes',
  eda_pcb_get_primitives_in_region: 'pcb_get_primitives_in_region',
  eda_pcb_navigate_to_region: 'pcb_navigate_to_region',
  eda_pcb_draw_board_outline: 'pcb_draw_board_outline',
}

// TPCB_LayersOfRegion = copper layer | MULTI(12). The board-outline layer (11)
// and the silkscreen/mechanical layers are not valid region layers.
function isRegionLayer(layer) {
  return layer === 1 || layer === 2 || layer === 12 || (layer >= 15 && layer <= 44)
}

function resolveRegionLayer(value, tool) {
  const layer = resolvePcbLayer(value)
  if (layer === undefined) throw new Error(tool + ' requires a valid layer')
  if (!isRegionLayer(layer)) {
    throw new Error(tool + ': layer ' + layer + ' cannot hold a region (official type TPCB_LayersOfRegion = copper top/bottom/inner(15-44) | MULTI(12))')
  }
  return layer
}

// TPCB_PolygonSourceArray: [x1, y1, 'L', x2, y2, x3, y3, ...]; the first and
// last point are joined automatically, so the closing point must not repeat.
function buildPolygonSource(points) {
  const source = [points[0], points[1], 'L']
  for (let i = 2; i < points.length; i += 2) source.push(points[i], points[i + 1])
  return source
}

function requireFlatPoints(value, tool) {
  const points = flattenPoints(value)
  if (points.length < 6 || points.length % 2 !== 0 || !points.every(Number.isFinite)) {
    throw new Error(tool + ': points must be a flat array of finite numbers shaped [x1,y1,x2,y2,...] with at least 3 points')
  }
  if (points.length >= 8 && points[0] === points[points.length - 2] && points[1] === points[points.length - 1]) {
    points.length -= 2
  }
  return points
}

/** EDA pin rotation -> outward direction (0=+x right, 90=+y up, 180=-x, 270=-y). */
function pinDirection(rotation) {
  const normalized = ((Math.round(Number(rotation) / 90) * 90) % 360 + 360) % 360
  if (normalized === 90) return { dx: 0, dy: 1 }
  if (normalized === 180) return { dx: -1, dy: 0 }
  if (normalized === 270) return { dx: 0, dy: -1 }
  return { dx: 1, dy: 0 }
}

const DOCUMENT_TYPES = {
  '-1': 'HOME', 0: 'BLANK', 1: 'SCHEMATIC_PAGE', 2: 'SYMBOL_COMPONENT', 3: 'PCB', 5: 'PROJECT',
  12: 'PCB_2D_PREVIEW', 15: 'PCB_3D_PREVIEW', 18: 'SYMBOL_NET_FLAG', 19: 'SYMBOL_NET_PORT',
  20: 'SYMBOL_DRAWING', 21: 'SYMBOL_NON_ELECTRICAL', 26: 'PANEL', 27: 'PANEL_3D_PREVIEW',
}

/**
 * Place a net label. sch_PrimitiveAttribute.createNetLabel is the real net-label
 * primitive (it participates in the netlist) but it is documented as "ADD since
 * EDA v4", so older builds are handled with a plain text label fallback.
 */
const NET_EMPTY_HINT = 'sch_Net.* returned no nets. Those APIs only report the ACTIVE document, so the schematic page must be the active tab: call eda_get_active_document, then eda_open_document with the schematic page uuid (eda_get_schematic_pages) and retry.'

/** Fallback for tab-dependent sch_Net APIs: parse the project netlist text. */
/**
 * Bounded-batch routing removal used when the connected EDA extension has no
 * background-job helper: one call deletes at most batchSize primitives, so the
 * MCP call always returns well inside the tool timeout and the caller loops.
 */
/** Read a PCB primitive list, turning the tab-dependent null failure into a clear error. */
async function pcbPrimitiveList(method, callArgs, timeoutMs) {
  try {
    const raw = await callExtension(method, callArgs, timeoutMs)
    return Array.isArray(raw) ? raw : []
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/null|undefined|map/i.test(message)) {
      throw new Error('PCB primitives could not be read (' + message + '). The PCB document is probably not the active tab: bring the PCB page to the front (eda_get_active_document / eda_open_document) and retry.')
    }
    throw error
  }
}

/**
 * Audit the active PCB against `docs/design-rules.md`. Read-only: it never edits
 * the board, it reports what a reviewer would flag and what the tool defaults
 * would have produced.
 */
async function auditPcb(args, timeoutMs) {
  const netFilter = args.net === undefined ? undefined : String(args.net)
  const tracks = await pcbPrimitiveList('pcb_PrimitiveLine.getAll', [netFilter, undefined, undefined], timeoutMs)
  const vias = await pcbPrimitiveList('pcb_PrimitiveVia.getAll', [netFilter, undefined], timeoutMs)
  const pours = await pcbPrimitiveList('pcb_PrimitivePour.getAll', [netFilter, undefined, undefined], timeoutMs)
  const outline = await pcbPrimitiveList('pcb_PrimitivePolyline.getAll', [undefined, PCB_LAYERS.boardOutline, undefined], timeoutMs)

  const violations = []
  const warnings = []
  const add = (bucket, rule, message, samples) => {
    const entry = bucket.find(item => item.rule === rule)
    if (entry === undefined) bucket.push({ rule, message, count: 1, samples: samples.slice(0, 5) })
    else { entry.count += 1; if (entry.samples.length < 5) entry.samples.push(samples[0]) }
  }

  // §5.1 track width per net role
  const widthByNet = new Map()
  for (const track of tracks) {
    const record = asRecord(track)
    const net = String(pickValue(record, 'Net', 'net') ?? '')
    const width = Number(pickValue(record, 'LineWidth', 'lineWidth'))
    if (!Number.isFinite(width) || width <= 0) continue
    const seen = widthByNet.get(net)
    if (seen === undefined || width < seen) widthByNet.set(net, width)
    const check = checkTrackWidth(net, width, false)
    if (!check.ok) add(violations, 'track-width-min', check.errors.join('; '), [pickValue(record, 'PrimitiveId', 'primitiveId')])
    else if (check.warnings.length > 0) add(warnings, 'track-width-role', check.warnings.join('; '), [pickValue(record, 'PrimitiveId', 'primitiveId')])
  }

  // §5.2 via drill / annular ring
  for (const via of vias) {
    const record = asRecord(via)
    const net = String(pickValue(record, 'Net', 'net') ?? '')
    const hole = Number(pickValue(record, 'HoleDiameter', 'holeDiameter'))
    const pad = Number(pickValue(record, 'Diameter', 'diameter'))
    if (!Number.isFinite(hole) || !Number.isFinite(pad)) continue
    const check = checkVia(net, hole, pad, false)
    if (!check.ok) add(violations, 'via-geometry', check.errors.join('; '), [pickValue(record, 'PrimitiveId', 'primitiveId')])
    else if (check.warnings.length > 0) add(warnings, 'via-standard', check.warnings.join('; '), [pickValue(record, 'PrimitiveId', 'primitiveId')])
  }

  // §2.1 net naming
  let netNames = []
  try { netNames = await callExtension('pcb_Net.getAllNetsName', [], timeoutMs) } catch { netNames = [] }
  if (!Array.isArray(netNames)) netNames = []
  for (const name of netNames) {
    const text = String(name)
    const check = checkNetName(text)
    if (!check.ok) add(violations, 'net-name', check.errors.join('; '), [text])
    else if (check.warnings.length > 0) add(warnings, 'net-name-style', check.warnings.join('; '), [text])
  }

  // §7.2 board outline, §5.4 copper pour
  if (outline.length === 0) violations.push({ rule: 'board-outline', message: 'No board outline on layer 11: auto-routing and Gerber export need a closed outline (pcb_draw_board_outline)', count: 1, samples: [] })
  if (pours.length === 0) warnings.push({ rule: 'copper-pour', message: 'No copper pour: a GND pour on the top/bottom layer is the recommended way to carry ground (eda_pcb_create_pour)', count: 1, samples: [] })

  // §6.3 DRC
  let drc = { ran: false, reason: null, violationCount: null }
  if (args.drc !== false) {
    try {
      const outcome = await callExtension('pcb_Drc.check', [true, false, true], toolTimeout(args, timeoutMs))
      drc = { ran: true, reason: null, violationCount: Array.isArray(outcome) ? outcome.length : (outcome === true ? 0 : null) }
    } catch (error) {
      drc = { ran: false, reason: error instanceof Error ? error.message : String(error), violationCount: null }
    }
  }
  if (drc.ran && drc.violationCount !== null && drc.violationCount > 0) {
    violations.push({ rule: 'drc', message: `PCB DRC reports ${drc.violationCount} violation(s)`, count: drc.violationCount, samples: [] })
  }

  const checklist = [
    { item: '板框存在（层 11 闭合折线）', status: outline.length > 0 ? 'pass' : 'fail' },
    { item: '走线宽度 ≥ ' + MIN_TRACK_WIDTH_MIL + ' mil（0.15 mm）', status: violations.some(item => item.rule === 'track-width-min') ? 'fail' : 'pass' },
    { item: '过孔孔径/焊环合规（≥' + VIA_HOLE_MIN_MM + ' mm 建议，焊环 ≥' + ANNULUS_MIN_MM + ' mm）', status: violations.some(item => item.rule === 'via-geometry') ? 'fail' : 'pass' },
    { item: '网络名仅含可解析字符', status: violations.some(item => item.rule === 'net-name') ? 'fail' : 'pass' },
    { item: 'GND 铺铜', status: pours.length > 0 ? 'pass' : 'warn' },
    { item: 'PCB DRC', status: drc.violationCount === 0 ? 'pass' : (drc.violationCount === null ? 'unknown' : 'fail') },
  ]

  return {
    ok: violations.length === 0,
    counts: { tracks: tracks.length, vias: vias.length, pours: pours.length, outlinePolylines: outline.length, nets: netNames.length },
    minWidthByNet: Object.fromEntries([...widthByNet.entries()].map(([net, width]) => [net, { widthMil: width, role: classifyNet(net), suggestedMil: suggestTrackWidthMil(net) }])),
    violations, warnings, checklist, drc,
    rules: {
      minTrackMil: MIN_TRACK_WIDTH_MIL,
      trackWidthTiers: TRACK_WIDTH_MIL,
      viaSizesMm: VIA_SIZES_MM,
      viaHoleMinMm: VIA_HOLE_MIN_MM,
      annulusMinMm: ANNULUS_MIN_MM,
      pourClearanceMil: { required: POUR_CLEARANCE_MIN_MIL, recommended: POUR_CLEARANCE_RECOMMENDED_MIL },
      silkscreenMinMm: { height: SILKSCREEN_HEIGHT_MIN_MM, width: SILKSCREEN_WIDTH_MIN_MM },
      boardOutlineWidthMil: BOARD_OUTLINE_WIDTH_MIL,
    },
  }
}

/**
 * Real probe for `resolveExecutable`: filesystem existence plus `reg query`.
 * Kept separate from the pure resolver so the resolution order stays testable.
 */
function launchProbe() {
  const cache = new Map()
  return {
    platform: process.platform,
    env: process.env,
    exists(path) {
      try { return statSync(path).isFile() } catch { return false }
    },
    registryQuery(key, valueName) {
      if (process.platform !== 'win32') return undefined
      // `undefined` (list every value) and `''` (the default value) are different
      // queries and must not share a cache entry.
      const cacheKey = key + '|' + (valueName === undefined ? 'LIST' : (valueName === '' ? 'DEFAULT' : 'V:' + valueName))
      if (cache.has(cacheKey)) return cache.get(cacheKey)
      let output
      try {
        // `reg query <key>` alone prints only the default value, so listing a key
        // (valueName undefined) needs `/s`; a single value uses `/v`, and the
        // default value uses `/ve`.
        const extra = valueName === undefined ? ['/s'] : (valueName === '' ? ['/ve'] : ['/v', valueName])
        const raw = execFileSync('reg', ['query', key, ...extra], {
          timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
        })
        output = decodeRegistryOutput(raw)
      } catch {
        output = undefined
      }
      cache.set(cacheKey, output)
      return output
    },
  }
}

/** How many processes currently run that image name (Windows tasklist). */
function processCountByName(imageName) {
  if (process.platform !== 'win32') {
    // pgrep exits non-zero when nothing matches, which is the "closed" case.
    try {
      const out = execFileSync('pgrep', ['-f', imageName], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      return out.split(/\r?\n/).filter(line => line.trim() !== '').length
    } catch {
      return 0
    }
  }
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + imageName, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split(/\r?\n/).filter(line => line.trim().startsWith('"')).length
  } catch {
    return 0
  }
}

/** Ask the app to close (/T closes the renderer children too); force kills it. */
function terminateByName(imageName, force) {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/IM', imageName, '/T'].concat(force ? ['/F'] : []), {
      timeout: 10000, stdio: ['ignore', 'ignore', 'ignore'],
    })
    return
  }
  execFileSync('pkill', [force ? '-9' : '-TERM', '-f', imageName], { timeout: 10000, stdio: ['ignore', 'ignore', 'ignore'] })
}

/** Wait (bounded) until at least one EDA extension reports ready. */
async function waitForExtensionConnection(timeoutMs) {
  const started = Date.now()
  const readyCount = () => pickClients().length
  while (Date.now() - started < timeoutMs) {
    if (readyCount() > 0) return { connected: true, clients: readyCount(), waitedMs: Date.now() - started }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return { connected: false, clients: readyCount(), waitedMs: Date.now() - started }
}

async function clearRoutingBatched(args, type, timeoutMs) {
  if (type === 'connection') throw new Error('eda_pcb_clear_routing: type=connection needs the EDA user interface; use type=all/net with mode=batched')
  const net = args.net === undefined ? undefined : String(args.net)
  const layer = args.layer === undefined ? undefined : resolvePcbLayer(args.layer)
  if (args.layer !== undefined && layer === undefined) throw new Error('eda_pcb_clear_routing: invalid layer ' + String(args.layer))
  const batchSize = Math.max(1, Math.min(2000, Number(args.batchSize ?? 200) || 200))
  const tracks = await pcbPrimitiveList('pcb_PrimitiveLine.getAll', [net, layer, undefined], timeoutMs)
  const vias = await pcbPrimitiveList('pcb_PrimitiveVia.getAll', [net, undefined], timeoutMs)
  const trackIds = (Array.isArray(tracks) ? tracks : []).map(item => pickValue(asRecord(item), 'PrimitiveId', 'primitiveId')).filter(id => typeof id === 'string')
  const viaIds = (Array.isArray(vias) ? vias : []).map(item => pickValue(asRecord(item), 'PrimitiveId', 'primitiveId')).filter(id => typeof id === 'string')
  const batch = [...trackIds.map(id => ({ kind: 'track', id })), ...viaIds.map(id => ({ kind: 'via', id }))].slice(0, batchSize)
  let deleted = 0
  const failed = []
  for (const item of batch) {
    try {
      await callExtension(item.kind === 'track' ? 'pcb_PrimitiveLine.delete' : 'pcb_PrimitiveVia.delete', [item.id], timeoutMs)
      deleted += 1
    } catch (error) {
      failed.push({ primitiveId: item.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const remaining = trackIds.length + viaIds.length - deleted
  return {
    mode: 'batched', type, net: net ?? null, layer: layer ?? null, batchSize,
    matched: trackIds.length + viaIds.length, deleted, remaining, done: remaining <= 0, failed,
    hint: remaining <= 0 ? 'Routing cleared.' : 'Call eda_pcb_clear_routing again (same arguments) until done=true.',
  }
}

async function parseNetlist(previous, timeoutMs) {
  let text
  try {
    text = await callExtension('sch_Netlist.getNetlist', [undefined], timeoutMs)
  } catch (error) {
    return { source: 'sch_Net.*', count: Array.isArray(previous) ? previous.length : 0, nets: previous, hint: NET_EMPTY_HINT, netlistError: error instanceof Error ? error.message : String(error) }
  }
  if (typeof text !== 'string' || text.trim() === '') {
    return { source: 'sch_Net.*', count: Array.isArray(previous) ? previous.length : 0, nets: previous, hint: NET_EMPTY_HINT }
  }
  const byNet = new Map()
  // JLCEDA netlist lines look like:  NET "GND" (R1.2 U3.1 ...)
  for (const match of text.matchAll(/NET\s+"?([^"\s()]+)"?\s*\(([^)]*)\)/gi)) {
    const name = match[1]
    const pins = match[2].split(/\s+/).map(part => part.trim()).filter(part => part !== '')
    const existing = byNet.get(name)
    if (existing === undefined) byNet.set(name, pins)
    else byNet.set(name, [...new Set([...existing, ...pins])])
  }
  const nets = [...byNet.entries()].map(([net, pins]) => ({ net, pins, pinCount: pins.length }))
  return { source: 'sch_Netlist.getNetlist', count: nets.length, nets, netlistBytes: text.length }
}

async function placeNetLabel(net, x, y, fontSize, timeoutMs, options = {}) {
  if (net === '' || net === 'undefined') throw new Error('a net name is required')
  assertNetName(String(net), 'eda_place_net_label')
  const size = fontSize === undefined ? 12 : Number(fontSize)
  if (options.probe === true) netLabelSupport = null
  let failure = null
  // The capability is probed ONCE per session: on JLCEDA Pro 3.2.186 createNetLabel
  // exists but never resolves, and paying the 4s timeout for every one of hundreds
  // of labels is what turned a 133-label run into 15 minutes.
  if (netLabelSupport !== false) {
    try {
      const raw = await callExtension('sch_PrimitiveAttribute.createNetLabel', [x, y, net], Math.min(timeoutMs, 4000))
      if (raw === undefined || raw === null) throw new Error('createNetLabel returned nothing')
      netLabelSupport = true
      return { method: 'netLabel', net, x, y, label: summarizePrimitive(raw) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/not found|not available|not allowed|timed out|timeout|nothing|undefined/i.test(message)) throw error
      failure = message
      netLabelSupport = false
    }
  }
  // The stub wire (drawn by the *_at_pin callers) already carries the net; a text
  // label on top of it is pure clutter, so it is opt-in.
  if (options.textLabel !== true) {
    return { method: 'stub', net, x, y, created: false, warning: 'createNetLabel is unavailable on this EDA build (' + (failure ?? 'probe already failed this session') + '); the net is carried by the stub wire, and no text label was added (pass textLabel:true if you want one).' }
  }
  const raw = await callExtension('sch_PrimitiveText.create', [x, y, net, 0, null, null, size, false, false, false, 1], timeoutMs)
  const label = summarizePrimitive(raw)
  if (label.primitiveId !== undefined) {
    placedTextLabels.push({ net: String(net), x, y, primitiveId: label.primitiveId })
    if (placedTextLabels.length > 2000) placedTextLabels.shift()
  }
  return {
    method: 'text', net, x, y, created: label.primitiveId !== undefined,
    warning: 'createNetLabel is unavailable on this EDA build (' + (failure ?? 'probe already failed this session') +
      '), so a plain TEXT label was placed: it carries no electrical meaning. The stub wire drawn by the caller is what joins the net; eda_get_net_labels lists these texts by name and id.',
    ...(label.primitiveId === undefined
      ? { hint: 'No label primitive was created: the schematic page must be the ACTIVE document (sch_PrimitiveText.create is tab-dependent). Use eda_get_active_document / eda_open_document, then retry.' }
      : {}),
    label,
  }
}

/** Place a net flag or net label at a pin, pushing it outwards with a stub wire. */
async function placeAtPin(toolName, args, timeoutMs) {
  const pinPrimitiveId = String(args.pinPrimitiveId ?? '')
  if (pinPrimitiveId === '') throw new Error('pinPrimitiveId is required')
  const isFlag = toolName === 'eda_place_net_flag_at_pin'
  assertNetName(String(args.net ?? ''), toolName)
  const pin = await callExtension('sch_PrimitivePin.get', [pinPrimitiveId], timeoutMs)
  const pinRecord = asRecord(pin)
  const pinX = Number(pickValue(pinRecord, 'X', 'x'))
  const pinY = Number(pickValue(pinRecord, 'Y', 'y'))
  if (!Number.isFinite(pinX) || !Number.isFinite(pinY)) throw new Error('could not read pin position for ' + pinPrimitiveId)
  const pinRotation = Number(pickValue(pinRecord, 'Rotation', 'rotation') ?? 0)
  const direction = pinDirection(pinRotation)
  const explicitOffset = args.offsetX !== undefined || args.offsetY !== undefined
  // Placing a flag/label exactly ON the pin covers the symbol. Default: push it
  // outwards along the pin direction and keep connectivity with a short stub wire.
  const stubLength = args.stubLength === undefined
    ? (explicitOffset ? 0 : 20)
    : Math.max(0, Number(args.stubLength))
  const x = pinX + direction.dx * stubLength + Number(args.offsetX ?? 0)
  const y = pinY + direction.dy * stubLength + Number(args.offsetY ?? 0)
  if (args.allowOutsideFrame !== true) {
    const problem = checkPointInFrame(x, y, args.paper, 5) ?? checkPointAgainstTitleBlock(x, y, args.paper, 5)
    if (problem !== undefined) {
      throw new Error(toolName + ' refused: ' + problem + ' - reduce stubLength or pass offsetX/offsetY to place it elsewhere.')
    }
  }
  let stub
  if (stubLength > 0 && typeof args.net === 'string' && args.net !== '') {
    stub = summarizePrimitive(await callExtension('sch_PrimitiveWire.create', [
      [pinX, pinY, x, y], String(args.net), args.color === undefined ? undefined : String(args.color),
      args.lineWidth === undefined ? undefined : Number(args.lineWidth), args.lineType === undefined ? undefined : Number(args.lineType),
    ], timeoutMs))
  }
  const placement = { pin: { primitiveId: pinPrimitiveId, x: pinX, y: pinY, rotation: pinRotation }, direction, stubLength, x, y, stub }
  if (isFlag) {
    const flag = await callExtension('sch_PrimitiveComponent.createNetFlag', [
      String(args.identification), String(args.net), x, y,
      args.rotation === undefined ? pinRotation : Number(args.rotation), Boolean(args.mirror ?? false),
    ], timeoutMs)
    return { ...placement, flag: summarizePrimitive(flag) }
  }
  const label = await placeNetLabel(String(args.net), x, y, args.fontSize, timeoutMs)
  return { ...label, ...placement }
}

/**
 * True when the connected EDA extension build does not implement a dsh.internal.*
 * helper (older zip still imported). Callers then fall back to the synchronous API.
 */
function isInternalHelperMissing(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/unsupported job kind/i.test(message)) return true
  return /not allowed|not found|not available/i.test(message) && /dsh\.internal|API method/i.test(message)
}

/** Per-call timeout override for long operations (auto-routing, Gerber export, DRC). */
function toolTimeout(args, fallback) {
  const value = Number(args.timeoutMs)
  return Number.isFinite(value) && value > 0 ? Math.max(value, fallback) : fallback
}

function pickDefined(source, keys) {
  const out = {}
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

/** Resolve a project uuid from { uuid } or { name } (exact match first, then case-insensitive substring). */
async function resolveProjectUuid(args, timeoutMs) {
  const direct = args.uuid === undefined ? '' : String(args.uuid).trim()
  if (direct !== '') return { uuid: direct, matched: null }
  const name = args.name === undefined ? '' : String(args.name).trim()
  if (name === '') throw new Error('provide uuid or name')
  const unfiltered = await callExtension('dmt_Project.getAllProjectsUuid', [], toolTimeout(args, timeoutMs))
  const candidates = Array.isArray(unfiltered) ? unfiltered.map(String) : []
  // Local directories are modelled as teams, so an unfiltered listing is empty;
  // collect every team's projects before giving up on the name.
  if (candidates.length === 0) {
    const teams = await callExtension('dmt_Team.getAllTeamsInfo', [], toolTimeout(args, timeoutMs)).catch(() => [])
    const seen = new Set()
    for (const team of Array.isArray(teams) ? teams : []) {
      const teamUuid = String(pickValue(asRecord(team), 'uuid', 'Uuid') ?? '')
      if (teamUuid === '') continue
      const owned = await callExtension('dmt_Project.getAllProjectsUuid', [teamUuid], toolTimeout(args, timeoutMs)).catch(() => [])
      for (const uuid of Array.isArray(owned) ? owned.map(String) : []) {
        if (seen.has(uuid)) continue
        seen.add(uuid)
        candidates.push(uuid)
      }
    }
  }
  const resolved = []
  for (const candidate of candidates) {
    try {
      const info = asRecord(await callExtension('dmt_Project.getProjectInfo', [candidate], toolTimeout(args, timeoutMs)))
      resolved.push({ uuid: candidate, friendly: String(pickValue(info, 'FriendlyName', 'friendlyName', 'Name', 'name') ?? '') })
    } catch {
      resolved.push({ uuid: candidate, friendly: '' })
    }
  }
  const matched = resolved.find(item => item.friendly === name)
    ?? resolved.find(item => item.friendly.toLowerCase().includes(name.toLowerCase()))
    ?? null
  if (matched === null) {
    throw new Error('no project matches "' + name + '"; known names: ' +
      resolved.map(item => item.friendly || item.uuid).slice(0, 20).join(', '))
  }
  return { uuid: matched.uuid, matched }
}

/** Wait (bounded) until getCurrentProjectInfo reports the expected project uuid. */
async function waitForActiveProject(uuid, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  let lastActive = null
  for (;;) {
    try {
      const info = asRecord(await callExtension('dmt_Project.getCurrentProjectInfo', [], 3000))
      lastActive = String(pickValue(info, 'uuid', 'Uuid') ?? '') || null
      if (lastActive === uuid) return { active: true, project: info }
    } catch {
      // The app answers undefined while the project is switching.
    }
    if (Date.now() > deadline) return { active: false, project: null, lastActive }
    await sleep(400)
  }
}

/** Collect the internal ids a project owns (schematic / page / pcb uuids). */
function internalIdsOf(info) {
  const ids = new Set()
  const boards = Array.isArray(asRecord(info).data) ? asRecord(info).data : []
  for (const board of boards) {
    const record = asRecord(board)
    const boardUuid = String(pickValue(record, 'uuid', 'Uuid') ?? '')
    if (boardUuid !== '') ids.add(boardUuid)
    for (const docKey of ['schematic', 'pcb']) {
      const doc = asRecord(record[docKey])
      const docUuid = String(pickValue(doc, 'uuid', 'Uuid') ?? '')
      if (docUuid !== '') ids.add(docUuid)
      const pages = Array.isArray(doc.pages) ? doc.pages : []
      for (const page of pages) {
        const pageUuid = String(pickValue(asRecord(page), 'uuid', 'Uuid') ?? '')
        if (pageUuid !== '') ids.add(pageUuid)
      }
    }
  }
  return ids
}

/**
 * Refuse PCB writes on a net the board does not have.
 *
 * Measured on 3.2.186: pcb_PrimitiveLine.create happily accepts an arbitrary net
 * name and the board then carries a phantom net (which DRC reports as a netlist
 * error). force:true is the documented escape hatch.
 */
async function assertKnownPcbNet(toolName, net, timeoutMs, force) {
  const name = String(net ?? '').trim()
  if (name === '') throw new Error(toolName + ' requires a net name')
  if (force === true) return
  let names
  try {
    const raw = await callExtension('pcb_Net.getAllNetsName', [], Math.min(timeoutMs, 8000))
    names = new Set((Array.isArray(raw) ? raw : []).map(value => String(value)))
  } catch {
    // The PCB tab may not be active yet; let the write itself decide.
    return
  }
  if (names.size === 0) return
  if (names.has(name)) return
  const sample = [...names].slice(0, 12).join(', ')
  throw new Error(toolName + ': net "' + name + '" is not on this PCB (' + names.size + ' nets: ' + sample +
    '…). A write on an unknown net creates a phantom net that DRC reports as a netlist error; pass force:true if that is really intended.')
}

async function executeTool(name, rawArgs, timeoutMs) {
  const args = asRecord(rawArgs)
  const tool = PCB_TOOL_ALIASES[name] ?? name

  switch (tool) {
    case 'eda_status': {
      const ready = pickClients()
      // Every EDA page keeps its own socket, so several clients can disagree: list
      // them all and judge the bridge as outdated when ANY of them is not on VERSION.
      const versions = ready.map(client => (typeof client.extensionVersion === 'string' ? client.extensionVersion : null))
      const extensionVersion = versions.find(value => typeof value === 'string') ?? null
      const stale = versions.filter(value => value !== VERSION)
      return {
        ok: true, bridgeVersion: VERSION, wsPort: WS_PORT, allowRawApi: ALLOW_RAW_API,
        connectedClients: ready.length,
        extensionVersion: extensionVersion ?? null,
        extensionVersions: versions,
        versionMismatch: stale.length > 0,
        mcpUnits: '0.01 inch', defaultPaper: DEFAULT_PAPER,
        hint: ready.length === 0
          ? 'No JLCEDA extension is connected. Open JLCEDA Pro and click DSH MCP -> connect, or re-import dsh-eda-bridge-extension-' + VERSION + '.zip.'
          : (stale.length > 0
            ? 'Connected EDA extension ' + stale.join(', ') + ' does not match bridge ' + VERSION +
              '. In JLCEDA Pro remove the OLD dsh-eda-bridge extension first, import dsh-eda-bridge-extension-' + VERSION + '.zip again, then restart the app; a simple reload keeps the old copy.'
            : 'ok'),
      }
    }

    case 'eda_close_document':
      return await callExtension('dmt_EditorControl.closeDocument', [String(args.tabId ?? '')], timeoutMs)

    case 'eda_export_project': {
      const result = await callExtension('dsh.internal.exportProjectFile', [
        args.uuid === undefined ? null : String(args.uuid),
        args.fileName === undefined ? undefined : String(args.fileName),
        undefined,
        args.fileType === undefined ? undefined : String(args.fileType),
      ], toolTimeout(args, timeoutMs))
      const base64 = typeof result?.base64 === 'string' ? result.base64 : ''
      const outPath = args.outPath === undefined ? '' : String(args.outPath).trim()
      if (outPath !== '') {
        await writeFile(outPath, Buffer.from(base64, 'base64'))
        return { ok: true, written: outPath, name: result?.name ?? null, size: base64 === '' ? 0 : Buffer.from(base64, 'base64').length }
      }
      if (args.inline !== true) {
        return { ok: true, name: result?.name ?? null, base64Length: base64.length, hint: 'Pass outPath to write the file, or inline=true to receive the base64 payload.' }
      }
      return { ok: true, name: result?.name ?? null, base64 }
    }

    case 'eda_import_project': {
      const path = String(args.path ?? '').trim()
      if (path === '') throw new Error('eda_import_project requires path')
      let bytes
      try { bytes = await readFile(path) } catch {
        throw new Error('eda_import_project: cannot read "' + path + '"')
      }
      // importProjectByProjectFile only lands anything when the target team is given
      // (saveTo); without it the app answers undefined and nothing is imported.
      let teamUuid = args.teamUuid === undefined ? '' : String(args.teamUuid).trim()
      if (teamUuid === '') {
        const current = await callExtension('dmt_Team.getCurrentTeamInfo', [], timeoutMs).catch(() => undefined)
        teamUuid = String(pickValue(asRecord(current), 'uuid', 'Uuid') ?? '')
      }
      if (teamUuid === '') {
        throw new Error('eda_import_project needs teamUuid: the app imports nothing without a target team. Use a team uuid from eda_list_teams (local mode reports project directories) or the teamUuid of an existing project (eda_list_projects).')
      }
      const saveTo: Record<string, unknown> = { operation: 'New Project', newProjectOwnerTeamUuid: teamUuid }
      if (args.folderUuid !== undefined) saveTo.newProjectOwnerFolderUuid = String(args.folderUuid)
      if (args.friendlyName !== undefined) saveTo.newProjectFriendlyName = String(args.friendlyName)
      const imported = await callExtension('dsh.internal.importProjectFile', [
        bytes.toString('base64'),
        basename(path),
        args.fileType === undefined ? undefined : String(args.fileType),
        saveTo,
      ], toolTimeout(args, timeoutMs))
      const raw = imported?.result ?? imported
      const uuid = typeof raw === 'string' ? raw : (typeof raw?.uuid === 'string' ? raw.uuid : undefined)
      const landed = raw !== null && raw !== undefined
      let opened = false
      if (args.open === true && uuid !== undefined) {
        try {
          await callExtension('dmt_Project.openProject', [uuid], timeoutMs)
          // Same as eda_open_project: trust the observed state, not the return value.
          opened = (await waitForActiveProject(uuid, 4000)).active
        } catch {
          opened = false
        }
      }
      // Import copies the file verbatim, so schematic/page/pcb uuids inside the new
      // project can collide with the source. Detect it and say so instead of leaving a
      // silent data-integrity trap.
      let collisions = null
      if (landed && uuid !== undefined && args.checkCollisions !== false) {
        try {
          const mine = await callExtension('dmt_Project.getProjectInfo', [uuid], toolTimeout(args, timeoutMs))
          const myIds = internalIdsOf(mine)
          const others = await callExtension('dmt_Project.getAllProjectsUuid', [], toolTimeout(args, timeoutMs))
          const list = (Array.isArray(others) ? others.map(String) : []).filter(other => other !== uuid).slice(0, 20)
          collisions = []
          for (const other of list) {
            const info = await callExtension('dmt_Project.getProjectInfo', [other], timeoutMs).catch(() => undefined)
            const shared = [...internalIdsOf(info)].filter(sharedId => myIds.has(sharedId))
            if (shared.length > 0) {
              collisions.push({ projectUuid: other, friendlyName: pickValue(asRecord(info), 'friendlyName', 'FriendlyName') ?? null, sharedIds: shared })
            }
          }
        } catch {
          collisions = null
        }
      }
      return {
        ok: landed,
        imported: landed,
        name: basename(path),
        size: bytes.length,
        teamUuid,
        uuid: uuid ?? null,
        opened,
        collisions,
        result: raw ?? null,
        hint: landed ? null : 'The app returned nothing: the import did not create a project. That means this build ignores the saveTo target (same limitation as createProject), so import cannot be used to create projects here.',
      }
    }

    case 'eda_close': {
      const resolved = resolveExecutable(launchProbe(), {
        executable: args.executable === undefined ? undefined : String(args.executable),
      })
      const imageName = resolved === undefined ? 'lceda-pro.exe' : basename(resolved.executable)
      const before = processCountByName(imageName)
      const waitMs = Number.isFinite(Number(args.waitMs)) ? Math.max(1000, Number(args.waitMs)) : 8000
      let error = null
      try {
        terminateByName(imageName, false)
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure)
      }
      const started = Date.now()
      let remaining = processCountByName(imageName)
      while (remaining > 0 && Date.now() - started < waitMs) {
        await new Promise(resolve => setTimeout(resolve, 500))
        remaining = processCountByName(imageName)
      }
      let forced = false
      if (remaining > 0) {
        try {
          terminateByName(imageName, true)
          forced = true
          await new Promise(resolve => setTimeout(resolve, 1500))
          remaining = processCountByName(imageName)
        } catch (failure) {
          error = error ?? (failure instanceof Error ? failure.message : String(failure))
        }
      }
      const connected = pickClients().length
      return {
        ok: remaining <= 0,
        closed: remaining <= 0,
        forced,
        imageName,
        processesBefore: before,
        processesAfter: remaining,
        connectedClients: connected,
        waitedMs: Date.now() - started,
        error,
      }
    }

    case 'eda_list_projects': {
      // Omit the filters entirely when they are not given: the official API treats a
      // literal null as a filter value and the call does not resolve.
      const filters = []
      if (args.teamUuid !== undefined) filters.push(String(args.teamUuid))
      if (args.folderUuid !== undefined || args.workspaceUuid !== undefined) filters.push(args.folderUuid === undefined ? null : String(args.folderUuid))
      if (args.workspaceUuid !== undefined) filters.push(String(args.workspaceUuid))
      let uuids = await callExtension('dmt_Project.getAllProjectsUuid', filters, toolTimeout(args, timeoutMs))
      let list = Array.isArray(uuids) ? uuids.map(String) : []
      let aggregated = false
      // In semi-offline mode the app models each local project directory as a
      // "team", so an unfiltered call returns nothing; walk the teams instead.
      if (list.length === 0 && filters.length === 0) {
        const teams = await callExtension('dmt_Team.getAllTeamsInfo', [], toolTimeout(args, timeoutMs)).catch(() => [])
        const seen = new Set()
        for (const team of Array.isArray(teams) ? teams : []) {
          const teamUuid = String(pickValue(asRecord(team), 'uuid', 'Uuid') ?? '')
          if (teamUuid === '') continue
          const owned = await callExtension('dmt_Project.getAllProjectsUuid', [teamUuid], toolTimeout(args, timeoutMs)).catch(() => [])
          for (const uuid of Array.isArray(owned) ? owned.map(String) : []) {
            if (seen.has(uuid)) continue
            seen.add(uuid)
            list.push(uuid)
          }
        }
        aggregated = true
      }
      if (args.resolveNames === false) return { count: list.length, uuids: list, aggregated }
      const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Number(args.limit)) : list.length
      const projects = []
      for (const uuid of list.slice(0, limit)) {
        try {
          // Verbatim: project records carry unstable keys and summarising them
          // produced empty objects.
          projects.push(await callExtension('dmt_Project.getProjectInfo', [uuid], toolTimeout(args, timeoutMs)))
        } catch {
          projects.push({ uuid })
        }
      }
      return { count: list.length, resolved: projects.length, aggregated, projects }
    }

    case 'eda_get_project': {
      const project = await callExtension('dmt_Project.getCurrentProjectInfo', [], timeoutMs)
      return project === undefined || project === null
        ? { project: null, hint: 'No project is open: JLCEDA Pro is on the HOME page. Use eda_list_projects + eda_open_project, or open one in the app.' }
        : project
    }

    case 'eda_open_project': {
      const resolvedProject = await resolveProjectUuid(args, timeoutMs)
      const uuid = resolvedProject.uuid
      const returned = await callExtension('dmt_Project.openProject', [uuid], toolTimeout(args, timeoutMs))
      // openProject returned false on the first call although the switch had already
      // happened, so report what the app actually has open instead of its boolean.
      const activation = await waitForActiveProject(uuid, args.verifyMs === undefined ? 4000 : Number(args.verifyMs))
      return {
        opened: activation.active,
        openReturned: returned !== false,
        uuid,
        matched: resolvedProject.matched,
        current: activation.active ? summarizePrimitive(activation.project) : null,
        ...(activation.active ? {} : { hint: 'The project did not become active within the verification window (last active: ' + (activation.lastActive ?? 'unknown') + '); it may still be loading, or the app refused the switch.' }),
      }
    }

    case 'eda_get_workspace': {
      const workspace = await callExtension('dmt_Workspace.getCurrentWorkspaceInfo', [], timeoutMs).catch(() => undefined)
      const team = await callExtension('dmt_Team.getCurrentTeamInfo', [], timeoutMs).catch(() => undefined)
      // Team/workspace payloads are small and their field names are unstable, so
      // they are returned verbatim: summarising them produced empty objects.
      return {
        workspace: workspace === undefined ? null : workspace,
        team: team === undefined ? null : team,
        hint: workspace === undefined && team === undefined
          ? 'No workspace/team is available: start JLCEDA Pro and sign in to a JLC account. Workspace projects cannot be created or listed without one.'
          : 'ok',
      }
    }

    case 'eda_list_teams': {
      const teams = await callExtension(args.involved === true ? 'dmt_Team.getAllInvolvedTeamInfo' : 'dmt_Team.getAllTeamsInfo', [], toolTimeout(args, timeoutMs))
      const list = Array.isArray(teams) ? teams : []
      return { count: list.length, teams: list }
    }

    case 'eda_list_folders': {
      const teamUuid = args.teamUuid === undefined ? '' : String(args.teamUuid).trim()
      let resolvedTeam = teamUuid
      if (resolvedTeam === '') {
        const current = await callExtension('dmt_Team.getCurrentTeamInfo', [], timeoutMs).catch(() => undefined)
        resolvedTeam = String(pickValue(asRecord(current), 'Uuid', 'uuid') ?? '')
      }
      if (resolvedTeam === '') throw new Error('eda_list_folders needs teamUuid (eda_list_teams shows them)')
      // The app throws a bare TypeError when the team is not a real uuid (the local
      // directories reported by eda_list_teams are paths), so say what to pass.
      let uuids
      try {
        uuids = await callExtension('dmt_Folder.getAllFoldersUuid', [resolvedTeam], toolTimeout(args, timeoutMs))
      } catch (failure) {
        throw new Error('eda_list_folders: the app rejected team "' + resolvedTeam + '" (' +
          (failure instanceof Error ? failure.message : String(failure)) +
          '); pass the uuid from a project record (eda_list_projects) or eda_list_teams')
      }
      const list = Array.isArray(uuids) ? uuids.map(String) : []
      if (args.resolveNames === false) return { teamUuid: resolvedTeam, count: list.length, uuids: list }
      const folders = []
      for (const folderUuid of list.slice(0, 20)) {
        try {
          folders.push({ folderUuid, info: await callExtension('dmt_Folder.getFolderInfo', [resolvedTeam, folderUuid], timeoutMs) })
        } catch {
          folders.push({ folderUuid, info: null })
        }
      }
      return { teamUuid: resolvedTeam, count: list.length, folders }
    }

    case 'eda_delete_project': {
      const resolvedProject = await resolveProjectUuid(args, timeoutMs)
      const deleted = await callExtension('dmt_Project.deleteProject', [resolvedProject.uuid], toolTimeout(args, timeoutMs))
      const ok = deleted !== false
      return {
        deleted: ok,
        uuid: resolvedProject.uuid,
        matched: resolvedProject.matched,
        hint: ok ? null : 'The app returned false and the project still exists: this build refuses deleteProject for local projects (verified with the project open and after switching away), so remove it in the app.',
      }
    }

    case 'eda_modify_project': {
      const resolvedProject = await resolveProjectUuid(args, timeoutMs)
      const changes = []
      if (args.friendlyName !== undefined) {
        changes.push(['friendlyName', await callExtension('dmt_Project.modifyProjectFriendlyName', [resolvedProject.uuid, String(args.friendlyName)], timeoutMs)])
      }
      if (args.description !== undefined) {
        changes.push(['description', await callExtension('dmt_Project.modifyProjectDescription', [resolvedProject.uuid, String(args.description)], timeoutMs)])
      }
      if (changes.length === 0) throw new Error('eda_modify_project requires friendlyName or description')
      return {
        ok: changes.every(([, value]) => value !== false),
        uuid: resolvedProject.uuid,
        matched: resolvedProject.matched,
        applied: changes.map(([field, value]) => ({ field, ok: value !== false })),
      }
    }

    case 'eda_copy_project': {
      const source = await resolveProjectUuid({
        uuid: args.sourceUuid, name: args.sourceName,
      }, timeoutMs)
      // copyProject answered nothing for every argument combination on 3.2.186, and
      // returning {copied:false} with no reason left the caller guessing.
      let copyRaw
      try {
        copyRaw = await callExtension('dmt_Project.copyProject', [
          source.uuid,
          args.targetTeamUuid === undefined ? undefined : String(args.targetTeamUuid),
          args.targetFolderUuid === undefined ? undefined : String(args.targetFolderUuid),
          args.newFriendlyName === undefined ? undefined : String(args.newFriendlyName),
          args.newName === undefined ? undefined : String(args.newName),
        ], toolTimeout(args, timeoutMs))
      } catch (failure) {
        throw new Error('eda_copy_project failed: ' + (failure instanceof Error ? failure.message : String(failure)))
      }
      const copyUuid = typeof copyRaw === 'string' ? copyRaw : String(pickValue(asRecord(copyRaw), 'uuid', 'Uuid') ?? '')
      return {
        copied: copyUuid !== '',
        sourceUuid: source.uuid,
        uuid: copyUuid === '' ? null : copyUuid,
        raw: copyRaw ?? null,
        hint: copyUuid === ''
          ? 'The app returned no uuid and created nothing: copyProject does not work on this build for local projects (same family as createProject/deleteProject). Duplicate it in the app, or export with eda_export_project and import it back with eda_import_project to get an independent copy.'
          : null,
      }
      return { copied: typeof uuid === 'string' && uuid !== '', sourceUuid: source.uuid, uuid: uuid ?? null }
    }

    case 'eda_create_project': {
      const friendlyName = String(args.friendlyName ?? '').trim()
      if (friendlyName === '') throw new Error('eda_create_project requires friendlyName')
      // createProject needs an owning team: default to the current one instead of
      // passing undefined, which the app answers with an empty uuid.
      let teamUuid = args.teamUuid === undefined ? '' : String(args.teamUuid).trim()
      let teamSource = 'argument'
      if (teamUuid === '') {
        const current = await callExtension('dmt_Team.getCurrentTeamInfo', [], timeoutMs).catch(() => undefined)
        teamUuid = String(pickValue(asRecord(current), 'Uuid', 'uuid') ?? '')
        teamSource = teamUuid === '' ? 'unavailable' : 'current-team'
      }
      if (teamUuid === '') {
        throw new Error('eda_create_project: no team is available (sign in to a JLC account in JLCEDA Pro, or pass teamUuid from eda_list_teams)')
      }
      const folderUuid = args.folderUuid === undefined ? '' : String(args.folderUuid).trim()
      const uuid = await callExtension('dmt_Project.createProject', [
        friendlyName,
        args.name === undefined ? undefined : String(args.name),
        teamUuid,
        folderUuid === '' ? undefined : folderUuid,
        args.description === undefined ? undefined : String(args.description),
      ], toolTimeout(args, timeoutMs))
      if (typeof uuid !== 'string' || uuid === '') {
        throw new Error('eda_create_project: the app returned no project uuid (team ' + teamUuid + ' from ' + teamSource + '; the app may have shown a dialog or rejected the name)')
      }
      let opened = false
      if (args.open === true) {
        try {
          await callExtension('dmt_Project.openProject', [uuid], timeoutMs)
          opened = (await waitForActiveProject(uuid, 4000)).active
        } catch {
          opened = false
        }
      }
      return { created: true, uuid, friendlyName, teamUuid, teamSource, folderUuid: folderUuid === '' ? null : folderUuid, opened }
    }

    case 'eda_launch': {
      const probe = launchProbe()
      const resolved = resolveExecutable(probe, {
        executable: args.executable === undefined ? undefined : String(args.executable),
        project: args.project === undefined ? undefined : String(args.project),
      })
      if (resolved === undefined) {
        throw new Error([
          'eda_launch: could not find the JLCEDA Pro executable on this machine.',
          'Set `DSH_EDA_EXECUTABLE` (or the plugin setting edaExecutable) to the full path of lceda-pro.exe.',
          'Searched: DSH_EDA_EXECUTABLE / JLCEDA_EXECUTABLE, the registry handler registered for .eprj2/.eprj,',
          'conventional install directories under Program Files / LOCALAPPDATA / the system drive, and PATH.',
        ].join(' '))
      }

      const alreadyConnected = pickClients().length
      const project = args.project === undefined ? undefined : String(args.project)
      if (project !== undefined && project !== '') {
        try { if (!statSync(project).isFile()) throw new Error('not a file') } catch {
          throw new Error('eda_launch: project "' + project + '" does not exist or is not a file')
        }
      }

      // On Windows a direct spawn (and even ShellExecute) makes lceda-pro.exe start
      // and quit immediately, while the same executable works when the desktop
      // shell launches it. Explorer runs in the interactive desktop, so the launch
      // is handed to it through a tiny script that starts the app (with the project
      // when given). Other platforms spawn the resolved command directly.
      const plan = buildLaunchArgs(process.platform, resolved.executable, project)
      let child
      let via = 'direct'
      if (process.platform === 'win32') {
        try {
          const scriptPath = join(tmpdir(), 'dsh-eda-launch-' + process.pid + '-' + Date.now() + '.cmd')
          await writeFile(scriptPath, buildLaunchScript(resolved.executable, project), 'utf8')
          child = spawn(process.env.SystemRoot ? join(process.env.SystemRoot, 'explorer.exe') : 'explorer.exe', [scriptPath], {
            detached: true, stdio: 'ignore', windowsHide: false,
          })
          via = 'explorer'
        } catch {
          child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', windowsHide: false })
          via = 'direct'
        }
      } else {
        child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', windowsHide: false })
      }
      child.unref()

      const shouldWait = args.waitForExtension !== false
      const timeoutMs = Number.isFinite(Number(args.timeoutMs)) ? Math.max(1000, Number(args.timeoutMs)) : 30000
      const waited = shouldWait
        ? await waitForExtensionConnection(timeoutMs)
        : { connected: alreadyConnected > 0, clients: alreadyConnected, waitedMs: 0 }

      return {
        ok: true,
        launched: true,
        pid: child.pid ?? null,
        via,
        executable: resolved.executable,
        source: resolved.source,
        project: project ?? null,
        // Verified on JLCEDA Pro 3.2.186: the app starts but ignores the project
        // argument passed on the command line (it opens on HOME), so the caller must
        // not assume the project was opened.
        projectOpenedByArgument: false,
        projectNote: project === undefined || project === ''
          ? null
          : 'The app was started with the project path, but this JLCEDA Pro build ignores it and opens on HOME; open the project from the app itself.',
        target: { command: plan.command, args: plan.args },
        connected: waited.connected,
        connectedClients: waited.clients,
        waitedMs: waited.waitedMs,
        hint: waited.connected
          ? 'JLCEDA is connected; the eda_* tools can be used now.'
          : 'The app was started but no EDA extension connected yet. In JLCEDA Pro: 扩展 → DSH MCP → 连接 (and enable “允许外部交互”); the extension must be imported once from dsh-eda-bridge-extension-' + VERSION + '.zip.',
      }
    }

    case 'eda_get_page_info': {
      const paper = paperOf(args.paper)
      let page
      try { page = await callExtension('dmt_Schematic.getCurrentSchematicPageInfo', [], timeoutMs) } catch { page = undefined }
      return {
        page,
        units: { mcp: '0.01 inch', internal: 'inch', factor: MCP_UNITS_PER_INCH },
        paper: paper.name,
        frame: paper.frame,
        titleBlock: paper.titleBlock,
        safeAreas: safeAreas(paper.name),
        note: 'Coordinates are MCP units (0.01 inch). Frame origin is the lower-left corner, y grows upward. Title-block overlap is rejected by eda_place_component.',
      }
    }

    case 'eda_get_schematic_pages': {
      if (typeof args.pageUuid === 'string' && args.pageUuid !== '') {
        return await callExtension('dmt_Schematic.getSchematicPageInfo', [args.pageUuid], timeoutMs)
      }
      return await callExtension('dmt_Schematic.getCurrentSchematicAllSchematicPagesInfo', [], timeoutMs)
    }

    case 'eda_search_components': {
      const keyword = String(args.keyword ?? '')
      if (keyword.trim() === '') throw new Error('keyword is required')
      const limit = Math.max(1, Math.min(50, Number(args.limit ?? 20)))
      return await callExtension('lib_Device.search', [keyword, undefined, undefined, undefined, limit, 1], timeoutMs)
    }

    case 'eda_place_component': {
      const x = Number(args.x)
      const y = Number(args.y)
      const paper = args.paper
      const allowOutside = args.allowOutsideFrame === true
      if (!allowOutside) {
        const problem = checkPointInFrame(x, y, paper, 5) ?? checkPointAgainstTitleBlock(x, y, paper, 5)
        if (problem !== undefined) throw new Error('eda_place_component refused: ' + problem)
      }
      const component = { libraryUuid: String(args.libraryUuid), uuid: String(args.uuid) }
      const result = await callExtension('sch_PrimitiveComponent.create', [
        component, x, y, args.subPartName, Number(args.rotation ?? 0), Boolean(args.mirror ?? false),
        args.addIntoBom === undefined ? true : Boolean(args.addIntoBom),
        args.addIntoPcb === undefined ? true : Boolean(args.addIntoPcb),
      ], timeoutMs)
      const primitiveId = extractPrimitiveId(result)
      if (primitiveId !== undefined && (args.designator !== undefined || args.value !== undefined || args.name !== undefined)) {
        const otherProperty = {}
        if (args.value !== undefined) otherProperty.Value = String(args.value)
        const property = {}
        if (args.designator !== undefined) property.designator = String(args.designator)
        if (args.name !== undefined) property.name = String(args.name)
        if (Object.keys(otherProperty).length > 0) property.otherProperty = otherProperty
        await callExtension('sch_PrimitiveComponent.modify', [primitiveId, property], timeoutMs)
      }
      if (primitiveId !== undefined && !allowOutside) {
        const bbox = await bboxOf([primitiveId], timeoutMs)
        if (bbox !== undefined) {
          const problem = checkBBoxInFrame(bbox, paper, 0)
          if (problem !== undefined) {
            try { await callExtension('sch_PrimitiveComponent.delete', [primitiveId], timeoutMs) } catch { /* best effort */ }
            throw new Error('eda_place_component rolled back: ' + problem + '. Move the component into a safe area or pass allowOutsideFrame=true.')
          }
        }
      }
      return { primitiveId, result }
    }

    case 'eda_place_net_flag': {
      const x = Number(args.x)
      const y = Number(args.y)
      assertNetName(String(args.net), 'eda_place_net_flag')
      if (args.allowOutsideFrame !== true) {
        const problem = checkPointInFrame(x, y, args.paper, 5) ?? checkPointAgainstTitleBlock(x, y, args.paper, 5)
        if (problem !== undefined) throw new Error('eda_place_net_flag refused: ' + problem)
      }
      return await callExtension('sch_PrimitiveComponent.createNetFlag', [
        String(args.identification), String(args.net), x, y, Number(args.rotation ?? 0), Boolean(args.mirror ?? false),
      ], timeoutMs)
    }

    case 'eda_place_net_port': {
      const x = Number(args.x)
      const y = Number(args.y)
      assertNetName(String(args.net), 'eda_place_net_port')
      if (args.allowOutsideFrame !== true) {
        const problem = checkPointInFrame(x, y, args.paper, 5) ?? checkPointAgainstTitleBlock(x, y, args.paper, 5)
        if (problem !== undefined) throw new Error('eda_place_net_port refused: ' + problem)
      }
      return await callExtension('sch_PrimitiveComponent.createNetPort', [
        String(args.direction), String(args.net), x, y, Number(args.rotation ?? 0), Boolean(args.mirror ?? false),
      ], timeoutMs)
    }

    case 'eda_get_pins': {
      const componentPrimitiveId = String(args.componentPrimitiveId ?? '')
      if (componentPrimitiveId === '') throw new Error('componentPrimitiveId is required')
      // One call already returns pinName/pinNumber (ISCH_PrimitiveComponentPin);
      // summarising it used to drop exactly those fields, forcing one sch_PrimitivePin.get
      // round trip per pin (135 of them for a mid-size schematic).
      const raw = await callExtension('sch_PrimitiveComponent.getAllPinsByPrimitiveId', [componentPrimitiveId], timeoutMs)
      if (!Array.isArray(raw)) return raw
      return raw.map((entry) => {
        const record = asRecord(entry)
        return {
          primitiveId: pickValue(record, 'PrimitiveId', 'primitiveId'),
          pinNumber: pickValue(record, 'PinNumber', 'pinNumber') ?? null,
          pinName: pickValue(record, 'PinName', 'pinName') ?? null,
          x: pickValue(record, 'X', 'x'),
          y: pickValue(record, 'Y', 'y'),
          rotation: pickValue(record, 'Rotation', 'rotation') ?? 0,
          pinLength: pickValue(record, 'PinLength', 'pinLength') ?? null,
          noConnected: pickValue(record, 'NoConnected', 'noConnected') ?? null,
        }
      })
    }

    case 'eda_place_net_flag_at_pin':
    case 'eda_place_net_label_at_pin':
      return await placeAtPin(name, args, timeoutMs)

    case 'eda_place_net_label': {
      const x = Number(args.x)
      const y = Number(args.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('eda_place_net_label requires numeric x/y')
      return await placeNetLabel(String(args.net), x, y, args.fontSize, timeoutMs, {
        probe: args.probe === true, textLabel: args.textLabel === true,
      })
    }

    case 'eda_place_net_labels': {
      // One MCP round trip for many labels: a 133-label schematic used to exceed the
      // caller's timeout with no way to learn what had already been placed.
      const items = Array.isArray(args.items) ? args.items.map(asRecord) : []
      if (items.length === 0) throw new Error('eda_place_net_labels requires items: [{ pinPrimitiveId, net }] or [{ x, y, net }]')
      // Measured on 3.2.186: one label costs ~2 s (the app writes per primitive), so a
      // sequential 133-label run still took minutes. Items are independent, so run them
      // with bounded concurrency; results keep the caller's order.
      const concurrency = Number.isFinite(Number(args.concurrency)) ? Math.max(1, Math.min(8, Number(args.concurrency))) : 4
      const results = await mapLimit(items, concurrency, async (item) => {
        const net = item.net === undefined ? '' : String(item.net)
        try {
          const placed = item.pinPrimitiveId !== undefined
            ? await placeAtPin('eda_place_net_label_at_pin', { ...item, net }, timeoutMs)
            : await placeNetLabel(net, Number(item.x), Number(item.y), item.fontSize, timeoutMs, {
                probe: args.probe === true, textLabel: args.textLabel === true,
              })
          return { ok: true, net, ...placed }
        } catch (error) {
          return { ok: false, net, error: error instanceof Error ? error.message : String(error) }
        }
      })
      const done = results.filter(entry => entry.ok).length
      return {
        total: items.length,
        done,
        failed: items.length - done,
        method: netLabelSupport === true ? 'netLabel' : 'text',
        results,
      }
    }

    case 'eda_get_net_labels': {
      // Enumerate every label-like primitive: net labels/flags/ports are attribute
      // primitives, while the text fallback (createNetLabel unavailable) lands in
      // sch_PrimitiveText. Listing only attributes reported count:0 right after a
      // successful placement, so the labels could not be found or cleaned up.
      const attributes = await callExtension('sch_PrimitiveAttribute.getAll', [
        args.parentPrimitiveId === undefined ? undefined : String(args.parentPrimitiveId),
      ], timeoutMs).catch(() => [])
      const texts = args.parentPrimitiveId === undefined
        ? await callExtension('sch_PrimitiveText.getAll', [], timeoutMs).catch(() => [])
        : []
      const entries = []
      for (const entry of Array.isArray(attributes) ? attributes : []) {
        const record = asRecord(entry)
        entries.push({
          primitiveId: pickValue(record, 'PrimitiveId', 'primitiveId'),
          kind: String(pickValue(record, 'PrimitiveType', 'primitiveType', 'Type', 'type') ?? 'attribute'),
          net: pickValue(record, 'Net', 'net') ?? null,
          userValue: pickValue(record, 'UserValue', 'userValue', 'Value', 'value') ?? null,
          x: pickValue(record, 'X', 'x'),
          y: pickValue(record, 'Y', 'y'),
        })
      }
      for (const entry of Array.isArray(texts) ? texts : []) {
        const record = asRecord(entry)
        const content = String(pickValue(record, 'Content', 'content', 'Text', 'text') ?? '')
        if (content === '') continue
        entries.push({
          primitiveId: pickValue(record, 'PrimitiveId', 'primitiveId'),
          kind: 'text',
          net: content,
          userValue: content,
          x: pickValue(record, 'X', 'x'),
          y: pickValue(record, 'Y', 'y'),
        })
      }
      return {
        count: entries.length,
        attributeCount: Array.isArray(attributes) ? attributes.length : 0,
        textCount: Array.isArray(texts) ? texts.length : 0,
        sessionTextLabels: placedTextLabels.length,
        note: 'kind "text" entries are plain texts (no electrical meaning). Delete any entry with eda_delete_primitive(kind: "netlabel"|"netport"|"netflag"|"text", primitiveId).',
        labels: entries,
      }
    }

    case 'eda_get_active_document': {
      const info = await callExtension('dmt_SelectControl.getCurrentDocumentInfo', [], timeoutMs)
      const record = asRecord(info)
      const type = Number(record.documentType)
      return { document: info, documentTypeName: DOCUMENT_TYPES[type] ?? String(record.documentType ?? 'unknown'), documentType: record.documentType }
    }

    case 'eda_open_document': {
      const documentUuid = String(args.documentUuid ?? '')
      if (documentUuid === '') throw new Error('documentUuid is required')
      const raw = await callExtension('dmt_EditorControl.openDocument', [
        documentUuid, args.splitScreenId === undefined ? undefined : String(args.splitScreenId),
      ], timeoutMs)
      // Measured on 3.2.186: from a freshly launched app sitting on HOME, openDocument
      // answers without creating a tab, so callers thought the page was active and every
      // tab-dependent call then returned empty. Verify instead of trusting it.
      await sleep(600)
      let tabIds = []
      try {
        const tree = asRecord(await callExtension('dmt_EditorControl.getSplitScreenTree', [], Math.min(timeoutMs, 4000)))
        tabIds = (Array.isArray(tree.tabs) ? tree.tabs : []).map(tab => String(pickValue(asRecord(tab), 'tabId') ?? ''))
      } catch { /* the tree is only a hint */ }
      let activeUuid = ''
      try {
        const info = asRecord(await callExtension('dmt_SelectControl.getCurrentDocumentInfo', [], Math.min(timeoutMs, 4000)))
        activeUuid = String(pickValue(info, 'uuid', 'Uuid') ?? '')
      } catch { /* ignore */ }
      // "opened" must mean "this document is now the active one": right after an app
      // restart the call answers success while the Start Page (tab_page1) stays active,
      // and a length-based guess reported opened:true for it.
      const activeIsTarget = activeUuid === documentUuid
      const tabOpened = activeIsTarget || tabIds.some(tab => tab.startsWith(documentUuid + '@'))
      return {
        ...(raw !== null && typeof raw === 'object' ? raw : { result: raw ?? null }),
        opened: tabOpened,
        activated: activeIsTarget,
        activeDocumentUuid: activeUuid || null,
        tabIds,
        hint: tabOpened
          ? null
          : 'The app accepted openDocument but the document is not active (activeDocumentUuid=' +
            (activeUuid || 'unknown') + ', tabs: ' + (tabIds.join(', ') || 'none') +
            '). After an app restart the editor sits on the Start Page: open the project first'
            + ' (eda_open_project), then open the document. This build cannot open a document from the HOME screen programmatically, so never assume a page is active without checking activeDocumentUuid.',
      }
    }

    case 'eda_set_no_connect': {
      const ids = Array.isArray(args.primitiveIds) ? args.primitiveIds.map(String) : []
      if (ids.length === 0) throw new Error('primitiveIds is required')
      const noConnected = args.noConnected === undefined ? true : Boolean(args.noConnected)
      const results = await mapLimit(ids, 8, async (id) => {
        try { return { id, ok: true, result: await callExtension('sch_PrimitivePin.modify', [id, { noConnected }], timeoutMs) } }
        catch (error) { return { id, ok: false, error: error instanceof Error ? error.message : String(error) } }
      })
      return { noConnected, results }
    }

    case 'eda_draw_wire': {
      const points = flattenPoints(args.points)
      if (points.length < 4 || points.length % 2 !== 0) throw new Error('points must be a flat array with an even length >= 4')
      if (args.net !== undefined && String(args.net) !== '') assertNetName(String(args.net), 'eda_draw_wire')
      const wire = await callExtension('sch_PrimitiveWire.create', [
        points, args.net, args.color,
        args.lineWidth === undefined ? undefined : Number(args.lineWidth),
        args.lineType === undefined ? undefined : Number(args.lineType),
      ], timeoutMs)
      const warnings = args.net === undefined || String(args.net) === '' ? [] : checkNetName(String(args.net)).warnings
      return warnings.length === 0 ? wire : { created: wire, rules: { warnings } }
    }

    case 'eda_draw_rectangle':
      return await callExtension('sch_PrimitiveRectangle.create', [
        Number(args.topLeftX), Number(args.topLeftY), Number(args.width), Number(args.height),
        args.cornerRadius === undefined ? undefined : Number(args.cornerRadius),
        args.rotation === undefined ? undefined : Number(args.rotation),
        args.color, args.fillColor,
        args.lineWidth === undefined ? undefined : Number(args.lineWidth),
        args.lineType === undefined ? undefined : Number(args.lineType),
        args.fillStyle,
      ], timeoutMs)

    case 'eda_draw_functional_box': {
      const margin = args.margin === undefined ? 1 : Number(args.margin)
      let ids = Array.isArray(args.componentIds) ? args.componentIds.map(String) : []
      if (ids.length === 0) {
        const all = await callExtension('sch_PrimitiveComponent.getAll', ['part', false], timeoutMs)
        if (Array.isArray(all)) ids = all.map((item) => extractPrimitiveId(item)).filter((id) => typeof id === 'string')
      }
      if (ids.length === 0) throw new Error('no components found to box')
      const bbox = await bboxOf(ids, timeoutMs)
      if (bbox === undefined) throw new Error('could not compute component bounding box')
      const left = bbox.minX - margin
      const right = bbox.maxX + margin
      const bottom = bbox.minY - margin
      const top = bbox.maxY + margin
      const rectangle = await callExtension('sch_PrimitiveRectangle.create', [
        left, top, right - left, top - bottom, 0, 0, args.color ?? null, 'none',
        args.lineWidth === undefined ? 1 : Number(args.lineWidth),
        args.lineType === undefined ? 1 : Number(args.lineType), 'None',
      ], timeoutMs)
      let label
      if (typeof args.label === 'string' && args.label.trim() !== '') {
        label = await callExtension('sch_PrimitiveText.create', [
          left + 4, top - 14, args.label, 0, null, null, 12, false, false, false, 1,
        ], timeoutMs)
      }
      return { bbox, box: { left, right, bottom, top }, rectangle, label }
    }

    case 'eda_draw_circle':
      return await callExtension('sch_PrimitiveCircle.create', [
        Number(args.centerX), Number(args.centerY), Number(args.radius), args.color, args.fillColor,
        args.lineWidth === undefined ? undefined : Number(args.lineWidth),
        args.lineType === undefined ? undefined : Number(args.lineType), args.fillStyle,
      ], timeoutMs)

    case 'eda_draw_text':
      return await callExtension('sch_PrimitiveText.create', [
        Number(args.x), Number(args.y), String(args.content), Number(args.rotation ?? 0),
        args.textColor, args.fontName,
        args.fontSize === undefined ? undefined : Number(args.fontSize),
        Boolean(args.bold ?? false), Boolean(args.italic ?? false), Boolean(args.underLine ?? false),
        args.alignMode === undefined ? undefined : Number(args.alignMode),
      ], timeoutMs)

    case 'eda_save_document':
      return await callExtension('sch_Document.save', [], timeoutMs)

    case 'eda_zoom_to_fit': {
      // The API reported bounds outside the sheet (left:-340, bottom:-772.9 on A4),
      // which is useless for a caller that wants to know what it is looking at.
      // Clamp the region to the page frame and re-apply it.
      const raw = await callExtension('dmt_EditorControl.zoomToAllPrimitives', [args.tabId], timeoutMs)
      const record = asRecord(raw)
      const left = Number(pickValue(record, 'left', 'Left'))
      const right = Number(pickValue(record, 'right', 'Right'))
      const bottom = Number(pickValue(record, 'bottom', 'Bottom'))
      const top = Number(pickValue(record, 'top', 'Top'))
      if (![left, right, bottom, top].every(value => Number.isFinite(value))) return raw
      const frame = paperOf(args.paper).frame
      const clamped = {
        left: Math.max(frame.left, left), right: Math.min(frame.right, right),
        bottom: Math.max(frame.bottom, bottom), top: Math.min(frame.top, top),
      }
      if (clamped.left >= clamped.right || clamped.bottom >= clamped.top) {
        return { ...record, requested: { left, right, bottom, top }, clamped: null, note: 'the primitive bounds do not overlap the page frame' }
      }
      await callExtension('dmt_EditorControl.zoomToRegion', [
        clamped.left, clamped.right, clamped.top, clamped.bottom, args.tabId,
      ], timeoutMs)
      return { ...record, requested: { left, right, bottom, top }, clamped }
    }

    case 'eda_zoom_to_region':
      return await callExtension('dmt_EditorControl.zoomToRegion', [
        Number(args.left), Number(args.right), Number(args.top), Number(args.bottom), args.tabId,
      ], timeoutMs)

    case 'eda_get_components': {
      const raw = await callExtension('sch_PrimitiveComponent.getAll', ['part', Boolean(args.allSchematicPages ?? false)], timeoutMs)
      if (!Array.isArray(raw)) return raw
      const summarized = raw.map(summarizePrimitive)
      if (args.includeBounds === false) return summarized
      return await mapLimit(summarized, 8, async (item) => {
        const id = typeof item.primitiveId === 'string' ? item.primitiveId : undefined
        if (id === undefined) return item
        try {
          const bbox = await bboxOf([id], timeoutMs)
          return bbox === undefined ? item : { ...item, bbox, width: bbox.maxX - bbox.minX, height: bbox.maxY - bbox.minY }
        } catch { return item }
      })
    }

    case 'eda_get_wires': {
      const raw = await callExtension('sch_PrimitiveWire.getAll', [], timeoutMs)
      if (Array.isArray(raw)) return raw.map(summarizePrimitive)
      return raw
    }

    case 'eda_get_nets': {
      if (typeof args.name === 'string' && args.name !== '') {
        const single = await callExtension('sch_Net.getNet', [args.name], timeoutMs)
        if (single !== undefined && single !== null) return { source: 'sch_Net.getNet', net: single }
        return { source: 'sch_Net.getNet', net: null, hint: NET_EMPTY_HINT }
      }
      const project = await callExtension('sch_Net.getCurrentProjectAllNets', [], timeoutMs)
      if (Array.isArray(project) && project.length > 0) return { source: 'sch_Net.getCurrentProjectAllNets', count: project.length, nets: project }
      const all = await callExtension('sch_Net.getAllNets', [], timeoutMs)
      if (Array.isArray(all) && all.length > 0) return { source: 'sch_Net.getAllNets', count: all.length, nets: all }
      if (args.parseNetlist === false) return { source: 'sch_Net.*', count: 0, nets: [], hint: NET_EMPTY_HINT }
      const parsed = await parseNetlist(Array.isArray(all) ? all : project, timeoutMs)
      return parsed
    }

    case 'eda_run_drc': {
      // includeVerboseError:true makes the API return one record per problem; the
      // boolean overload only said "something is wrong" and gave nothing to locate.
      const verbose = await callExtension('sch_Drc.check', [
        args.strict === undefined ? true : Boolean(args.strict), false, true,
      ], toolTimeout(args, timeoutMs))
      if (Array.isArray(verbose)) {
        return {
          ok: verbose.length === 0,
          count: verbose.length,
          entries: verbose.map((entry) => {
            const record = asRecord(entry)
            return {
              type: pickValue(record, 'Type', 'type', 'Level', 'level') ?? null,
              message: pickValue(record, 'Message', 'message', 'Error', 'error', 'Description', 'description') ?? null,
              primitiveId: pickValue(record, 'PrimitiveId', 'primitiveId') ?? null,
              x: pickValue(record, 'X', 'x') ?? null,
              y: pickValue(record, 'Y', 'y') ?? null,
              raw: entry,
            }
          }),
          hint: 'EDA 3.2.186 returns AGGREGATED entries only (e.g. {type:"warn",count:1}) even with includeVerboseError, so message/primitiveId stay null — "raw" carries exactly what the app sent. Per-problem coordinates are not available on this build; use eda_pcb_run_drc for the PCB side and the DRC panel for details.',
        }
      }
      return { ok: Boolean(verbose), count: null, entries: [], raw: verbose }
    }

    case 'eda_auto_layout':
    case 'eda_auto_route': {
      // Standing rule from the user: do not auto-lay-out or auto-route unless asked.
      if (ALLOW_AUTO_LAYOUT !== true && args.force !== true) {
        throw new Error(name + ' is disabled by policy (settings allowAutoLayoutRouting=false, env DSH_EDA_ALLOW_AUTO_LAYOUT). Do NOT retry with force:true unless the user explicitly asked for automatic layout/routing.',
          '',
          'Do this instead, in order:',
          '1. eda_get_active_document — make sure a schematic page is active (eda_open_document if not).',
          '2. eda_get_page_info — read the A4 frame and the safe areas before placing anything.',
          '3. eda_get_components — see what is already placed and where (x/y + bounding boxes) to avoid overlap.',
          '4. Place or move parts yourself on a 10-unit grid: eda_place_component for new ones, eda_move_component (keeps designator/value) to re-grid existing ones. Signal flow left to right, power rails on top, ground at the bottom, >=20 units between symbols for wires and labels.',
          '5. Connect with eda_draw_wire for local nets; for anything that spans the sheet use eda_place_net_port or a net label (a wire net name is overridden by connectivity once an endpoint touches a pin).',
          '6. Verify: eda_export_netlist (every net should have >=2 endpoints) and eda_run_drc (per-problem entries). For a visual check export the canvas to an image and look at it, rather than letting EDA rearrange the sheet.',
          '7. Call eda_workflow_guide for the full standard.',)
      }
      const payload = Array.isArray(args.uuids) ? { uuids: args.uuids.map(String) } : undefined
      return await callExtension(name === 'eda_auto_layout' ? 'sch_Document.autoLayout' : 'sch_Document.autoRouting', [payload], toolTimeout(args, timeoutMs))
    }

    case 'eda_export_netlist': {
      const payload = await callExtension('sch_ManufactureData.getNetlistFile', [
        undefined, typeof args.type === 'string' && args.type !== '' ? args.type : undefined,
      ], toolTimeout(args, timeoutMs))
      const text = typeof payload === 'string'
        ? payload
        : (payload !== null && typeof payload === 'object' && typeof payload.text === 'string' ? payload.text : undefined)
      if (text === undefined) return { parsed: false, netlist: payload ?? null }
      if (args.format === 'text') return { parsed: false, netlistText: text, bytes: text.length }
      // The API hands back a JSON document; returning it as an escaped string forced
      // callers to parse twice (and once more through the MCP envelope).
      try {
        return { parsed: true, bytes: text.length, netlist: JSON.parse(text) }
      } catch {
        return { parsed: false, bytes: text.length, netlistText: text }
      }
    }

    case 'eda_export_bom': {
      const format = args.format === 'xlsx' ? 'xlsx' : 'csv'
      const payload = await callExtension('sch_ManufactureData.getBomFile', [undefined, format], toolTimeout(args, timeoutMs))
      if (format === 'xlsx') return payload
      const raw = typeof payload === 'string'
        ? payload
        : (payload !== null && typeof payload === 'object' && typeof payload.text === 'string' ? payload.text : '')
      // Measured: with the PCB active the export answers null and this used to return
      // { bom: '', encoding: 'unknown' }, which reads like an empty BOM instead of the
      // real cause. Say it plainly, like eda_export_netlist does.
      if (raw === '') {
        throw new Error('eda_export_bom: no BOM data (the schematic page must be the active document; ' +
          'call eda_get_active_document, then eda_open_document on the schematic page and retry)')
      }
      // The extension (0.4.1+) decodes text payloads with the encoding named by their BOM;
      // decodeTextPayload stays as a fallback for older extensions.
      const encoding = payload !== null && typeof payload === 'object' ? payload.encoding : undefined
      return { format, bom: decodeTextPayload(raw), encoding: encoding ?? 'unknown' }
    }

    case 'eda_delete_primitive': {
      const kind = String(args.kind)
      // Net ports / flags / labels are attribute primitives; without these kinds the
      // only way to remove one was to remember the id from the placement call.
      const className = kind === 'netport' || kind === 'netflag' || kind === 'netlabel'
        ? 'sch_PrimitiveAttribute'
        : primitiveKindToClass(kind)
      return await callExtension(className + '.delete', [String(args.primitiveId)], timeoutMs)
    }

    case 'eda_move_component':
      // Schematic parts could only be moved through raw sch_PrimitiveComponent.modify.
      return await callExtension('sch_PrimitiveComponent.modify', [String(args.primitiveId), {
        x: args.x === undefined ? undefined : Number(args.x),
        y: args.y === undefined ? undefined : Number(args.y),
        rotation: args.rotation === undefined ? undefined : Number(args.rotation),
        mirror: args.mirror === undefined ? undefined : Boolean(args.mirror),
      }], timeoutMs)

    case 'eda_list_api_methods': {
      // Ask the running extension first: its answer is the real capability boundary.
      const live = await extensionApiMethods(timeoutMs, args.refresh === true)
      if (live !== undefined) {
        return {
          source: 'extension',
          extensionVersion: live.version,
          count: live.all.length,
          allowedCount: live.allowed.length,
          fileCount: live.files.length,
          fileMethods: live.files,
          methods: live.all,
          note: 'This is the list the connected extension enforces (dsh.internal.listApiMethods). sendable:true means eda_api_call will forward it.',
        }
      }
      return {
        source: 'bridge-local-copy',
        stale: true,
        count: ALLOWED_API.size,
        methods: [...ALLOWED_API].sort(),
        note: 'The connected extension does not expose its list (older zip), so this is the bridge copy — it may be narrower than what the extension accepts. eda_api_call forwards unknown methods and reports the extension verdict, so try the call instead of trusting this list.',
      }
    }

    case 'pcb_draw_text': {
      const text = String(args.text ?? '')
      if (text.trim() === '') throw new Error('pcb_draw_text requires text')
      if (text.length > 200) throw new Error('pcb_draw_text: longer than 200 characters is probably a mistake; split it')
      const silkLayer = args.layer === undefined ? PCB_LAYERS.topSilkscreen : resolvePcbLayer(args.layer)
      const fontSize = args.fontSize === undefined ? 40 : Number(args.fontSize)
      // pcb_PrimitiveString is the PCB text primitive (silkscreen / assembly / document).
      return await callExtension('pcb_PrimitiveString.create', [
        silkLayer, Number(args.x), Number(args.y), text, 'Arial', fontSize,
        args.lineWidth === undefined ? Math.max(6, Math.round(fontSize / 6)) : Number(args.lineWidth),
        args.alignMode === undefined ? 1 : Number(args.alignMode),
        args.rotation === undefined ? 0 : Number(args.rotation),
        false, 0, Boolean(args.mirror ?? false), Boolean(args.locked ?? false),
      ], timeoutMs)
    }

    case 'pcb_draw_mounting_hole': {
      const holeX = Number(args.x)
      const holeY = Number(args.y)
      const holeDiameter = Number(args.diameter)
      if (![holeX, holeY, holeDiameter].every(value => Number.isFinite(value)) || holeDiameter <= 0) {
        throw new Error('pcb_draw_mounting_hole requires numeric x/y and a positive diameter (mil)')
      }
      if (holeDiameter < 20) throw new Error('pcb_draw_mounting_hole: ' + holeDiameter + ' mil is smaller than any drill (>= 20 mil)')
      const holeShape = String(args.shape ?? 'round')
      const holeRotation = args.rotation === undefined ? 0 : Number(args.rotation)
      // Mounting holes are non-plated by default: metallization:false, no net, no pad copper.
      const metallization = args.plated === true
      let holeSpec
      if (holeShape === 'slot') {
        const slotLength = args.slotLength === undefined ? holeDiameter * 2 : Number(args.slotLength)
        if (!Number.isFinite(slotLength) || slotLength <= holeDiameter) {
          throw new Error('pcb_draw_mounting_hole: slotLength must exceed the slot width (diameter)')
        }
        holeSpec = ['SLOT', holeDiameter, slotLength]
      } else {
        holeSpec = ['ROUND', holeDiameter]
      }
      const holeLayer = args.layer === undefined ? PCB_LAYERS.multi : resolvePcbLayer(args.layer)
      return await callExtension('pcb_PrimitivePad.create', [
        holeLayer, '', holeX, holeY, holeRotation, undefined, undefined, holeSpec,
        0, 0, 0, metallization, undefined, undefined, undefined, undefined, false,
      ], timeoutMs)
    }

    case 'eda_capture': {
      // Geometry math is no substitute for looking at the document.
      const captured = await callExtension('dmt_EditorControl.getCurrentRenderedAreaImage', [], toolTimeout(args, timeoutMs))
      const dataUrl = typeof captured === 'string'
        ? captured
        : (captured !== null && typeof captured === 'object' && typeof captured.dataUrl === 'string' ? captured.dataUrl : '')
      if (dataUrl === '') throw new Error('eda_capture: the app returned no image (is a document tab active?)')
      const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl
      const pngBytes = Buffer.from(base64, 'base64')
      const capturePath = args.outPath === undefined ? '' : String(args.outPath).trim()
      if (capturePath !== '') {
        await writeFile(capturePath, pngBytes)
        return { ok: true, written: capturePath, bytes: pngBytes.length, hint: 'Read the file with the image reader to actually look at the document.' }
      }
      if (args.inline === true) return { ok: true, bytes: pngBytes.length, dataUrl }
      return { ok: true, bytes: pngBytes.length, dataUrlPrefix: dataUrl.slice(0, 32), hint: 'Pass outPath to save a PNG, or inline:true to receive the data URL.' }
    }

    case 'eda_workflow_guide':
      return { summary: WORKFLOW_SUMMARY, guide: WORKFLOW_GUIDE, autoLayoutAllowed: ALLOW_AUTO_LAYOUT }

    case 'eda_create_board':
      return await callExtension('dmt_Board.createBoard', [args.schematicUuid, args.pcbUuid], timeoutMs)

    case 'eda_api_call': {
      if (!ALLOW_RAW_API) throw new Error('eda_api_call is disabled by settings (allowRawApi=false)')
      const method = String(args.method ?? '')
      // No local gate: the extension enforces its own allow-list, and gating here
      // with a drifted copy rejected methods that actually worked. Forward and
      // translate the extension's refusal into something actionable.
      try {
        return await callExtension(method, Array.isArray(args.args) ? args.args : [], timeoutMs)
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure)
        if (!/not allowed/i.test(message)) throw failure
        const live = await extensionApiMethods(timeoutMs, true)
        const hint = live === undefined
          ? 'The connected extension rejected it and does not expose its list (older zip); eda_list_api_methods then shows the bridge copy, which may be narrower than reality.'
          : 'The extension enforces ' + live.all.length + ' methods right now (eda_list_api_methods source:"extension").'
        throw new Error('API method not allowed: ' + method + '. ' + hint +
          ' Wrapped helpers usually exist: eda_get_pins (pins), eda_place_net_labels (labels), eda_pcb_* (PCB primitives).')
      }
    }

    case 'pcb_get_components': {
      const layer = resolvePcbLayer(args.layer)
      const raw = await callExtension('pcb_PrimitiveComponent.getAll', [layer, args.locked === undefined ? undefined : Boolean(args.locked)], timeoutMs)
      if (!Array.isArray(raw)) return raw
      const summarized = raw.map(summarizePrimitive)
      const enrich = async (item) => {
        const id = typeof item.primitiveId === 'string' ? item.primitiveId : undefined
        if (id === undefined) return item
        let enriched = item
        if (args.includePins === true) {
          try {
            // getAllPinsByPrimitiveId is the accurate pad/net source; the pads that
            // ride along with the component object can lag behind a netlist import.
            const pins = await callExtension('pcb_PrimitiveComponent.getAllPinsByPrimitiveId', [id], timeoutMs)
            if (Array.isArray(pins)) {
              enriched = {
                ...enriched,
                pins: pins.map(pin => summarizePrimitive(pin)),
                padNets: pins.map(pin => {
                  const record = asRecord(pin)
                  return { num: pickValue(record, 'Number', 'number', 'num', 'PadNumber'), net: pickValue(record, 'Net', 'net') }
                }).filter(entry => entry.num !== undefined || entry.net !== undefined),
              }
            }
          } catch { /* keep the summary */ }
        }
        if (args.includeBounds === false) return enriched
        try {
          const bboxRaw = await callExtension('pcb_Primitive.getPrimitivesBBox', [[id]], timeoutMs)
          const record = asRecord(bboxRaw)
          if (!Number.isFinite(Number(record.minX))) return enriched
          return { ...enriched, bbox: record, width: Number(record.maxX) - Number(record.minX), height: Number(record.maxY) - Number(record.minY) }
        } catch { return enriched }
      }
      return await mapLimit(summarized, 8, enrich)
    }

    case 'pcb_get_nets': {
      if (typeof args.name === 'string' && args.name !== '') return await callExtension('pcb_Net.getAllNets', [], timeoutMs)
      if (args.detail === true) return await callExtension('pcb_Net.getAllNets', [], timeoutMs)
      return await callExtension('pcb_Net.getAllNetsName', [], timeoutMs)
    }

    case 'pcb_get_layers':
      return await callExtension('pcb_Layer.getAllLayers', [], timeoutMs)

    case 'pcb_place_component': {
      const layer = resolvePcbLayer(args.layer)
      if (layer === undefined) throw new Error('pcb_place_component requires a valid layer')
      return await callExtension('pcb_PrimitiveComponent.create', [
        { libraryUuid: String(args.libraryUuid), uuid: String(args.uuid) }, layer, Number(args.x), Number(args.y),
        args.rotation === undefined ? undefined : Number(args.rotation),
      ], timeoutMs)
    }

    case 'pcb_draw_track': {
      const layer = resolvePcbLayer(args.layer)
      if (layer === undefined) throw new Error('pcb_draw_track requires a valid layer')
      const net = String(args.net)
      assertNetName(net, 'pcb_draw_track')
      await assertKnownPcbNet('pcb_draw_track', net, timeoutMs, args.force === true)
      // Width defaults to the role-based suggestion and is checked against the
      // 0.15 mm design minimum (docs/design-rules.md §5.1); force overrides.
      const width = checkTrackWidth(net, args.lineWidth === undefined ? undefined : Number(args.lineWidth), args.force === true)
      if (!width.ok) throw new Error('pcb_draw_track: ' + width.errors.join('; '))
      const created = await callExtension('pcb_PrimitiveLine.create', [
        net, layer, Number(args.startX), Number(args.startY), Number(args.endX), Number(args.endY),
        width.widthMil,
      ], timeoutMs)
      return { created, rules: { net, role: width.role, widthMil: width.widthMil, suggestedMil: width.suggestedMil, warnings: width.warnings } }
    }

    case 'pcb_draw_via': {
      const net = String(args.net)
      assertNetName(net, 'pcb_draw_via')
      await assertKnownPcbNet('pcb_draw_via', net, timeoutMs, args.force === true)
      // Defaults follow the standard drill pairs; geometry is checked in mm.
      const role = classifyNet(net)
      const defaultVia = role === 'signal' ? VIA_SIZES_MM[0] : VIA_SIZES_MM[1]
      const hole = args.holeDiameter === undefined ? defaultVia.hole * 39.37007874015748 : Number(args.holeDiameter)
      const pad = args.diameter === undefined ? defaultVia.pad * 39.37007874015748 : Number(args.diameter)
      const via = checkVia(net, hole, pad, args.force === true)
      if (!via.ok) throw new Error('pcb_draw_via: ' + via.errors.join('; '))
      const created = await callExtension('pcb_PrimitiveVia.create', [
        net, Number(args.x), Number(args.y), hole, pad,
        args.viaType === undefined ? undefined : Number(args.viaType),
      ], timeoutMs)
      return {
        created,
        rules: {
          net, role, holeMm: Number(via.holeMm.toFixed(3)), padMm: Number(via.padMm.toFixed(3)),
          annulusMm: Number(via.annulusMm.toFixed(3)), warnings: via.warnings,
        },
      }
    }

    case 'pcb_draw_board_outline': {
      const points = requireFlatPoints(args.points, tool)
      const lineWidth = args.lineWidth === undefined ? 10 : Number(args.lineWidth)
      if (!Number.isFinite(lineWidth) || lineWidth <= 0) throw new Error(tool + ': lineWidth must be a positive number')
      // A board outline is stored as ONE pcb_PrimitivePolyline whose polygon is
      // built from a TPCB_PolygonSourceArray (verified against JLCEDA project
      // files: ["POLY", id, 0, "", 11, 10, [x,y,"L",...], 1]). pcb_PrimitiveLine
      // is a copper track and refuses layer 11.
      const raw = await callExtension('dsh.internal.polylineCreate', [
        args.net === undefined ? '' : String(args.net),
        PCB_LAYERS.boardOutline,
        buildPolygonSource(points),
        lineWidth,
        args.locked === undefined ? undefined : Boolean(args.locked),
      ], timeoutMs)
      return {
        layer: 'BoardOutline', layerId: PCB_LAYERS.boardOutline, lineWidth,
        pointCount: points.length / 2, closed: true, polyline: summarizePrimitive(raw),
      }
    }

    case 'pcb_draw_polyline': {
      const layer = resolvePcbLayer(args.layer)
      if (layer === undefined) throw new Error('pcb_draw_polyline requires a valid layer')
      const points = requireFlatPoints(args.points, 'pcb_draw_polyline')
      const lineWidth = args.lineWidth === undefined ? 10 : Number(args.lineWidth)
      if (!Number.isFinite(lineWidth) || lineWidth <= 0) throw new Error('pcb_draw_polyline: lineWidth must be a positive number')
      const raw = await callExtension('dsh.internal.polylineCreate', [
        args.net === undefined ? '' : String(args.net), layer, buildPolygonSource(points), lineWidth,
        args.locked === undefined ? undefined : Boolean(args.locked),
      ], timeoutMs)
      return { layer, layerId: layer, lineWidth, pointCount: points.length / 2, closed: true, polyline: summarizePrimitive(raw) }
    }

    case 'eda_pcb_get_polylines': {
      const raw = await callExtension('pcb_PrimitivePolyline.getAll', [
        args.net === undefined ? undefined : String(args.net),
        args.layer === undefined ? undefined : resolvePcbLayer(args.layer),
        args.locked === undefined ? undefined : Boolean(args.locked),
      ], timeoutMs)
      if (!Array.isArray(raw)) return raw
      return { count: raw.length, polylines: raw.map(summarizePrimitive) }
    }

    case 'eda_pcb_delete_polyline':
      return await callExtension('pcb_PrimitivePolyline.delete', [String(args.primitiveId)], timeoutMs)

    case 'eda_pcb_clear_routing': {
      const type = args.type === undefined ? 'all' : String(args.type)
      if (type !== 'all' && type !== 'net' && type !== 'connection') throw new Error('eda_pcb_clear_routing: type must be all, net or connection')
      if (args.mode === 'batched') return await clearRoutingBatched(args, type, timeoutMs)
      if (args.wait === true) {
        return { mode: 'native', type, result: await callExtension('pcb_Document.clearRouting', [type], toolTimeout(args, timeoutMs)) }
      }
      // Clearing every track of a big board easily exceeds any MCP timeout while
      // EDA keeps working, so the native clear runs as a background job.
      try {
        const started = asRecord(await callExtension('dsh.internal.jobStart', ['clearRouting', type], timeoutMs))
        const running = started.started === true || started.alreadyRunning === true
        return {
          mode: 'native', started: started.started === true, alreadyRunning: started.alreadyRunning === true, running, type,
          startedAt: started.startedAt ?? null,
          hint: 'EDA is clearing the routing in the background. Poll eda_pcb_job_status until running=false (do not raise timeouts).',
        }
      } catch (error) {
        if (!isInternalHelperMissing(error)) throw error
        // Older EDA extension without the background-job helper: delete primitives
        // in bounded batches instead, so no single call can time out.
        const first = await clearRoutingBatched(args, type, timeoutMs)
        return { ...first, backgroundUnavailable: true, hint: 'The imported EDA extension has no background-job helper, so routing is deleted in bounded batches: call eda_pcb_clear_routing again until done=true.' }
      }
    }

    case 'pcb_save_document':
      return await callExtension('pcb_Document.save', [], timeoutMs)

    case 'pcb_import_changes': {
      const uuid = args.schematicUuid === undefined || args.schematicUuid === null ? null : String(args.schematicUuid)
      if (args.wait === true) {
        return await callExtension('pcb_Document.importChanges', [uuid === null ? undefined : uuid], toolTimeout(args, timeoutMs))
      }
      // The import opens EDA's own "sync schematic changes" confirmation dialog and
      // blocks until the user answers it, so it is fired as a background job and the
      // user's confirmation is detected by polling for newly imported components.
      pcbComponentBaseline = await pcbComponentIds(timeoutMs)
      let started
      try {
        started = asRecord(await callExtension('dsh.internal.jobStart', ['importChanges', uuid], timeoutMs))
      } catch (error) {
        if (!isInternalHelperMissing(error)) throw error
        // Older EDA extension: no background job helper, so the sync must be awaited.
        const result = await callExtension('pcb_Document.importChanges', [uuid === null ? undefined : uuid], toolTimeout(args, timeoutMs))
        const after = await pcbComponentIds(timeoutMs)
        return {
          triggered: true, backgroundUnavailable: true, importResult: result,
          componentsBefore: pcbComponentBaseline.length, componentsAfter: after.length,
          confirmedYet: after.length > pcbComponentBaseline.length,
          hint: 'The imported EDA extension has no background-job helper, so the sync was awaited. Re-import dsh-eda-bridge-extension-' + VERSION + '.zip to use the async + polling flow.',
        }
      }
      return {
        triggered: started.started === true || started.alreadyRunning === true,
        alreadyRunning: started.alreadyRunning === true,
        confirmedYet: false,
        componentsBefore: pcbComponentBaseline.length,
        hint: 'EDA is showing the sync confirmation dialog. Ask the user to click OK, then call eda_pcb_wait_for_components (low-frequency polling; it returns confirmed=true as soon as new PCB components appear).',
      }
    }

    case 'eda_pcb_wait_for_components': {
      const interval = Math.max(3000, Number(args.pollIntervalMs ?? 5000) || 5000)
      const maxWait = Math.min(Math.max(Number(args.maxWaitMs ?? 45000) || 45000, interval), 300000)
      if (pcbComponentBaseline === null) pcbComponentBaseline = await pcbComponentIds(timeoutMs)
      const baseline = args.baselineIds === undefined && Array.isArray(args.baseline) ? args.baseline.map(String) : pcbComponentBaseline
      let waited = 0
      let ids = await pcbComponentIds(timeoutMs)
      while (true) {
        const fresh = ids.filter(id => !baseline.includes(id))
        if (fresh.length > 0) {
          return {
            confirmed: true, componentsBefore: baseline.length, componentsAfter: ids.length,
            newComponentIds: fresh, waitedMs: waited, pollIntervalMs: interval,
            hint: 'The user confirmed the sync and the PCB now has the new components. Save the PCB (pcb_save_document) before continuing.',
          }
        }
        if (waited >= maxWait) {
          return {
            confirmed: false, componentsBefore: baseline.length, componentsAfter: ids.length,
            waitedMs: waited, pollIntervalMs: interval,
            hint: 'Still no new PCB components - the user has not answered the sync dialog yet (or nothing changed). Ask them to click OK in EDA and call this tool again; polling runs at a deliberately low rate.',
          }
        }
        await sleep(interval)
        waited += interval
        ids = await pcbComponentIds(timeoutMs)
      }
    }

    case 'pcb_get_primitives_in_region':
      return await callExtension('pcb_Document.getPrimitivesInRegion', [
        Number(args.left), Number(args.right), Number(args.top), Number(args.bottom),
        args.leftToRight === undefined ? undefined : Boolean(args.leftToRight),
      ], timeoutMs)

    case 'pcb_navigate_to_region':
      return await callExtension('pcb_Document.navigateToRegion', [
        Number(args.left), Number(args.right), Number(args.top), Number(args.bottom),
      ], timeoutMs)

    case 'eda_pcb_move_component': {
      const property = pickDefined({
        x: args.x === undefined ? undefined : Number(args.x),
        y: args.y === undefined ? undefined : Number(args.y),
        rotation: args.rotation === undefined ? undefined : Number(args.rotation),
        layer: args.layer === undefined ? undefined : resolvePcbLayer(args.layer),
        designator: args.designator,
        name: args.name,
        primitiveLock: args.locked === undefined ? undefined : Boolean(args.locked),
      }, ['x', 'y', 'rotation', 'layer', 'designator', 'name', 'primitiveLock'])
      const keys = Object.keys(property)
      if (keys.length === 0) throw new Error('eda_pcb_move_component requires at least one of x, y, rotation, layer, designator, name, locked')
      for (const key of ['x', 'y', 'rotation']) {
        if (property[key] !== undefined && !Number.isFinite(property[key])) throw new Error('eda_pcb_move_component: ' + key + ' must be a finite number')
      }
      if (args.layer !== undefined && property.layer === undefined) throw new Error('eda_pcb_move_component: invalid layer ' + String(args.layer))
      const raw = await callExtension('pcb_PrimitiveComponent.modify', [String(args.primitiveId), property], timeoutMs)
      return summarizePrimitive(raw)
    }

    case 'eda_pcb_delete_component':
      return await callExtension('pcb_PrimitiveComponent.delete', [String(args.primitiveId)], timeoutMs)

    case 'eda_pcb_get_tracks': {
      const raw = await pcbPrimitiveList('pcb_PrimitiveLine.getAll', [
        args.net === undefined ? undefined : String(args.net),
        args.layer === undefined ? undefined : resolvePcbLayer(args.layer),
        args.locked === undefined ? undefined : Boolean(args.locked),
      ], timeoutMs)
      return { count: raw.length, tracks: raw.map(summarizePrimitive) }
    }

    case 'eda_pcb_modify_track': {
      const layer = args.layer === undefined ? undefined : resolvePcbLayer(args.layer)
      if (args.layer !== undefined && layer === undefined) throw new Error('eda_pcb_modify_track: invalid layer ' + String(args.layer))
      const property = pickDefined({
        net: args.net,
        layer,
        startX: args.startX === undefined ? undefined : Number(args.startX),
        startY: args.startY === undefined ? undefined : Number(args.startY),
        endX: args.endX === undefined ? undefined : Number(args.endX),
        endY: args.endY === undefined ? undefined : Number(args.endY),
        lineWidth: args.lineWidth === undefined ? undefined : Number(args.lineWidth),
        primitiveLock: args.locked === undefined ? undefined : Boolean(args.locked),
      }, ['net', 'layer', 'startX', 'startY', 'endX', 'endY', 'lineWidth', 'primitiveLock'])
      const keys = Object.keys(property)
      if (keys.length === 0) throw new Error('eda_pcb_modify_track requires at least one of net, layer, startX, startY, endX, endY, lineWidth, locked')
      for (const key of ['startX', 'startY', 'endX', 'endY', 'lineWidth']) {
        if (property[key] !== undefined && !Number.isFinite(property[key])) throw new Error('eda_pcb_modify_track: ' + key + ' must be a finite number')
      }
      const raw = await callExtension('pcb_PrimitiveLine.modify', [String(args.primitiveId), property], timeoutMs)
      return summarizePrimitive(raw)
    }

    case 'eda_pcb_delete_track':
      return await callExtension('pcb_PrimitiveLine.delete', [String(args.primitiveId)], timeoutMs)

    case 'eda_pcb_get_vias': {
      const raw = await pcbPrimitiveList('pcb_PrimitiveVia.getAll', [
        args.net === undefined ? undefined : String(args.net),
        args.locked === undefined ? undefined : Boolean(args.locked),
      ], timeoutMs)
      return { count: raw.length, vias: raw.map(summarizePrimitive) }
    }

    case 'eda_pcb_delete_via':
      return await callExtension('pcb_PrimitiveVia.delete', [String(args.primitiveId)], timeoutMs)

    case 'eda_pcb_create_pour': {
      const layer = resolveRegionLayer(args.layer, 'eda_pcb_create_pour')
      const points = requireFlatPoints(args.points, 'eda_pcb_create_pour')
      assertNetName(String(args.net), 'eda_pcb_create_pour')
      const fill = args.pourFillMethod === undefined ? undefined : String(args.pourFillMethod)
      if (fill !== undefined && fill !== '45grid' && fill !== '90grid' && fill !== 'solid') throw new Error('eda_pcb_create_pour: pourFillMethod must be 45grid, 90grid or solid')
      // This build rejects some pour argument combinations ("无法创建覆铜边框图元"),
      // so a plain-GND pour is retried once with the most conservative settings
      // before the caller is told to pour by hand.
      const attempt = async (fillMethod, preserveSilos) => callExtension('dsh.internal.pourCreate', [
        String(args.net), layer, buildPolygonSource(points), fillMethod,
        preserveSilos,
        args.pourName === undefined ? undefined : String(args.pourName),
        args.pourPriority === undefined ? undefined : Number(args.pourPriority),
        args.lineWidth === undefined ? undefined : Number(args.lineWidth),
        args.locked === undefined ? undefined : Boolean(args.locked),
      ], timeoutMs)
      let raw
      let retried = false
      try {
        raw = await attempt(fill, args.preserveSilos === undefined ? undefined : Boolean(args.preserveSilos))
      } catch (firstFailure) {
        retried = true
        try {
          raw = await attempt('solid', false)
        } catch (secondFailure) {
          const detail = secondFailure instanceof Error ? secondFailure.message : String(secondFailure)
          throw new Error('eda_pcb_create_pour failed twice (first: ' +
            (firstFailure instanceof Error ? firstFailure.message : String(firstFailure)) + '; retry: ' + detail + '). ' +
            'This EDA build rejects API pour creation for some polygons: confirm every point is inside the board outline and the layer is copper, ' +
            'or pour by hand in the PCB editor (覆铜 → GND → top+bottom); eda_design_audit keeps reporting it as a warn until then.')
        }
      }
      return {
        net: String(args.net), layer, layerId: layer, pointCount: points.length / 2, pour: summarizePrimitive(raw), retried,
        rules: {
          clearanceMil: { required: POUR_CLEARANCE_MIN_MIL, recommended: POUR_CLEARANCE_RECOMMENDED_MIL },
          note: 'The pour/clearance value lives in the board design rules, not in this call: set it in 设计 → 设计规则 (recommended ' + POUR_CLEARANCE_RECOMMENDED_MIL + ' mil) and remove islands before exporting.',
        },
      }
    }

    case 'eda_pcb_get_pours': {
      const raw = await callExtension('pcb_PrimitivePour.getAll', [
        args.net === undefined ? undefined : String(args.net),
        args.layer === undefined ? undefined : resolveRegionLayer(args.layer, 'eda_pcb_get_pours'),
        args.locked === undefined ? undefined : Boolean(args.locked),
      ], timeoutMs)
      if (!Array.isArray(raw)) return raw
      return { count: raw.length, pours: raw.map(summarizePrimitive) }
    }

    case 'eda_pcb_delete_pour':
      return await callExtension('pcb_PrimitivePour.delete', [String(args.primitiveId)], timeoutMs)

    case 'eda_pcb_run_drc': {
      const strict = args.strict === undefined ? true : Boolean(args.strict)
      const userInterface = args.userInterface === undefined ? false : Boolean(args.userInterface)
      const verbose = args.includeVerboseError === undefined ? true : Boolean(args.includeVerboseError)
      const callTimeout = toolTimeout(args, timeoutMs)
      const result = await callExtension('pcb_Drc.check', [strict, userInterface, verbose], callTimeout)
      if (Array.isArray(result)) {
        return { checkPassed: result.length === 0, violationCount: result.length, violations: result, strict, userInterface }
      }
      return { checkPassed: result === true, result, strict, userInterface }
    }

    case 'eda_pcb_get_drc_rules': {
      const name = await callExtension('pcb_Drc.getCurrentRuleConfigurationName', [], timeoutMs)
      let configuration
      try { configuration = await callExtension('pcb_Drc.getCurrentRuleConfiguration', [], timeoutMs) } catch { configuration = undefined }
      const realTime = await (async () => { try { return await callExtension('pcb_Drc.getRealTimeDrcStatus', [], timeoutMs) } catch { return undefined } })()
      return { ruleConfigurationName: name ?? null, configuration: configuration ?? null, realTimeDrcRunning: realTime ?? null }
    }

    case 'eda_pcb_set_net_track_width': {
      const net = String(args.net)
      const lineWidth = Number(args.lineWidth)
      if (!Number.isFinite(lineWidth) || lineWidth <= 0) throw new Error('eda_pcb_set_net_track_width: lineWidth must be a positive number (mil)')
      const width = checkTrackWidth(net, lineWidth, args.force === true)
      if (!width.ok) throw new Error('eda_pcb_set_net_track_width: ' + width.errors.join('; '))
      const layer = args.layer === undefined ? undefined : resolvePcbLayer(args.layer)
      if (args.layer !== undefined && layer === undefined) throw new Error('eda_pcb_set_net_track_width: invalid layer ' + String(args.layer))
      const raw = await callExtension('pcb_PrimitiveLine.getAll', [net, layer, undefined], timeoutMs)
      if (!Array.isArray(raw)) return raw
      const ids = raw.map(track => pickValue(asRecord(track), 'PrimitiveId', 'primitiveId')).filter(id => typeof id === 'string')
      const results = await mapLimit(ids, 8, async (id) => {
        try {
          await callExtension('pcb_PrimitiveLine.modify', [id, { lineWidth }], timeoutMs)
          return { primitiveId: id, ok: true }
        } catch (error) {
          return { primitiveId: id, ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      })
      const failed = results.filter(item => item.ok === false)
      return { net, lineWidth, layer: layer ?? null, matched: ids.length, updated: ids.length - failed.length, failed, results: args.verbose === true ? results : undefined }
    }

    case 'eda_design_audit':
      return await auditPcb(args, timeoutMs)

    case 'eda_pcb_get_regions': {
      const raw = await callExtension('pcb_PrimitiveRegion.getAll', [
        args.layer === undefined ? undefined : resolveRegionLayer(args.layer, 'eda_pcb_get_regions'),
        Array.isArray(args.ruleType) ? args.ruleType.map(Number) : undefined,
        args.locked === undefined ? undefined : Boolean(args.locked),
      ], timeoutMs)
      if (!Array.isArray(raw)) return raw
      return { count: raw.length, regions: raw.map(summarizePrimitive) }
    }

    case 'eda_pcb_create_region': {
      const layer = resolveRegionLayer(args.layer, 'eda_pcb_create_region')
      const points = requireFlatPoints(args.points, 'eda_pcb_create_region')
      const ruleType = Array.isArray(args.ruleType) && args.ruleType.length > 0 ? args.ruleType.map(Number) : undefined
      const lineWidth = args.lineWidth === undefined ? undefined : Number(args.lineWidth)
      const raw = await callExtension('dsh.internal.pcbCreateRegion', [
        layer, buildPolygonSource(points), ruleType,
        args.regionName === undefined ? undefined : String(args.regionName), lineWidth,
        args.locked === undefined ? undefined : Boolean(args.locked),
      ], timeoutMs)
      return { pointCount: points.length / 2, region: summarizePrimitive(raw) }
    }

    case 'eda_pcb_delete_region':
      return await callExtension('pcb_PrimitiveRegion.delete', [String(args.primitiveId)], timeoutMs)

    case 'eda_pcb_auto_place': {
      if (args.wait === false) {
        let started
        try {
          started = asRecord(await callExtension('dsh.internal.jobStart', ['autoLayout', null], timeoutMs))
        } catch (error) {
          if (!isInternalHelperMissing(error)) throw error
          const blocking = await callExtension('pcb_Document.autoLayout', [], toolTimeout(args, timeoutMs))
          return { backgroundUnavailable: true, result: blocking, hint: 'The imported EDA extension has no background-job helper, so layout was awaited.' }
        }
        return { started: started.started === true, alreadyRunning: started.alreadyRunning === true, running: started.started === true || started.alreadyRunning === true, hint: 'Poll eda_pcb_job_status until running=false.' }
      }
      return await callExtension('pcb_Document.autoLayout', [], toolTimeout(args, timeoutMs))
    }

    case 'eda_pcb_job_status': {
      const status = asRecord(await callExtension('dsh.internal.jobStatus', [], timeoutMs))
      if (status.job === null && status.running === false) {
        return { running: false, job: null, hint: 'No background PCB job has been started in this EDA session (or the extension was reloaded).' }
      }
      const finished = asRecord(status.result)
      const failed = Array.isArray(finished.failedNets) ? finished.failedNets : []
      if (typeof status.result === 'boolean') {
        return {
          ...status, error,
          hint: status.result === true
            ? 'Finished: EDA reported the operation succeeded. Routing is cleared - re-run eda_pcb_auto_route when you want to route again.'
            : 'Finished, but EDA reported failure (nothing was cleared or the operation was rejected).',
        }
      }
      const error = status.error === null || status.error === undefined ? null : String(status.error)
      const hint = status.running === true
        ? 'Still running in EDA; poll again in ~10 s.'
        : (error !== null
          ? 'The job failed: ' + error
          : (finished.success === false
            ? 'Finished with success=false. duration=0 means the engine refused to start (check that the board outline is one closed polyline on layer 11, that design rules exist, and that nets really have unrouted connections).'
            : (failed.length > 0 ? 'Finished with ' + failed.length + ' unrouted net(s); re-run only those nets, then run eda_pcb_run_drc.' : 'Finished. Next: eda_pcb_run_drc, then eda_pcb_set_net_track_width for power/GND nets.')))
      return { ...status, error, hint }
    }

    case 'eda_pcb_auto_route': {
      const extra = args.props === undefined || args.props === null ? {} : asRecord(args.props)
      // The official doc example uses "nets" but the shipped implementation only
      // reads "RoutingNets", so both are accepted here.
      const explicit = args.RoutingNets ?? args.nets ?? extra.RoutingNets ?? extra.nets
      let requested
      const explicitEmpty = Array.isArray(explicit) && explicit.length === 0
      if (explicit !== undefined && explicit !== null && !explicitEmpty) requested = explicit
      else {
        // Every net must be passed explicitly: with an empty routingRange this EDA
        // build answers success=false, duration=0 and fails every net.
        const names = await callExtension('pcb_Net.getAllNetsName', [], timeoutMs)
        if (!Array.isArray(names) || names.length === 0) {
          throw new Error('eda_pcb_auto_route: the active PCB reports no nets. Either the PCB document is not the active tab (PCB APIs only work while the PCB page is in front - check eda_get_active_document / eda_open_document), or the schematic changes have not been imported yet (pcb_import_changes).')
        }
        requested = names.map(String)
      }
      const extraProps = Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'nets' && key !== 'RoutingNets'))
      const props = { RoutingNets: requested, ...extraProps }
      if (args.ignoreNets !== undefined) props.ignoreNets = args.ignoreNets
      if (args.layers !== undefined) props.layers = args.layers
      if (args.cornerStyle !== undefined) props.cornerStyle = args.cornerStyle
      if (args.optimization !== undefined) props.optimization = args.optimization
      if (args.existingPrimitiveMode !== undefined) props.existingPrimitiveMode = args.existingPrimitiveMode
      if (args.wait !== true) {
        let started
        try {
          started = asRecord(await callExtension('dsh.internal.jobStart', ['autoRoute', props], timeoutMs))
        } catch (error) {
          if (!isInternalHelperMissing(error)) throw error
          // Older EDA extension without the background-job helper: fall back to the
          // blocking call (which may hit the tool timeout for large boards).
          const blocking = asRecord(await callExtension('pcb_Document.autoRouting', [props], toolTimeout(args, timeoutMs)))
          return { ...blocking, backgroundUnavailable: true, props, hint: 'The imported EDA extension has no background-job helper, so routing was awaited. Re-import dsh-eda-bridge-extension-' + VERSION + '.zip to get the async + polling flow.' }
        }
        const running = started.started === true || started.alreadyRunning === true
        return {
          started: started.started === true, alreadyRunning: started.alreadyRunning === true, running,
          startedAt: started.startedAt ?? null, requestedNets: Array.isArray(requested) ? requested.length : 0, props,
          hint: started.started === true
            ? 'EDA is routing in the background (its progress bar is visible in the PCB editor). Poll eda_pcb_job_status until running=false, then run eda_pcb_run_drc. Do not raise timeouts - the job outlives the MCP call.'
            : 'A PCB job is already running; poll eda_pcb_job_status.',
        }
      }
      const result = await callExtension('pcb_Document.autoRouting', [props], toolTimeout(args, timeoutMs))
      const record = asRecord(result)
      const failed = Array.isArray(record.failedNets) ? record.failedNets : []
      const requestedCount = Array.isArray(requested) ? requested.length : 0
      const hint = record.success === true
        ? (failed.length === 0 ? 'ok' : 'The router returned success but left ' + failed.length + ' net(s) unrouted.')
        : 'The router failed. duration=0 means it refused to start: check that the board outline is a single closed polyline on layer 11 (use pcb_draw_board_outline / eda_pcb_get_polylines), that the design rules are configured, and that the nets really have unrouted connections.'
      return { ...record, requestedNets: requestedCount, props, hint }
    }

    case 'eda_pcb_export_gerber': {
      const unit = args.unit === undefined ? undefined : String(args.unit)
      if (unit !== undefined && unit !== 'mm' && unit !== 'inch') throw new Error('eda_pcb_export_gerber: unit must be "mm" or "inch"')
      const digitalFormat = args.integerNumber === undefined && args.decimalNumber === undefined ? undefined : {
        integerNumber: args.integerNumber === undefined ? 4 : Number(args.integerNumber),
        decimalNumber: args.decimalNumber === undefined ? 4 : Number(args.decimalNumber),
      }
      const payload = await callExtension('pcb_ManufactureData.getGerberFile', [
        args.fileName === undefined ? undefined : String(args.fileName),
        args.colorSilkscreen === undefined ? undefined : Boolean(args.colorSilkscreen),
        unit,
        digitalFormat,
        args.other === undefined ? undefined : asRecord(args.other),
        Array.isArray(args.layers) ? args.layers : undefined,
        Array.isArray(args.objects) ? args.objects : undefined,
      ], timeoutMs)
      if (payload === null || payload === undefined) throw new Error('eda_pcb_export_gerber: the API returned no file (is a PCB document active?)')
      return payload
    }

    default:
      throw new Error('unknown tool: ' + name)
  }
}

function writeJson(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
}

async function handleJsonRpc(message) {
  if (message === null || typeof message !== 'object') return
  if (message.jsonrpc !== '2.0') return
  if (message.id !== undefined && message.method !== undefined) {
    try {
      const result = await handleMethod(message.method, message.params ?? {}, message.id)
      if (result !== undefined) writeJson({ jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      writeJson({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
    }
  } else if (message.method !== undefined) {
    try { await handleMethod(message.method, message.params ?? {}, undefined) } catch { /* notifications best-effort */ }
  }
}

async function handleMethod(method, params, _id) {
  if (method === 'initialize') {
    const protocolVersion = params && params.protocolVersion ? params.protocolVersion : '2024-11-05'
    return { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'dsh-eda-mcp-bridge', version: VERSION } }
  }
  if (method === 'notifications/initialized') return undefined
  if (method === 'notifications/cancelled') return undefined
  if (method === 'ping') return {}
  if (method === 'tools/list') return { tools: TOOLS }
  if (method === 'tools/call') {
    const name = String((params && params.name) || '')
    const args = (params && params.arguments) || {}
    try { return toolResult(await executeTool(name, args, TOOL_TIMEOUT_MS)) }
    catch (error) { return toolError(error instanceof Error ? error.message : String(error)) }
  }
  throw new Error('method not found: ' + method)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ status: 'ok', version: VERSION, clients: pickClients().length }))
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname !== '/ws') { socket.destroy(); return }
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || key.length === 0) { socket.destroy(); return }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  const client = new WsConnection(socket)
  clients.add(client)
  socket.on('data', (chunk) => { client.handleData(chunk) })
  socket.on('close', () => { clients.delete(client) })
  socket.on('error', () => { clients.delete(client) })
})

server.on('error', (error) => {
  process.stderr.write('[dsh-eda-mcp] bridge ' + VERSION + ' failed to listen on ' + WS_HOST + ':' + WS_PORT + ' (' +
    (error && error.code ? error.code : String(error)) + '). Another dsh-eda-mcp bridge process is probably still running; ' +
    'stop the stale process (netstat -ano | findstr ' + WS_PORT + ') and reconnect.\n')
})

server.listen(WS_PORT, WS_HOST, () => {
  process.stderr.write('[dsh-eda-mcp] bridge ' + VERSION + ' listening on ws://' + WS_HOST + ':' + WS_PORT + '/ws\n')
})

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  try { void handleJsonRpc(JSON.parse(line)) } catch { /* ignore malformed stdin lines */ }
})

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  for (const client of clients) client.close()
  clients.clear()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}

process.stdin.on('end', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
