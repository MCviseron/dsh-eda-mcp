# DSH version sweep (weekly checklist)

The scheduled reminder runs this sweep. Two traps cost a wrong report once — keep both in mind.

Run `pnpm version-sweep` first — it prints the registry facts, the tuples this repo declares, and
the exact next command. The sections below explain *why* the output says what it says.

## 1. Never trust `latest` alone

- The meta package `@deepseek-ai/dsh` carries the real tags: `latest`, `next`, `alpha`.
- The individual seam packages (`dsh-mcp-client`, `dsh-host-webserver`, `dsh-settings`,
  `dsh-system-prompt`, `dsh-client-ui-*`, `dsh-client-locale`) still publish their own
  `latest` pointing at the **placeholder `0.0.1-rc.1`**. Resolving through `latest` there tests
  the wrong generation.
- Always also read each package's **newest published version** (last key of `versions` in the
  registry document, or `npm view <pkg> versions --json | Select-Object -Last 1`).

## 2. Same version line still needs a probe

A version that lives in an already-supported range can still be *unverified*. When the newest
published build differs from the generations listed as verified in the READMEs, run the seam
check even if the `major.minor.patch` tuple is unchanged (0.2.1-rc.2 → 0.2.1-rc.3 was exactly
this case).

```bash
node scripts/seam-check.mjs <newest version>     # seven seams, temp dir, ~1-2 min
```

`ALL PASS` means the seams still match. Then check the two contracts the script cannot see, by
unpacking the published tarballs:

```bash
npm pack @deepseek-ai/dsh-tools@<v> @deepseek-ai/dsh-plugin-manager@<v>
# expected: dsh-tools still has  super(ctx, "tools")
# expected: dsh-plugin-manager still reads  manifest.dsh?.bundle?.patch
```

## 3. Decide and record

| Situation | Action |
|---|---|
| Newest published == a verified generation, contracts hold | one-line "nothing to do", no changes |
| Same tuple, newer build, seams PASS | no dependency change; add the build to the READMEs' verified list and note the evidence in CHANGELOG |
| **New tuple** (e.g. 0.2.2-rc.x, 0.3.x), seams PASS | add that line to `dependencies`/`peerDependencies` alongside the existing ones (never delete), note it in CHANGELOG/README, run typecheck + tests + build |
| Any seam or contract FAIL | change no code; report the failing assertion, the package and version, plus a suggested fix and its risk |

Boundaries: no `v*` tag and no npm publish (the maintainer decides releases), and the extension
allow-list / bridge wire version stay untouched unless explicitly requested.

## The scheduled task itself (how to change it)

The weekly run is a DSH schedule stored in `%USERPROFILE%\.dsh\storages\schedule.json`
(`tables.tasks.<schedule-id>.record.prompt`). **There is no tool for it** — `tool_activate`
lists no `schedule` namespace — so it is edited on disk. Do not hand-write the prompt: the
sibling repo `dsh-matlab-mcp` owns an idempotent script that appends a standard rule block and
leaves each task's own technical steps untouched.

```powershell
# audit (read-only): which weekly tasks are missing the rule
node D:\Program\DSH-Plugin-Class\dsh-matlab-mcp\scripts\fix-schedule-autonomy.mjs

# fix this plugin's task only (backs up schedule.json, atomic write, idempotent)
node D:\Program\DSH-Plugin-Class\dsh-matlab-mcp\scripts\fix-schedule-autonomy.mjs --match dsh-eda-mcp --apply
```

The appended block ("## 自动化发版授权（统一规则）") grants the scheduled task the right to bump,
commit, push, tag and release on its own, states that restrictions spoken in a human conversation
do not apply to a scheduled task, and keeps the one stop condition: host API breakage that needs
code changes. **A running DSH holds an in-memory copy of the schedule, so restart DSH after any
edit** — otherwise the old prompt keeps firing and the next write can overwrite the change.

Prompt shape that has proven to work here: repo-specific `## 步骤` / `## 边界` first, then the
standard block appended by the script.
