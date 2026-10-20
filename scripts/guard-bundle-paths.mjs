#!/usr/bin/env node
// The published bundles must not contain build-machine paths, or the build is not
// reproducible. The first version of this guard flagged every 'node_modules/' and so
// failed on our own documentation string ("zip lives at node_modules/dsh-eda-mcp/…"),
// which aborted the v0.7.3 publish before npm ever saw it. Flag absolute paths only.
import { readFile } from 'node:fs/promises'

const bundles = ['lib/index.js', 'lib/bridge.mjs', 'lib/client.js']
// A leaked path looks like D:/…/node_modules/.pnpm/…, C:\…, /home/runner/…, /Users/…
const leak = /(?:[A-Za-z]:[\\/][^"'\n]*node_modules)|(?:\/(?:home|Users|root)\/)|node_modules[\\/]\.pnpm/

let failed = false
for (const file of bundles) {
  let source
  try {
    source = await readFile(file, 'utf8')
  } catch {
    console.error(`guard:bundle cannot read ${file} - run the build first`)
    process.exit(1)
  }
  for (const [index, line] of source.split('\n').entries()) {
    const match = leak.exec(line)
    if (match === null) continue
    failed = true
    console.error(`${file}:${index + 1} leaks a build path: ${match[0].slice(0, 120)}`)
  }
}
if (failed) {
  console.error('guard:bundle FAILED - the build embeds build-machine module paths')
  process.exit(1)
}
console.log('guard:bundle PASS - no build-machine paths in ' + bundles.length + ' bundles')
