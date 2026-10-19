/**
 * Session content index — pure Node.js, no DSH dependency.
 *
 * Reads DSH session transcripts on disk (`<root>/<workspace>/<session>/session.vN.jsonl.zstd`),
 * extracts the human-meaningful text of every record together with that record's own
 * `time` (epoch ms), and answers substring queries over it.
 *
 * Storage format notes (verified against real transcripts):
 *  - A transcript is an append-only sequence of independent Zstandard frames.
 *    `zlib.createZstdDecompress` stops after the FIRST frame, so frames are located by
 *    scanning for the zstd magic number and decoded one by one with `zstdDecompressSync`.
 *    A byte sequence that merely looks like a magic simply fails to decode and is skipped.
 *  - Every frame decompresses to one or more JSONL lines.
 *  - The first line is the session header `{type:'session', id, createdAt, cwd, ...}`;
 *    every later line is an event `{type, seq, time, data}`.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Record types whose text is worth searching, mapped to the user-facing kind. */
const KIND_BY_TYPE = {
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/call': 'tool',
  'tool/result': 'tool',
  'session/title': 'title',
}

/** Hard ceiling per record, so one pathological transcript cannot blow up memory. */
export const DEFAULT_MAX_CHARS_PER_RECORD = 65536

/**
 * Extract the searchable text of one event, or null when the event carries none.
 * @param type - event type.
 * @param data - event payload.
 */
