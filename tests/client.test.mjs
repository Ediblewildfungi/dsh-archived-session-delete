import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * Offline smoke test of the browser bundle: evaluate the lazy ModuleLoader
 * factory with a fake `require` (the shell's static platform modules), apply
 * the plugin against a fake client Context and drive the menu item and the
 * confirmation dialog end to end without a browser.
 */

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

function loadBundle() {
  let entry
  const fakeWindow = {
    __ModuleLoader__: {
      load(value) {
        entry = value
      },
    },
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(fakeWindow, undefined)
  assert.equal(entry.id, 'dsh-archived-session-delete')
  return entry
}

function createFakeReact() {
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
  const useState = (initial) => {
    const box = { value: initial }
    return [box.value, (next) => {
      box.value = typeof next === 'function' ? next(box.value) : next
    }]
  }
  return { createElement, useState }
}

test('client bundle renders the archived-session menu item and deletes through the dialog', async () => {
  const entry = loadBundle()
  const react = createFakeReact()
  const symbols = {
    MenuItemButton: function MenuItemButton() {},
    Modal: function Modal() {},
    Button: function Button() {},
    IconTrashOutlineRegular: function IconTrashOutlineRegular() {},
  }
  const calls = []
  let refreshCount = 0
  const archivedSnapshot = {
    items: [],
    archivedSessionIds: ['session-archived', 'session-other'],
    pinnedSessionIds: [],
    state: 'ready',
    phase: 'ready',
    error: null,
  }
  const fakeStore = (initial) => {
    let value = initial
    const listeners = new Set()
    return {
      getSnapshot: () => value,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      set: (next) => {
        value = next
        for (const listener of listeners) listener()
      },
    }
  }
  const services = {
    workspaces: {
      list: {
        getSnapshot: () => archivedSnapshot,
        subscribe: () => () => {},
      },
    },
    sessions: {
      refresh: () => {
        refreshCount += 1
      },
    },
    connection: {
      rpc: {
        call: (channel, endpoint, payload) => {
          calls.push({ channel, endpoint, payload })
          return Promise.resolve({ ok: true, value: { deleted: [payload.sessionId] } })
        },
      },
    },
  }
  const injected = []
  const localeDictionaries = []
  const ctx = {
    get: (name) => services[name],
    effect: (fn) => {
      fn()
    },
    locale: {
      register: (namespace, dictionaries) => {
        localeDictionaries.push({ namespace, dictionaries })
        return () => {}
      },
    },
    slots: {
      inject: (name, callback) => {
        injected.push({ name, callback })
      },
      register: (spec, component) => ({ spec, component, dispose: () => {} }),
    },
  }

  entry.factory((name) => {
    if (name === 'react') return react
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return symbols
    if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: fakeStore }
    throw new Error(`unexpected require: ${name}`)
  }).apply(ctx)

  assert.deepEqual(entry.factory.length, 1)
  assert.deepEqual(localeDictionaries.map((item) => item.namespace), ['archivedSessionDelete'])
  assert.equal(localeDictionaries[0].dictionaries.zh['menu.delete'], '删除会话')
  assert.deepEqual(injected.map((item) => item.name), [
    'sidebar.workspaces.session.menu.item',
    'shell.overlay',
  ])

  const t = (key, params) => {
    const template = localeDictionaries[0].dictionaries.zh[key] ?? key
    return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
  }

  // Menu item: hidden for an unarchived row, visible for an archived row.
  const menuSpec = injected[0].callback()
  const menuInjected = menuSpec.spec.inject()
  const baseMenuProps = {
    t,
    useArchived: (selector) => selector(new Set(archivedSnapshot.archivedSessionIds)),
    useMenuOpenState: () => [false, (next) => {
      menuOpenChanges.push(next)
    }],
    ...menuInjected,
  }
  const menuOpenChanges = []
  assert.equal(menuSpec.component({ ...baseMenuProps, sessionId: 'session-active', displayTitle: 'Active' }), null)
  const menuElement = menuSpec.component({ ...baseMenuProps, sessionId: 'session-archived', displayTitle: 'Archived chat' })
  assert.equal(menuElement.type, symbols.MenuItemButton)
  assert.equal(menuElement.props.separatorBefore, true)
  assert.deepEqual(menuElement.children, ['删除会话'])
  menuElement.props.onSelect()
  assert.deepEqual(menuOpenChanges, [false])

  // Overlay dialog: the pending request is rendered and confirming deletes.
  const overlaySpec = injected[1].callback()
  const overlayInjected = overlaySpec.spec.inject()
  assert.deepEqual(overlayInjected.hooks.deleteRequest.getSnapshot(), {
    sessionId: 'session-archived',
    title: 'Archived chat',
  })
  let cancelCount = 0
  const overlayProps = {
    t,
    useDeleteRequest: (selector) => selector(overlayInjected.hooks.deleteRequest.getSnapshot()),
    cancelDelete: () => {
      cancelCount += 1
      overlayInjected.hooks.deleteRequest.set(null)
    },
    deleteSession: overlayInjected.deleteSession,
  }
  const dialogElement = overlaySpec.component(overlayProps)
  assert.equal(typeof dialogElement.type, 'function')
  const confirmElement = dialogElement.type(dialogElement.props)
  assert.equal(confirmElement.type, symbols.Modal)
  assert.equal(confirmElement.props.title, '删除会话')
  assert.match(confirmElement.props.description, /Archived chat/)
  assert.equal(confirmElement.props.footer.length, 2)
  assert.deepEqual(confirmElement.props.footer[0].children, ['取消'])
  assert.deepEqual(confirmElement.props.footer[1].children, ['删除'])

  confirmElement.props.footer[1].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [{
    channel: '/archived-session-delete',
    endpoint: 'delete',
    payload: { sessionId: 'session-archived' },
  }])
  assert.equal(refreshCount, 1)
  assert.equal(cancelCount, 1)
  assert.equal(overlayInjected.hooks.deleteRequest.getSnapshot(), null)
  assert.equal(overlaySpec.component({ ...overlayProps, useDeleteRequest: (selector) => selector(null) }), null)
})
