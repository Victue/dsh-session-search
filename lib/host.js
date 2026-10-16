/**
 * Session content search — host half.
 *
 * Owns an incrementally refreshed index of every session transcript and exposes it to
 * the browser half over a dedicated Connection RPC channel (`/session-search`).
 *
 * Why this plugin owns its own index instead of enabling the shipped
 * `@deepseek-ai/dsh-session-query-sqlite` backend:
 *  - that backend is disabled in this profile (`openAt: never`) and only a profile
 *    patch can change that;
 *  - it tokenizes with FTS5 `unicode61`, where a whole CJK run is a single token, so
 *    `光速` never matches `光速太慢` — unacceptable for CJK content;
 *  - it ranks by relevance and groups hits per session (`bestMatch`), so per-record
 *    content timestamps never reach the wire. This plugin's whole point is that they do.
 *
 * Deliberately dependency-free: only `node:*` builtins and the injected `connection`
 * service. The plugin is loaded from a path outside the profile tree, where bare
 * `@deepseek-ai/*` specifiers would not resolve.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { SessionContentIndex } from './core/session-index.js'

/** Loader entry name; also the diagnostic prefix. */
export const name = 'session-search'

/**
 * `connection` supplies the RPC channel façade; `webServer` is required because that
 * façade registers the channel's HTTP route as an effect on THIS context.
 */
export const inject = ['connection', 'webServer']

/** Dedicated Connection RPC channel; `/api` is reserved by the API gateway. */
const CHANNEL = '/session-search'

/** Re-stat the corpus at most this often on a search, so typing stays cheap. */
const REFRESH_THROTTLE_MS = 1500

/**
 * Resolve `<DSH_HOME>/sessions` the same way the runtime does, without importing
 * `@deepseek-ai/dsh-home-paths` (a bare specifier this plugin cannot resolve).
 * @returns absolute sessions root.
 */
function defaultSessionsRoot() {
  const override = process.env.DSH_HOME?.trim() || process.env.DSH_HOME_DIR?.trim()
  return join(override && override.length > 0 ? override : join(homedir(), '.dsh'), 'sessions')
}

/**
 * @param ctx - the plugin context.
 * @param config - raw row configuration (no `Config` schema is exported, so Cordis
 *   passes the row's `config:` through untouched).
 */
