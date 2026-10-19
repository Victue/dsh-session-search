/**
 * Client-half test.
 *
 * The browser half is a module-system bundle, not an ES module, so it is loaded here the
 * way the page loads it: by defining `window.__ModuleLoader__` and invoking the captured
 * factory with a stub `require`. React is stubbed with just enough hook runtime to call
 * each component once, which catches module-scope mistakes, wrong slot registration
 * shapes and render-time crashes without a browser.
 *
 * Run: node --test test/client.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).name

/**
 * Minimal React stand-in. `overrides` supplies values for specific `useState` call
 * indices so a test can drive a component into a non-initial state; every later call
 * keeps its initial value.
 */
function createReactStub(overrides = {}) {
  let useStateCalls = 0
  return {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    useState(initial) {
      const index = useStateCalls++
      const value = Object.prototype.hasOwnProperty.call(overrides, index)
        ? overrides[index]
        : (typeof initial === 'function' ? initial() : initial)
      return [value, () => {}]
    },
    useRef(value) { return { current: value ?? null } },
    useCallback(fn) { return fn },
    useEffect() {},
  }
}

/** Load the client bundle and return its factory result. */
function loadClientBundle(overrides = {}) {
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  const registrations = []
  const React = createReactStub(overrides)
  const scope = {
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
    document: undefined,
  }
  // The bundle only touches `window`; evaluate it against a scoped global.
  const evaluate = new Function('window', 'require', `${source}\n`)
  evaluate(scope, (specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  })
  assert.equal(registrations.length, 1, 'the bundle must register exactly one module')
  return { registration: registrations[0], factory: registrations[0].factory }
}

/** Cordis stand-in capturing slot, locale and shortcut registrations. */
function createClientContext({ remoteReply } = {}) {
  const slots = []
  const locales = []
  const shortcuts = []
  const calls = []
  const ctx = {
    logger: { info: () => {} },
    effect: (factory) => { const dispose = factory(); return typeof dispose === 'function' ? dispose : () => {} },
    inject: (dependencies, callback) => callback(ctx),
    get: (key) => {
      if (key === 'connection') {
        return {
          rpc: {
            call: async (channel, endpoint, payload) => {
              calls.push({ channel, endpoint, payload })
              return remoteReply
            },
          },
        }
      }
      if (key === 'layout') return { selectPanel: () => {} }
      if (key === 'uiWorkspace') return { openSession: () => {} }
      return undefined
    },
    slots: {
      inject: (key, callback) => callback(),
      register: (options, component) => { slots.push({ options, component }); return () => {} },
    },
    locale: {
      register: (namespace, dictionaries) => { locales.push({ namespace, dictionaries }) },
      bind: () => (key, params) => {
        const template = `zh:${key}`
        if (!params) return template
        return Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template)
      },
    },
    shortcuts: { register: (definition) => { shortcuts.push(definition); return () => {} } },
  }
  return { ctx, slots, locales, shortcuts, calls }
}

/** Flatten a rendered tree into its text content. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

/** Depth-first search for the first rendered element satisfying a predicate. */
function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit) return hit
    }
    return undefined
  }
  if (!node || typeof node !== 'object' || typeof node.type === 'undefined') return undefined
  if (predicate(node)) return node
  return find(node.props?.children, predicate)
}

test('the bundle registers itself under the package name', () => {
  const { registration } = loadClientBundle()
  assert.equal(registration.id, PACKAGE_NAME)
  assert.equal(typeof registration.factory, 'function')
})

test('the client half exports apply and injects only shipped services', () => {
  const { factory } = loadClientBundle()
  // The factory resolves React when the module system materialises it, so `react` must
  // be served here — and nothing else may be required.
  const requested = []
  const plugin = factory((specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return createReactStub()
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  })
  assert.deepEqual(requested, ['react'], 'the client half must not import Harness packages')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'connection'])
})

