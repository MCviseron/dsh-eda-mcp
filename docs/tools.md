# Tool reference (generated)

Generated from the built bridge's MCP `tools/list` — this is the authoritative list of what the agent can call. Coordinates: schematic/symbol = **0.01 inch** (MCP units), PCB = **mil**. Rotation = 0/90/180/270 for schematic primitives.

## Schematic: query

| Tool | Description | Parameters |
|---|---|---|
| `eda_status` | Get the dsh-eda-mcp bridge status and how many JLCEDA Pro bridge extensions are connected. | `` |
| `eda_get_page_info` | Return the current schematic page, the A4 frame range, the title-block keep-out range, and the recommended safe placement areas. All coordinates are MCP units (0.01 inch). | `paper?: string` |
| `eda_get_schematic_pages` | List the schematic pages of the current schematic, or fetch one page by uuid. | `pageUuid?: string` |
| `eda_search_components` | Search JLCEDA library devices by keyword. Returns candidate components with uuid/libraryUuid needed by eda_place_component. | `keyword: string, limit?: integer` |
| `eda_get_pins` | List pins of one schematic component. Use the returned primitiveId with eda_place_net_flag_at_pin, eda_place_net_label_at_pin, or eda_set_no_connect. | `componentPrimitiveId: string` |
| `eda_get_components` | List components on the active schematic page (or all pages). Returns designator, value, x, y, rotation and bounding box when available. | `allSchematicPages?: boolean, includeBounds?: boolean` |
| `eda_get_wires` | List wires on the active schematic page. | `` |
| `eda_get_nets` | List nets of the current schematic project. Uses sch_Net.* first; when the schematic is not the active document those APIs return [] and this tool falls back to parsing sch_Netlist.getNetlist, reporting which source was used. | `name?: string, parseNetlist?: boolean` |
| `eda_get_active_document` | Return the document/tab that is currently active (documentType, uuid, tabId, parent project). Most tab-dependent APIs (sch_Net.*, netlist export, DRC) only work when the matching document is active - use eda_open_document to switch. | `` |
| `eda_open_document` | Open/activate a document tab by uuid (dmt_EditorControl.openDocument). Works for a schematic page or a PCB, so tab-dependent APIs can run. | `documentUuid: string, splitScreenId?: string` |
| `eda_get_net_labels` | List net-label / attribute primitives on the active schematic page (sch_PrimitiveAttribute.getAll), optionally for one parent primitive. | `parentPrimitiveId?: string` |

## Schematic: place & draw

| Tool | Description | Parameters |
|---|---|---|
| `eda_place_component` | Place a JLCEDA library component on the active schematic page. Coordinates are MCP units (0.01 inch), origin at the lower-left of the A4 frame. Placement is rejected when the symbol leaves the frame or overlaps the title block unless allowOutsideFrame is true. | `libraryUuid: string, uuid: string, x: number, y: number, subPartName?: string, rotation?: integer, mirror?: boolean, addIntoBom?: boolean, addIntoPcb?: boolean, designator?: string, value?: string, name?: string, paper?: string, allowOutsideFrame?: boolean` |
| `eda_place_net_flag` | Place a power/ground net flag (VCC/GND etc.) on the active schematic page. | `identification: string, net: string, x: number, y: number, rotation?: integer, mirror?: boolean, paper?: string, allowOutsideFrame?: boolean` |
| `eda_place_net_port` | Place a net port on the active schematic page. | `direction: string, net: string, x: number, y: number, rotation?: integer, mirror?: boolean, paper?: string, allowOutsideFrame?: boolean` |
| `eda_place_net_flag_at_pin` | Read one pin position and place a power/ground net flag at that pin, with optional MCP-unit offsets. | `pinPrimitiveId: string, identification: string, net: string, offsetX?: number, offsetY?: number, rotation?: integer, mirror?: boolean` |
| `eda_place_net_label_at_pin` | Read one pin position and place a REAL net label there (sch_PrimitiveAttribute.createNetLabel; falls back to text and reports which method was used), with optional MCP-unit offsets. | `pinPrimitiveId: string, net: string, offsetX?: number, offsetY?: number, rotation?: integer, fontSize?: number` |
| `eda_set_no_connect` | Set or clear the no-connect flag on one or more schematic pins via sch_PrimitivePin.modify. | `primitiveIds: array, noConnected?: boolean` |
| `eda_draw_wire` | Draw a schematic wire (polyline). Coordinates are MCP units (0.01 inch). | `points: array, net?: string, color?: string, lineWidth?: integer, lineType?: integer` |
| `eda_draw_rectangle` | Draw a rectangle. topLeftY is the UPPER y coordinate (max y); height extends downward. Coordinates are MCP units. | `topLeftX: number, topLeftY: number, width: number, height: number, cornerRadius?: number, rotation?: integer, color?: string, fillColor?: string, lineWidth?: integer, lineType?: integer, fillStyle?: string` |
| `eda_draw_functional_box` | Draw a dashed functional-group box around one group of components, with an optional label. Margins and coordinates are MCP units; default margin 1 unit (about 0.254 mm). | `componentIds?: array, label?: string, margin?: number, color?: string, lineWidth?: integer, lineType?: integer` |
| `eda_draw_circle` | Draw a circle. Coordinates are MCP units. | `centerX: number, centerY: number, radius: number, color?: string, fillColor?: string, lineWidth?: integer, lineType?: integer, fillStyle?: string` |
| `eda_draw_text` | Draw text. Coordinates are MCP units. | `x: number, y: number, content: string, rotation?: integer, textColor?: string, fontName?: string, fontSize?: number, bold?: boolean, italic?: boolean, underLine?: boolean, alignMode?: integer` |
| `eda_place_net_label` | Place a real net label at x/y via sch_PrimitiveAttribute.createNetLabel (falls back to a plain text label when that API is missing, and reports which method was used). Coordinates are MCP units. | `x: number, y: number, net: string, fontSize?: number, rotation?: integer` |
| `eda_delete_primitive` | Delete a schematic primitive by kind and primitive id. | `kind: string, primitiveId: string` |

