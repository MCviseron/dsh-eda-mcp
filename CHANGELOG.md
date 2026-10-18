# Changelog

## 未发布（unreleased）

### 设置页：勾选框改为开关

- 设置卡片里的三个布尔项（`enabled` / `announceToAgent` / `allowRawApi`）由 `<input type="checkbox">`
  改为真正的开关控件：`<button role="switch" aria-checked aria-label>`，40×22 轨道 + 18px 圆钮，
  品牌色（`--dsw-alias-brand-primary`）表示开启、`--dsw-alias-border-l2` 表示关闭，140ms 过渡；
  键盘 Enter/Space 与 `disabled` 状态沿用原生 button 行为。
- 顺带去掉硬编码的「开/关」文字：它只有中文，而卡片是中英双语；状态由开关位置 + `aria-checked` 表达。
- 仅客户端产物变化（`lib/client.js`），桥接与 EDA 扩展不变；**刷新/重启 DSH 后生效**。

## 0.6.1

### 发布准备：npm 包元数据、CI 自动发布与可复现构建

尚未发布到 npm（账号侧暂不可用）；仓库侧准备工作已全部完成，恢复后按
[`docs/release.md`](docs/release.md) 走一遍即可。

- `package.json`
  - `publishConfig.registry` 写死 `https://registry.npmjs.org` —— 本机默认 registry 常是国内只读镜像，
    之前这一项会让 `npm publish` 直接 403；
  - `files` 增加 `docs`、`CHANGELOG.md`、`CONTRIBUTING.md`、`LICENSE`：README 里链到
    `docs/design-rules.md` / `docs/tools.md`，npm 页面同样可读；
  - 新增 `prepublishOnly: pnpm check`（发布前必定跑 typecheck + 单测 + build）。
- **可复现构建**：esbuild 会把 `// node_modules/.pnpm/<pkg>_<peer-hash>/…` 这类注释写进 bundle，
  其中的 peer 哈希随机器/pnpm 布局变化 → 同源码在不同机器上字节不同。`build.mjs` 现在构建后剥离这些注释
  （本次 451 B），并把 `node_modules/` 残留检查作为构建输出的一部分。
- 新增 `.github/workflows/publish.yml`：推 `v*` tag 时校验 tag 与 `package.json` 版本一致 →
  `pnpm check` → `npm publish --provenance`，走 **npm trusted publishing（OIDC）**，仓库里没有任何 npm token；
  `workflow_dispatch` 默认只 `npm pack --dry-run`。工作流带两个守卫：bundle 里不得含构建机路径、tag/版本必须一致。
- 新增 [`docs/release.md`](docs/release.md)：首次手动发布、**staged publishing（`0.0.0-stage` 占位版）** 的识别与批准
  （`npx npm@12 stage list/approve`）、trusted publisher 配置表、npmmirror 同步、版本约定（插件版本 vs 线协议版本对）、
  失败模式速查，以及「账号不可用期间不要打 tag」的操作约定。
- `npm pack --dry-run` 实测：**33 文件 / 162.5 kB**（解压 560.6 kB），含 `lib/index.js`、`lib/client.js`、
  `lib/bridge.mjs`、`dsh-eda-bridge-extension.zip`、`cordis.patch.yml`、`docs/`；包名 `dsh-eda-mcp`
  在官方与国内 registry 均未被占用。
- 依赖可解析性已核对：`@deepseek-ai/dsh-mcp-client`、`dsh-settings`、`dsh-system-prompt`、
  `dsh-host-webserver`（均含 `0.1.5-rc.2`）与 `@deepseek-ai/schemastery`（3.18.x）都在公共 registry 上。
- **2FA 两种形态都写进手册**：`npm config get auth-type` 为 `web` 时（本机即是）发布只会打印
  `https://www.npmjs.com/auth/cli/<uuid>` 并在浏览器用安全密钥/设备验证完成，**不需要 6 位码**；
  只有 TOTP 账号才需要 `--otp` 或改用 `--auth-type=web`。
- `publish.yml` 增加 `Is this version already on the registry?` 步骤：版本已存在时跳过 `npm publish`，
  因此**手动发布之后再推 tag 也不会让 CI 变红**（会打印「already published」并正常结束）。

### 跨版本兼容：适配 DSH `0.2.1-rc.x`，并把接缝校验固化成脚本

- **版本事实（2026-10-17 实测）**：npm 上 `@deepseek-ai/dsh` 的 `latest` = `0.2.0-rc.2`（= 桌面端内置运行时），
  `next` = **`0.2.1-rc.2`**（0.2.1-alpha.2→rc.2 一整条线）。本机全局 CLI 为 `0.1.5-rc.2`。
- **0.2.0-rc.2 → 0.2.1-rc.2 的接缝差异（逐个包比对，不是推测）**：

  | 包 | 体积变化 | 结论 |
  |---|---|---|
  | `dsh-mcp-client` | 35041 → 35041（0%） | 字节一致：`inject: ["tools"]`、`serverName`/`command`/`args`/`env`/`cwd`/`toolCallTimeoutMs`/`failOnStartupError`/`reconnect`、`already in use` 守卫全未变 |
  | `dsh-settings` | 22636 → 22636（0%） | 字节一致：`configure` / `installSection` / `register` 三张面孔与 `isVolatile`/`plainConfig` 未变 |
  | `dsh-system-prompt` | 17395 → 19817（+13.9%） | `section({ name, order, text })` 单对象签名未变 |
  | `dsh-host-webserver` | 13284 → 21436（+61.4%） | `register(route)` 与 `route.kind === "exact"` 逐行相同（增长在 IP 校验等安全部分） |
  | `dsh-client-ui-slots` / `dsh-client-locale` | 23461 / 64372（0%） | 字节一致：`slots.inject/register`、`locale.register/bind` 未变 |
  | `dsh-client-ui-settings` | 60010 → 58624（−2.3%） | 有变化，但**本插件的设置卡片不使用它的运行时 API**（卡片用结构化的 `SettingsScope` 走自己的回环路由），因此无影响 |

  另外核对：`dsh-tools` 仍是 `super(ctx, "tools")`（服务名不变）、`dsh-plugin-manager` 仍读 `bundle?.patch`
  （`cordis.patch.yml` 插入机制不变）、`window.__ModuleLoader__.load({ id, factory })` 包装格式在 0.2.1 的客户端产物里逐字相同。
