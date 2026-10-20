/**
 * Extension zip packaging helpers: the plugin ships
 * `dsh-eda-bridge-extension-<wire version>.zip`, the download server publishes the same
 * file, and a user who installs the plugin from npm must be able to tell whether the copy
 * they got is byte-identical to the one the bridge expects.
 */
import { createHash } from 'node:crypto'

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function extensionZipName(version: string): string {
  return 'dsh-eda-bridge-extension-' + version + '.zip'
}

/** Normalises a base URL ('…/eda' or '…/eda/') and appends the zip name. */
export function extensionDownloadUrl(base: string, version: string): string {
  const normalised = base.endsWith('/') ? base : base + '/'
  return new URL(extensionZipName(version), normalised).toString()
}

export type DigestVerdict = 'match' | 'mismatch' | 'unverified'

/**
 * A missing expected digest is reported as 'unverified', never as a pass: an absent
 * comparison is not evidence of equality.
 */
export function compareDigest(expected: string | null | undefined, actual: string | null | undefined): DigestVerdict {
  if (typeof expected !== 'string' || typeof actual !== 'string') return 'unverified'
  const left = expected.trim().toLowerCase()
  const right = actual.trim().toLowerCase()
  if (left === '' || right === '') return 'unverified'
  return left === right ? 'match' : 'mismatch'
}
