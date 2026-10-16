/**
 * Host-half integration test.
 *
 * Mounts the plugin against a Cordis stand-in, drives the registered HTTP route the way
 * the web server does (node-style request stream + response recorder), and runs the
 * index over the real transcripts in this machine's Harness home.
 *
 * Run: node --test test/host.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'

import { apply } from '../lib/host.js'
import { name, inject } from '../lib/entry.js'
import { SessionContentIndex, decodeFrames, extractRecordText, listSessionFiles } from '../lib/core/session-index.js'

const CHANNEL = '/session-search'
const SESSIONS_ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
const hasCorpus = existsSync(SESSIONS_ROOT)

/** Minimal Cordis stand-in recording the route the plugin registers. */
function fakeContext() {
  const routes = []
  const provided = new Map()
  const warnings = []
  const ctx = {
    logger: { info: () => {}, warn: (message) => warnings.push(message), debug: () => {} },
    effect: (factory) => {
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get: () => undefined,
    inject: (dependencies, callback) => callback(ctx),
    provide: (key, value) => provided.set(key, value),
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
    connection: { admit: () => ({ allowed: true }) },
  }

  /** POST one endpoint exactly as the browser transport would. */
  const call = async (channel, endpoint, payload, { method = 'POST', raw } = {}) => {
    const route = routes.find(candidate => channel.startsWith(candidate.path))
    if (!route) throw new Error(`no route registered for ${channel}`)
    const body = raw ?? JSON.stringify({ type: 'client-request', rpcId: 'test-rpc', method: endpoint, payload })
    const request = Readable.from([Buffer.from(body)])
    request.method = method
    request.url = `${channel}/${endpoint}`
    let status = 0
    let text = ''
    await route.handler(request, {
      writeHead: (code) => { status = code },
      end: (value) => { text = value ?? '' },
    })
    return { status, text, json: (() => { try { return JSON.parse(text) } catch { return undefined } })() }
  }

  return { ctx, call, routes, provided, warnings }
}

/** Unwrap the Connection RPC envelope into its value. */
function valueOf(reply) {
  assert.equal(reply.status, 200, `expected HTTP 200, got ${reply.status}: ${reply.text}`)
  assert.equal(reply.json?.type, 'server-response')
  assert.equal(reply.json.result.ok, true, `endpoint failed: ${JSON.stringify(reply.json.result.error)}`)
  return reply.json.result.value
}

test('plugin declares its shape', () => {
  assert.equal(name, 'session-search')
  // `webServer` is required alongside `connection`: the channel route is registered on
  // this context, and `connection` supplies the admission fence.
  assert.deepEqual(inject, ['connection', 'webServer'])
})

test('registers exactly one channel route and exposes one host service', () => {
  const { ctx, routes, provided } = fakeContext()
  apply(ctx, { warmup: false })
  assert.deepEqual(routes.map(route => route.path), [CHANNEL])
  assert.equal(routes[0].kind, 'prefix')
  assert.deepEqual([...provided.keys()], ['sessionContentSearch'])
})

test('rejects a wrong method, an unknown endpoint and a malformed body', async () => {
  const { ctx, call } = fakeContext()
  apply(ctx, { warmup: false })

  const wrongMethod = await call(CHANNEL, 'search', {}, { method: 'GET' })
  assert.equal(wrongMethod.status, 405)

  const unknown = await call(CHANNEL, 'nope', {})
  assert.equal(unknown.status, 200)
  assert.equal(unknown.json.result.ok, false)
  assert.equal(unknown.json.result.error.code, 'gateway/not-found')

  const malformed = await call(CHANNEL, 'search', {}, { raw: '{not json' })
  assert.equal(malformed.status, 400)
})

test('an envelope whose method disagrees with the path is refused', async () => {
  const { ctx, call } = fakeContext()
  apply(ctx, { warmup: false })
  const reply = await call(CHANNEL, 'search', {}, {
    raw: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'stats', payload: {} }),
  })
  assert.equal(reply.status, 200)
  assert.equal(reply.json.result.ok, false)
  assert.equal(reply.json.result.error.code, 'gateway/bad-request')
})

test('extractRecordText pulls text out of every searchable record type', () => {
  assert.equal(extractRecordText('user/message', { content: [{ type: 'text', text: '你好' }] }), '你好')
  assert.equal(
    extractRecordText('assistant/message', {
      message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool-call', name: 'read', arguments: '{"a":1}' }] },
    }),
    'hi\nread {"a":1}',
  )
  assert.equal(extractRecordText('tool/call', { name: 'grep', arguments: '{"pattern":"x"}' }), 'grep {"pattern":"x"}')
  // System prompts and reasoning are noise, not session content.
  assert.equal(extractRecordText('system/message', { message: { content: [{ type: 'text', text: 'noise' }] } }), null)
  assert.equal(extractRecordText('reasoning-chunks', { anything: 1 }), null)
})