- **因此 0.2.1-rc.x 无需改任何代码**，只需把版本区间补上：`dependencies` 与 `peerDependencies` 现在都是
  `^0.1.5-rc.2 || ^0.2.0-rc.2 || ^0.2.1-rc.2`（注意 semver 的预发布规则：`^0.2.0-rc.2` **不覆盖** `0.2.1-rc.x`，
  比较器元组必须落在同一 major.minor.patch 上）。
- **新增 `test/seams.test.ts` + `scripts/seam-check.mjs`**：把上述每一条契约写成断言，可对任意代际运行 ——
  `pnpm seam-check next` 会把该代际的 7 个接缝包装进临时目录再跑断言，输出每个契约的 PASS/FAIL 与实际版本号。
  实测：`0.1.5-rc.2`（本地）**ALL PASS**、`0.2.1-rc.2`（npm `next`）**ALL PASS**；`pnpm test` 现在包含这套接缝测试。

## 0.6.0

### 设计规范落地：可量化部分改为工具强制，另加只读审计

新增规范正文 [`docs/design-rules.md`](docs/design-rules.md)（原理图分区/放置、网络命名、PCB 布局、
线宽/过孔/铺铜、DRC、丝印板框、制造输出、打样检查清单与推荐工作流），并把其中**能判定的部分**做成代码：

- 新增 `src/bridge/design-rules.ts`（14 个单测，`test/design-rules.test.ts`）：
  - `checkNetName` / `assertNetName`：允许字母、数字、`_`、`.`、`+`、`-`，最长 255 字符；空格、斜杠、括号、中文等
    JLC 后端无法解析的字符**直接拒绝**（后端按精确字符串匹配，`USB_DP/DM` 会被拆成两个网络）；非大写只给警告。
  - `classifyNet` / `suggestTrackWidthMil`：按网络名分 ground / power / signal，给出 6 / 16 mil 的角色默认线宽。
  - `checkTrackWidth`：低于 **6 mil（0.15 mm）** 报错（`force:true` 可越过）；低于角色建议值给警告；
    不在 0.05 mm 步进上的线宽给圆整提示（四个档位值 6/10/16/20 mil 豁免）。
  - `checkVia`：焊环按 **盘径−孔径 ≥ 0.20 mm** 判定（0.2/0.4、0.3/0.6、0.4/0.8 三组标准尺寸均满足），
    孔径 <0.2 mm 报错、<0.3 mm（免费打样下限）警告，非标尺寸警告。
- 工具接线：
  - `pcb_draw_track` 的 `lineWidth` 变为**可选**（按角色取默认值），并回传 `rules` 说明实际用了哪个宽度；
  - `pcb_draw_via` 的 `holeDiameter`/`diameter` 变为**可选**（按角色取标准孔径）；
  - 所有带 `net` 的工具（`eda_draw_wire`、`eda_place_net_flag/port/label(_at_pin)`、`pcb_draw_track/via`、
    `eda_pcb_create_pour`）统一走网络名校验；`eda_pcb_set_net_track_width` 同样校验线宽；
  - `eda_pcb_create_pour` 回传铺铜间距要求（≥6 mil / 建议 10 mil）与「去孤岛」提醒（间距属于板级规则，API 写不了）。
- **新增只读审计工具 `eda_design_audit`**：一次调用返回 `violations` / `warnings` / `checklist`，
  逐项检查每个网络的走线线宽（含 `minWidthByNet` 与角色建议值）、过孔孔径与焊环、网络名合法性、板框、
  铺铜、PCB DRC（可 `drc:false` 跳过）。布线前后各跑一次即可对照 `docs/design-rules.md` §9 清单。
- 系统提示（`src/guidance.ts`）改为**规范优先**的紧凑版本：网络命名、线宽档位、过孔标准尺寸、铺铜与 DRC、
  分区/布局/丝印流程、长任务轮询、活动文档规则；细则留在 `docs/design-rules.md`，避免每轮 prompt 过长。
- 工具总数 81 → **82**；`docs/tools.md` 由新增的 `scripts/gen-tools-doc.mjs`（`pnpm docs`）重新生成。

### 未改动

- bridge 与 EDA 扩展的线协议版本仍为 **0.3.5**（白名单与内部助手未变，**无需重新导入 zip**）。
- 平台相关能力（丝印尺寸、布局评分、铺铜间距）API 不暴露，因此只写进规范与提示，不做自动判定。

## 0.5.1

### 修复：官方桌面端（DSH 0.2.0-rc.2）里 bridge 子进程根本起不来

