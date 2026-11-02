import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cleanupWorkspaceAccounting,
  collectDeletionPlan,
  createDeletionRouteHandler,
  defaultSessionsRoot,
  encodeSegment,
  parseRpcEnvelope,
  projectKey,
  resolveSessionDirectories,
  sessionDirectory,
} from '../lib/index.js'

test('projectKey mirrors the readable JSONL project directory convention', () => {
  assert.equal(projectKey('/home/jiang/agent-talk'), '--home-jiang-agent-talk--')
  assert.equal(projectKey('/'), '--root--')
  assert.equal(projectKey('/a//b'), '--a-b--')
  assert.equal(projectKey('C:\\Users\\x'), '--C-Users-x--')
  assert.equal(projectKey('/tmp/../etc'), '--tmp-..-etc--')
})

test('encodeSegment is injective over separators, traversal and tilde', () => {
  assert.equal(encodeSegment('session-030e503e-2772-4a1e-8ec9-1e4a65858242'), 'session-030e503e-2772-4a1e-8ec9-1e4a65858242')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.equal(encodeSegment('~'), '~007E')
  assert.equal(encodeSegment('a b'), 'a~0020b')
})

test('sessionDirectory joins the project key and the encoded session id', () => {
  assert.equal(
    sessionDirectory('/dsh/sessions', '/home/jiang/agent-talk', 'session-x'),
    '/dsh/sessions/--home-jiang-agent-talk--/session-x',
  )
  assert.equal(sessionDirectory('/dsh/sessions', undefined, 'session-x'), '/dsh/sessions/_no-cwd/session-x')
})

test('defaultSessionsRoot follows DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(defaultSessionsRoot({ DSH_HOME: '/srv/dsh' }, '/home/u'), '/srv/dsh/sessions')
  assert.equal(defaultSessionsRoot({}, '/home/u'), '/home/u/.dsh/sessions')
  assert.equal(defaultSessionsRoot({ DSH_HOME: '' }, '/home/u'), '/home/u/.dsh/sessions')
})

const snapshots = [
  { header: { id: 'session-target', cwd: '/home/jiang/agent-talk' } },
  { header: { id: 'session-subagent', cwd: '/home/jiang/agent-talk', origin: 'subagent', parentSession: 'session-target' } },
  { header: { id: 'session-subagent-2', cwd: '/home/jiang/agent-talk', origin: 'subagent', parentSession: 'session-subagent' } },
  { header: { id: 'session-fork', cwd: '/home/jiang/agent-talk', parentSession: 'session-target' } },
  { header: { id: 'session-other', cwd: '/home/jiang/agent-talk' } },
]

test('collectDeletionPlan includes the target and hidden subagent descendants only', () => {
  const plan = collectDeletionPlan({
    targetId: 'session-target',
    snapshots,
    archivedIds: ['session-target'],
  })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.ids, ['session-target', 'session-subagent', 'session-subagent-2'])
})

test('collectDeletionPlan refuses non-archived and unknown sessions', () => {
  const notArchived = collectDeletionPlan({ targetId: 'session-target', snapshots, archivedIds: [] })
  assert.equal(notArchived.ok, false)
  assert.equal(notArchived.code, 'not-archived')

  const unknown = collectDeletionPlan({ targetId: 'session-missing', snapshots, archivedIds: ['session-missing'] })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'not-found')

  const invalid = collectDeletionPlan({ targetId: '', snapshots, archivedIds: [] })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'invalid-request')
})

test('collectDeletionPlan is structural: process liveness is checked separately', () => {
  // A live-but-idle Agent may legitimately linger for an archived session, so
  // the pure planner must not reject on liveness. The plugin body guards on a
  // running Agent and on the workspace activity waterfall instead.
  const plan = collectDeletionPlan({ targetId: 'session-target', snapshots, archivedIds: ['session-target'] })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.ids, ['session-target', 'session-subagent', 'session-subagent-2'])
})

test('resolveSessionDirectories resolves from stored headers and stays under the root', () => {
  const plan = collectDeletionPlan({ targetId: 'session-target', snapshots, archivedIds: ['session-target'] })
  assert.equal(plan.ok, true)
  const resolved = resolveSessionDirectories({ root: '/dsh/sessions', ids: plan.ids, records: plan.records })
  assert.deepEqual(resolved.map((entry) => entry.path), [
    '/dsh/sessions/--home-jiang-agent-talk--/session-target',
    '/dsh/sessions/--home-jiang-agent-talk--/session-subagent',
    '/dsh/sessions/--home-jiang-agent-talk--/session-subagent-2',
  ])
})

