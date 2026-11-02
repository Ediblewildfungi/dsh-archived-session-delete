/**
 * Host half of `dsh-archived-session-delete`.
 *
 * Exposes one authenticated Connection RPC channel,
 * `/archived-session-delete`, with two endpoints:
 *
 * - `plan({ sessionId })` — read-only dry run: resolves the stored session,
 *   its hidden subagent descendants and each session directory that a delete
 *   would remove. Useful for diagnostics and for tests.
 * - `delete({ sessionId })` — permanently deletes the JSONL session artifact
 *   of an *archived* session (and the artifacts of its subagent descendants),
 *   then detaches the id from workspace accounting, removes it from the
 *   global archive/pin sets, and forwards `api-session/removed` so open
 *   clients refresh their session list.
 *
 * The module deliberately imports only Node builtins: it is loaded as a
 * linked package from the DSH profile and must not rely on the profile's
 * dependency graph. All DSH capabilities are injected as Cordis services.
 *
 * @module dsh-archived-session-delete
 */

import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'

export const name = 'archived-session-delete'

/** Services the Host half waits for before registering its RPC channel. */
export const inject = ['connection', 'webServer', 'sessionPersistence', 'workspaceRegistry', 'sessions']

/** Single-segment channel the browser half talks to. */
export const CHANNEL = '/archived-session-delete'

/**
 * Encode an arbitrary string as one safe filesystem path segment.
 *
 * This mirrors the escaping rule of the shipped JSONL session backend so a
 * session directory can be located from its id alone; safe code units stay
 * literal and every other unit becomes `~XXXX`.
 *
 * @param {string} raw - unpinned identifier; must be non-empty.
 * @returns {string} safe single path segment.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Readable directory key for a project path.
 *
 * Mirrors the backend convention: separators collapse to one `-`, unsafe code
 * units use `~XXXX`, and the key is wrapped in `--…--`.
 *
 * @param {string} cwd - absolute working directory the session was created in.
 * @returns {string} single safe path segment.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Directory owned by one stored session.
 *
 * @param {string} root - session persistence root (`$DSH_HOME/sessions`).
 * @param {string | undefined} cwd - stored session cwd; `undefined` -> `_no-cwd`.
 * @param {string} id - session id.
 * @returns {string} absolute session directory.
 */
export function sessionDirectory(root, cwd, id) {
  const project = cwd === undefined ? join(root, '_no-cwd') : join(root, projectKey(cwd))
  return join(project, encodeSegment(id))
}

/**
 * Default session persistence root, matching the shipped base profile's
 * `@deepseek-ai/dsh-session-persistence-jsonl` configuration.
 *
 * @param {NodeJS.ProcessEnv} [env] - process environment.
 * @param {string} [home] - user home directory.
 * @returns {string} absolute sessions root.
 */
export function defaultSessionsRoot(env = process.env, home = homedir()) {
  const base = typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(home, '.dsh')
  return join(base, 'sessions')
}

/** Build a `RemoteResult` success envelope. */
function ok(value) {
  return { ok: true, value }
}

/** Build a `RemoteResult` failure envelope. */
function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

/**
 * Pure deletion-plan planner (no I/O), shared by the `plan` and `delete`
 * endpoints and by the unit tests.
 *
 * The plan includes the archived target plus every stored session whose
 * header marks it as a subagent descendant of a planned id. Fork children are
 * *not* included: `parentSession` also records fork lineage, and deleting a
 * session must never delete an independently forked conversation. Hidden
 * subagent artifacts are the only descendants a delete piggybacks on.
 *
 * @param {object} input - planning input.
 * @param {string} input.targetId - session the user asked to delete.
 * @param {readonly {header: {id: unknown, cwd?: string, parentSession?: unknown, origin?: string}}[]} input.snapshots
 *   `sessionPersistence.list()` snapshot rows.
 * @param {readonly unknown[]} input.archivedIds - registry-global archive set.
 * @returns {{ok: true, ids: string[], records: Map<string, object>} | {ok: false, code: string, message: string, details?: object}}
 *
 * The plan is structural only: whether the session still has live work is a
 * separate check made against the Agent registry by the plugin body, because a
 * live-but-idle Agent may legitimately linger for a deleted archived Session.
 */