- **根因**：桌面端把插件宿主跑在 Electron 里，`process.execPath` 是 `D:\DeepSeek Harness\DeepSeek Harness.exe` 而不是 Node。旧代码 `command: process.execPath` 等于让应用二进制去执行 `lib/bridge.mjs`——要么启动第二个实例、要么被单实例锁挡掉后立刻退出，于是 39009 从来没有监听：设置卡片在、`/test` 恒 503、Agent 也拿不到 `mcp__jlceda__*` 工具。
- **修复**：新增 `src/node-runtime.ts`，按六级顺序挑真正能跑 Node 脚本的可执行文件：
  1. `DSH_EDA_MCP_NODE` 显式覆盖；
  2. `DSH_NODE_EXECUTABLE` / `DSH_DESKTOP_NODE_EXECUTABLE`（+ `ELECTRON_RUN_AS_NODE=1`）；
  3. 宿主是 Node → `process.execPath`；
  4. Electron 宿主 → 桌面负载自带 `resources/runtime/primary-runtime/dependencies/node/bin/node.exe`；
  5. `PATH` 里的 `node`；
  6. 兜底 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`。
- 子进程 `cwd` 从 `process.cwd()`（GUI 应用里可能是 `C:\Windows\System32`）改为 bridge 脚本所在目录。
- `/api/dsh-eda-mcp/test` 与 `/reconnect` 的响应新增 `launch: { command, args, source }`，直接暴露「用的哪个可执行文件、依据哪条规则」，不用再靠猜。

### 修复（第二轮）：可执行文件选对之后，MCP 客户端仍然没有 spawn

桌面端重启后 `launch` 已证明命令正确（`desktop runtime Node` + `lib/bridge.mjs`），但 `/test` 依旧 503；用进程监视盯住整次 `/reconnect`，**没有任何 `node.exe` 子进程被创建过** —— 问题在挂载，不在命令。

- **0.2.0-rc.2 的契约**（从 `app.asar` 提取真实 runtime 读出）：`@deepseek-ai/dsh-mcp-client` 的 `inject = ["tools"]`（`tools` 由根级行 `@deepseek-ai/dsh-tools` 的 `super(ctx, "tools")` 提供），所以它只会在「工具注册表可达」的上下文里 apply；此外它给 `serverName` 加了一把唯一性守卫——同一个 owner 作用域里 `jlceda` 还没随旧 fiber 释放就被再次占用，就直接抛 `serverName "jlceda" is already in use`。而 `fiber.dispose()` 是**异步**的，插件的 `sync()` 在启动阶段会跑两次 `remountClient()`，第二次完全可能撞上守卫；再叠加 `failOnStartupError: false`，错误只进 host logger（桌面端不落盘），于是表现为「什么都没发生」。
- **修复**：`remountClient()` 改为**串行队列 + await 上一次 fiber 销毁**；MCP 客户端改到 `ctx.inject(['tools'], …)` 内挂载（既等待服务可见，又能记录它是否出现）；所有挂载异常写入诊断记录，不再静默。
- **新增自检路由**（这次排查缺的就是它）：
  - `POST /api/dsh-eda-mcp/diagnostics` → `{ launch, diagnostics, config }`，其中 `diagnostics` 记录 `toolsServiceSeen` / `mountAttempts` / `mountError` / `clientFiberState` / `bridgeHealth` / `probeError` / `probedAt`；
  - `POST /api/dsh-eda-mcp/self-test` → **从插件宿主进程内部**直接 spawn bridge（`spawned`/`exited`/`exitCode`/`stderr`/`stdout`/`healthz`/`spawnError`/`pid`），用来区分「宿主不能启动该可执行文件」和「MCP 客户端没去启动它」。

### 修复（第三轮，真正的根因）：0.2 的 `volatile` 配置字段是「活值句柄」，不是值

打开 `failOnStartupError: true` 并捕获 fiber 的 reject 之后，终于拿到被吞掉的错误：

```
ValidationError: invalid config
  ... but got {"transport":"stdio","serverName":"jlceda","command":"…\\node.exe","args":["…\\bridge.mjs"],
              "env":{"DSH_EDA_MCP_ALLOW_RAW_API":"1","DSH_EDA_MCP_TOOL_TIMEOUT_MS":"[object Object]"},
              "cwd":"…\\lib","toolCallTimeoutMs":{},"failOnStartupError":true,…}
```

- **根因**：DSH ≥ 0.2 把标了 `.volatile()` 的配置字段交给 `apply()` 时**不是普通值**，而是活值引用。`@deepseek-ai/cosmokit` 的定义是 `const write = Symbol.for("cosmokit.volatile.write")`、句柄为 `Object.freeze({ get: () => current, [write]: (v) => … })`，判定函数是 `isVolatile(v) = typeof v === "object" && v !== null && write in v`（**Symbol 键**）；`@deepseek-ai/dsh-settings` 用 `isVolatile(v) ? v.get() : v` 拆包。插件直接当值用 → 数字字段变成 `{}`、字符串化成 `"[object Object]"` → **mcp-client 的配置校验失败，连接从头到尾没有发起**；`failOnStartupError: false` 又把这个错误只写进 host logger（桌面端不落盘），于是一直表现为「重连失败: bridge-unreachable」而没有任何提示。这也解释了 `/diagnostics` 里 `config` 四个字段全是 `{}`。
- **修复**：新增 `src/config-values.ts` —— 标记用 `Symbol.for('cosmokit.volatile.write')` 从**全局符号注册表**取（因此不依赖 cosmokit 包本身，也不依赖宿主导入的是哪一份）；提供 `isLiveValue` / `readConfigValue` / `unwrapConfig` 以及带默认值的 `booleanField` / `numberField`。`apply()` 的 `current()` 与 `setSource` 两条路径统一解包，`bridgeLaunchFor()` 与 `sync()` 改用带默认值的读取器——即使将来设置代际再换包装，也只会退回默认值，而不会把一个对象塞进会做类型校验的消费者。`/diagnostics` 新增 `launchConfig`，直接暴露交给 mcp-client 的那份配置。
- **中途踩的坑（已修）**：第一版判定写成 `'write' in value`（字符串键），对 Symbol 键恒为 false，于是解包没生效 —— 重启后 `/diagnostics.launchConfig` 仍是 `toolCallTimeoutMs: {}`，这才定位到 Symbol。`test/config-values.test.ts` 现在按 cosmokit 的真实构造（`Object.freeze` + `Symbol.for` 键）造句柄。
- `failOnStartupError` 保持 `true`：bridge 是本插件自己的脚本，启动失败就该抛出（而不是静默重试到放弃）。

### 验证

- **单测**：`test/config-values.test.ts` 14 例全过（含「有 `get` 但没有协议 Symbol 的普通对象不得误拆」「`booleanField`/`numberField` 对不可读包装退回默认值」）；`test/node-runtime.test.ts` 7 例全过（Node 宿主 / Electron 找自带 Node / 覆盖变量 / 启动器变量 / 不存在的覆盖值 / PATH 回退 / Electron 兜底）；按真实桌面布局（`execPath = D:\DeepSeek Harness\DeepSeek Harness.exe`）解析出 `…\primary-runtime\dependencies\node\bin\node.exe`，`source = desktop runtime Node`。
- **真实启动**：用该可执行文件跑 `lib/bridge.mjs` → `http://127.0.0.1:39009/healthz` 返回 `{"status":"ok","version":"0.3.5","clients":0}`，进程结束后端口关闭。
- **0.2.0-rc.2 接缝逐条核对**（从 `app.asar` 提取真实运行时确认）：`SystemPrompt.section({ name, order, text })` 仍是单对象签名；`SettingsForms` 的 `configure({ auto:false })` + `describe`/`mutate` 可用（实测 `POST /api/dsh-eda-mcp/settings/describe` 返回 `writable: true`，`mutate` 提交成功）；`dsh-mcp-client` 的子进程环境是 `{ ...scrubbedParentEnv(), ...config.env }`（合并，不是替换）；客户端 inject 的 `@deepseek-ai/dsh-client-ui-settings@0.2.0-rc.2`、`dsh-client-locale@0.2.0-rc.2` 都在桌面负载里。
- `tsc --noEmit` 与 `node build.mjs` 通过。
- **桌面端实测（用户重启后）**：`POST /api/dsh-eda-mcp/test` → `{"ok":true,"health":{"status":"ok","version":"0.3.5","clients":1}}`；`/diagnostics` → `config` 为明文 `{enabled:true, announceToAgent:true, toolCallTimeoutMs:60000, allowRawApi:true}`、`launchConfig.toolCallTimeoutMs=60000`、`env.DSH_EDA_MCP_TOOL_TIMEOUT_MS="60000"`、`bridgeHealth:"ok"`、`clientFiberState:2`（active）；插件管理器 `/failures` 为空、`dsh-eda-mcp` 行 `enabled:true @0.5.1`；会话内 `mcp__jlceda__*` 命名空间（81 个工具）已注册。
- 收尾小修（下次重启自然生效）：`beginMount()` 现在会清掉上一轮的 `clientStartupError`（否则启动期重挂竞争会留下一条与当前健康连接并存的旧错误，例如 `cannot create effect on inactive context`）；`apply()` 末尾的兜底 `sync()` 只在设置接缝没有回调过时才执行，避免启动时多做一次重挂。

