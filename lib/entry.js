/**
 * Loader entry for the host half.
 *
 * The Harness loads plugin rows through Node's ESM loader, which caches both the
 * resolved package entry and the module it produced for the lifetime of the Host
 * process. Re-activating a row therefore re-runs the cached module, so a fix on disk
 * cannot be observed without restarting the app.
 *
 * This entry keeps a stable module URL and loads the implementation through an
 * mtime-keyed query, so editing `host.js` takes effect on the next activation. The
 * `inject` list must live here: Cordis reads it from the entry module, not from the
 * dynamically imported one.
 */

import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'session-search'

/** `connection` supplies the RPC façade; that façade registers its HTTP route as an
 * effect on THIS context, so `webServer` must be injected here as well. */
export const inject = ['connection', 'webServer']

export async function apply(ctx, config = {}) {
  const url = new URL('./host.js', import.meta.url)
  try {
    url.searchParams.set('v', String(statSync(fileURLToPath(url)).mtimeMs))
  } catch {
    /* fall back to the bare URL when the implementation cannot be stat'ed */
  }
  const implementation = await import(url.href)
  return implementation.apply(ctx, config)
}