export function collectDeletionPlan({ targetId, snapshots, archivedIds }) {
  if (typeof targetId !== 'string' || targetId.length === 0 || targetId.length > 1024) {
    return { ok: false, code: 'invalid-request', message: 'sessionId must be a non-empty string' }
  }
  if (!Array.isArray(archivedIds) || !archivedIds.map(String).includes(targetId)) {
    return { ok: false, code: 'not-archived', message: `session '${targetId}' is not archived; only archived sessions can be deleted here` }
  }
  const records = new Map()
  for (const snapshot of snapshots) {
    const header = snapshot?.header
    if (header === undefined || header === null) continue
    const id = String(header.id)
    if (!records.has(id)) records.set(id, header)
  }
  const targetHeader = records.get(targetId)
  if (targetHeader === undefined) {
    return { ok: false, code: 'not-found', message: `stored session '${targetId}' was not found` }
  }
  const ids = [targetId]
  const seen = new Set(ids)
  for (const [id, header] of records) {
    if (header.origin !== 'subagent') continue
    const parent = header.parentSession === undefined ? undefined : String(header.parentSession)
    if (parent === undefined || !seen.has(parent)) continue
    seen.add(id)
    ids.push(id)
  }
  return { ok: true, ids, records }
}

/**
 * Resolve the on-disk directories for a plan without deleting anything.
 *
 * @param {object} input - directory resolution input.
 * @param {string} input.root - session persistence root.
 * @param {readonly string[]} input.ids - planned session ids.
 * @param {Map<string, object>} input.records - headers keyed by session id.
 * @returns {{id: string, path: string, cwd?: string}[]} resolved session artifacts.
 */
export function resolveSessionDirectories({ root, ids, records }) {
  const rootPrefix = root.endsWith(sep) ? root : root + sep
  return ids.map((id) => {
    const header = records.get(id)
    const cwd = header !== undefined && typeof header.cwd === 'string' ? header.cwd : undefined
    const path = sessionDirectory(root, cwd, id)
    const rel = relative(root, path)
    if (rel.length === 0 || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel) || !path.startsWith(rootPrefix)) {
      throw new Error(`refusing to touch a path outside the session root: ${path}`)
    }
    return { id, path, ...(cwd === undefined ? {} : { cwd }) }
  })
}

/**
 * Best-effort workspace accounting cleanup for ids whose artifacts are gone.
 *
 * A failure here never fails the deletion: the artifacts are already gone, and
 * the registry prunes unknown accounting on its next mutation/startup.
 *
 * @param {object} input - cleanup input.
 * @param {object} input.registry - `ctx.workspaceRegistry`.
 * @param {readonly string[]} input.ids - deleted session ids.
 * @param {(message: string) => void} [input.warn] - warning sink.
 * @returns {Promise<string[]>} warnings collected.
 */
export async function cleanupWorkspaceAccounting({ registry, ids, warn = () => {} }) {
  const warnings = []
  const note = (message) => {
    warnings.push(message)
    warn(message)
  }
  for (const id of ids) {
    try {
      for (const workspace of registry.list()) {
        if (workspace.sessionIds.includes(id)) await workspace.detachSession(id)
      }
    } catch (error) {
      note(`failed to detach session '${id}' from workspace accounting: ${String(error)}`)
    }
    try {
      await registry.unarchiveSession(id)
    } catch (error) {
      note(`failed to unarchive session '${id}' before cleanup: ${String(error)}`)
    }
    try {
      await registry.unpinSession(id)
    } catch (error) {
      note(`failed to unpin session '${id}' before cleanup: ${String(error)}`)
    }
  }
  return warnings
}

/** Maximum JSON envelope accepted by the deletion route. */
export const MAX_RPC_BODY_BYTES = 64 * 1024

/** Endpoint segment shape accepted after the channel prefix. */
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * Parse one Connection RPC client-request envelope.
 *
 * The wire format is the one `ctx.connection.rpc.call` writes; keeping the
 * route on that format means the browser half does not need a second
 * transport or a custom error mapping.
 *
 * @param {string} text - raw request body.
 * @returns {{ok: true, rpcId: string, method: string, payload: unknown} | {ok: false, message: string}}
 *   parsed envelope, or the reason it was refused.
 */