### 已知限制

- **宿主模块热重载不会重新 import 已缓存的 ESM**：试过两条路都不行 —— 插件管理器 `set-enabled` 停用/启用（会写 profile patch 并让宿主重挂载该行，但模块仍走缓存），以及把 `package.json` 的入口换成新文件名（换 URL 本应触发重新 import，实测宿主仍执行旧模块）。改了 `src/` 必须 `node build.mjs` + **重启桌面应用**。
- 第二轮挂载修复（`inject(['tools'])` + 串行销毁）**尚未在运行中的应用里验证**，需要一次重启；重启后 `/diagnostics` 与 `/self-test` 会直接给出结论。
- 本版只改宿主端；bridge（0.3.5）与 EDA 扩展（0.3.5）不变。扩展侧仍缺 `clearRouting` 后台任务类型的那一版需要重新导入 zip 才能拿到「异步清布线」。

## 0.5.0

### 兼容 DSH 0.2.0-rc.x 与官方桌面端（同一份构建继续支持 0.1.1-rc.x / 0.1.5-rc.x）

- **设置接缝三代表探测**：0.2 起 `ctx.settings` 是 `SettingsForms`，插件的命名空间就是它在 profile 里的 entry Config，`installSection`/`register` 都已移除。现在按 0.2 `configure({ auto: false })` → 0.1.5 `installSection` → 0.1.1 `register` 依次探测；0.2 下关掉自动生成的设置页，插件自带的卡片仍是唯一入口。
- **Config 字段标记 `.volatile()`**：0.2 只把标了 `volatile` 的字段投影成可编辑表单（`SettingsForms.describe()` 会跳过其余字段），四个设置项全部标记；该标记在旧接缝上只是 schema 元数据。
- **schema 依赖换成 `@deepseek-ai/schemastery`**：与各代运行时加载插件 Config 所用的包一致（原为不带 scope 的 `schemastery`）。
- **桥接路由改为结构类型**：`@deepseek-ai/dsh-settings` 的 `SettingsProvider` 类型在 0.2 已不存在，`src/routes.ts` 改用本地 `SettingsBridge`/`SettingsBridgeView`（`describe`/`mutate`/`writable`），`ctx.settings` 在调用点显式转型——一份代码同时通过两代类型检查。
- **设置冲突判定跨副本安全**：插件自带的 `@deepseek-ai/dsh-settings` 副本与宿主实际抛错的副本不是同一份，`instanceof` 恒为 false；现在同时检查 `error.code === 'SETTINGS_CONFLICT'`。
- **客户端类型本地化**：`SettingsScope`/`SettingsScopeSnapshot` 在 0.2 已改名 `ConfigForm`/`ConfigFormSnapshot`，卡片改用 `src/client/settings-scope.ts` 内声明的结构类型（成员与两代一致）。
- 对等依赖范围扩到 `^0.1.1-rc.2 || ^0.1.5-rc.2 || ^0.2.0-rc.2`；构建设置新增 `zustand@4.4.7`、`immer@10.2.0`（内联快照存储的构建期依赖，不进入运行时外部清单）。

### 未改动（刻意保持）

- 工具集（69 个）、MCP/bridge 协议、WebSocket 端口 39009、扩展白名单、设置卡片字段与交互全部与 0.4.1 相同；bridge 与 EDA 扩展版本号仍为 **0.3.5**，**无需重新导入 zip**。

### 验证

- 0.1.5-rc.2 与 0.2.0-rc.2 两套 `tsc --noEmit` 与构建全部通过；客户端 bundle 的运行时依赖仍只有 `react`/`react/jsx-runtime`。
- 在隔离 `DSH_HOME` 里用 0.2 运行时启动 web profile：插件加载无任何报错，`POST /api/dsh-eda-mcp/settings/describe` 正确返回 `schema`/`value`/`base`/`user`/`secrets`/`writable`；`/api/dsh-eda-mcp/test` 正常响应。
- 跨代 mcp-client 兼容性已核对：0.1.5 与 0.2 的 `ctx.tools.register(definition)` 签名、`ToolDefinition` 形状一致（0.2 仅新增可选 `projectContent`），因此插件自带的 0.1.5 `dsh-mcp-client` 副本在 0.2 宿主上可用。

### 升级注意

- 0.2 上本插件设置由 **profile entry Config** 承载；旧 `~/.dsh/settings.yaml` 会在 0.2 首次启动时被迁移/改名（`settings.yaml.imported`），`eda-mcp` 一节会迁进当时运行的那个 profile。

## 0.4.1

bridge 与 EDA 扩展版本：**0.3.4 → 0.3.5**（扩展白名单与内部助手有新增，需要重新导入 zip 并重启嘉立创EDA专业版）。

### 自动布线/自动布局：改为「启动 + 轮询」，不再用超时硬等

