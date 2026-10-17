# 发布到 npm（维护者手册）

> 面向把 `dsh-eda-mcp` 发到公共 npm registry 的人。用户侧的安装说明在
> [README.zh.md](../README.zh.md)，与发布无关的 CI 说明在 `.github/workflows/`。

## 0. 事实与前提（先读，能省掉一半失败）

| 项 | 值 / 说明 |
|---|---|
| 包名 | `dsh-eda-mcp` —— 在 `registry.npmjs.org` 与 `registry.npmmirror.com` 上**均未被占用**（2026-10 实测 404） |
| 发布源 | **只能**用 `https://registry.npmjs.org`。`package.json` 的 `publishConfig.registry` 已写死，正常不需要再传 `--registry` |
| 本机默认 registry | 通常是 `registry.npmmirror.com`（**只读镜像，不能发布**）。`publishConfig.registry` 会覆盖它；如仍报 `E403`，显式加 `--registry=https://registry.npmjs.org` |
| 2FA | npm 现在**强制**发布时提供动态码。不带 `--otp` 不会直接失败，而是生成一个 `0.0.0-stage` 占位版并把真实版本**暂存**起来等你批准 |
| 首次发布 | 必须**手动**完成：trusted publisher 只能对已存在的包配置 |
| 包体积 | 约 162 kB（33 个文件），`dependencies` 只指向公开的 `@deepseek-ai/*` 与 `schemastery`，安装方不需要构建工具链 |

## 1. 发布前自检

```powershell
cd D:\Program\DSH-Plugin-Class\dsh-eda-mcp

git status                          # 干净
node -p "require('./package.json').version"   # 与即将打的 tag 一致
git tag -l                          # 不能重复

pnpm check                          # typecheck + 3 套单测 + build
node scripts/gen-tools-doc.mjs      # 工具描述变了就重新生成 docs/tools.md

npm pack --dry-run                  # 看 tarball 内容
```

`npm pack --dry-run` 里必须能同时看到 **`lib/index.js`、`lib/client.js`、`lib/bridge.mjs`、
`dsh-eda-bridge-extension.zip`、`cordis.patch.yml`、`docs/`**。`lib/` 与 zip 是构建产物（被 gitignore），
由 `prepare` 脚本在打包时生成 —— 所以**打包机必须是 Windows**（zip 用 PowerShell `Compress-Archive`）。

## 2. 首次手动发布

```powershell
npm login --registry=https://registry.npmjs.org      # 浏览器登录
npm whoami --registry=https://registry.npmjs.org     # 应回显你的用户名

npm publish --access public --otp=你的6位动态码
```

`--registry` 可省略（`publishConfig.registry` 已指定），但显式写出最稳妥。

### 2a. 如果 npm 把它「暂存」了（`0.0.0-stage` 占位版）

现象：终端显示发布成功，但 registry 上 `latest` 是 `0.0.0-stage`，而
`https://registry.npmjs.org/dsh-eda-mcp/-/dsh-eda-mcp-<版本>.tgz` 是 **404**。

本地 npm 需要 **≥ 11.6** 才有 `stage` 命令（npm 10 没有），用 `npx` 跑新版即可：

```powershell
npx --yes npm@12 stage list                        # 列出暂存版本与 stage-id
npx --yes npm@12 stage approve <stage-id>          # 批准即真正发布（要 OTP）
# 需要重新暂存时：
npx --yes npm@12 stage publish . --registry=https://registry.npmjs.org
```

> npm 12 要求 Node ≥ 22.22.2；本机 Node 22.19 只会打 warning，`npx` 可以正常运行。

### 2b. 占位版清理（可选）

```powershell
npx --yes npm@12 unpublish dsh-eda-mcp@0.0.0-stage --registry=https://registry.npmjs.org
```

## 3. 发布后验证

```powershell
# ① 版本与 tag
curl.exe -s https://registry.npmjs.org/dsh-eda-mcp | Select-String '"latest"'
# ② tarball 可下载（应为 200）
curl.exe -sI https://registry.npmjs.org/dsh-eda-mcp/-/dsh-eda-mcp-<版本>.tgz | Select-Object -First 1
# ③ 国内镜像同步（npmmirror 会自动同步，这条是催一下）
curl.exe -sX PUT "https://registry.npmmirror.com/-/package/dsh-eda-mcp/syncs"
```

再实测一次「别人装」的路径（干净目录，不带任何 link 历史）：

```powershell
mkdir $env:TEMP\npm-check; cd $env:TEMP\npm-check
npm init -y
npm i dsh-eda-mcp --registry=https://registry.npmjs.org
dir node_modules\dsh-eda-mcp\lib            # index.js / client.js / bridge.mjs
dir node_modules\dsh-eda-mcp\*.zip          # 扩展 zip 必须在
node -e "import('dsh-eda-mcp').then(m => console.log(Object.keys(m).slice(0, 6)))"
```

