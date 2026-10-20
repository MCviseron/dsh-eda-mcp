/* eslint-disable */
/**
 * dsh-eda-mcp — JLCEDA Pro bridge extension (version injected from extension.json).
 *
 * Connects to the local dsh-eda-mcp bridge process over WebSocket and executes
 * a strict allow-list of official EasyEDA Pro extension APIs. Import through:
 *   Extensions → Import → select dsh-eda-bridge-extension-<version>.zip
 *   then enable "Allow interactive with external" for this extension.
 */
var DSH_EDA_MCP = {
  version: '__EXTENSION_VERSION__',
  connect: null,
  disconnect: null,
  status: null,
  isConnected: function () { return false; }
};

/**
 * Header-menu callbacks. The JLCEDA extension runner resolves registerFn names
 * in this script scope, so these declarations must stay at top level.
 */
function dshEdaMcpConnect() {
  if (typeof DSH_EDA_MCP.connect === 'function') return DSH_EDA_MCP.connect();
  return undefined;
}

function dshEdaMcpDisconnect() {
  if (typeof DSH_EDA_MCP.disconnect === 'function') return DSH_EDA_MCP.disconnect();
  return undefined;
}

function dshEdaMcpStatus() {
  if (typeof DSH_EDA_MCP.status === 'function') return DSH_EDA_MCP.status();
  return undefined;
}