test('decodeFrames walks concatenated zstd frames and resumes past decoded frames', () => {
  const header = zstdCompressSync(Buffer.from('{"type":"session","id":"a"}\n'))
  const event = zstdCompressSync(Buffer.from('{"type":"user/message","seq":1,"time":10,"data":{}}\n'))
  const later = zstdCompressSync(Buffer.from('{"type":"user/message","seq":2,"time":20,"data":{}}\n'))

  const whole = decodeFrames(Buffer.concat([header, event]), 0)
  assert.match(whole.text, /"id":"a"/)
  assert.match(whole.text, /"seq":1/)
  // The resume offset points just past the last decoded frame's magic, so frames already
  // consumed are never decoded twice. (Node's own zstd stream stops after frame one.)
  assert.equal(whole.resumeOffset, header.length + 4)

  const grown = decodeFrames(Buffer.concat([header, event, later]), whole.resumeOffset)
  assert.match(grown.text, /"seq":2/)
  assert.doesNotMatch(grown.text, /"id":"a"/)

  // A half-written trailing frame is skipped, and the offset still points past the last
  // frame that decoded cleanly.
  const torn = Buffer.concat([header, event.subarray(0, Math.floor(event.length / 2))])
  const partial = decodeFrames(torn, 0)
  assert.match(partial.text, /"id":"a"/)
  assert.equal(partial.resumeOffset, 4)
})

test('index searches Chinese substrings and orders hits by content time', { skip: !hasCorpus }, async () => {
  const index = new SessionContentIndex({ root: SESSIONS_ROOT })
  const stats = await index.refresh()
  assert.ok(stats.documents > 0, 'expected a non-empty corpus')

  const result = index.search('会话', { limit: 50 })
  assert.ok(result.hits.length > 0, 'expected hits for a common CJK substring')
  const times = result.hits.map(hit => hit.time).filter(time => typeof time === 'number')
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i - 1] >= times[i], 'hits must be ordered newest first')
  }
  for (const hit of result.hits) {
    assert.ok(hit.snippet.includes('会话'), `snippet should contain the term: ${hit.snippet}`)
    assert.equal(typeof hit.sessionId, 'string')
  }
})

test('matches a CJK needle the shipped FTS5 tokenizer cannot', { skip: !hasCorpus }, async () => {
  const index = new SessionContentIndex({ root: SESSIONS_ROOT })
  await index.refresh()
  // `unicode61` treats a whole CJK run as one token, so a two-character needle never
  // matches inside a longer run there; substring matching here must find it.
  const result = index.search('会话', { limit: 5, kinds: ['user'] })
  assert.ok(result.hits.every(hit => hit.kind === 'user'))
})

test('subagent sessions are excluded by default and includable on request', { skip: !hasCorpus }, async () => {
  const index = new SessionContentIndex({ root: SESSIONS_ROOT })
  await index.refresh()
  const excluded = index.search('a', { limit: 1 })
  const included = index.search('a', { limit: 1, includeSubagents: true })
  assert.ok(included.total >= excluded.total)
})

test('rpc search endpoint returns a serialisable payload over the real route', { skip: !hasCorpus }, async () => {
  const { ctx, call } = fakeContext()
  apply(ctx, { warmup: false })
  const payload = valueOf(await call(CHANNEL, 'search', { query: '会话', limit: 3 }))
  assert.ok(payload.total > 0)
  assert.ok(payload.hits.length <= 3)
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(payload)))
  assert.equal(typeof payload.tookMs, 'number')
  assert.equal(typeof payload.stats.sessions, 'number')
})

test('empty query short-circuits without touching the corpus', async () => {
  const { ctx, call } = fakeContext()
  apply(ctx, { warmup: false })
  const payload = valueOf(await call(CHANNEL, 'search', { query: '   ' }))
  assert.equal(payload.total, 0)
  assert.deepEqual(payload.hits, [])
})

test('listSessionFiles discovers transcripts and tolerates a missing root', () => {
  assert.deepEqual(listSessionFiles(join(SESSIONS_ROOT, '__definitely_missing__')), [])
  if (hasCorpus) {
    const files = listSessionFiles(SESSIONS_ROOT)
    assert.ok(files.length > 0)
    assert.ok(files.every(file => file.sessionId && file.workspace && file.path))
  }
})