export function parseRpcEnvelope(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, message: 'body is not JSON' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, message: 'envelope must be an object' }
  if (value.type !== 'client-request') return { ok: false, message: 'envelope type must be client-request' }
  if (typeof value.rpcId !== 'string' || value.rpcId.length === 0) return { ok: false, message: 'envelope rpcId must be a non-empty string' }
  if (typeof value.method !== 'string' || value.method.length === 0) return { ok: false, message: 'envelope method must be a non-empty string' }
  return { ok: true, rpcId: value.rpcId, method: value.method, payload: value.payload }
}

/** Write one JSON response (no-store; the payload is per-request state). */
function writeJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** Read a bounded request body as UTF-8 text. */
async function readBody(request, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('request body too large')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Build the HTTP handler for the deletion channel.
 *
 * Admission mirrors the shared `/api` bridge: the Host/Origin trust fence is
 * applied first, then browser/API authentication; unauthenticated callers get
 * 401/403 before any JSON is read. Only `POST` requests whose path is
 * `<channel>/<endpoint>` with a Connection RPC envelope reach the endpoint
 * handler.
 *
 * @param {object} input - handler dependencies.
 * @param {object} input.connection - Host `ctx.connection` service.
 * @param {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<object>} input.handleEndpoint
 *   business endpoint dispatcher returning a `RemoteResult`.
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 *   route handler.
 */
export function createDeletionRouteHandler({ connection, handleEndpoint }) {
  return async function handleDeletionRoute(request, response) {
    try {
      const admission = connection.admit(request)
      if (admission !== null && admission !== undefined && 'rejection' in admission) {
        response.writeHead(admission.rejection)
        response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const peer = admission?.peer
      if (peer !== undefined && peer.principal?.kind !== 'owner') {
        response.writeHead(403)
        response.end('forbidden')
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405)
        response.end('method not allowed')
        return
      }
      const pathname = new URL(String(request.url ?? '/'), 'http://dsh.invalid').pathname
      if (!pathname.startsWith(CHANNEL + '/')) {
        response.writeHead(404)
        response.end('not found')
        return
      }
      const endpoint = pathname.slice(CHANNEL.length + 1)
      if (!ENDPOINT_PATTERN.test(endpoint)) {
        response.writeHead(404)
        response.end('not found')
        return
      }
      const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        response.writeHead(415)
        response.end('content type must be application/json')
        return
      }
      let text
      try {
        text = await readBody(request, MAX_RPC_BODY_BYTES)
      } catch (error) {
        response.writeHead(error?.statusCode ?? 400)
        response.end(String(error?.message ?? error))
        return
      }
      const envelope = parseRpcEnvelope(text)
      if (!envelope.ok) {
        writeJson(response, 400, {
          type: 'server-response',
          rpcId: 'invalid-request',
          result: fail('invalid-request', envelope.message),
        })
        return
      }
      if (envelope.method !== endpoint) {
        writeJson(response, 200, {
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: fail('bad-request', `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`),
        })
        return
      }
      let result
      try {
        result = await handleEndpoint(endpoint, envelope.payload)
      } catch (error) {
        result = fail('internal', String(error?.message ?? error))
      }
      writeJson(response, 200, { type: 'server-response', rpcId: envelope.rpcId, result })
    } catch (error) {
      if (!response.headersSent) {
        writeJson(response, 500, {
          type: 'server-response',
          rpcId: 'internal-error',
          result: fail('internal', String(error?.message ?? error)),
        })
      } else {
        response.destroy()
      }
    }
  }
}

/**
 * Cordis plugin body: register the authenticated RPC channel.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context with the injected services.
 * @param {{sessionsRoot?: string}} [config] - optional deployment override of the sessions root.
 */