## Schematic: automation & export

| Tool | Description | Parameters |
|---|---|---|
| `eda_save_document` | Save the active schematic document. | `` |
| `eda_zoom_to_fit` | Zoom to fit all primitives in the active document. | `tabId?: string` |
| `eda_zoom_to_region` | Zoom to a region. Schematic coordinates are MCP units. | `left: number, right: number, top: number, bottom: number, tabId?: string` |
| `eda_run_drc` | Run schematic DRC and return the verbose result array. | `strict?: boolean` |
| `eda_auto_layout` | Run schematic auto-layout (sch_Document.autoLayout). | `uuids?: array` |
| `eda_auto_route` | Run schematic auto-routing (sch_Document.autoRouting). | `uuids?: array` |
| `eda_export_netlist` | Export the schematic netlist as text (default JLCEDA format). Returns null when no schematic is active - check eda_get_active_document / open the schematic page first. | `type?: string` |
| `eda_export_bom` | Export the schematic BOM. csv returns text; xlsx returns a base64 data URL. | `format?: string` |
| `eda_create_board` | Create a board linking a schematic and a PCB (dmt_Board.createBoard). | `schematicUuid?: string, pcbUuid?: string` |

## Generic allow-listed API

| Tool | Description | Parameters |
|---|---|---|
| `eda_api_call` | Call an allow-listed JLCEDA Pro extension API method directly. | `method: string, args: array` |

## PCB: query

| Tool | Description | Parameters |
|---|---|---|
| `pcb_get_components` | List PCB components (mil). includePins=true also reads pcb_PrimitiveComponent.getAllPinsByPrimitiveId per component, which is the accurate pad/net source; the fast summary pad list can be stale. | `layer?: string|integer, locked?: boolean, includeBounds?: boolean, includePins?: boolean` |
| `pcb_get_nets` | List PCB nets. Set detail=true for full net info. | `detail?: boolean, name?: string` |
| `pcb_get_layers` | List PCB layers. | `` |
| `pcb_get_primitives_in_region` | List PCB primitives inside a region. Coordinates are mil. | `left: number, right: number, top: number, bottom: number, leftToRight?: boolean` |
| `eda_pcb_get_tracks` | List PCB tracks (pcb_PrimitiveLine.getAll). Optional net/layer/locked filters. | `net?: string, layer?: string|integer, locked?: boolean` |
| `eda_pcb_get_vias` | List PCB vias (pcb_PrimitiveVia.getAll). Optional net/locked filters. | `net?: string, locked?: boolean` |
| `eda_pcb_get_polylines` | List PCB polylines (pcb_PrimitivePolyline.getAll) - board outline, silkscreen shapes, mechanical drawings. Optional net/layer/locked filters. | `net?: string, layer?: string|integer, locked?: boolean` |
| `eda_pcb_get_pours` | List PCB copper pours (pcb_PrimitivePour.getAll). Optional net/layer/locked filters. | `net?: string, layer?: string|integer, locked?: boolean` |
| `eda_pcb_run_drc` | Run PCB DRC (pcb_Drc.check). includeVerboseError=true returns the verbose error array (strict=true also reports warnings). Set userInterface=true only if the user should see the DRC panel. | `strict?: boolean, userInterface?: boolean, includeVerboseError?: boolean` |
| `eda_pcb_get_drc_rules` | Return the current PCB DRC rule configuration name and content. | `` |
| `eda_pcb_get_regions` | List PCB regions (pcb_PrimitiveRegion.getAll). layer must be a copper layer (top 1 / bottom 2 / inner 15-44) or MULTI 12. | `layer?: string|integer, ruleType?: array, locked?: boolean` |
| `eda_pcb_job_status` | Poll the background PCB job started by eda_pcb_auto_route (or eda_pcb_auto_place with wait=false): running, elapsedMs, result, error. EDA keeps its own progress bar while running. | `` |

