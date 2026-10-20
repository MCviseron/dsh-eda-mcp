# dsh-eda-mcp

[![check](https://github.com/MCviseron/dsh-eda-mcp/actions/workflows/check.yml/badge.svg)](https://github.com/MCviseron/dsh-eda-mcp/actions/workflows/check.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/dsh-eda-mcp.svg)](https://www.npmjs.com/package/dsh-eda-mcp)
[![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](package.json)

DeepSeek Harness (DSH) plugin that connects DSH to **嘉立创EDA专业版 / EasyEDA Pro** and lets the agent draw schematics through MCP tools.

> 中文文档：[README.zh.md](README.zh.md) · Tool reference: [docs/tools.md](docs/tools.md) · Changes: [CHANGELOG.md](CHANGELOG.md)

## How it works

```
DSH agent
  └─ mcp__jlceda__eda_* tools
       └─ @deepseek-ai/dsh-mcp-client (stdio)
            └─ lib/bridge.mjs  (local MCP + WebSocket server, 127.0.0.1:39009)
                 └─ JLCEDA Pro extension  dsh-eda-bridge-extension-<version>.zip
                      └─ official EasyEDA Pro extension API (eda.sch_*)
```

The DSH plugin starts a zero-dependency bridge child process. The bridge speaks MCP over stdio to DSH and WebSocket to a small JLCEDA Pro extension. The extension executes a strict allow-list of official EDA APIs, so the model cannot run arbitrary code inside JLCEDA.

## Install

> Runtime requirement: DSH `0.1.1-rc.x`, `0.1.5-rc.x`, `0.2.0-rc.x` or `0.2.1-rc.x` (Web GUI and the official Desktop). The host settings seam and the browser bundle are adapted to every generation, so one build loads on any of them.
>
> Verified generations: `0.1.5-rc.2` (this repo's dev set) and `0.2.0-rc.2` / `0.2.1-rc.2` (desktop runtime and npm `next`). Re-check any new line with `pnpm seam-check next` — it installs that generation's seam packages into a throwaway directory and asserts every contract this plugin probes: mcp-client `inject: ['tools']` and its config keys, the settings faces, `systemPrompt.section({ name, order, text })`, `webServer.register({ kind: 'exact' })`, and the `window.__ModuleLoader__.load({ id, factory })` wrapper.

### 0. From npm (recommended)

```sh
cd "$DSH_HOME/profiles/<profile>"
pnpm add dsh-eda-mcp            # or use the plugin manager in the Web GUI
# restart DSH
```

The published package already contains `lib/` and `dsh-eda-bridge-extension-<version>.zip`, so no build
toolchain is needed. The extension still has to be imported into JLCEDA Pro by hand — the zip
sits at `node_modules/dsh-eda-mcp/dsh-eda-bridge-extension-<version>.zip` (or download it from the
settings card).

Direct links (no package install needed):

- `http://159.75.130.207/eda/dsh-eda-bridge-extension-0.4.9.zip` (current wire version)
- `http://159.75.130.207/eda/` - directory listing of every uploaded extension zip

The filename always carries the wire version; check `eda_status` after importing and restart JLCEDA
Pro when the version differs from the bridge.

Verification: `eda_extension_package` reports the zip this plugin ships (path, bytes, sha256) and,
with `download: true`, fetches the served copy and compares the two byte for byte (`verified: match |
mismatch`). On a match it saves the file to `outDir` (default: the temp directory); on a mismatch it
writes nothing and tells you to re-upload. The zip build is reproducible, so equal sources always
produce the same sha256.

The download server throttles `/eda/` to 5 requests/minute per IP (burst 5, loopback exempt), so
a `429` shows up as `verified: 'unverified'` with `httpStatus: 429` — that is throttling, not a
checksum mismatch; wait a minute and retry.

### 1. Install into the DSH web profile

```sh
# directly from GitHub (pnpm runs the package's `prepare` build)
dsh plugin --profile web add "github:MCviseron/dsh-eda-mcp"

# or from a local clone, so every `pnpm build` is picked up by a profile restart
git clone https://github.com/MCviseron/dsh-eda-mcp.git
cd dsh-eda-mcp && pnpm install && dsh plugin --profile web add "link:$PWD"
```

`dsh plugin` forwards to pnpm and reconciles `dsh.profile.bundles` automatically. Restart the running DSH Web profile after installation.

### 1b. Running inside the official Desktop app

The Desktop app hosts plugins in **Electron**, so there `process.execPath` is `DeepSeek Harness.exe`, not Node: spawning it with `lib/bridge.mjs` starts (or single-instance-aborts) a second app instead of a bridge, and port 39009 never listens — the settings card exists, `/test` always fails and the agent gets no `mcp__jlceda__*` tools.

The plugin now resolves a real Node executable (`src/node-runtime.ts`), in order: `DSH_EDA_MCP_NODE` override → `DSH_NODE_EXECUTABLE` / `DSH_DESKTOP_NODE_EXECUTABLE` (with `ELECTRON_RUN_AS_NODE=1`) → `process.execPath` on a Node host → the Desktop payload's own `resources/runtime/primary-runtime/dependencies/node/bin/node.exe` → `node` on `PATH` → Electron-as-Node.

`POST /api/dsh-eda-mcp/test` reports which one it picked:

```json
{"ok":true,"health":{"status":"ok","version":"0.3.5","clients":1},
 "launch":{"command":"…\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe","source":"desktop runtime Node"}}
```

> The Desktop loads the packaged `lib/index.js`, and a plugin reload does **not** re-import a cached ESM module — after changing `src/`, run `node build.mjs` and restart the Desktop app.

### 2. Import the JLCEDA Pro bridge extension

Build produces `dsh-eda-bridge-extension-<version>.zip` only — a second copy under the stable name only made it unclear which build you were looking at. In JLCEDA Pro:

1. Open **扩展 → 导入** (Extensions → Import).
2. Select `dsh-eda-bridge-extension-<version>.zip`.
3. In the extension list find **DSH EDA MCP Bridge**.
4. Enable it and, importantly, enable **允许外部交互 / Allow external interactions**.

The extension connects to `ws://127.0.0.1:39009/ws`. Keep JLCEDA Pro running and a schematic page open.

### 3. Verify

In the DSH Web GUI settings page, the **嘉立创EDA MCP** card has a **测试连接** button. It checks the local bridge health endpoint. The MCP tools appear as `mcp__jlceda__eda_status`, `mcp__jlceda__eda_place_component`, `mcp__jlceda__eda_draw_wire`, etc.

## Design rules

The normative schematic + PCB rule set (zoning, placement, net naming, track widths, vias, copper pour,
DRC, silkscreen, fabrication output, pre-order checklist) lives in **[docs/design-rules.md](docs/design-rules.md)**.

The measurable half is enforced by the tools, not just documented:

| Rule | Enforcement |
|---|---|
| Net names | Letters, digits, `_`, `.`, `+`, `-`, max 255 chars. Space, `/`, brackets or CJK are **rejected** by every net-taking tool (`USB_DP/DM` would be split into two nets by the backend). |
| Track width | `pcb_draw_track` defaults by net role (signal 6 mil / power 16 mil) and **rejects anything below 6 mil (0.15 mm)** unless `force: true`. |
| Via size | `pcb_draw_via` defaults to a standard drill pair (0.2/0.4 mm signal, 0.3/0.6 mm power); ring = pad − hole must be ≥ 0.20 mm, a hole below 0.2 mm is rejected, below 0.3 mm is warned. |
| Pour / DRC | `eda_pcb_create_pour` returns the 6/10 mil clearance rule; `eda_design_audit` runs the DRC and the checklist. |

**`eda_design_audit`** is the one-call health check: per-net minimum width vs. role, via geometry, net names,
board outline, copper pour and PCB DRC, returned as `violations` / `warnings` / `checklist`. Run it before and
after routing.

## MCP tools (schematic-first MVP)

| Tool | Purpose |
|---|---|
| `eda_status` | Bridge status and connected JLCEDA clients |
| `eda_launch` | Start JLCEDA Pro (optionally opening a `.eprj2` project) and wait until the extension connects |
| `eda_list_projects` / `eda_get_project` | List workspace projects (uuid + name) / read the current project |
| `eda_open_project` | Open a project by uuid, or by friendly name |
| `eda_create_project` | Create a project and return its uuid (optionally open it) |
| `eda_search_components` | Search JLCEDA library devices |
| `eda_place_component` | Place a component/symbol |
| `eda_place_net_flag` | Place VCC/GND/Power net flag |
| `eda_place_net_port` | Place IN/OUT/BI net port |
| `eda_draw_wire` | Draw a wire/polyline |
| `eda_draw_rectangle` | Draw a rectangle |
| `eda_draw_circle` | Draw a circle |
| `eda_draw_text` | Draw text |
| `eda_save_document` | Save the active schematic |
| `eda_zoom_to_fit` / `eda_zoom_to_region` | Zoom canvas |
| `eda_get_components` / `eda_get_wires` | Inspect primitives |
| `eda_delete_primitive` | Delete one primitive |
| `eda_api_call` | Allow-listed generic API call (can be disabled in settings) |
| `pcb_*` / `eda_pcb_*` (65 tools total) | PCB query, place/move/delete components, tracks, vias, regions, board outline, auto-place/auto-route, Gerber export |

Schematic/symbol coordinates are in **0.01 inch** units; PCB coordinates are in **mil**. Rotation values are `0/90/180/270`. Wire points are a flat array `[x1, y1, x2, y2, ...]`.

**What takes effect when** (read this before retrying anything): plugin source in `src/` needs `node build.mjs` plus a **DSH restart** — the running host keeps the old bundle in memory; the EDA extension in `jlc-extension/` needs the zip **re-imported** and JLCEDA Pro restarted (`eda_status.extensionVersions` must match `bridgeVersion`); only the bridge child can be restarted by the agent (`POST /api/dsh-eda-mcp/reconnect`). The generated `docs/schematic-workflow.md` chapter 12 has the full table, and the skill `jlceda-schematic-workflow` carries the same text.

Every PCB tool has an equivalent `eda_pcb_*` alias (`eda_pcb_get_components` = `pcb_get_components`). See `README.zh.md` for the full PCB table and the region-layer rules (`pcb_PrimitiveRegion.create` accepts copper layers and MULTI only, so the board outline stays a closed line loop on layer 11).

## Tool reference

`docs/tools.md` is generated from the built bridge's MCP `tools/list` (81 tools) and is the authoritative list of names, parameters and required fields.

## Workflows

### A. Schematic (make connections real)

1. `eda_get_page_info` for the A4 frame, title-block keep-out and safe areas; then `eda_search_components` + `eda_place_component` (out-of-frame placement is rejected and rolled back).
2. Connect with `eda_draw_wire` **net** parameter (same-name nets merge) - the most reliable electrical connection. `eda_place_net_flag_at_pin` places power/ground flags. `eda_place_net_label_at_pin` prefers a REAL net label and reports `method: "netLabel"`; when it reports `method: "text"` the EDA build has no `createNetLabel` and the text label does **not** create an electrical connection - fall back to the wire net parameter.
3. `eda_set_no_connect` for unused pins, `eda_draw_functional_box` to group, then `eda_run_drc` + `eda_save_document`.

### B. Schematic -> PCB sync (EDA shows its own confirmation dialog)

1. `eda_create_board` links schematic and PCB (first time only).
2. `pcb_import_changes` is **asynchronous by default**: `pcb_Document.importChanges` opens EDA's confirmation dialog and blocks until it is answered, so the tool returns immediately with `componentsBefore` and keeps the import running in the background.
3. Ask the user to click OK, then call `eda_pcb_wait_for_components`: it polls every 5 s by default (**minimum 3 s**, deliberately low) for up to 45 s (`pollIntervalMs` / `maxWaitMs`). Confirmation is detected as "new PCB components appeared that did not exist before".
4. On `confirmed: true` run `pcb_save_document`; on `confirmed: false` ask the user and call again.

### C. PCB layout and routing (long jobs are always polled)

1. Outline: `pcb_draw_board_outline` (one closed `pcb_PrimitivePolyline` on layer 11).
2. Placement: `eda_pcb_get_components` (`includePins: true` for accurate pad nets) + `eda_pcb_move_component`; `eda_pcb_auto_place` (blocking by default, `wait: false` for a background job).
3. Routing: `eda_pcb_auto_route` **starts asynchronously** (EDA shows its own progress bar); poll `eda_pcb_job_status` until `running=false`. Never await it and never raise timeouts - a whole board or a 35+ pin net such as GND always exceeds any sane timeout while EDA keeps working. Use `eda_pcb_clear_routing` to start over.
4. Check: `eda_pcb_run_drc` (`strict` includes warnings, `includeVerboseError` returns details) + `eda_pcb_get_drc_rules`.
5. Finish: `eda_pcb_set_net_track_width` for power/GND, `eda_pcb_create_pour` for copper pours (`45grid`/`90grid`/`solid`, copper layers only), `eda_pcb_export_gerber` (base64 data URL, can be several MB).

### D. Active-document rule

`sch_Net.*`, netlist export and the schematic get/getAll APIs only act on the **active tab**: with a PCB in front they return `[]` / `null`. `eda_get_nets` therefore degrades through `getCurrentProjectAllNets -> getAllNets -> parsing sch_Netlist.getNetlist` and reports `source`; when it is empty use `eda_get_active_document` and `eda_open_document` to bring the schematic page forward.
## Configuration

The Web GUI settings card exposes:

- `enabled` — mount/unmount the MCP bridge.
- `announceToAgent` — inject plugin guidance into the system prompt.
- `toolCallTimeoutMs` — per-call EDA timeout.
- `allowRawApi` — expose the generic `eda_api_call` tool.

The WebSocket port is fixed at `39009` in the first version. Do not run another service on that port.

## Development

Requirements: Node `^22.19.0 || >=24`, pnpm (pinned by `packageManager`), and Windows for the extension zip (PowerShell `Compress-Archive`).

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # unit tests
pnpm build       # bundles + extension zip
pnpm check       # all three
```

Build outputs:

- `lib/index.js` — DSH host plugin.
- `lib/client.js` — DSH Web GUI settings card.
- `lib/bridge.mjs` — standalone MCP/WebSocket bridge child.
- `dsh-eda-bridge-extension-<version>.zip` — JLCEDA Pro extension (the version is the wire contract).

`lib/` and the zip are build outputs and are git-ignored; the host loads the packaged `lib/index.js`, so a change under `src/` needs `pnpm build` plus a Host restart (a plugin reload does not re-import a cached ESM module).

See [CONTRIBUTING.md](CONTRIBUTING.md) for the repository layout, the release/tag flow, and the bridge/extension version rule. Publishing to npm — the first release is manual, then `v*` tags publish through trusted publishing (OIDC, no token) — is documented in [docs/release.md](docs/release.md).

## Security

- The bridge listens on loopback only (`127.0.0.1`).
- The JLCEDA extension and the bridge both enforce the same API allow-list.
- Generic `eda_api_call` is allow-list-only and can be disabled.
- No raw JavaScript evaluation is exposed.

## Known limitations

- The board outline is one `pcb_PrimitivePolyline` on layer 11 (polygon source + line width). It cannot be created with `pcb_PrimitiveLine` (a copper-track primitive; the core rejects layer 11) nor with `pcb_PrimitiveRegion` (`TPCB_LayersOfRegion` allows copper layers and MULTI(12) only). Verified against real `.eprj2` project files, where an outline is stored as `["POLY", id, 0, "", 11, 10, [...], 1]`.
- `pcb_Document.autoRouting` returns `success=false, duration=0` for every net when no net list is passed (empty `routingRange` in this EDA build), so `eda_pcb_auto_route` enumerates all net names first.
- Auto-routing is asynchronous by default: `eda_pcb_auto_route` returns as soon as EDA starts routing (EDA shows its own progress bar) and `eda_pcb_job_status` is polled until `running=false`. Awaiting a whole-board or many-pin net (e.g. GND) always exceeds any sane timeout while EDA keeps working.
- Schematic APIs (`sch_Net.*`, netlist export) only act on the ACTIVE document; when they return empty/null, use `eda_get_active_document` and `eda_open_document` to bring the schematic page to the front.
- `eda_pcb_export_gerber` returns the Gerber zip as a base64 data URL, which can be several MB for a large board.
- The JLCEDA extension socket is registered through `sys_WebSocket`, which has neither a close callback nor auto-reconnect; versions before 0.3.3 therefore had to be reconnected by hand after the DSH bridge child restarted. 0.3.3 adds a 10 s heartbeat that re-registers the socket when `pong` stops arriving.
- Screenshot/canvas image return is not yet wired into MCP image blocks.
- Changing the bridge WebSocket port requires editing both the bridge env and `jlc-extension/api-bridge.js`, then rebuilding/reimporting the extension zip.
- `dmt_Project.createProject` / `deleteProject` do nothing on this EDA build (3.2.186, signed in but semi-offline): the former returns no uuid for a directory team, a canonical team uuid, or either with/without a folderUuid, and the latter always returns `false` (verified with the project open and after switching away). **Create projects with `eda_import_project` instead** (importing a project file does create one — verified), and delete them in the app.
- In semi-offline mode EDA models **each local project directory as a "team"**: the `uuid` reported by `eda_list_teams` is the directory path, while a project record's `teamUuid` is a real uuid. `eda_list_projects` without a filter walks every team, so the first call is slower than one with `teamUuid`.
- Spawning `lceda-pro.exe` directly (even through ShellExecute) makes it exit with code 0 immediately; only handing the launch to the desktop shell (`explorer.exe`) starts it, so on Windows `eda_launch` always goes through explorer plus a temporary `.cmd`.
- A project path on the command line is **ignored by the app** (the active document stays HOME), so `eda_launch({ project })` only forwards the argument; the result carries `projectOpenedByArgument: false` and a `projectNote`. Use `eda_open_project` to actually open one.
- Schematic parts move with `eda_move_component` (`sch_PrimitiveComponent.modify`); net ports, net flags, net labels and text labels are deleted with `eda_delete_primitive` kinds `netport` / `netflag` / `netlabel` / `text`.
- The `net` argument of `eda_draw_wire` only sticks on a **floating** wire: once an endpoint touches a pin, EDA recomputes the net from connectivity (measured: `TESTNET` merged into `LED_A`). Joining same-named nets across regions requires `eda_place_net_port` or a net label.
- `sch_PrimitiveAttribute.createNetLabel` never resolves on EDA 3.2.186: the probe result is cached per session and placement degrades to a plain text label (no electrical meaning; the stub wire carries the net). Batch with `eda_place_net_labels`, enumerate with `eda_get_net_labels`, clean up with `eda_delete_primitive(kind:"text")`.
- Net port primitives do not appear in `eda_get_components` / BOM / netlist (application behaviour); audit them through `eda_get_net_labels`.
- Importing a `.epro2` copies its internal uuids (schematic/page/pcb), which can collide with the source project: `eda_import_project` reports them in `collisions`, but cannot regenerate them.
- `dmt_Project.copyProject` is as inert as `createProject` / `deleteProject` for local projects; copy with `eda_export_project` + `eda_import_project` instead.
- Automatic layout/routing is off by default (`allowAutoLayoutRouting`); `eda_auto_layout` / `eda_auto_route` only run with `force:true`.
- The extension and bridge wire versions must move **together** (currently 0.4.1, patch-only bumps): a changed allow-list requires re-importing the zip, otherwise new tools answer `API method not allowed`. `eda_status` reports every connected page's version in `extensionVersions`.

## Repository

| Path | What it is |
|---|---|
| `src/index.ts`, `src/routes.ts`, `src/node-runtime.ts`, `src/config-values.ts`, `src/bridge-diagnostics.ts`, `src/guidance.ts` | DSH host half |
| `src/bridge/index.ts` | Standalone MCP/WebSocket bridge child |
| `src/bridge/design-rules.ts` | Enforceable design limits: net naming, width tiers, via geometry |
| `src/client/` | Web settings card |
| `jlc-extension/` | JLCEDA Pro extension packaged into the zip |
| `test/` | Unit tests |
| `docs/design-rules.md` | Normative schematic + PCB rule set |
| `docs/tools.md` | Generated tool reference (every MCP tool, its parameters, and required fields) |
| `docs/release.md` | Maintainer publishing runbook (npm, trusted publishing) |
| `scripts/gen-tools-doc.mjs` | Regenerates `docs/tools.md` from the built bridge |
| `build.mjs` | esbuild bundles (reproducible) + extension zip |

## License

Apache-2.0 © dsh-eda-mcp contributors. See [LICENSE](LICENSE).