(function () {
  'use strict';

  // Injected from extension.json at build time: a hand-maintained constant here
  // went stale once and made the bridge report a version mismatch forever.
  var VERSION = '__EXTENSION_VERSION__';
  var WS_ID = 'dsh-eda-mcp-bridge';
  var WS_PORT = 39009;
  var WS_URL = 'ws://127.0.0.1:' + WS_PORT + '/ws';
  var HEARTBEAT_MS = 10000;

  function earlyToast(message, type) {
    try {
      if (typeof eda !== 'undefined' && eda.sys_Message && typeof eda.sys_Message.showToastMessage === 'function') {
        eda.sys_Message.showToastMessage(message, type || 'info', 5);
      }
    } catch (_) { /* ignore */ }
  }

  earlyToast('DSH EDA MCP 扩展已加载 v' + VERSION, 'info');

  var globalScope = typeof globalThis !== 'undefined' ? globalThis
    : (typeof window !== 'undefined' ? window : self);
  var previous = globalScope.__DSH_EDA_MCP_BRIDGE_STATE__;
  if (previous && previous.timer) { try { clearInterval(previous.timer); } catch (_) {} }

  var ALLOWED_API = new Set([
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
    'dmt_Team.getAllTeamsInfo',
    'dmt_Team.getAllInvolvedTeamInfo',
    'dmt_Team.getCurrentTeamInfo',
    'dmt_Folder.getAllFoldersUuid',
    'dmt_Folder.getFolderInfo',
    'dmt_Workspace.getCurrentWorkspaceInfo',
    'dmt_Project.getAllProjectsUuid',
    'dmt_Project.getProjectInfo',
    'dmt_Project.getCurrentProjectInfo',
    'dmt_Project.openProject',
    'dmt_Project.createProject',
    'dmt_Project.deleteProject',
    'dmt_Project.modifyProjectFriendlyName',
    'dmt_Project.modifyProjectDescription',
    'dmt_Project.copyProject',
    'dmt_Project.moveProjectToFolder',
    'dmt_Board.createBoard',
    'dmt_Board.getAllBoardsInfo',
    'dmt_Board.getCurrentBoardInfo',
    'dmt_EditorControl.getSplitScreenTree',
    'dmt_EditorControl.getTabsBySplitScreenId',
    'dmt_EditorControl.openDocument',
    'dmt_EditorControl.closeDocument',
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
    'pcb_Document.setCanvasOrigin',
    'pcb_Document.convertCanvasOriginToDataOrigin',
    'pcb_Document.convertDataOriginToCanvasOrigin',
    'pcb_Primitive.getPrimitivesBBox',
    'pcb_PrimitiveComponent.create',
    'pcb_PrimitiveComponent.getAll',
    'pcb_PrimitiveComponent.getAllPrimitiveId',
    'pcb_PrimitiveComponent.getAllPinsByPrimitiveId',
    'pcb_PrimitiveComponent.modify',
    'pcb_PrimitiveComponent.delete',
    'pcb_PrimitiveLine.create',
    'pcb_PrimitiveLine.getAll',
    'pcb_PrimitiveLine.getAllPrimitiveId',
    'pcb_PrimitiveLine.modify',
    'pcb_PrimitiveLine.delete',
    'pcb_PrimitiveVia.create',
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
    'pcb_MathPolygon.createComplexPolygon',
    'pcb_PrimitiveString.create',
    'pcb_PrimitiveString.get',
    'pcb_PrimitiveString.getAll',
    'pcb_PrimitiveString.modify',
    'pcb_PrimitiveString.delete',
    'pcb_PrimitivePad.create',
    'pcb_PrimitivePad.getAll',
    'pcb_PrimitivePad.delete',
    'pcb_PrimitiveFill.create',
    'pcb_PrimitiveFill.getAll',
    'pcb_PrimitiveFill.delete',
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
    'pcb_Document.autoLayout',
    'pcb_Document.autoRouting',
    'pcb_Net.getAllNets',
    'pcb_Net.getAllNetsName',
    'pcb_Layer.getAllLayers',
    'pcb_Layer.getCurrentLayer'
  ]);

  var FILE_METHODS = new Set([
    'sch_ManufactureData.getNetlistFile',
    'sch_ManufactureData.getBomFile',
    'sch_ManufactureData.getBomTemplateFile',
    'pcb_ManufactureData.getNetlistFile',
    'pcb_ManufactureData.getBomFile',
    'pcb_ManufactureData.getGerberFile'
  ]);

  var JOB = null;
  var wsReady = false;
  var lastPongAt = 0;
  var lastRegisterAt = 0;

  function resolveApi(path) {
    var parts = path.split('.');
    var cursor = typeof eda !== 'undefined' ? eda : undefined;
    for (var i = 0; i < parts.length; i++) {
      if (cursor == null) return undefined;
      cursor = cursor[parts[i]];
    }
    return cursor;
  }

  function callApi(method, args) {
    var dot = method.lastIndexOf('.');
    if (dot <= 0 || dot >= method.length - 1) throw new Error('bad API method: ' + method);
    var ownerPath = method.slice(0, dot);
    var fnName = method.slice(dot + 1);
    var owner = resolveApi(ownerPath);
    if (owner == null || typeof owner[fnName] !== 'function') {
      throw new Error('API method not found: ' + method);
    }
    var callArgs = (args || []).map(function (value) { return value === null ? undefined : value; });
    return owner[fnName].apply(owner, callArgs);
  }

  function toJsonable(value) {
    if (value === undefined || value === null || typeof value !== 'object') {
      if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
      return value;
    }
    if (typeof value.toJSON === 'function') {
      try { return toJsonable(value.toJSON()); } catch (_) { /* fall through */ }
    }
    if (Array.isArray(value)) return value.map(toJsonable);

    var out = {};
    var proto = Object.getPrototypeOf(value);
    if (proto != null) {
      var names = Object.getOwnPropertyNames(proto);
      for (var i = 0; i < names.length; i++) {
        var key = names[i];
        if (key === 'constructor') continue;
        var descriptor = Object.getOwnPropertyDescriptor(proto, key);
        var fn = descriptor && typeof descriptor.value === 'function' ? descriptor.value : undefined;
        if (fn && key.indexOf('getState_') === 0) {
          try { out[key.slice('getState_'.length)] = toJsonable(fn.call(value)); } catch (_) { /* skip */ }
        }
      }
    }
    var ownKeys = Object.keys(value);
    for (var j = 0; j < ownKeys.length; j++) {
      var ownKey = ownKeys[j];
      var ownValue = value[ownKey];
      if (typeof ownValue === 'function') continue;
      out[ownKey] = toJsonable(ownValue);
    }
    return out;
  }

  function bytesToBase64(bytes) {
    var chunk = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return btoa(parts.join(''));
  }

  // JSON turns undefined array slots into null; the official API expects
  // undefined (omitted) for optional parameters. One shared helper: the earlier
  // per-helper copies were invisible to the project file helpers.
  function optional(value) { return value === null ? undefined : value; }

  async function blobToDataUrl(blob) {
    var buffer = await blob.arrayBuffer();
    var bytes = new Uint8Array(buffer);
    var mimeType = blob.type || 'image/png';
    return { mimeType: mimeType, dataUrl: 'data:' + mimeType + ';base64,' + bytesToBase64(bytes) };
  }

  async function blobToFilePayload(blob) {
    var mimeType = blob.type || 'application/octet-stream';
    var name = blob.name || '';
    var buffer = await blob.arrayBuffer();
    var bytes = new Uint8Array(buffer);
    var isText = /^text\//i.test(mimeType) ||
      /(csv|json|net|plain|xml)/i.test(mimeType) ||
      /\.(csv|json|txt|net|xml)$/i.test(name);
    if (isText && typeof TextDecoder !== 'undefined') {
      // A blanket UTF-8 decode destroyed text payloads that carry another encoding: the
      // BOM CSV is UTF-16LE, so the bytes became replacement characters before the bridge
      // ever saw them. Detect the BOM and report which decoder ran.
      var encoding = 'utf-8';
      var offset = 0;
      if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) { encoding = 'utf-16le'; offset = 2; }
      else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) { encoding = 'utf-16be'; offset = 2; }
      else if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) { offset = 3; }
      var body = bytes.subarray(offset);
      var text;
      try { text = new TextDecoder(encoding).decode(body); }
      catch (_) { text = new TextDecoder('utf-8').decode(body); encoding = 'utf-8'; }
      return { mimeType: mimeType, name: name, size: bytes.length, encoding: encoding, text: text };
    }
    return { mimeType: mimeType, name: name, size: bytes.length, dataUrl: 'data:' + mimeType + ';base64,' + bytesToBase64(bytes) };
  }

  async function handleMessage(message) {
    if (typeof message !== 'object' || message === null) return;
    if (typeof message.id === 'undefined') return;
    if (typeof message.method !== 'string') {
      throw new Error('API method not allowed: ' + String(message.method));
    }
    // Internal helper: export a project as a File and hand it back as base64
    // (the File object cannot cross the WebSocket boundary).
    if (message.method === 'dsh.internal.exportProjectFile') {
      var expArgs = message.args || [];
      if (typeof eda === 'undefined' || !eda.sys_FileManager) {
        throw new Error('dsh.internal.exportProjectFile: sys_FileManager is not available');
      }
      var expUuid = expArgs[0] == null ? undefined : String(expArgs[0]);
      var expFile = expUuid === undefined
        ? await eda.sys_FileManager.getProjectFile(optional(expArgs[1]), optional(expArgs[2]), optional(expArgs[3]))
        : await eda.sys_FileManager.getProjectFileByProjectUuid(expUuid, optional(expArgs[1]), optional(expArgs[2]), optional(expArgs[3]));
      if (!expFile) throw new Error('dsh.internal.exportProjectFile: the app returned no file (project not open, or the export was cancelled)');
      var expBuffer = new Uint8Array(await expFile.arrayBuffer());
      var expBinary = '';
      for (var expIndex = 0; expIndex < expBuffer.length; expIndex += 1) expBinary += String.fromCharCode(expBuffer[expIndex]);
      return { name: expFile.name || String(expArgs[1] || 'project.epro'), size: expBuffer.length, base64: btoa(expBinary) };
    }
    // Internal helper: import a project from base64 (local .eprj2/.epro handed over
    // by the bridge) by rebuilding the File the official API expects.
    if (message.method === 'dsh.internal.importProjectFile') {
      var impArgs = message.args || [];
      if (typeof eda === 'undefined' || !eda.sys_FileManager) {
        throw new Error('dsh.internal.importProjectFile: sys_FileManager is not available');
      }
      var impBinary = atob(String(impArgs[0] || ''));
      var impBytes = new Uint8Array(impBinary.length);
      for (var impIndex = 0; impIndex < impBinary.length; impIndex += 1) impBytes[impIndex] = impBinary.charCodeAt(impIndex);
      var impFile = new File([impBytes], String(impArgs[1] || 'import.eprj2'), { type: 'application/octet-stream' });
      // saveTo (4th argument) is what gives the import a target team; without it the
      // app answers undefined and imports nothing.
      var impResult = await eda.sys_FileManager.importProjectByProjectFile(
        impFile, optional(impArgs[2]), undefined, optional(impArgs[3])
      );
      return { result: impResult === undefined ? null : toJsonable(impResult) };
    }
    // Internal helper: build an IPCB_Polygon from a raw source array and create
    // Internal helper: report THIS extension's own allow-list. The bridge keeps a
    // copy for docs/offline hints, but it drifts — and a bridge that is stricter
    // than the extension silently rejects methods that actually work. This is the
    // authority: what the running extension will accept right now.
    if (message.method === 'dsh.internal.listApiMethods') {
      return {
        version: VERSION,
        allowed: Array.from(ALLOWED_API).sort(),
        files: Array.from(FILE_METHODS).sort(),
      };
    }
    // a PCB region (used for the board outline).
    if (message.method === 'dsh.internal.pcbCreateRegion') {
      var regionArgs = message.args || [];
      if (typeof eda === 'undefined' || !eda.pcb_MathPolygon || !eda.pcb_PrimitiveRegion) {
        throw new Error('dsh.internal.pcbCreateRegion: PCB region APIs are not available');
      }
      var regionPolygon = eda.pcb_MathPolygon.createPolygon(regionArgs[1]);
      if (!regionPolygon) throw new Error('dsh.internal.pcbCreateRegion: invalid polygon source');
      var region = await eda.pcb_PrimitiveRegion.create(
        optional(regionArgs[0]), regionPolygon, optional(regionArgs[2]), optional(regionArgs[3]),
        optional(regionArgs[4]), optional(regionArgs[5])
      );
      if (!region) throw new Error('dsh.internal.pcbCreateRegion: pcb_PrimitiveRegion.create returned undefined (check the layer - regions only support copper/MULTI layers)');
      return toJsonable(region);
    }
    // Internal helper: compose pcb_MathPolygon.createPolygon + pcb_PrimitivePolyline.create.
    // A polyline is the primitive JLCEDA stores for a board outline, silkscreen
    // shape or mechanical drawing; the polygon object cannot be serialized over
    // WebSocket, so both official calls have to happen in one extension round trip.
    if (message.method === 'dsh.internal.polylineCreate') {
      var polyArgs = message.args || [];
      if (typeof eda === 'undefined' || !eda.pcb_MathPolygon || !eda.pcb_PrimitivePolyline) {
        throw new Error('dsh.internal.polylineCreate: PCB polyline APIs are not available');
      }
      var source = polyArgs[2];
      var polygon = eda.pcb_MathPolygon.createPolygon(source);
      if (!polygon) throw new Error('dsh.internal.polylineCreate: invalid polygon source ' + JSON.stringify(source));
      var polyline = await eda.pcb_PrimitivePolyline.create(
        optional(polyArgs[0]), optional(polyArgs[1]), polygon, optional(polyArgs[3]), optional(polyArgs[4])
      );
      if (!polyline) {
        throw new Error('dsh.internal.polylineCreate: pcb_PrimitivePolyline.create returned undefined (net/layer/polygon rejected)');
      }
      return toJsonable(polyline);
    }
    // Internal helper: compose pcb_MathPolygon.createPolygon + pcb_PrimitivePour.create
    // (copper pour / 覆铜). Same reason as dsh.internal.polylineCreate: the polygon
    // object cannot be serialized over WebSocket.
    if (message.method === 'dsh.internal.pourCreate') {
      var pourArgs = message.args || [];
      if (typeof eda === 'undefined' || !eda.pcb_MathPolygon || !eda.pcb_PrimitivePour) {
        throw new Error('dsh.internal.pourCreate: PCB pour APIs are not available');
      }
      // A pour is a complex polygon (an outer ring plus optional holes). Passing a
      // single IPCB_Polygon made the app answer 无法创建覆铜边框图元; createComplexPolygon is the documented entry point.
      var pourSource = pourArgs[2];
      var pourPolygon = eda.pcb_MathPolygon.createComplexPolygon
        ? eda.pcb_MathPolygon.createComplexPolygon(Array.isArray(pourSource) && Array.isArray(pourSource[0]) ? pourSource : [pourSource])
        : undefined;
      if (!pourPolygon) pourPolygon = eda.pcb_MathPolygon.createPolygon(pourSource);
      if (!pourPolygon) throw new Error('dsh.internal.pourCreate: invalid polygon source ' + JSON.stringify(pourSource));
      // Route 1: the documented static factory.
      var pourRoutes = [];
      var pour = null;
      var usedRoute = 'static';
      try {
        pour = await eda.pcb_PrimitivePour.create(
          optional(pourArgs[0]), optional(pourArgs[1]), pourPolygon, optional(pourArgs[3]), optional(pourArgs[4]),
          optional(pourArgs[5]), optional(pourArgs[6]), optional(pourArgs[7]), optional(pourArgs[8])
        );
      } catch (staticError) {
        pourRoutes.push('static: ' + (staticError && staticError.message ? staticError.message : String(staticError)));
      }
      // Route 2: the instance entry point (@internal in the typings, but the class
      // constructor is exported at runtime on some builds).
      if (!pour) {
        var PourCtor = null;
        try {
          if (typeof eda.IPCB_PrimitivePour === 'function') PourCtor = eda.IPCB_PrimitivePour;
          else if (eda.pcb_PrimitivePour && typeof eda.pcb_PrimitivePour.constructor === 'function' && eda.pcb_PrimitivePour.constructor !== Object) PourCtor = eda.pcb_PrimitivePour.constructor;
        } catch (ctorProbeError) { PourCtor = null; }
        if (PourCtor !== null) {
          usedRoute = 'instance';
          try {
            var pourInstance = new PourCtor(
              optional(pourArgs[0]), optional(pourArgs[1]), pourPolygon, optional(pourArgs[3]), optional(pourArgs[4]),
              optional(pourArgs[5]), optional(pourArgs[6]), optional(pourArgs[7]), optional(pourArgs[8])
            );
            pour = await pourInstance.create();
          } catch (instanceError) {
            pourRoutes.push('instance: ' + (instanceError && instanceError.message ? instanceError.message : String(instanceError)));
            usedRoute = 'none';
          }
        } else {
          pourRoutes.push('instance: no exported constructor');
          usedRoute = 'none';
        }
      }
      if (!pour) {
        throw new Error('dsh.internal.pourCreate: every route refused (' + pourRoutes.join(' | ') + ')');
      }
      // A pour border alone leaves no copper: rebuild so the fill (and the clearance
      // against other nets) is actually computed.
      var rebuilt = false;
      if (pour && typeof pour.rebuildCopperRegion === 'function') {
        try { await pour.rebuildCopperRegion(); rebuilt = true; } catch (error) { rebuilt = false; }
      }
      var pourJson = toJsonable(pour);
      if (pourJson && typeof pourJson === 'object') { pourJson.rebuilt = rebuilt; pourJson.route = usedRoute; }
      return pourJson;
    }
    // Internal helper: long-running jobs (auto-routing / auto-layout) are started
    // without awaiting so the MCP call returns immediately; the operation keeps
    // running inside EDA (with its progress bar) and is polled via jobStatus.
    // Awaiting it would hit the MCP tool timeout while EDA keeps working.
    if (message.method === 'dsh.internal.jobStart') {
      var jobArgs = message.args || [];
      var kind = jobArgs[0];
      var jobProps = jobArgs[1];
      if (kind !== 'autoRoute' && kind !== 'autoLayout' && kind !== 'importChanges' && kind !== 'clearRouting') {
        throw new Error('dsh.internal.jobStart: unsupported job kind ' + String(kind));
      }
      if (JOB && JOB.running) {
        return { started: false, alreadyRunning: true, kind: JOB.kind, startedAt: JOB.startedAt, elapsedMs: Date.now() - JOB.startedAt };
      }
      JOB = { kind: kind, startedAt: Date.now(), finishedAt: 0, running: true, result: null, error: null };
      // importChanges() blocks until the user answers EDA's "sync schematic changes"
      // confirmation dialog, so it must never be awaited by the MCP call either.
      var runner = kind === 'autoRoute'
        ? eda.pcb_Document.autoRouting(jobProps === null ? undefined : jobProps)
        : (kind === 'autoLayout'
          ? eda.pcb_Document.autoLayout()
          : (kind === 'importChanges'
            ? eda.pcb_Document.importChanges(jobProps === null ? undefined : jobProps)
            : eda.pcb_Document.clearRouting(jobProps === null ? undefined : jobProps)));
      Promise.resolve().then(function () { return runner; }).then(function (result) {
        JOB.running = false;
        JOB.finishedAt = Date.now();
        JOB.result = toJsonable(result);
      }).catch(function (error) {
        JOB.running = false;
        JOB.finishedAt = Date.now();
        JOB.error = error && error.message ? error.message : String(error);
      });
      return { started: true, kind: kind, startedAt: JOB.startedAt };
    }
    if (message.method === 'dsh.internal.jobStatus') {
      if (!JOB) return { running: false, job: null };
      return {
        running: JOB.running,
        kind: JOB.kind,
        startedAt: JOB.startedAt,
        finishedAt: JOB.finishedAt || null,
        elapsedMs: (JOB.running ? Date.now() : (JOB.finishedAt || Date.now())) - JOB.startedAt,
        result: JOB.result,
        error: JOB.error
      };
    }
    // Two sets gate the wire: ALLOWED_API for plain calls and FILE_METHODS for the ones
    // that hand a File back. Only checking the first one made every export (BOM,
    // netlist, Gerber) answer "API method not allowed".
    if (!ALLOWED_API.has(message.method) && !FILE_METHODS.has(message.method)) {
      throw new Error('API method not allowed: ' + String(message.method) +
        ' (the extension accepts ' + (ALLOWED_API.size + FILE_METHODS.size) + ' methods: ALLOWED_API + FILE_METHODS)');
    }
    if (message.method === 'dmt_EditorControl.getCurrentRenderedAreaImage') {
      var blob = await callApi(message.method, message.args || []);
      if (!blob) return null;
      return await blobToDataUrl(blob);
    }
    if (FILE_METHODS.has(message.method)) {
      var file = await callApi(message.method, message.args || []);
      if (!file) return null;
      return await blobToFilePayload(file);
    }
    return toJsonable(await callApi(message.method, message.args || []));
  }

  function sendObject(object) {
    if (!wsReady) return;
    try {
      eda.sys_WebSocket.send(WS_ID, JSON.stringify(object));
    } catch (error) {
      console.error('[dsh-eda-mcp] send failed:', error);
    }
  }

  function onReceiveMessage(event) {
    var raw = event && event.data;
    var text = typeof raw === 'string' ? raw : String(raw);
    var message;
    try { message = JSON.parse(text); } catch (_) { return; }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'pong') { lastPongAt = Date.now(); return; }
    if (typeof message.id === 'undefined') return;
    Promise.resolve().then(function () {
      return handleMessage(message);
    }).then(function (result) {
      sendObject({ id: message.id, ok: true, result: result });
    }).catch(function (error) {
      sendObject({ id: message.id, ok: false, error: { message: error && error.message ? error.message : String(error) } });
    });
  }

  function registerWebSocket() {
    lastRegisterAt = Date.now();
    try {
      eda.sys_WebSocket.register(
        WS_ID,
        WS_URL,
        onReceiveMessage,
        function () {
          wsReady = true;
          lastPongAt = Date.now();
          // The 'not connected' tip is sticky by design while we are offline; once the
          // socket is up it must go away, otherwise it sits on the canvas forever.
          hideConnectTip();
          sendObject({ type: 'hello', version: VERSION });
        }
      );
    } catch (error) {
      wsReady = false;
      console.error('[dsh-eda-mcp] websocket register failed:', error);
      setTimeout(registerWebSocket, 5000);
    }
  }

  /**
   * The official SYS_WebSocket API has no close/error callback and no
   * auto-reconnect, so the heartbeat below re-registers the socket whenever the
   * DSH bridge process restarts or disappears.
   */
  function reconnectIfIdle() {
    if (Date.now() - lastRegisterAt < 5000) return;
    registerWebSocket();
  }

  function showToast(message, type, seconds) {
    try {
      if (typeof eda !== 'undefined' && eda.sys_Message && typeof eda.sys_Message.showToastMessage === 'function') {
        // Always pass a finite timer: omitting it (or 0) leaves the toast on screen forever.
        eda.sys_Message.showToastMessage(message, type || 'info', seconds || 4);
      } else {
        console.log('[dsh-eda-mcp] ' + message);
      }
    } catch (error) {
      console.error('[dsh-eda-mcp] toast failed:', error);
    }
  }

  function menuGroup() {
    return {
      id: 'dsh-eda-mcp',
      title: 'DSH MCP',
      menuItems: [
        { id: 'connect', title: '连接 DSH MCP 服务器', registerFn: 'dshEdaMcpConnect' },
        { id: 'disconnect', title: '断开 DSH MCP 连接', registerFn: 'dshEdaMcpDisconnect' },
        { id: 'status', title: '查看 DSH MCP 连接状态', registerFn: 'dshEdaMcpStatus' }
      ]
    };
  }

  function registerHeaderMenus(attempt) {
    attempt = attempt || 0;
    if (typeof eda === 'undefined' || !eda.sys_HeaderMenu || typeof eda.sys_HeaderMenu.insertHeaderMenus !== 'function') {
      console.warn('[dsh-eda-mcp] SYS_HeaderMenu not available yet, attempt ' + attempt);
      if (attempt < 5) setTimeout(function () { registerHeaderMenus(attempt + 1); }, 1000 * (attempt + 1));
      return;
    }
    try {
      var result = eda.sys_HeaderMenu.insertHeaderMenus({ schematic: [menuGroup()], pcb: [menuGroup()] });
      console.log('[dsh-eda-mcp] header menus registered (attempt ' + attempt + ')');
      if (result && typeof result.catch === 'function') {
        result.catch(function (error) {
          console.error('[dsh-eda-mcp] header menu registration rejected:', error);
        });
      }
    } catch (error) {
      console.error('[dsh-eda-mcp] header menu registration failed:', error);
      if (attempt < 5) setTimeout(function () { registerHeaderMenus(attempt + 1); }, 1000 * (attempt + 1));
    }
  }

  try {
    globalScope.dshEdaMcpConnect = dshEdaMcpConnect;
    globalScope.dshEdaMcpDisconnect = dshEdaMcpDisconnect;
    globalScope.dshEdaMcpStatus = dshEdaMcpStatus;
  } catch (_) { /* ignore */ }

  DSH_EDA_MCP.connect = function () {
    try {
      wsReady = false;
      registerWebSocket();
      showToast('DSH MCP：正在连接 ws://127.0.0.1:39009/ws ...', 'info');
      setTimeout(function () {
        showToast(
          wsReady ? 'DSH MCP：已连接' : 'DSH MCP：连接请求已发送；请确认 DSH 桥接服务已启动，且本扩展已开启「允许外部交互」',
          wsReady ? 'success' : 'warning'
        );
      }, 1000);
      return true;
    } catch (error) {
      showToast('DSH MCP：连接失败 ' + (error && error.message ? error.message : String(error)), 'error');
      return false;
    }
  };

  DSH_EDA_MCP.disconnect = function () {
    try {
      wsReady = false;
      eda.sys_WebSocket.close(WS_ID);
      showToast('DSH MCP：已断开连接', 'info');
      return true;
    } catch (error) {
      showToast('DSH MCP：断开失败 ' + (error && error.message ? error.message : String(error)), 'error');
      return false;
    }
  };

  DSH_EDA_MCP.status = function () {
    var connected = wsReady === true;
    showToast(
      'DSH MCP：' + (connected ? '已连接' : '未连接') + '；端口 39009；扩展 v' + VERSION,
      connected ? 'success' : 'warning'
    );
    return connected;
  };

  DSH_EDA_MCP.isConnected = function () { return wsReady === true; };

  function registerManualConnectBus() {
    try {
      if (typeof eda === 'undefined' || !eda.sys_MessageBus || typeof eda.sys_MessageBus.subscribePublic !== 'function') return;
      eda.sys_MessageBus.subscribePublic('dsh-eda-mcp/connect', function () {
        if (typeof DSH_EDA_MCP.connect === 'function') DSH_EDA_MCP.connect();
      });
      eda.sys_MessageBus.subscribePublic('dsh-eda-mcp/status', function () {
        if (typeof DSH_EDA_MCP.status === 'function') DSH_EDA_MCP.status();
      });
      console.log('[dsh-eda-mcp] public connect bus registered');
    } catch (error) {
      console.error('[dsh-eda-mcp] public connect bus registration failed:', error);
    }
  }

  // One removable tip instead of a stack of toasts: showToastMessage has no hide API
  // (timer:0 meant "never"), so a stack of them used to pile up over the canvas and the
  // '未连接' banner survived even after the connection was established (measured).
  var CONNECT_TIP = 'DSH MCP 未连接：菜单 DSH MCP → 连接 DSH MCP 服务器（ws://127.0.0.1:39009/ws）';

  function hideConnectTip() {
    try {
      if (typeof eda !== 'undefined' && eda.sys_Message && typeof eda.sys_Message.removeFollowMouseTip === 'function') {
        eda.sys_Message.removeFollowMouseTip(CONNECT_TIP);
      }
    } catch (_) { /* ignore */ }
  }

  function showConnectToast() {
    if (wsReady) return;
    try {
      if (typeof eda === 'undefined' || !eda.sys_Message) return;
      if (typeof eda.sys_Message.showFollowMouseTip === 'function') {
        eda.sys_Message.showFollowMouseTip(CONNECT_TIP, 8000);
        return;
      }
      eda.sys_Message.showToastMessage(CONNECT_TIP, 'warning', 8);
    } catch (error) {
      console.error('[dsh-eda-mcp] connect tip failed:', error);
    }
  }

  var timer = setInterval(function () {
    if (!wsReady) { reconnectIfIdle(); return; }
    if (lastPongAt > 0 && Date.now() - lastPongAt > HEARTBEAT_MS * 2.5) {
      // The bridge is gone (e.g. the DSH plugin rebooted its bridge child).
      wsReady = false;
      try { eda.sys_WebSocket.close(WS_ID); } catch (_) { /* ignore */ }
      reconnectIfIdle();
      return;
    }
    try {
      eda.sys_WebSocket.send(WS_ID, JSON.stringify({ type: 'ping' }));
    } catch (error) {
      wsReady = false;
      reconnectIfIdle();
    }
  }, HEARTBEAT_MS);

  globalScope.__DSH_EDA_MCP_BRIDGE_STATE__ = { version: VERSION, timer: timer };
  registerManualConnectBus();
  registerHeaderMenus();
  registerWebSocket();
  setTimeout(showConnectToast, 3000);
})();