- 之前 `eda_pcb_auto_route` 会一直等到布线结束，整板或大网络（GND 35+ 引脚）必然撞上 MCP 工具超时——而 EDA 侧其实还在正常布线并显示进度条，只是调用方已经超时放弃了。
- 现在默认**异步启动**：扩展内部用 `dsh.internal.jobStart` 发起 `pcb_Document.autoRouting` 但**不 await**，把 promise 状态存起来立刻返回；新增 `eda_pcb_job_status`（`dsh.internal.jobStatus`）轮询 `{running, elapsedMs, result, error}`。
- `eda_pcb_auto_route`：默认异步（返回 `started`/`running`/`requestedNets`/`props` 与提示），`wait: true` 才阻塞；`eda_pcb_auto_place` 默认阻塞、`wait: false` 异步。
- 因此**不需要再加大超时**；长任务用轮询。`timeoutMs` 参数保留给 DRC/Gerber 等同步调用。
- 任务结束时 `hint` 会给出下一步（`success=false`/`duration=0` 的解释、未布通网络列表、建议跑 DRC 与加宽电源网络）。

### 网络标签：createNetLabel + 文本回退

- 新增 `eda_place_net_label`（`sch_PrimitiveAttribute.createNetLabel(x, y, net)`）与 `eda_get_net_labels`；`eda_place_net_label_at_pin` 改为**优先创建真正的网络标签图元**，返回 `method: 'netLabel' | 'text'`。
- `createNetLabel` 官方标注「ADD since EDA v4」，当前 EDA 3.2.186 上可能不存在；不存在时自动回退到文本标签，并在结果里明确警告「文本标签不建立电气连接，请改用 eda_draw_wire 的 net 参数」。

### eda_get_nets 返回空的定位与修复

- 实测：`sch_Net.getCurrentProjectAllNets` / `sch_Net.getAllNets` / `sch_Net.getAllNetsName` 在**当前活动文档不是原理图**时全部返回 `[]`（`sch_ManufactureData.getNetlistFile` 同时返回 `null`）。这是「查询作用于当前活动文档」造成的，不是网表坏了。
- 新增 `eda_get_active_document`（`dmt_SelectControl.getCurrentDocumentInfo`，返回 `documentTypeName`）与 `eda_open_document`（`dmt_EditorControl.openDocument`），可以在调用前把原理图/PCB 切到前台。
- `eda_get_nets` 现在按 getCurrentProjectAllNets → getAllNets → 解析 `sch_Netlist.getNetlist` 依次降级，并返回 `source` 与提示；`eda_export_netlist` 为 `null` 的说明也写进了工具描述。

### 覆铜 / PCB DRC / 电源线宽

- `eda_pcb_create_pour` / `eda_pcb_get_pours` / `eda_pcb_delete_pour`：`pcb_MathPolygon.createPolygon` + `pcb_PrimitivePour.create`（内部助手 `dsh.internal.pourCreate`），`pourFillMethod` 支持 `45grid` / `90grid` / `solid`，铜层 1/2/15-44。
- `eda_pcb_run_drc`（`pcb_Drc.check`，strict / userInterface / includeVerboseError）、`eda_pcb_get_drc_rules`（当前规则配置名与内容、实时 DRC 状态）。
- `eda_pcb_set_net_track_width`：按网络批量改线宽（遍历 `pcb_PrimitiveLine.getAll` 再逐条 `modify`），用于布完线给电源/GND 加粗。

### 器件引脚网络一致性

- `pcb_get_components` 新增 `includePins`：额外调用 `pcb_PrimitiveComponent.getAllPinsByPrimitiveId`（准确来源）返回 `pins` 与 `padNets`；器件对象自带的那份 pad/net 在网表导入后可能滞后。

### 设计流程知识（写入系统提示）

- 在插件注入的说明里补充 PCB 设计流程：先闭合板框 → 功能分区布局（连接器靠板边、去耦电容贴近电源引脚、晶振/敏感模拟远离开关电源）→ 导入网表 → 布线（长任务轮询）→ DRC → 电源/GND 加粗与铺铜；并说明原理图 API 依赖活动文档。

### 原理图→PCB 同步：异步触发 + 低频轮询确认

- `pcb_Document.importChanges` 会弹出 EDA 自己的同步确认对话框并**一直阻塞**，所以 `pcb_import_changes` 默认改为**异步触发**：调用立刻返回 `componentsBefore`，导入在后台跑（`dsh.internal.jobStart` 新增 `importChanges` 类型）。`wait: true` 保留旧的阻塞行为。
- 新增 `eda_pcb_wait_for_components`：**低频轮询**（默认 5 s、最小 3 s、最长 45 s，可调），判定规则是「PCB 上出现了同步前不存在的元件」——出现即说明用户点了确认。返回 `confirmed` / `waitedMs` / `newComponentIds`；未确认则返回 `confirmed: false` 让调用方去问用户再调一次。

### 文档

- 新增 `docs/tools.md`：由构建产物的 MCP `tools/list` **自动生成**的完整工具参考（名称/描述/参数/必填项），避免文档与代码漂移。
- `README.md` / `README.zh.md` 增加「推荐工作流」：原理图电气连接（net 参数 vs 文本标签）、同步确认轮询、异步布线轮询、DRC、电源加宽与铺铜、活动文档规则。

### 网络标识不再压住元件（引脚方向 + 短导线）

- 旧行为把电源标识/网络标签**正好放在引脚连接点**上，直接盖住元件本体与引脚，原理图看不清。
- 现在两个 at_pin 工具先读引脚的 `rotation`（实测语义：0=+x、90=+y、180=-x、270=-y，且指向**离开元件本体**的方向），再从引脚沿该方向拉一条**带同名 net 的短导线**（`stubLength`，默认 20 MCP 单位 = 5.08 mm），把标识/标签放在导线末端：
  - `eda_place_net_flag_at_pin`：`createNetFlag` 放在末端，rotation 默认跟随引脚方向；
  - `eda_place_net_label_at_pin`：`createNetLabel`（或文本回退）放在末端。
- 因为短导线本身带 net，即使标签是文本回退（`method: "text"`）**电气连接也已经由导线建立**，不再依赖标签图元。
- `offsetX/offsetY` = 手动定位（自动禁用短导线，保持旧语义）；`stubLength: 0` = 完全旧行为；落点同样做图框/标题栏避让检查，越界直接报错而不是画到框外。
- 已在用户原理图上实测（J3 的 rotation=270 与 90 两个引脚）：落点分别在引脚下方 20 与上方 20，短导线与标识创建成功，测试图元已全部删除。