## PCB: place & draw

| Tool | Description | Parameters |
|---|---|---|
| `pcb_place_component` | Place a PCB component/footprint. Coordinates are mil. | `libraryUuid: string, uuid: string, layer: string|integer, x: number, y: number, rotation?: number` |
| `pcb_draw_track` | Draw a PCB track segment. Coordinates are mil. | `net: string, layer: string|integer, startX: number, startY: number, endX: number, endY: number, lineWidth?: number` |
| `pcb_draw_via` | Place a PCB via. Coordinates and sizes are mil. | `net: string, x: number, y: number, holeDiameter: number, diameter: number, viaType?: integer` |
| `pcb_draw_board_outline` | Create a closed board outline on the BoardOutline layer (layer 11) from a flat [x1,y1,x2,y2,...] point list in mil. Implemented as ONE pcb_PrimitivePolyline built from a pcb_MathPolygon polygon - the primitive JLCEDA itself stores for a board outline. pcb_PrimitiveLine cannot create it (that API is a copper track and rejects layer 11). | `points: array, lineWidth?: number, net?: string, locked?: boolean` |
| `pcb_draw_polyline` | Create a closed polyline (pcb_PrimitivePolyline) on any line layer: board outline 11, silkscreen 3/4, assembly 9/10, mechanical 14, document 13, copper 1/2. points is a flat [x1,y1,x2,y2,...] array in mil and is closed automatically. | `points: array, layer: string|integer, net?: string, lineWidth?: number, locked?: boolean` |
| `eda_pcb_move_component` | Move/rotate/modify an existing PCB component (pcb_PrimitiveComponent.modify). Coordinates are mil. | `primitiveId: string, x?: number, y?: number, rotation?: number, layer?: string|integer, locked?: boolean, designator?: string, name?: string` |
| `eda_pcb_delete_component` | Delete a PCB component (pcb_PrimitiveComponent.delete). | `primitiveId: string` |
| `eda_pcb_modify_track` | Modify a PCB track (pcb_PrimitiveLine.modify). Coordinates are mil. | `primitiveId: string, net?: string, layer?: string|integer, startX?: number, startY?: number, endX?: number, endY?: number, lineWidth?: number, locked?: boolean` |
| `eda_pcb_delete_track` | Delete a PCB track (pcb_PrimitiveLine.delete). | `primitiveId: string` |
| `eda_pcb_delete_via` | Delete a PCB via (pcb_PrimitiveVia.delete). | `primitiveId: string` |
| `eda_pcb_create_region` | Create a PCB region (pcb_PrimitiveRegion.create). points is a flat [x1,y1,x2,y2,...] array in mil and is closed automatically. Allowed layers are copper only: top(1), bottom(2), inner(15-44) and multi(12) - the official API type is TPCB_LayersOfRegion = copper \| MULTI, so the board-outline layer (11) is rejected. ruleType uses EPCB_PrimitiveRegionRuleType: 2 noComponents, 5 noWires, 6 noFills, 7 noPours, 8 noInnerElectricalLayers, 9 followRegionRule. | `layer: string|integer, points: array, ruleType?: array, regionName?: string, lineWidth?: number, locked?: boolean` |
| `eda_pcb_delete_polyline` | Delete a PCB polyline (pcb_PrimitivePolyline.delete). | `primitiveId: string` |
| `eda_pcb_create_pour` | Create a copper pour (覆铜, pcb_MathPolygon.createPolygon + pcb_PrimitivePour.create). points is a flat [x1,y1,x2,y2,...] array in mil, closed automatically. layer must be a copper layer (top 1 / bottom 2 / inner 15-44). pourFillMethod: 45grid \| 90grid \| solid. | `net: string, layer: string|integer, points: array, pourFillMethod?: string, preserveSilos?: boolean, pourName?: string, pourPriority?: integer, lineWidth?: number, locked?: boolean` |
| `eda_pcb_delete_pour` | Delete a copper pour (pcb_PrimitivePour.delete). | `primitiveId: string` |
| `eda_pcb_set_net_track_width` | Set the track width of every existing track of one net (iterates pcb_PrimitiveLine.getAll + pcb_PrimitiveLine.modify). Use it to thicken power/GND nets after auto-routing. | `net: string, lineWidth: number, layer?: string|integer` |
| `eda_pcb_delete_region` | Delete a PCB region (pcb_PrimitiveRegion.delete). | `primitiveId: string` |