## 4. 配置 CI 自动发布（一次，取代手动 OTP）

1. `docs/release.md` 所在仓库已带 `.github/workflows/publish.yml`；
2. 打开 npmjs.com → 该包 → **Settings → Trusted Publisher → GitHub Actions**：

| 字段 | 值 |
|---|---|
| Organization or user | `MCviseron` |
| Repository | `dsh-eda-mcp` |
| Workflow filename | `publish.yml` |
| Environment | **留空** |
| 勾选项 | ✔ **Allow npm publish**（必勾，否则 CI 只能暂存）；✔ **Allow npm dist-tag**（可选，用于修正 `latest`） |

3. 之后发版就是：

```powershell
npm version patch        # 改 package.json + 提交 + 打 tag
git push --follow-tags   # CI: check → publish --provenance（OIDC，无需动态码）
```

> **不要再往仓库里加 `NPM_TOKEN`**：OIDC 模式下设置 `NODE_AUTH_TOKEN` 会让 npm 走 bearer token
> 而不是 OIDC 交换，反而失败。工作流里已用注释说明。

## 5. 版本约定

| 版本 | 含义 | 例子 |
|---|---|---|
| `package.json.version` | 插件包版本 = git tag（`v` + 版本号） | `0.6.1` ↔ `v0.6.1` |
| `lib/bridge.mjs` 的 `VERSION` + `jlc-extension/extension.json` 的 `version` | **线协议版本对**：只有白名单/内部助手变化时才一起抬，`eda_status` 会比对并报 `versionMismatch` | 均为 `0.3.5` |

改了 `src/bridge/` 的行为但没改白名单时，**不要**抬线协议版本 —— 否则每个用户都要重新导入 zip。
CHANGELOG 里要写明「是否需要重新导入扩展」。

## 6. 发布后收尾清单

- [ ] `README.md` / `README.zh.md` 顶部加 npm 徽章：
      `[![npm](https://img.shields.io/npm/v/dsh-eda-mcp.svg)](https://www.npmjs.com/package/dsh-eda-mcp)`
- [ ] README 安装小节加「从 npm 安装」三行：

      ```powershell
      cd "$env:DSH_HOME\profiles\<profile>"
      pnpm add dsh-eda-mcp          # 或用 DSH 插件管理器的安装
      # 重启 DSH；扩展 zip 在 node_modules\dsh-eda-mcp\ 下，仍需手动导入嘉立创EDA
      ```

- [ ] `CHANGELOG.md` 把该版本标为「已发布到 npm」
- [ ] npmmirror 已同步（`dist-tags.latest` 一致）

## 7. 已知失败模式速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `E403 ... Two-factor authentication ... is required` | 没带 `--otp` | 加 `--otp=123456`；或按 §2a 批准暂存 |
| `E403 Forbidden - PUT https://registry.npmmirror.com/...` | 默认 registry 是只读镜像 | 加 `--registry=https://registry.npmjs.org` |
| 发布成功但 `latest` 是 `0.0.0-stage`、真实 tgz 404 | staged publishing | §2a |
| `E404` 安装时找不到依赖 | `@deepseek-ai/*` 版本在本机源不可用 | 用官方 registry 安装，检查 `dependencies` 版本区间 |
| tarball 里没有 `lib/` | 打包机没跑 `prepare`（例如 `--ignore-scripts`） | 去掉 `--ignore-scripts`，或先 `pnpm build` |
| tarball 里没有扩展 zip | 打包机不是 Windows / `Compress-Archive` 不可用 | 在 Windows 上打包 |
| CI 报 tag 与 version 不一致 | 忘了 `npm version` | `npm version patch && git push --follow-tags` |
| CI 报 `Bundles contain build-machine module paths` | 构建可复现性守卫 | `pnpm build` 后提交（`build.mjs` 会剥离这类注释） |

## 8. 账号不可用期间（例如 npm 账号被临时停用）

发布流程本身不受仓库侧改动影响：先把版本、CHANGELOG、CI 与文档准备好并推 `main`，
**不要**在账号恢复前打 `v*` tag —— 否则 CI 会触发一次注定失败的发布。

恢复后：

```powershell
npm whoami --registry=https://registry.npmjs.org     # 确认账号可用
git tag -a v<版本> -m "..." && git push origin v<版本> # 首次发布建议手动 npm publish，见 §2
```

首次手动发布完成、配置好 trusted publisher 之后，才把 tag 交给 CI。