### 清除布线超时：后台任务 + 分批回退

- 现象：`eda_pcb_clear_routing`（type=all）在整板上必然超时。实测你的板子现在 **0 条走线、4 个过孔**——也就是说 MCP 侧早就超时放弃了，EDA 内部其实**已经把布线清完了**，和自动布线是同一类问题。
- 现在 `pcb_Document.clearRouting` 默认走**后台任务**（`dsh.internal.jobStart` 新增 `clearRouting` 类型）：调用立刻返回，用 `eda_pcb_job_status` 轮询直到 `running=false`（布尔结果会给出「已清除/失败」的说明）。
- 导入的还是旧扩展时**自动降级为分批删除**（`pcb_PrimitiveLine.getAll` + 逐条 delete，`batchSize` 默认 200、上限 2000）：每次调用都在超时内返回 `{matched, deleted, remaining, done, failed}`，重复调用直到 `done: true`。所以清整板不再会超时。
- `mode: "batched"` 强制分批；`wait: true` 保留旧的阻塞调用（可用 `timeoutMs`）；`net`/`layer` 可只清某个网络/层。
- 顺带加固：PCB 图元列表读取遇到「当前活动文档不是 PCB」导致的 `null` 异常时，不再抛出 EDA 内部错误，而是明确提示「请把 PCB 页切到前台」。
- **实机验证**（用户板子上画 12 条走线再清除）：`batchSize: 5` 共 4 轮，每轮 11–48 ms，`matched` 16→11→6→1（含 4 个过孔）、`deleted` 每轮 5、末轮 `done: true`，清除后走线数归零。整板清除不会再超时。
- 兼容性补强：扩展有 `jobStart` 但不支持该 kind 时会抛 `unsupported job kind`，该错误现在同样触发分批回退（此前会直接失败）。

### createNetLabel 实测：函数存在但永不 resolve

- 实测 `eda.sch_PrimitiveAttribute.createNetLabel(0, 0, 'X')` 在 JLCEDA Pro 3.2.186 上**对 MCP 调用一直挂住直到 60 s 超时**（扩展能解析到该函数，所以不是 `API method not found`）。
- 因此 `eda_place_net_label` / `eda_place_net_label_at_pin` 对它的探测改为 **4 s 短超时**并把超时也视为降级信号，立刻回退到文本标签；电气连接由 at_pin 工具同时画出的**带 net 短导线**保证。
### 工具数量

- 69 → 81。

## 0.4.0

### 兼容 DSH 0.1.5-rc.x（同一份构建同时支持 0.1.1-rc.x 与 0.1.5-rc.x）

- 浏览器端不再依赖 DSH 客户端运行时：快照存储 `createSnapshotStore` 改为随插件打包，`lib/client.js` 的运行时依赖只剩 Web 外壳内置的 `react` 与 `react/jsx-runtime`。原 `@deepseek-ai/dsh-client-runtime` 自 DSH 0.1.2 起被上游移除，`@deepseek-ai/dsh-client-store` 是 0.1.5 才有的平台模块，内联后两代外壳都能加载。
- 宿主端设置接缝改为运行时探测：DSH 0.1.5 走 `settings.installSection(owner, ns, schema, entry, hooks)`；旧版回退到 `settings.register(ns, schema, { base })` 的等价接线——与上游已移除的自由函数 `installSettingsSection` 行为一致（同样的 `setSource` 时机、`onChange` 触发点与卸载保护）。
- 设置命名空间常量 `EDA_MCP_SETTINGS_NAMESPACE` 改为普通字符串 `'eda-mcp'`（上游移除了 `settingsNamespace()`）。
- 客户端类型来源迁移：`ClientContext` 改用 `@deepseek-ai/cordis`；`SettingsScope` / `SettingsScopeSnapshot` 改用 `@deepseek-ai/dsh-client-ui-settings/client`；`ctx.slots` 的类型增补由 `@deepseek-ai/dsh-client-ui-renderer/client` 提供。
- 浏览器端设置作用域补齐 0.1.5 契约新增的 `mutate(ops, expectedRevision)`，直接复用既有桥接写路径；`set` / `unset` 行为不变。
- 依赖声明：`dsh.client.inject` 收敛为两代都存在的 `@deepseek-ai/dsh-client-ui-settings` 与 `@deepseek-ai/dsh-client-locale`；`@deepseek-ai/dsh-*` 对等依赖范围为 `^0.1.1-rc.2 || ^0.1.5-rc.2`，`@deepseek-ai/cordis` 为 `^4.0.1`。

### 未改动（刻意保持）

- **工具集与工具数量不变（69 个）**，MCP/bridge 协议、WebSocket 端口（39009）、扩展白名单、设置卡片字段、坐标与单位约定全部与 0.3.4 相同；本次只做运行时接缝适配。
- **bridge 与嘉立创EDA 扩展的版本号仍为 0.3.4**：`src/bridge/index.ts` 的 `VERSION` 与 `jlc-extension/extension.json` 的 `version` 参与 `eda_status.versionMismatch` 比对，二者代码未变就不该抬版本——否则会误报「版本不一致」并要求重新导入 zip。因此**本次升级无需重新导入扩展、也无需重启嘉立创EDA**。

### 升级注意

- 插件包版本（0.4.0）与 bridge/扩展版本（0.3.4）本就不要求一致，`eda_status` 只比对 bridge 与扩展。
- 若从 DSH 0.1.1-rc.x 升到 0.1.5-rc.x，插件无需重装；反之回退 DSH 版本同样可用。

## 0.3.4

### 板框：改用 `pcb_PrimitivePolyline`（根因已定位）

- **0.3.3 的板框实现是错的**：`pcb_PrimitiveLine` 是「导线」（铜层 + 网络）图元，板框层 11 会被核心拒绝，报「无法创建直线图元，可能是传入的参数不正确」（线宽 1/5/10/20/50 都一样）。
- 根因证据来自 JLCEDA 自己的工程文件格式（`assets/db/example-projects.zip` 里的 `.eprj2` 是 SQLite，PCB 文档在 `documents.dataStr`）。真实板框记录长这样：

  ```
  ["POLY", "e102", 0, "", 11, 10, ["R", 0, 0, 3149.6063, 2362.2047, 0, 0], 1]
  ```

  即 **`POLY`（折线 = `pcb_PrimitivePolyline`）**，层 11，多边形源数组；而 `LINE` 记录全部是带网络的铜层导线。
