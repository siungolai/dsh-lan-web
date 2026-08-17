/**
 * dsh-lan-web — mobile surface API client (JSON-RPC envelope over /api).
 *
 * Wire facts (verified against dsh-client-connection schemas):
 *   request  {type:'client-request', rpcId, method, payload?}
 *   response {type:'server-response', rpcId, result:{ok, value?|error:{code,details?}}}
 * rpcId is an opaque string the server echoes; we use a monotonic counter
 * (NOT crypto.randomUUID — LAN plain HTTP is a non-secure context).
 */
let rpcCounter = 0

function nextRpcId(): string {
  rpcCounter += 1
  return `${Date.now().toString(36)}-${rpcCounter}`
}

export class RpcError extends Error {
  constructor(
    readonly code: string,
    readonly details: unknown,
    readonly status?: number,
  ) {
    super(`rpc error: ${code}${details !== undefined ? ` (${JSON.stringify(details)})` : ''}`)
    this.name = 'RpcError'
  }
}

export async function rpc<T>(method: string, payload?: unknown): Promise<T> {
  const rpcId = nextRpcId()
  let res: Response
  try {
    res = await fetch(`/api/lan-web/m/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
  } catch (error) {
    throw new RpcError('network', error instanceof Error ? error.message : String(error))
  }
  if (res.status === 401) throw new RpcError('unauthorized', undefined, 401)
  if (!res.ok) throw new RpcError(`http_${res.status}`, undefined, res.status)
  let envelope: unknown
  try {
    envelope = await res.json()
  } catch {
    throw new RpcError('bad_response', 'invalid json')
  }
  const env = envelope as { type?: unknown; rpcId?: unknown; result?: { ok?: unknown; value?: unknown; error?: { code?: unknown; details?: unknown } } }
  if (env.type !== 'server-response' || env.rpcId !== rpcId || env.result === undefined) {
    throw new RpcError('bad_response', envelope)
  }
  if (env.result.ok !== true) {
    throw new RpcError(String(env.result.error?.code ?? 'error'), env.result.error?.details)
  }
  return env.result.value as T
}

/* ------------------------- session domain ------------------------- */

export interface SessionProjections {
  asOfSeq: number
  values: Record<string, unknown>
}

export interface SessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  origin?: string
  cwd?: string
  agentPreset?: string
  projections?: SessionProjections
}

export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

export interface HistoryEntry {
  event: SessionEvent
  view?: unknown
}

export interface HistoryResult {
  events: HistoryEntry[]
  hasMore: boolean
  projections?: SessionProjections
}

export function titleOf(session: SessionSummary): string {
  const title = session.projections?.values?.title
  return typeof title === 'string' && title.length > 0 ? title : '新会话'
}

export async function listSessions(): Promise<SessionSummary[]> {
  const value = await rpc<{ items: SessionSummary[] }>('session.list', {})
  return value.items
}

export async function createSession(): Promise<string> {
  const value = await rpc<{ sessionId: string }>('session.create', {})
  return value.sessionId
}

export async function sessionHistory(sessionId: string, opts: { beforeSeq?: number; maxMessages?: number } = {}): Promise<HistoryResult> {
  return rpc<HistoryResult>('session.history', { sessionId, ...opts })
}

export async function sendPrompt(sessionId: string, text: string): Promise<void> {
  await rpc<{ accepted: true }>('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  })
}

/* ------------------------- skills domain ------------------------- */

export interface SkillSummary {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
}

/** User-invocable skills for a session (the desktop / menu's source). */
export async function listSkills(sessionId: string): Promise<SkillSummary[]> {
  const value = await rpc<{ skills: SkillSummary[] }>('skill.list', { sessionId })
  return value.skills
}

/* ------------------------- models domain ------------------------- */

export interface ModelReasoning {
  efforts: Array<{ id: string; name: string; description?: string }>
  defaultEffort?: string
}

export interface ModelInfo {
  id: string
  name: string
  description?: string
  reasoning?: ModelReasoning
}

export interface ModelGroup {
  id: string
  name: string
  models: ModelInfo[]
}

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelCatalog {
  current: ModelSelection
  routable: boolean
  groups: ModelGroup[]
  failures: Array<{ id: string; name: string; message: string }>
}

/** Current model + routable catalog for a session. */
export async function listModels(sessionId: string): Promise<ModelCatalog> {
  return rpc<ModelCatalog>('session.models', { sessionId })
}

/** Switch the session model (and optionally reasoning effort). */
export async function selectModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection> {
  const value = await rpc<{ selected: ModelSelection }>('session.selectModel', { sessionId, ...selection })
  return value.selected
}

/* ------------------------- permission / sandbox domain ------------------------- */

export interface PermissionOption {
  value: string
  name: string
  description?: string
}

export interface PermissionsState {
  options: PermissionOption[]
  currentValue: string
}

/** Switch the sandbox permission preset.
 * Sent as a slash text through session.prompt: the host routes a lone
 * `/`-prefixed text block to the command registry (documented path), so no
 * commands/execute access is needed from the mobile data plane. */
export async function switchPermission(sessionId: string, value: string): Promise<void> {
  await sendPrompt(sessionId, `/permission ${value}`)
}

export const PERMISSION_ICONS: Record<string, string> = {
  'read-only': '📄',
  'workspace-write': '✏️',
  'danger-full-access': '⚡',
}

/** Read the permissions projection from a history response tail block. */
export function permissionsOf(projections: SessionProjections | undefined): PermissionsState | null {
  const value = projections?.values?.permissions as { options?: PermissionOption[]; currentValue?: string } | undefined
  if (value === undefined || !Array.isArray(value.options) || typeof value.currentValue !== 'string') return null
  return { options: value.options, currentValue: value.currentValue }
}
