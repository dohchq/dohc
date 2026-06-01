export type ViewRpcOp =
  | 'dohc.sources.list'
  | 'dohc.atom.get'
  | 'dohc.fields.query'
  | 'dohc.imports.list'
  | 'dohc.exports.list'
  | 'dohc.source.open'
  | 'dohc.agent.run'
  | 'dohc.patch.propose'

export type ViewRpcRequest =
  | { id: string; op: 'dohc.sources.list'; args: { source?: string } }
  | { id: string; op: 'dohc.atom.get'; args: { path: string } }
  | { id: string; op: 'dohc.fields.query'; args: { source?: string; keys?: string[] } }
  | { id: string; op: 'dohc.imports.list'; args: Record<string, never> }
  | { id: string; op: 'dohc.exports.list'; args: Record<string, never> }
  | { id: string; op: 'dohc.source.open'; args: { path: string } }
  | { id: string; op: 'dohc.agent.run'; args: { prompt: string; sources?: string[] } }
  | {
      id: string
      op: 'dohc.patch.propose'
      args: { path: string; summary: string; patch: Record<string, unknown> }
    }

export type ViewRpcResponse =
  | { id: string; ok: true; value: unknown }
  | {
      id: string
      ok: false
      error: { code: string; message: string }
    }

const OPS = new Set<ViewRpcOp>([
  'dohc.sources.list',
  'dohc.atom.get',
  'dohc.fields.query',
  'dohc.imports.list',
  'dohc.exports.list',
  'dohc.source.open',
  'dohc.agent.run',
  'dohc.patch.propose',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function stringArray(value: unknown): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  )
}

function hasOnlyKeys(args: Record<string, unknown>, allowed: string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(args).every((key) => allowedKeys.has(key))
}

function validateArgs(op: ViewRpcOp, args: Record<string, unknown>): boolean {
  switch (op) {
    case 'dohc.sources.list':
      return hasOnlyKeys(args, ['source']) && optionalString(args.source)
    case 'dohc.atom.get':
    case 'dohc.source.open':
      return (
        hasOnlyKeys(args, ['path']) &&
        typeof args.path === 'string' &&
        args.path.trim().length > 0
      )
    case 'dohc.fields.query':
      return (
        hasOnlyKeys(args, ['source', 'keys']) &&
        optionalString(args.source) &&
        stringArray(args.keys)
      )
    case 'dohc.imports.list':
    case 'dohc.exports.list':
      return Object.keys(args).length === 0
    case 'dohc.agent.run':
      return (
        hasOnlyKeys(args, ['prompt', 'sources']) &&
        typeof args.prompt === 'string' &&
        args.prompt.trim().length > 0 &&
        stringArray(args.sources)
      )
    case 'dohc.patch.propose':
      return (
        hasOnlyKeys(args, ['path', 'summary', 'patch']) &&
        typeof args.path === 'string' &&
        args.path.trim().length > 0 &&
        typeof args.summary === 'string' &&
        args.summary.trim().length > 0 &&
        isPlainObject(args.patch)
      )
  }
}

export function parseViewRpcRequest(value: unknown): ViewRpcRequest | null {
  if (!isPlainObject(value)) return null
  if (typeof value.id !== 'string' || !value.id) return null
  if (typeof value.op !== 'string' || !OPS.has(value.op as ViewRpcOp)) {
    return null
  }
  if (!isPlainObject(value.args)) return null

  const op = value.op as ViewRpcOp
  if (!validateArgs(op, value.args)) return null
  return {
    id: value.id,
    op,
    args: value.args,
  } as ViewRpcRequest
}

export function isViewRpcRequest(value: unknown): value is ViewRpcRequest {
  return parseViewRpcRequest(value) !== null
}

export function makeViewRpcSuccess(id: string, value: unknown): ViewRpcResponse {
  return { id, ok: true, value }
}

export function makeViewRpcError(
  id: string,
  code: string,
  message: string,
): ViewRpcResponse {
  return { id, ok: false, error: { code, message } }
}