export function apply(ctx, config = {}) {
  const settings = config && typeof config === 'object' ? config : {}
  const root = typeof settings.root === 'string' && settings.root.length > 0
    ? settings.root
    : defaultSessionsRoot()
  const maxHits = clampInt(settings.maxHits, 1, 2000, 300)
  const maxCharsPerRecord = clampInt(settings.maxCharsPerRecord, 256, 1 << 24, 65536)
  const includeSubagentsDefault = settings.includeSubagents === true

  const index = new SessionContentIndex({
    root,
    maxCharsPerRecord,
    logger: ctx.logger ?? null,
  })

  /** Warm the index in the background so the first keystroke is instant. */
  if (settings.warmup !== false) {
    const delay = clampInt(settings.warmupDelayMs, 0, 60000, 3000)
    ctx.effect(() => {
      const timer = setTimeout(() => {
        if (index.available) {
          index.refresh().catch(error => ctx.logger?.warn?.(`session-search warmup failed: ${error}`))
        }
      }, delay)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearTimeout(timer)
    }, 'session-search: warmup')
  }

  let refreshing = null
  const refreshIfStale = async (force) => {
    if (refreshing) return refreshing
    const stale = force
      || index.lastRefreshMs === null
      || Date.now() - index.lastRefreshMs > REFRESH_THROTTLE_MS
    if (!stale) return null
    refreshing = index.refresh({ force: false })
      .catch((error) => {
        ctx.logger?.warn?.(`session-search refresh failed: ${error}`)
        return null
      })
      .finally(() => { refreshing = null })
    return refreshing
  }

  const handlers = {
    async search(payload = {}) {
      await refreshIfStale(false)
      const started = Date.now()
      const result = index.search(payload.query ?? '', {
        limit: clampInt(payload.limit, 1, maxHits, maxHits),
        kinds: Array.isArray(payload.kinds) && payload.kinds.length ? payload.kinds : null,
        workspaces: Array.isArray(payload.workspaces) && payload.workspaces.length ? payload.workspaces : null,
        sessionIds: Array.isArray(payload.sessionIds) && payload.sessionIds.length ? payload.sessionIds : null,
        since: Number.isFinite(payload.since) ? payload.since : null,
        until: Number.isFinite(payload.until) ? payload.until : null,
        includeSubagents: typeof payload.includeSubagents === 'boolean'
          ? payload.includeSubagents
          : includeSubagentsDefault,
        sort: payload.sort === 'time-asc' || payload.sort === 'relevance' ? payload.sort : 'time-desc',
      })
      return { ...result, tookMs: Date.now() - started, stats: index.stats() }
    },

    async stats() {
      if (index.lastRefreshMs === null && index.available) await refreshIfStale(true)
      return index.stats()
    },

    async refresh(payload = {}) {
      await index.refresh({ force: payload.force === true })
      return index.stats()
    },
  }

  /**
   * Serve the channel directly on the web server.
   *
   * `ctx.connection.rpc.handle()` looks like the intended API, but it cannot be used
   * from a plugin: its façade calls `register(owner, …)` with `owner = this.ctx`, the
   * Connection plugin's own context — which injects only `credentials` and therefore
   * throws `cannot get property "webServer" without inject` on every call. (No shipped
   * plugin uses it.) Registering on our own context, whose `webServer` IS injected, and
   * reusing the Connection service's admission fence plus its RPC envelope reproduces
   * the same authenticated contract.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (request, response) => {
      const admission = ctx.connection.admit(request)
      if (admission && typeof admission === 'object' && 'rejection' in admission) {
        response.writeHead(admission.rejection, { 'content-type': 'text/plain; charset=utf-8' })
        response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const reply = (status, payload) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('method not allowed')
        return
      }
      const endpoint = endpointOf(request.url)
      if (endpoint === undefined) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('not found')
        return
      }
      let envelope
      try {
        envelope = JSON.parse(await readBody(request))
      } catch {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('body is not JSON')
        return
      }
      const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : ''
      if (envelope?.type !== 'client-request' || envelope.method !== endpoint) {
        reply(200, failure(rpcId, 'gateway/bad-request', 'invalid client-request envelope'))
        return
      }
      const handler = Object.prototype.hasOwnProperty.call(handlers, endpoint) ? handlers[endpoint] : undefined
      if (!handler) {
        reply(200, failure(rpcId, 'gateway/not-found', `unknown endpoint ${JSON.stringify(endpoint)}`))
        return
      }
      try {
        reply(200, { type: 'server-response', rpcId, result: { ok: true, value: await handler(envelope.payload) } })
      } catch (error) {
        reply(200, failure(rpcId, 'session-search/failed', String(error?.message ?? error)))
      }
    },
  }), 'session-search: rpc channel')

  // Expose the index as a Host service so other plugins (and a human debugging the
  // profile) can reuse it and confirm the plugin is live: `ctx.sessionContentSearch`.
  ctx.provide('sessionContentSearch', {
    get root() { return root },
    stats: () => index.stats(),
    refresh: (force = false) => index.refresh({ force }),
    search: (query, options = {}) => handlers.search({ query, ...options }),
  })

  ctx.logger?.info?.(`session-search: ready (sessions root ${root})`)
}

/** Collect a readable stream into a string, with a hard cap. */
async function readBody(request, limit = 1 << 20) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Extract the endpoint segment from `<channel>/<endpoint>`; undefined when malformed. */
function endpointOf(url) {
  const path = String(url ?? '').split('?', 1)[0]
  if (!path.startsWith(`${CHANNEL}/`)) return undefined
  const endpoint = path.slice(CHANNEL.length + 1)
  if (!/^[A-Za-z0-9_$.-]+$/.test(endpoint)) return undefined
  return endpoint
}

/** One Connection RPC failure envelope. */
function failure(rpcId, code, message) {
  return {
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code, message, details: {} } },
  }
}

/** Coerce a possibly-absent numeric setting into an integer inside `[min, max]`. */
function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}