- 因此 `pcb_draw_board_outline` / `eda_pcb_draw_board_outline` 现在改为：`pcb_MathPolygon.createPolygon([x1,y1,'L',x2,y2,...])` + `pcb_PrimitivePolyline.create(net, 11, polygon, lineWidth)`，一次调用创建 **一条闭合折线**（默认线宽 10 mil，与官方文件一致）。
- 新增扩展内部助手 `dsh.internal.polylineCreate`：多边形对象无法走 WebSocket 序列化，必须把两次官方调用合并到一次扩展往返里完成。
- 新增 PCB 折线工具：`pcb_draw_polyline`（板框 11 / 丝印 3、4 / 装配 9、10 / 机械 14 / 文档 13 / 铜层 1、2）、`eda_pcb_get_polylines`、`eda_pcb_delete_polyline`，扩展白名单同步放开 `pcb_PrimitivePolyline.*`。

### 自动布线：根因是「不传网络 = 全部」在这版 EDA 里不成立

- 实测：`pcb_Document.autoRouting` 不传网络时 `routingRange` 为 `[]`，本版 EDA 核心会立刻返回 `success=false, duration=0` 并把 48 个网络全部列为失败；显式传网络（如 `RoutingNets: ["GND"]`）则 `success=true`（288 ms，1/1 成功），`["VCC5","VCC3V3","LED_G"]` 也 3/3 成功。
- 所以 bridge 侧 `eda_pcb_auto_route` 现在：不传网络时先枚举 `pcb_Net.getAllNetsName` 并把**全部网络名显式传入**；空数组同样按「全部」处理。
- 官方文档示例写的是 `nets`，但 0.3.18 的实现只读 `RoutingNets`，`nets` 会被静默忽略。现在两个键都接受（`nets` → `RoutingNets`）。
- 参数补齐：`ignoreNets`、`layers`、`cornerStyle`(0=45°/1=90°)、`optimization`(1=布通率/0=更快)、`existingPrimitiveMode`(keep/remove) 可直接传顶层键；返回值附带 `requestedNets`、`props` 和 `hint`（`duration=0` 时说明路由器根本没启动及排查方向）。
- 新增 `eda_pcb_clear_routing`（`pcb_Document.clearRouting`，all / net / connection）。

### 其它

- 工具总数 65 → 69。
- 版本统一为 **0.3.4**（插件包、bridge、EDA 扩展）。板框/折线需要在嘉立创EDA里**重新导入 zip 并重启 EDA**；自动布线修复只在 bridge 侧，点一次设置页「重连」即可生效。

## 0.3.3

### 新增 PCB 写操作 / 查询工具（bridge + 扩展白名单）

- 器件：`eda_pcb_move_component`（`pcb_PrimitiveComponent.modify`）、`eda_pcb_delete_component`（`.delete`）。
- 走线：`eda_pcb_get_tracks`（`pcb_PrimitiveLine.getAll`）、`eda_pcb_modify_track`（`.modify`）、`eda_pcb_delete_track`（`.delete`）。
- 过孔：`eda_pcb_get_vias`（`pcb_PrimitiveVia.getAll`）、`eda_pcb_delete_via`（`.delete`）。
- 区域：`eda_pcb_create_region`（`pcb_MathPolygon.createPolygon` + `pcb_PrimitiveRegion.create`）、`eda_pcb_get_regions`、`eda_pcb_delete_region`。
- 自动布局/布线：`eda_pcb_auto_place`（`pcb_Document.autoLayout`）、`eda_pcb_auto_route`（`pcb_Document.autoRouting`）。
- Gerber：`eda_pcb_export_gerber`（`pcb_ManufactureData.getGerberFile`），返回 `{ name, size, dataUrl }`（zip 为 base64，大板可能很大）。
- 别名：`eda_pcb_get_components` / `eda_pcb_get_nets` / `eda_pcb_get_layers` / `eda_pcb_place_component` / `eda_pcb_draw_track` / `eda_pcb_draw_via` / `eda_pcb_save_document` / `eda_pcb_import_changes` / `eda_pcb_get_primitives_in_region` / `eda_pcb_navigate_to_region` / `eda_pcb_draw_board_outline` 统一映射到同名 `pcb_*` 工具。
- 工具总数 41 → 65。

### 修正

- **板框不能用区域 API**：官方类型是 `TPCB_LayersOfRegion = TPCB_LayersOfCopper | EPCB_LayerId.MULTI`，即只允许 top(1)/bottom(2)/内层(15-44)/MULTI(12)；板框层 11 调用 `pcb_PrimitiveRegion.create` 会失败。因此 `pcb_draw_board_outline` / `eda_pcb_draw_board_outline` 仍按**板框层 11 上的闭合线段**绘制，并在文档与工具描述里写清；`eda_pcb_create_region` 对非铜层直接报错。
- `pcb_draw_board_outline` 增加入参校验（至少 3 个点、有限数值、自动去掉重复的收尾点）、线段明细与失败计数，不再静默产生零长度线段。
- 区域创建走扩展内部助手 `dsh.internal.pcbCreateRegion`：先用 `pcb_MathPolygon.createPolygon` 把 `[x1,y1,'L',x2,y2,...]` 源数组转成 `IPCB_Polygon`（高层 API 不接受原始数组），并把 JSON 里的 `null` 还原为 `undefined`（可选参数）。
- bridge 监听端口被占用时不再抛出未捕获异常崩溃：输出可读的 stderr 提示（含 `netstat -ano | findstr 39009` 排查建议）。

### 嘉立创EDA扩展

- 新增心跳自愈：官方 `sys_WebSocket` 既没有关闭回调也不会自动重连，原实现一旦 DSH 桥接子进程重启（例如点设置页「重连」）就永久掉线，只能手动点菜单。现在每 10s 发一次 `ping`，超过 2.5 个心跳没有 `pong` 就关闭并重新 `register`，未连接时也会以 ≥5s 间隔自动重试。
- 白名单补齐上述 PCB 方法；`pcb_ManufactureData.getGerberFile` 走文件返回通道（返回 base64 data URL + 文件名 + 大小）。