test('cleanupWorkspaceAccounting detaches, unarchives and unpins every id', async () => {
  const detached = []
  const unarchived = []
  const unpinned = []
  const workspace = {
    sessionIds: ['session-target', 'session-keep'],
    detachSession: async (id) => {
      detached.push(id)
    },
  }
  const registry = {
    list: () => [workspace],
    unarchiveSession: async (id) => {
      unarchived.push(id)
    },
    unpinSession: async (id) => {
      unpinned.push(id)
    },
  }
  const warnings = await cleanupWorkspaceAccounting({ registry, ids: ['session-target', 'session-subagent'] })
  assert.deepEqual(detached, ['session-target'])
  assert.deepEqual(unarchived, ['session-target', 'session-subagent'])
  assert.deepEqual(unpinned, ['session-target', 'session-subagent'])
  assert.deepEqual(warnings, [])
})

test('cleanupWorkspaceAccounting reports cleanup failures without throwing', async () => {
  const registry = {
    list: () => [{
      sessionIds: ['session-target'],
      detachSession: async () => {
        throw new Error('table write failed')
      },
    }],
    unarchiveSession: async () => {
      throw new Error('archive write failed')
    },
    unpinSession: async () => {},
  }
  const warnings = await cleanupWorkspaceAccounting({ registry, ids: ['session-target'] })
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /detach/)
  assert.match(warnings[1], /unarchive/)
})

test('parseRpcEnvelope accepts the Connection RPC client-request shape', () => {
  const envelope = parseRpcEnvelope(JSON.stringify({
    type: 'client-request',
    rpcId: 'rpc-1',
    method: 'delete',
    payload: { sessionId: 'session-x' },
  }))
  assert.deepEqual(envelope, {
    ok: true,
    rpcId: 'rpc-1',
    method: 'delete',
    payload: { sessionId: 'session-x' },
  })
  assert.equal(parseRpcEnvelope('not json').ok, false)
  assert.equal(parseRpcEnvelope('[]').ok, false)
  assert.equal(parseRpcEnvelope('{"type":"client-request"}').ok, false)
  assert.equal(parseRpcEnvelope('{"type":"server-response","rpcId":"x","method":"delete"}').ok, false)
})

function createMockExchange({ method = 'POST', url = '/archived-session-delete/delete', headers = { 'content-type': 'application/json' }, body = '' } = {}) {
  const request = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body.length > 0) yield Buffer.from(body)
    },
  }
  const response = {
    statusCode: undefined,
    body: undefined,
    headersSent: false,
    writeHead(status) {
      this.statusCode = status
      this.headersSent = true
    },
    end(value) {
      this.body = value
    },
    destroy() {},
  }
  return { request, response }
}

const ownerAdmission = () => ({ peer: { principal: { kind: 'owner' } } })

async function runRoute({ admission = ownerAdmission, handleEndpoint = async () => ({ ok: true, value: {} }), ...exchange } = {}) {
  const handler = createDeletionRouteHandler({ connection: { admit: admission }, handleEndpoint })
  const io = createMockExchange(exchange)
  await handler(io.request, io.response)
  return io.response
}

test('createDeletionRouteHandler gates authentication, method, path and content type', async () => {
  assert.equal((await runRoute({ admission: () => ({ rejection: 401 }) })).statusCode, 401)
  assert.equal((await runRoute({ admission: () => ({ peer: { principal: { kind: 'api' } } }) })).statusCode, 403)
  assert.equal((await runRoute({ method: 'GET' })).statusCode, 405)
  assert.equal((await runRoute({ url: '/other/delete' })).statusCode, 404)
  assert.equal((await runRoute({ headers: { 'content-type': 'text/plain' } })).statusCode, 415)
  const empty = await runRoute({ body: '' })
  assert.equal(empty.statusCode, 400)
})

test('createDeletionRouteHandler dispatches the envelope and returns a server-response', async () => {
  const handled = []
  const response = await runRoute({
    body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-7', method: 'delete', payload: { sessionId: 'session-x' } }),
    handleEndpoint: async (endpoint, payload) => {
      handled.push([endpoint, payload])
      return { ok: true, value: { deleted: ['session-x'] } }
    },
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(handled, [['delete', { sessionId: 'session-x' }]])
  const envelope = JSON.parse(response.body)
  assert.deepEqual(envelope, {
    type: 'server-response',
    rpcId: 'rpc-7',
    result: { ok: true, value: { deleted: ['session-x'] } },
  })

  const mismatch = await runRoute({
    body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-8', method: 'plan', payload: {} }),
  })
  assert.equal(mismatch.statusCode, 200)
  assert.equal(JSON.parse(mismatch.body).result.ok, false)
  assert.equal(JSON.parse(mismatch.body).result.error.code, 'bad-request')
})