## PCB: sync, automation & export

| Tool | Description | Parameters |
|---|---|---|
| `pcb_save_document` | Save the active PCB document. | `` |
| `pcb_import_changes` | Import schematic changes into the active PCB (pcb_Document.importChanges). DEFAULT IS ASYNCHRONOUS because the call opens EDA own sync-confirmation dialog and blocks until the user answers it: the import runs as a background job, the tool returns immediately with componentsBefore, and the answer is detected by eda_pcb_wait_for_components. wait=true blocks instead (only when no dialog appears). | `schematicUuid?: string, wait?: boolean, timeoutMs?: integer` |
| `eda_pcb_wait_for_components` | Low-frequency poll (default every 5 s, minimum 3 s) that treats "new PCB components appeared" as "the user clicked OK in the schematic-sync confirmation dialog". Returns confirmed/waitedMs/newComponentIds, or confirmed=false after maxWaitMs (default 45 s) so the caller can ask the user and call again. | `pollIntervalMs?: integer, maxWaitMs?: integer, baseline?: array` |
| `pcb_navigate_to_region` | Navigate the PCB canvas to a region. Coordinates are mil. | `left: number, right: number, top: number, bottom: number` |
| `eda_pcb_clear_routing` | Clear PCB routing (pcb_Document.clearRouting). type: all \| net \| connection (net/connection act on the current selection). | `type?: string` |
| `eda_pcb_auto_place` | Run PCB auto-layout (pcb_Document.autoLayout). Blocking by default (layout is fast); pass wait=false to start it as a background job and poll eda_pcb_job_status. | `wait?: boolean, timeoutMs?: integer` |
| `eda_pcb_auto_route` | Start PCB auto-routing (pcb_Document.autoRouting). DEFAULT IS ASYNCHRONOUS: the call returns as soon as EDA starts routing (EDA shows its own progress bar) and you poll eda_pcb_job_status until running=false - a long routing job must NOT be awaited, otherwise the MCP call times out while EDA keeps working. Without nets/RoutingNets the bridge enumerates every net, because this EDA build fails every net (success=false, duration=0) when routingRange is empty. wait=true blocks until done (only for small jobs). cornerStyle: 0=45deg, 1=90deg; optimization: 1=completion, 0=faster; existingPrimitiveMode: keep\|remove. | `nets?: array, RoutingNets?: array|string, ignoreNets?: array, layers?: array, cornerStyle?: integer, optimization?: integer, existingPrimitiveMode?: string, wait?: boolean, timeoutMs?: integer, props?: object` |
| `eda_pcb_export_gerber` | Export PCB Gerber (pcb_ManufactureData.getGerberFile). Returns { name, size, dataUrl } - the zip is base64 encoded, so large boards can produce a big payload. | `fileName?: string, colorSilkscreen?: boolean, unit?: string, integerNumber?: integer, decimalNumber?: integer, other?: object, layers?: array, objects?: array` |

## eda_pcb_* aliases

| Tool | Description | Parameters |
|---|---|---|
| `eda_pcb_get_components` | Alias of pcb_get_components. List PCB components (mil). | `layer?: string|integer, locked?: boolean, includeBounds?: boolean` |
| `eda_pcb_get_nets` | Alias of pcb_get_nets. | `detail?: boolean, name?: string` |
| `eda_pcb_get_layers` | Alias of pcb_get_layers. | `` |
| `eda_pcb_place_component` | Alias of pcb_place_component. | `libraryUuid: string, uuid: string, layer: string|integer, x: number, y: number, rotation?: number` |
| `eda_pcb_draw_track` | Alias of pcb_draw_track. | `net: string, layer: string|integer, startX: number, startY: number, endX: number, endY: number, lineWidth?: number` |
| `eda_pcb_draw_via` | Alias of pcb_draw_via. | `net: string, x: number, y: number, holeDiameter: number, diameter: number, viaType?: integer` |
| `eda_pcb_draw_board_outline` | Alias-style name for pcb_draw_board_outline: draws a closed board outline as line segments on layer 11 (mil). | `points: array, lineWidth?: number` |
| `eda_pcb_save_document` | Alias of pcb_save_document. | `` |
| `eda_pcb_import_changes` | Alias of pcb_import_changes. | `schematicUuid?: string` |
| `eda_pcb_get_primitives_in_region` | Alias of pcb_get_primitives_in_region. | `left: number, right: number, top: number, bottom: number, leftToRight?: boolean` |
| `eda_pcb_navigate_to_region` | Alias of pcb_navigate_to_region. | `left: number, right: number, top: number, bottom: number` |