export function extractRecordText(type, data) {
  switch (type) {
    case 'user/message': {
      return joinTextBlocks(data?.content)
    }
    case 'assistant/message': {
      const parts = []
      for (const block of data?.message?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
        else if (block?.type === 'tool-call') parts.push(`${block.name ?? ''} ${block.arguments ?? ''}`)
      }
      return parts.length ? parts.join('\n') : null
    }
    case 'tool/call': {
      const text = `${data?.name ?? ''} ${data?.arguments ?? ''}`.trim()
      return text || null
    }
    case 'tool/result': {
      const parts = []
      for (const block of data?.message?.content ?? []) {
        for (const inner of block?.content ?? []) {
          if (inner?.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
        }
      }
      return parts.length ? parts.join('\n') : null
    }
    case 'session/title': {
      return typeof data?.title === 'string' && data.title ? data.title : null
    }
    default:
      return null
  }
}

function joinTextBlocks(content) {
  if (!Array.isArray(content)) return null
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.length ? parts.join('\n') : null
}

/**
 * Decode every Zstandard frame starting at or after `fromOffset`.
 * @returns decoded text plus the resume offset for the next incremental pass.
 */
export function decodeFrames(buffer, fromOffset = 0) {
  const parts = []
  let resumeOffset = fromOffset
  let index = buffer.indexOf(ZSTD_MAGIC, fromOffset)
  while (index !== -1) {
    let decoded = null
    try {
      decoded = zstdDecompressSync(buffer.subarray(index)).toString('utf8')
    } catch {
      decoded = null // not a real frame start (or an incomplete tail still being written)
    }
    if (decoded !== null) {
      parts.push(decoded)
      resumeOffset = index + ZSTD_MAGIC.length
    }
    index = buffer.indexOf(ZSTD_MAGIC, index + ZSTD_MAGIC.length)
  }
  return { text: parts.join(''), resumeOffset }
}

/** Session directory names are slugified cwds such as `--D-Code-dsh-plugin--`. */
export function workspaceSlugToPath(slug) {
  const inner = slug.replace(/^--/, '').replace(/--$/, '')
  const decoded = inner.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  return decoded.replace(/-/g, '\\')
}

/**
 * Locate every transcript under the sessions root.
 * @param root - absolute path of the sessions directory.
 */
export function listSessionFiles(root) {
  const found = []
  let workspaces = []
  try {
    workspaces = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  } catch {
    return found
  }
  for (const workspace of workspaces) {
    const workspaceDir = join(root, workspace)
    let sessions = []
    try {
      sessions = readdirSync(workspaceDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    } catch {
      continue
    }
    for (const session of sessions) {
      const sessionDir = join(workspaceDir, session)
      let names = []
      try {
        names = readdirSync(sessionDir)
      } catch {
        continue
      }
      // `session.vN.jsonl.zstd` for the live generation, `session.jsonl.zstd` / `.jsonl` for older ones.
      const transcript = names.find(n => n.startsWith('session.') && (n.endsWith('.jsonl.zstd') || n.endsWith('.jsonl')))
      if (transcript) found.push({ path: join(sessionDir, transcript), workspace, sessionId: session })
    }
  }
  return found
}

/** One indexed session. */
class IndexedSession {
  constructor(file) {
    this.path = file.path
    this.workspace = file.workspace
    this.sessionId = file.sessionId
    this.size = -1
    this.mtimeMs = -1
    this.resumeOffset = 0
    this.docs = []
    this.id = null
    this.cwd = null
    this.createdAt = null
    this.origin = null
    this.delegationDepth = 0
    this.parentSession = null
    this.title = null
    this.lastTime = null
    this.error = null
  }

  /** Re-read the file, decoding only frames appended since the previous pass. */
  refresh(maxCharsPerRecord) {
    let stat
    try {
      stat = statSync(this.path)
    } catch (error) {
      this.error = `stat: ${error.message}`
      return 0
    }
    if (stat.size === this.size && stat.mtimeMs === this.mtimeMs) return 0
    if (stat.size < this.size) this.reset()

    let buffer
    try {
      buffer = readFileSync(this.path)
    } catch (error) {
      this.error = `read: ${error.message}`
      return 0
    }

    const from = this.size < 0 ? 0 : this.resumeOffset
    const { text, resumeOffset } = decodeFrames(buffer, from)
    this.size = stat.size
    this.mtimeMs = stat.mtimeMs
    this.resumeOffset = resumeOffset
    this.error = null
    if (!text) return 0

    const before = this.docs.length
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let event
      try {
        event = JSON.parse(trimmed)
      } catch {
        continue // a torn final line; the next append completes it
      }
      this.absorb(event, maxCharsPerRecord)
    }
    return this.docs.length - before
  }

  reset() {
    this.size = -1
    this.resumeOffset = 0
    this.docs = []
    this.title = null
    this.lastTime = null
  }

  absorb(event, maxCharsPerRecord) {
    if (event?.type === 'session') {
      this.id = event.id ?? this.sessionId
      this.cwd = event.cwd ?? null
      this.createdAt = event.createdAt ?? null
      this.origin = event.origin ?? null
      this.delegationDepth = event.delegationDepth ?? 0
      this.parentSession = event.parentSession ?? null
      return
    }
    const kind = KIND_BY_TYPE[event?.type]
    if (!kind) return
    const raw = extractRecordText(event.type, event.data)
    if (!raw) return
    const text = raw.length > maxCharsPerRecord ? raw.slice(0, maxCharsPerRecord) : raw
    const time = typeof event.time === 'number' ? event.time : null
    if (kind === 'title') this.title = text
    if (time !== null && (this.lastTime === null || time > this.lastTime)) this.lastTime = time
    this.docs.push({
      sessionId: this.id ?? this.sessionId,
      seq: typeof event.seq === 'number' ? event.seq : -1,
      time,
      type: event.type,
      kind,
      text,
      truncated: text.length !== raw.length,
    })
  }
}

/**
 * In-memory, incrementally refreshed index of every session transcript.
 *
 * `search()` is a linear scan with early exit per record: at the scale of a real
 * Harness home (a few hundred sessions, tens of MB of text) this answers in a few
 * milliseconds and — unlike the shipped SQLite FTS5 engine, whose `unicode61`
 * tokenizer treats a whole CJK run as one token — it matches Chinese substrings.
 */
export class SessionContentIndex {
  /**
   * @param options.root - sessions root, normally `<DSH_HOME>/sessions`.
   * @param options.maxCharsPerRecord - per-record text ceiling.
   */
  constructor({ root, maxCharsPerRecord = DEFAULT_MAX_CHARS_PER_RECORD, logger = null } = {}) {
    this.root = root
    this.maxCharsPerRecord = maxCharsPerRecord
    this.logger = logger
    this.sessions = new Map()
    this.lastRefreshMs = null
    this.lastRefreshDurationMs = null
    this.refreshing = null
  }

  get available() {
    return existsSync(this.root)
  }

  /** Discover new transcripts and refresh changed ones. Concurrent calls share one pass. */
  async refresh({ force = false } = {}) {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const started = Date.now()
      const files = listSessionFiles(this.root)
      const seen = new Set()
      let decoded = 0
      for (const file of files) {
        seen.add(file.path)
        let session = this.sessions.get(file.path)
        if (!session) {
          session = new IndexedSession(file)
          this.sessions.set(file.path, session)
        }
        if (force) session.reset()
        decoded += session.refresh(this.maxCharsPerRecord)
      }
      for (const path of [...this.sessions.keys()]) {
        if (!seen.has(path)) this.sessions.delete(path)
      }
      this.lastRefreshMs = Date.now()
      this.lastRefreshDurationMs = this.lastRefreshMs - started
      const stats = this.stats()
      this.logger?.debug?.(
        `session content index: ${stats.sessions} sessions, ${stats.documents} records, ` +
        `${stats.characters} chars, +${decoded} new (${this.lastRefreshDurationMs} ms)`,
      )
      return stats
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  /**
   * List indexed sessions, newest activity first, for a scope picker.
   *
   * @param options.includeSubagents - include sessions started by a subagent.
   * @param options.limit - maximum rows.
   * @returns one row per session: id, title, cwd, timestamps, record count.
   */
  listSessions({ includeSubagents = false, limit = 300 } = {}) {
    const rows = []
    for (const session of this.sessions.values()) {
      if (!includeSubagents && session.origin === 'subagent') continue
      const sessionId = session.id ?? session.sessionId
      if (!sessionId) continue
      if (session.docs.length === 0 && !session.title) continue
      rows.push({
        sessionId,
        title: session.title,
        cwd: session.cwd,
        workspace: session.workspace,
        createdAt: session.createdAt,
        lastTime: session.lastTime,
        documents: session.docs.length,
      })
    }
    rows.sort((a, b) => (b.lastTime ?? b.createdAt ?? 0) - (a.lastTime ?? a.createdAt ?? 0))
    return rows.slice(0, Math.max(1, limit))
  }

  /**
   * Read the indexed records surrounding one hit, so a UI can show the match in context.
   *
   * Context is drawn from the *searchable* records only (user and assistant messages,
   * tool calls and results, titles); system prompts and reasoning are not indexed.
   *
   * @param options.sessionId - session to read.
   * @param options.seq - sequence number of the matched record.
   * @param options.before / options.after - how many neighbouring records to include.
   * @returns the window plus the match's ordinal, or null when it is not in the index.
   */
  readContext({ sessionId, seq, before = 4, after = 4 } = {}) {
    if (typeof sessionId !== 'string') return null
    for (const session of this.sessions.values()) {
      if ((session.id ?? session.sessionId) !== sessionId) continue
      const index = session.docs.findIndex(doc => doc.seq === seq)
      if (index === -1) return null
      const from = Math.max(0, index - before)
      const to = Math.min(session.docs.length, index + after + 1)
      return {
        sessionId,
        sessionTitle: session.title,
        cwd: session.cwd,
        index,
        total: session.docs.length,
        hitSeq: seq,
        records: session.docs.slice(from, to).map((doc, offset) => ({
          seq: doc.seq,
          time: doc.time,
          kind: doc.kind,
          type: doc.type,
          text: doc.text.length > 4000 ? `${doc.text.slice(0, 4000)}…` : doc.text,
          isMatch: from + offset === index,
        })),
      }
    }
    return null
  }

  stats() {
    let documents = 0
    let characters = 0
    let subagentSessions = 0
    for (const session of this.sessions.values()) {
      documents += session.docs.length
      for (const doc of session.docs) characters += doc.text.length
      if (session.origin === 'subagent') subagentSessions++
    }
    return {
      sessions: this.sessions.size,
      subagentSessions,
      documents,
      characters,
      root: this.root,
      lastRefreshMs: this.lastRefreshMs,
      lastRefreshDurationMs: this.lastRefreshDurationMs,
    }
  }

  /**
   * Search session content.
   *
   * @param query - whitespace-separated terms; every term must appear (AND).
   * @param options.limit - maximum returned hits.
   * @param options.kinds - restrict to `user` | `assistant` | `tool` | `title`.
   * @param options.workspaces - restrict to workspace slugs.
   * @param options.sessionIds - restrict to session ids.
   * @param options.since / options.until - epoch-ms bounds on the record time.
   * @param options.includeSubagents - include sessions started by a subagent.
   * @param options.sort - `time-desc` (default) | `time-asc` | `relevance`.
   */
  search(query, options = {}) {
    const {
      limit = 200,
      kinds = null,
      workspaces = null,
      sessionIds = null,
      since = null,
      until = null,
      includeSubagents = false,
      sort = 'time-desc',
    } = options

    const terms = normalizeTerms(query)
    if (!terms.length) return { query: String(query ?? ''), terms, hits: [], total: 0, sessions: 0, scanned: 0 }

    const kindFilter = kinds && kinds.length ? new Set(kinds) : null
    const workspaceFilter = workspaces && workspaces.length ? new Set(workspaces) : null
    const sessionFilter = sessionIds && sessionIds.length ? new Set(sessionIds) : null

    const hits = []
    let total = 0
    let scanned = 0
    const matchedSessions = new Set()

    for (const session of this.sessions.values()) {
      if (!includeSubagents && session.origin === 'subagent') continue
      if (workspaceFilter && !workspaceFilter.has(session.workspace)) continue
      if (sessionFilter && !sessionFilter.has(session.id) && !sessionFilter.has(session.sessionId)) continue

      for (const doc of session.docs) {
        scanned++
        if (kindFilter && !kindFilter.has(doc.kind)) continue
        if (since !== null && (doc.time === null || doc.time < since)) continue
        if (until !== null && (doc.time === null || doc.time > until)) continue
        const ranges = matchAll(doc.text, terms)
        if (!ranges) continue
        total++
        matchedSessions.add(session.path)
        if (hits.length < limit || sort === 'relevance') {
          hits.push({
            sessionId: doc.sessionId,
            sessionTitle: session.title,
            cwd: session.cwd,
            workspace: session.workspace,
            origin: session.origin,
            seq: doc.seq,
            time: doc.time,
            kind: doc.kind,
            type: doc.type,
            ...buildSnippet(doc.text, terms, ranges),
          })
        }
      }
    }

    sortHits(hits, sort, terms)
    if (hits.length > limit) hits.length = limit
    return {
      query: String(query ?? ''),
      terms,
      hits,
      total,
      sessions: matchedSessions.size,
      scanned,
    }
  }
}

/** Split a raw query into lower-cased terms; duplicates collapse. */
export function normalizeTerms(query) {
  const raw = String(query ?? '').trim()
  if (!raw) return []
  const terms = []
  for (const part of raw.split(/\s+/)) {
    const term = part.trim()
    if (!term) continue
    const lower = term.toLowerCase()
    if (!terms.includes(lower)) terms.push(lower)
  }
  return terms
}

/**
 * Case-insensitive containment of every term. Chinese queries take the raw `indexOf`
 * path and allocate nothing; a term containing ASCII letters falls back to one
 * lower-cased copy of the record text.
 */
function matchAll(text, terms) {
  const ranges = []
  let lowered = null
  for (const term of terms) {
    let at = text.indexOf(term)
    if (at === -1 && /[a-z]/i.test(term)) {
      lowered ??= text.toLowerCase()
      at = lowered.indexOf(term)
    }
    if (at === -1) return null
    ranges.push([at, at + term.length])
  }
  return ranges
}

const SNIPPET_BEFORE = 80
const SNIPPET_AFTER = 180

/** Build a context window around the earliest match, with every term occurrence marked. */
export function buildSnippet(text, terms, ranges, { before = SNIPPET_BEFORE, after = SNIPPET_AFTER } = {}) {
  const anchor = ranges.reduce((min, [start]) => (start < min ? start : min), Number.MAX_SAFE_INTEGER)
  let start = Math.max(0, anchor - before)
  let end = Math.min(text.length, anchor + after)
  start = clampToScalarBoundary(text, start, -1)
  end = clampToScalarBoundary(text, end, 1)
  const window = text.slice(start, end)

  const marks = []
  const loweredWindow = window.toLowerCase()
  for (const term of terms) {
    let from = 0
    for (;;) {
      const at = loweredWindow.indexOf(term, from)
      if (at === -1) break
      marks.push([at, at + term.length])
      from = at + Math.max(1, term.length)
    }
  }
  marks.sort((a, b) => a[0] - b[0])

  return {
    snippet: window,
    snippetMarks: marks,
    snippetTruncatedStart: start > 0,
    snippetTruncatedEnd: end < text.length,
    textLength: text.length,
  }
}

/** Keep snippet edges from splitting an astral code point. */
function clampToScalarBoundary(text, index, direction) {
  if (index <= 0) return 0
  if (index >= text.length) return text.length
  const code = text.charCodeAt(index)
  if (code >= 0xdc00 && code <= 0xdfff) return index + direction
  return index
}

function sortHits(hits, sort, terms) {
  if (sort === 'relevance') {
    hits.sort((a, b) => score(b, terms) - score(a, terms) || (b.time ?? 0) - (a.time ?? 0))
    return
  }
  const sign = sort === 'time-asc' ? 1 : -1
  hits.sort((a, b) => sign * ((a.time ?? 0) - (b.time ?? 0)) || sign * (a.seq - b.seq))
}

function score(hit, terms) {
  let score = 0
  for (const term of terms) {
    const occurrences = hit.snippetMarks.filter(([from, to]) => to - from === term.length).length
    score += occurrences
  }
  if (hit.kind === 'user') score += 3
  if (hit.kind === 'title') score += 2
  return score
}
