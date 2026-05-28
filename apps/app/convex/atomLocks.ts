import { ConvexError } from 'convex/values'

// file-org-v1 §2.7 (Track-4 D4.1a). Two error classes for the
// lock-guard chokepoints. Both follow the P2c-fold pattern from
// `convex/entities.ts:181` (StrictCreateConflictError):
// `ConvexError.message` defaults to JSON of `.data`, so we override
// it with `Object.defineProperty` so the human-friendly string
// survives `ctx.runMutation` AND surfaces via AI-SDK's
// `getErrorMessage(err)` to the model. Both `.message` AND `.data`
// propagate across the runMutation boundary.
//
// Context-aware messages: each constructor takes (path, context) where
// context ∈ 'edit'|'delete'|'rename'. The 6 message variants are
// pinned here so callsites can throw without picking strings.

export type LockContext = 'edit' | 'delete' | 'rename'

export type SystemLockData = {
  kind: 'system-locked'
  path: string
  context: LockContext
  message: string
}

export type UserLockData = {
  kind: 'user-locked'
  path: string
  context: LockContext
  message: string
}

function formatSystemLockMessage(path: string, context: LockContext): string {
  switch (context) {
    case 'edit':
      return `Cannot edit "${path}": this is a system-managed file.`
    case 'delete':
      return `Cannot delete "${path}": this is a system-managed file.`
    case 'rename':
      return `Cannot rename "${path}": this is a system-managed file. Its path is part of the system contract.`
  }
}

function formatUserLockMessage(path: string, context: LockContext): string {
  switch (context) {
    case 'edit':
      return `Cannot edit "${path}": you locked this file. Unlock it first to allow agent edits.`
    case 'delete':
      return `Cannot delete "${path}": you locked this file. Unlock it first to allow deletion.`
    case 'rename':
      return `Cannot rename "${path}": you locked this file. Unlock it first to allow renames.`
  }
}

export class SystemLockError extends ConvexError<SystemLockData> {
  constructor(path: string, context: LockContext) {
    const message = formatSystemLockMessage(path, context)
    super({ kind: 'system-locked', path, context, message })
    this.name = 'SystemLockError'
    // ConvexError defaults .message to JSON of the data payload;
    // override to the human-friendly form so AI-SDK's
    // `getErrorMessage(err)` surfaces clean text to the model.
    // Both `.message` AND `.data` survive `ctx.runMutation`.
    Object.defineProperty(this, 'message', {
      value: message,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  }

  get kind(): 'system-locked' {
    return this.data.kind
  }
  get path(): string {
    return this.data.path
  }
  get context(): LockContext {
    return this.data.context
  }
}

export class UserLockError extends ConvexError<UserLockData> {
  constructor(path: string, context: LockContext) {
    const message = formatUserLockMessage(path, context)
    super({ kind: 'user-locked', path, context, message })
    this.name = 'UserLockError'
    Object.defineProperty(this, 'message', {
      value: message,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  }

  get kind(): 'user-locked' {
    return this.data.kind
  }
  get path(): string {
    return this.data.path
  }
  get context(): LockContext {
    return this.data.context
  }
}

// file-org-v1 §2.2 — folder-cosmetic allowlists. Pinned here (not the
// design doc) so a misspelled value at the mutation boundary is a
// LOUD reject, not silent acceptance. UI components import the same
// constants so the picker grid and the validator stay in sync.

export const FOLDER_COLORS = [
  'default',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
] as const

export type FolderColor = (typeof FOLDER_COLORS)[number]

export const FOLDER_ICONS = [
  'folder',
  'folder-heart',
  'folder-star',
  'folder-lock',
  'folder-cog',
  'folder-search',
  'folder-tree',
  'folder-archive',
  'folder-clock',
] as const

export type FolderIcon = (typeof FOLDER_ICONS)[number]

export function isFolderColor(s: string): s is FolderColor {
  return (FOLDER_COLORS as readonly string[]).includes(s)
}

export function isFolderIcon(s: string): s is FolderIcon {
  return (FOLDER_ICONS as readonly string[]).includes(s)
}

// file-org-v1 §2.3 — ONE folder-path policy used by every callsite
// (create, move, remove, setMeta). normalize strips and collapses
// slashes; validate rejects the 5 unsafe shapes.

export function normalizeFolderPath(path: string): string {
  // Trim outer whitespace, strip leading/trailing slashes, collapse
  // any internal `//` runs to a single `/`. Returns the cleaned form
  // unchanged for a well-formed input.
  return path
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/')
}

export type FolderPathValidation =
  | { ok: true; path: string }
  | { ok: false; reason: string }

export function validateFolderPath(raw: string): FolderPathValidation {
  const path = normalizeFolderPath(raw)
  if (path === '') return { ok: false, reason: 'folder path cannot be empty' }
  if (path.length > 512) return { ok: false, reason: 'folder path too long (max 512 chars)' }
  if (path.includes('\u0000')) return { ok: false, reason: 'folder path cannot contain U+0000' }
  // Preserve existing folders.ts behavior — refuse spaces. Tree
  // renderer + wikilink resolver assume space-free path segments.
  if (path.includes(' ')) return { ok: false, reason: 'folder path cannot contain spaces' }
  // No `.` or `..` segments (would let a relative-traversal-ish
  // string sneak past slash-prefix matching elsewhere).
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') {
      return { ok: false, reason: `folder path has invalid segment: ${JSON.stringify(seg)}` }
    }
  }
  return { ok: true, path }
}