### DSH Host / bridge 诊断

- `eda_status` 新增 `extensionVersion`、`versionMismatch`、`hint`：能直接看出「桥接进程在跑但 EDA 扩展没连上 / 扩展版本与 bridge 不一致」。
- 版本号统一为 **0.3.3**（插件包、bridge、EDA 扩展）。

### 升级注意

- 重新导入 `dsh-eda-bridge-extension.zip` 并重启嘉立创EDA专业版，否则新 PCB 方法会被旧扩展的白名单拒绝（`API method not allowed`）。
- 点一次 DSH 设置页的「重连」即可让 bridge 子进程加载新代码，无需重启 DSH。

## 0.3.2

### 嘉立创EDA扩展

- 修复扩展菜单不显示的问题：
  - `extension.json` 的 `headerMenus` 改为 `home` / `sch` / `pcb` 三个 key，与本机能正常显示菜单的 `JLCEDA-MCP` 扩展保持一致。
  - `activationEvents` 简化为 `{ "onStartupFinished": true }`。
  - `entry` 改为 `"./api-bridge.js"`，并补上 `engines`、`dependentExtensions`、`categories`。
- 新增扩展加载诊断吐司：扩展入口执行时提示 `DSH EDA MCP 扩展已加载 v0.3.2`。
- 新增不依赖菜单的连接入口：
  - 扩展通过 `eda.sys_MessageBus.subscribePublic('dsh-eda-mcp/connect', ...)` 监听连接请求。
  - 未连接时弹出常驻吐司，右侧按钮 **连接 DSH MCP** 执行 `eda.sys_MessageBus.publishPublic('dsh-eda-mcp/connect', {})`。
- DSH 插件包版本、bridge 版本、EDA 扩展版本统一为 **0.3.2**。
- README 增加「菜单不显示时怎么排查」。

### DSH Host

- 无功能变化（仅版本号对齐）。

## 0.3.1

### 嘉立创EDA扩展

- 把菜单直接写进 `extension.json` 的 `headerMenus`，不再只依赖运行时 `insertHeaderMenus`。
- 运行时菜单注册增加重试（最多 5 次）和 `console.error` 日志。
- `dshEdaMcpConnect` / `dshEdaMcpDisconnect` / `dshEdaMcpStatus` 同时挂到 global，保证 `registerFn` 可被解析。

## 0.3.0

### 嘉立创EDA扩展

- 新增手动连接菜单：
  - **连接 DSH MCP 服务器**
  - **断开 DSH MCP 连接**
  - **查看 DSH MCP 连接状态**
- 扩展从原理图切到 PCB 时不再掉线：`activationEvents` 覆盖启动和编辑器事件。
- 修正重复激活时的定时器累积问题。

### DSH Host

- 设置卡片新增 **重新连接** 按钮和固定端口显示。
- 新增 `/api/dsh-eda-mcp/reconnect` 路由，会重启 MCP 桥接子进程并返回健康状态。

## 0.2.0

### 坐标与页面边界

- 新增 MCP 工具 `eda_get_page_info`：返回当前页、A4 图框、标题栏避让范围、推荐安全区。
- A4 常量落地：图框 `x 0~1170, y 0~825`；标题栏 `x 460~1160, y 10~190`（MCP 单位 0.01 inch）。
- `eda_place_component` 默认拒绝越出图框或压住标题栏的放置；放置后按实际包围盒二次检查，越界自动删除并报错。
- `eda_draw_rectangle` 明确 `topLeftY` 是上边 y，height 向下延伸。

### 查询修复

- 修复 `eda_get_components`：`sch_PrimitiveComponent.getAll` 固定传 `['part', false]`。
- 返回内容增加 designator、value、x/y、rotation、bbox、width、height。

### 白名单扩展

- 新增 `dmt_Schematic.*`、`sch_Document.autoLayout/autoRouting`、`sch_Drc.check`、`sch_Net.*`、`sch_PrimitivePin.get/modify`、`sch_Primitive.getPrimitivesBBox`、`sch_ManufactureData.getNetlistFile/getBomFile`。
- 新增 PCB 相关：`pcb_Document.*`、`pcb_PrimitiveComponent.*`、`pcb_PrimitiveLine.create`、`pcb_PrimitiveVia.create`、`pcb_Net.*`、`pcb_Layer.*`、`dmt_Board.createBoard`。

### 新工具

- `eda_get_schematic_pages`、`eda_get_nets`、`eda_get_pins`
- `eda_place_net_flag_at_pin`、`eda_place_net_label_at_pin`
- `eda_set_no_connect`
- `eda_draw_functional_box`
- `eda_run_drc`、`eda_auto_layout`、`eda_auto_route`
- `eda_export_netlist`、`eda_export_bom`
- `eda_create_board`
- PCB：`pcb_get_components`、`pcb_get_nets`、`pcb_get_layers`、`pcb_place_component`、`pcb_draw_track`、`pcb_draw_via`、`pcb_draw_board_outline`、`pcb_save_document`、`pcb_import_changes`、`pcb_get_primitives_in_region`、`pcb_navigate_to_region`

### 其他

- EDA 扩展支持返回文件类结果（网表/BOM）的文本或 data URL。
- 系统提示补充坐标单位、A4 图框和标题栏避让说明。

## 0.1.0

- 首个版本：DSH Host 插件 + 零依赖 MCP/WebSocket bridge + 嘉立创EDA扩展 + Web GUI 设置卡片。
- 原理图工具：放置器件、网络标识/端口、画导线/矩形/圆/文本、保存、缩放、查询、删除、白名单通用 API。

## 已知限制

- `sch_Document.navigateToRegion` 在 pro-api 0.3.18 是空实现，始终返回 `false`；请用 `dmt_EditorControl.zoomToRegion` 或 `sch_Document.navigateToCoordinates`。
- 当前 API 版本没有 `dmt_Board.updateBoardFromSchematic`，只有 `dmt_Board.createBoard`。
- 画布截图已能返回 data URL，但还没接入 MCP 图片块。
- 元件包围盒检查依赖 `sch_Primitive.getPrimitivesBBox`；个别没有 BBox 的图元会跳过越界检查。
- WebSocket 端口固定为 `39009`。
