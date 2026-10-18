# Contributing

Thanks for taking a look. This document is short on purpose — the plugin is
small, and the checks below are the whole contract.

## Repository layout

| Path | What it is |
|---|---|
| `src/index.ts` | DSH host half: settings seam, loopback routes, MCP client mount |
| `src/node-runtime.ts` | Picks the executable that can actually run the bridge (Node host vs. Electron desktop) |
| `src/config-values.ts` | Resolves DSH `volatile` config fields (live handles) to plain values |
| `src/bridge-diagnostics.ts` | Mount/bridge diagnostics and the host-side spawn self-test |
| `src/routes.ts` | Loopback HTTP routes: test, reconnect, diagnostics, self-test, settings bridge, extension zip |
| `src/guidance.ts` | System-prompt section injected when `announceToAgent` is on |
| `src/bridge/index.ts` | Standalone MCP (stdio) + WebSocket bridge child, zero dependencies |
| `src/bridge/design-rules.ts` | Enforceable half of the design rules: net naming, width tiers, via geometry |
| `src/client/` | Web settings card (slot `settings.section`) |
| `jlc-extension/` | JLCEDA Pro extension (allow-listed API bridge) packaged into the zip |
| `test/` | Node-runtime, config-value and design-rule unit tests |
| `docs/design-rules.md` | Normative schematic + PCB rule set, with the enforcement mapping |
| `docs/tools.md` | Generated reference for every MCP tool (`pnpm docs`) |
| `scripts/gen-tools-doc.mjs` | Regenerates `docs/tools.md` from the built bridge's `tools/list` |
| `build.mjs` | esbuild bundles + extension zip |

## Development

Requirements: Node `^22.19.0 || >=24`, pnpm (the repo pins `pnpm@10.6.3` through
`packageManager`), and **Windows** for `pnpm build` — the extension zip is
packaged with PowerShell `Compress-Archive`.

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # unit tests + the seam compatibility test
pnpm build       # lib/*.js, lib/bridge.mjs, lib/client.js, dsh-eda-bridge-extension.zip
pnpm check       # all three, in that order
pnpm docs        # regenerate docs/tools.md from the built bridge
pnpm seam-check  # assert the plugin's DSH contracts against another version line
```

`pnpm seam-check` defaults to the registry's `latest`; pass a dist-tag or a version
to check a specific one:

```sh
pnpm seam-check next            # e.g. 0.2.1-rc.2
pnpm seam-check 0.2.0-rc.2
```

It installs that generation's seam packages into a throwaway directory and runs
`test/seams.test.ts` against them, so it never touches this repo's `node_modules`.
When a new DSH line appears, run it first; only widen the ranges in `package.json`
once it passes. Note the semver trap: `^0.2.0-rc.2` does **not** cover `0.2.1-rc.x`
(a prerelease only matches a comparator with the same major.minor.patch), so each
new `0.2.x` prerelease line needs its own entry.

Install the working copy into a DSH profile as a link, so every rebuild is picked
up by a profile restart:

```sh
dsh plugin --profile web add "link:/absolute/path/to/dsh-eda-mcp"
```

The host half is loaded as a packaged ESM module: **a plugin reload does not
re-import a cached module**, so a change under `src/` needs `pnpm build` plus a
Host restart.

## Tests

`test/node-runtime.test.ts` and `test/config-values.test.ts` cover the two places
where a wrong guess is invisible at runtime: which executable starts the bridge on
an Electron host, and how DSH hands `volatile` config fields to `apply()`. Add a
case there when you touch either file — both bugs they cover presented as "the
plugin silently does nothing".

## Pull requests

- Keep a change to one concern; describe what you observed (commands, output) and
  what changed.
- Run `pnpm check` before opening the PR.
- Update `CHANGELOG.md` under a new version heading when behaviour, the tool set,
  the bridge protocol, or the EDA extension allow-list changes.
- Bridge and extension versions are compared by `eda_status` (`versionMismatch`):
  bump `lib/bridge.mjs`'s `VERSION` and `jlc-extension/extension.json` **together
  with** the EDA extension whenever the white-list or an internal helper changes,
  and say so in the changelog so users know to re-import the zip.

## Releases

**Tags are created only on the maintainer's explicit request.** Commits and pushes
to `main` are normal work and land as *unreleased* changes (own heading in
`CHANGELOG.md`); creating a `v*` tag is a release decision and must be asked for
first. A pushed `v*` tag also triggers the `publish` workflow, so tagging by
accident means an accidental npm release.

```sh
# only after the maintainer says "tag it"
# 1. move the unreleased changelog heading to the version, bump package.json, run pnpm check
# 2. commit, then tag and push
git commit -am "chore(release): 0.6.2"
git tag -a v0.6.2 -m "dsh-eda-mcp 0.6.2"
git push origin main --follow-tags
```

`package.json.version` tracks the plugin package; `lib/bridge.mjs` + the EDA
extension have their own version pair (they are the wire contract between the
bridge process and JLCEDA, and `eda_status` reports a mismatch).

Publishing to npm is documented step by step in [`docs/release.md`](docs/release.md):
first release is manual (2FA / staged publishing), afterwards the `publish`
workflow releases on every `v*` tag through npm trusted publishing (OIDC, no
token in the repo). Run `npm pack --dry-run` before tagging — the tarball must
contain `lib/`, the extension zip and `docs/`.

## License

Apache-2.0 — see [LICENSE](LICENSE).