export function apply(ctx, config) {
  const root = typeof config?.sessionsRoot === 'string' && config.sessionsRoot.length > 0
    ? config.sessionsRoot
    : defaultSessionsRoot()
  const log = ctx.logger ?? console

  const resolvePlan = async (sessionId, signal) => {
    const snapshots = await ctx.sessionPersistence.list({ signal })
    const plan = collectDeletionPlan({
      targetId: sessionId,
      snapshots,
      archivedIds: ctx.workspaceRegistry.archivedSessionIds,
    })
    if (!plan.ok) return plan
    const agents = ctx.get('agents')
    const liveIds = plan.ids.filter((id) => agents?.get?.(id) !== undefined)
    const runningIds = plan.ids.filter((id) => agents?.get?.(id)?.status === 'running')
    if (runningIds.length > 0) {
      return {
        ok: false,
        code: 'session-active',
        message: `session '${runningIds[0]}' is running; stop its work before deleting it`,
        details: { ids: runningIds },
      }
    }
    let activity
    try {
      activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    } catch (error) {
      return {
        ok: false,
        code: 'activity-unavailable',
        message: `could not verify that the session has no work in flight: ${String(error?.message ?? error)}`,
      }
    }
    if (Array.isArray(activity) && activity.length > 0) {
      return {
        ok: false,
        code: 'session-active',
        message: `session '${sessionId}' still has work in flight`,
        details: { activity },
      }
    }
    let resolved
    try {
      resolved = resolveSessionDirectories({ root, ids: plan.ids, records: plan.records })
    } catch (error) {
      return fail('unsafe-path', String(error), { root })
    }
    return { ok: true, ...plan, resolved, liveIds, snapshots }
  }

  const planEndpoint = async (sessionId, signal) => {
    const plan = await resolvePlan(sessionId, signal)
    if (!plan.ok) return plan
    return ok({
      sessionId,
      archived: true,
      root,
      live: plan.liveIds,
      sessions: plan.resolved.map((entry) => ({ id: entry.id, path: entry.path })),
    })
  }

  const deleteEndpoint = async (sessionId, signal) => {
    const plan = await resolvePlan(sessionId, signal)
    if (!plan.ok) return plan
    signal?.throwIfAborted?.()
    const deleted = []
    for (const entry of plan.resolved) {
      try {
        await rm(entry.path, { recursive: true, force: true })
        deleted.push(entry.id)
      } catch (error) {
        log.warn?.(`[archived-session-delete] failed to remove ${entry.path}: ${String(error)}`)
        return fail('delete-failed', `failed to remove stored session '${entry.id}'`, {
          id: entry.id,
          path: entry.path,
          deleted: [...deleted],
        })
      }
    }
    const warnings = await cleanupWorkspaceAccounting({
      registry: ctx.workspaceRegistry,
      ids: plan.ids,
      warn: (message) => log.warn?.(`[archived-session-delete] ${message}`),
    })
    // A live-but-idle Agent may still hold the archived Session in the live
    // store. Detach it (the same public path normal disposal uses) so list
    // surfaces stop publishing a row whose durable log no longer exists; the
    // Agent itself is reclaimed by the Host on restart.
    const liveStore = ctx.get('sessions')
    for (const id of plan.ids) {
      try {
        const session = liveStore?.get?.(id)
        if (session === undefined) continue
        const entry = liveStore.liveEntryFor?.(session)
        if (entry !== undefined) liveStore.detachEntered(entry)
      } catch (error) {
        warnings.push(`failed to detach live session '${id}' from the Host session store: ${String(error)}`)
        log.warn?.(`[archived-session-delete] failed to detach live session '${id}': ${String(error)}`)
      }
    }
    for (const id of plan.ids) {
      try {
        ctx.emit('api-session/removed', id)
      } catch (error) {
        log.warn?.(`[archived-session-delete] failed to announce removal of '${id}': ${String(error)}`)
      }
    }
    log.info?.(`[archived-session-delete] deleted session '${sessionId}' (${plan.ids.length} stored log(s))`)
    return ok({
      sessionId,
      deleted: plan.ids,
      paths: plan.resolved.map((entry) => entry.path),
      warnings,
    })
  }

  const endpointHandler = async (endpoint, payload) => {
    try {
      const sessionId = payload?.sessionId
      switch (endpoint) {
        case 'plan':
          return await planEndpoint(sessionId, undefined)
        case 'delete':
          return await deleteEndpoint(sessionId, undefined)
        default:
          return fail('unknown-endpoint', `unknown endpoint '${String(endpoint)}'`)
      }
    } catch (error) {
      const aborted = error?.name === 'AbortError'
      return fail(aborted ? 'cancelled' : 'internal', String(error?.message ?? error))
    }
  }

  // The channel is registered on the Web server directly: the admission check
  // below is the same Host/Origin fence plus browser/API authentication the
  // shared `/api` bridge applies, and the wire envelope matches
  // `ctx.connection.rpc.call` so the browser half needs no bespoke transport.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: createDeletionRouteHandler({ connection: ctx.connection, handleEndpoint: endpointHandler }),
  }), 'archived-session-delete: authenticated deletion route')
}