test('apply registers the panel icon, the matching main panel and the shortcut', () => {
  const { factory } = loadClientBundle()
  const plugin = factory((specifier) => {
    if (specifier === 'react') return createReactStub()
    throw new Error(`unexpected require(${specifier})`)
  })
  const { ctx, slots, locales, shortcuts } = createClientContext()
  plugin.apply(ctx)

  assert.deepEqual(locales.map(entry => entry.namespace), [plugin.NS])
  assert.ok(locales[0].dictionaries.zh && locales[0].dictionaries.en)

  const panel = slots.find(entry => entry.options.name === 'sidebar.panellist')
  const main = slots.find(entry => entry.options.name === 'main')
  assert.ok(panel, 'sidebar.panellist must be occupied')
  assert.ok(main, 'the main panel must be occupied')
  // The sidebar dispatches `main` by the panellist id, so they have to agree.
  assert.equal(panel.options.id, plugin.PANEL_ID)
  assert.equal(main.options.key, plugin.PANEL_ID)
  assert.equal(typeof panel.options.label, 'function')
  assert.equal(typeof panel.component, 'function')
  assert.deepEqual(main.options.inject(), { ctx })

  assert.equal(shortcuts.length, 1)
  assert.equal(shortcuts[0].id, 'session-search.open')
  // Desktop profiles only. The Web profiles are unbound because `session.fork` already
  // owns KeyF + primary+shift there, and the shortcut registry validates defaults across
  // every declared profile — a duplicate makes the later registrant throw.
  assert.deepEqual(Object.keys(shortcuts[0].defaults).sort(), [
    'desktop:linux', 'desktop:macos', 'desktop:windows',
  ])
  assert.equal(shortcuts[0].resolve().status, 'handled')
})

test('a rejected shortcut registration must not break plugin activation', () => {
  // Regression: claiming a key another plugin already owns used to throw out of `apply`,
  // and when that other plugin was `ui-workspace` the whole web boot failed.
  const { factory } = loadClientBundle()
  const plugin = factory((specifier) => {
    if (specifier === 'react') return createReactStub()
    throw new Error(`unexpected require(${specifier})`)
  })
  const { ctx, slots } = createClientContext()
  const warnings = []
  ctx.shortcuts.register = () => { throw new Error('Conflicting shortcut defaults: session-search.open and session.fork (web:windows)') }
  ctx.logger = { info: () => {}, warn: (message) => warnings.push(message) }

  assert.doesNotThrow(() => plugin.apply(ctx))
  // The panel must still be there, and the degradation must be reported.
  assert.ok(slots.some(entry => entry.options.name === 'sidebar.panellist'))
  assert.ok(slots.some(entry => entry.options.name === 'main'))
  assert.ok(warnings.some(message => /shortcut unavailable/.test(message)))
})

test('the panel icon renders an svg at the requested size', () => {
  const { factory } = loadClientBundle()
  const plugin = factory((specifier) => {
    if (specifier === 'react') return createReactStub()
    throw new Error(`unexpected require(${specifier})`)
  })
  const { ctx, slots } = createClientContext()
  plugin.apply(ctx)
  const icon = slots.find(entry => entry.options.name === 'sidebar.panellist').component
  const tree = icon({ size: 18, active: true })
  assert.equal(tree.type, 'svg')
  assert.equal(tree.props.width, 18)
})

test('the panel shows its prompt before a query and results after one', () => {
  // useSearch's state is the 4th useState call in SearchPanel: query, kind, subagents, result.
  const hits = [{
    sessionId: 'session-1', sessionTitle: '示例会话', cwd: 'D:\\Code\\demo',
    seq: 7, time: Date.UTC(2026, 9, 16, 6, 6), kind: 'user', type: 'user/message',
    snippet: '这里是命中的内容片段', snippetMarks: [[3, 5]], textLength: 10,
  }]
  const reply = { ok: true, value: { query: '会话', terms: ['会话'], hits, total: 1, sessions: 1, scanned: 9, tookMs: 7, stats: { sessions: 3, documents: 20 } } }
  const { factory } = loadClientBundle({ 0: '会话', 3: { status: 'done', result: reply.value, error: null } })
  const plugin = factory((specifier) => {
    if (specifier === 'react') return createReactStub({ 0: '会话', 3: { status: 'done', result: reply.value, error: null } })
    throw new Error(`unexpected require(${specifier})`)
  })
  const { ctx, slots } = createClientContext()
  plugin.apply(ctx)
  const SearchPanel = slots.find(entry => entry.options.name === 'main').component
  const tree = SearchPanel({ ctx, t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) })
  const text = textOf(tree)
  assert.match(text, /示例会话/)
  assert.match(text, /这里是命中的内容片段/)
  assert.match(text, /summary:/)
  // The first matched range must be wrapped in a highlight element.
  const mark = find(tree, node => node.type === 'mark')
  assert.equal(mark.props.children, '命中')
})

test('the panel degrades to a message when no result is available', () => {
  const { factory } = loadClientBundle()
  const plugin = factory((specifier) => {
    if (specifier === 'react') return createReactStub()
    throw new Error(`unexpected require(${specifier})`)
  })
  const { ctx, slots } = createClientContext()
  plugin.apply(ctx)
  const SearchPanel = slots.find(entry => entry.options.name === 'main').component
  const text = textOf(SearchPanel({ ctx, t: (key) => key }))
  assert.match(text, /empty/)
})
