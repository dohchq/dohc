import type {
  Configuration,
  beforeHandleAwarenessPayload,
  beforeHandleMessagePayload,
  beforeSyncPayload,
  connectedPayload,
  onAuthenticatePayload,
  onChangePayload,
  onAwarenessUpdatePayload,
  onDisconnectPayload,
  onLoadDocumentPayload,
  onTokenSyncPayload,
  onStoreDocumentPayload,
} from '@hocuspocus/server'
import * as Y from 'yjs'
import { decodeDocName } from './doc-name.js'
import { verifyCollabToken, type CollabActorKind } from './auth.js'
import type { PostgresYDocStore } from './persistence.js'
import { markdownToYDoc } from './import-export.js'
import {
  createProjectionWorker,
  type ProjectionWorker,
} from './projection.js'

export type DohcHocuspocusContext = {
  userId: string
  workspaceId: string
  atomId: string
  actorKind: CollabActorKind
  authzVersion: number
  tokenExpiresAt?: number
}

export type AtomAccessInput = {
  workspaceId: string
  atomId: string
  userId: string
  actorKind: CollabActorKind
  authzVersion: number
}

export type AtomBodyCacheProjectionInput = {
  workspaceId: string
  atomId: string
  markdown: string
  projectionHash: string
  schemaVersion: number
  ydocStateVector: string
  lastEditedByUserId?: string | null
  projectedAt: number
}

export type AtomBodyCacheProjectionResult =
  | { ok: true }
  | { ok: false; reason: 'missing-atom' | 'frontmatter-id-mismatch' }

export type AtomCreateInput = {
  workspaceId: string
  path: string
  content: string
  userId: string
  actorKind: CollabActorKind
  authzVersion: number
}

export type AtomCreateResult =
  | { ok: true; atomId: string; markdown: string }
  | {
      ok: false
      reason:
        | 'already-exists'
        | 'forbidden'
        | 'stale-authz'
        | 'missing-frontmatter-id'
    }

export type WorkspaceAuthzVersionInput = {
  workspaceId: string
  atomId: string
  userId: string
  actorKind: CollabActorKind
  authzVersion: number
}

export type HocuspocusAcl = {
  getWorkspaceAuthzVersion(input: WorkspaceAuthzVersionInput): Promise<number>
  canReadAtom(input: AtomAccessInput): Promise<boolean>
  canWriteAtom(input: AtomAccessInput): Promise<boolean>
  loadAtomBootstrap?(
    input: AtomAccessInput,
  ): Promise<{ markdown: string } | null>
  setAtomBodyCache?(
    input: AtomBodyCacheProjectionInput,
  ): Promise<AtomBodyCacheProjectionResult>
  createAtom?(input: AtomCreateInput): Promise<AtomCreateResult>
}

export type HocuspocusLogger = {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export type CreateHocuspocusHooksOptions = {
  jwtSecret: string
  acl: HocuspocusAcl
  store: PostgresYDocStore
  logger: HocuspocusLogger
  revocations?: HocuspocusRevocations
  projectionWorker?: ProjectionWorker
  projectionDebounceMs?: number
}

type DohcHocuspocusHooks = {
  onAuthenticate: NonNullable<
    Configuration<DohcHocuspocusContext>['onAuthenticate']
  >
  connected: NonNullable<Configuration<DohcHocuspocusContext>['connected']>
  onLoadDocument: NonNullable<
    Configuration<DohcHocuspocusContext>['onLoadDocument']
  >
  onTokenSync: NonNullable<
    Configuration<DohcHocuspocusContext>['onTokenSync']
  >
  beforeHandleMessage: NonNullable<
    Configuration<DohcHocuspocusContext>['beforeHandleMessage']
  >
  beforeHandleAwareness: NonNullable<
    Configuration<DohcHocuspocusContext>['beforeHandleAwareness']
  >
  beforeSync: NonNullable<Configuration<DohcHocuspocusContext>['beforeSync']>
  onStoreDocument: NonNullable<
    Configuration<DohcHocuspocusContext>['onStoreDocument']
  >
  onChange: NonNullable<Configuration<DohcHocuspocusContext>['onChange']>
  onAwarenessUpdate: NonNullable<
    Configuration<DohcHocuspocusContext>['onAwarenessUpdate']
  >
  onDisconnect: NonNullable<Configuration<DohcHocuspocusContext>['onDisconnect']>
}

const YJS_SYNC_STEP2 = 1
const YJS_UPDATE = 2

export type HocuspocusRevocableConnection = {
  socketId: string
  close(options?: { code?: number; reason?: string }): void
}

export type HocuspocusRevocations = {
  registerConnection?(input: {
    workspaceId: string
    userId: string
    connection: HocuspocusRevocableConnection
  }): void
  unregisterSocket?(socketId: string): void
}

class AppliedSequenceTracker {
  private readonly pendingBySocket = new Map<string, number[]>()
  private readonly appliedByDocument = new Map<
    string,
    { contiguous: number; outOfOrder: Set<number> }
  >()

  setLoadedSequence(documentName: string, seq: number): void {
    const state = this.stateFor(documentName)
    state.contiguous = Math.max(state.contiguous, seq)
    for (const applied of state.outOfOrder) {
      if (applied <= state.contiguous) {
        state.outOfOrder.delete(applied)
      }
    }
  }

  markPending(documentName: string, socketId: string, seq: number): void {
    const key = this.socketKey(documentName, socketId)
    this.pendingBySocket.set(key, [...(this.pendingBySocket.get(key) ?? []), seq])
  }

  markApplied(documentName: string, socketId: string): void {
    const key = this.socketKey(documentName, socketId)
    const queue = this.pendingBySocket.get(key)
    if (!queue) return

    const seq = queue?.shift()
    if (seq === undefined) return
    if (queue.length === 0) {
      this.pendingBySocket.delete(key)
    }

    const state = this.stateFor(documentName)
    if (seq === state.contiguous + 1) {
      state.contiguous = seq
      while (state.outOfOrder.delete(state.contiguous + 1)) {
        state.contiguous += 1
      }
      return
    }

    if (seq > state.contiguous) {
      state.outOfOrder.add(seq)
    }
  }

  latestContiguous(documentName: string): number | undefined {
    return this.appliedByDocument.get(documentName)?.contiguous
  }

  private stateFor(documentName: string): {
    contiguous: number
    outOfOrder: Set<number>
  } {
    const existing = this.appliedByDocument.get(documentName)
    if (existing) return existing

    const state = { contiguous: 0, outOfOrder: new Set<number>() }
    this.appliedByDocument.set(documentName, state)
    return state
  }

  private socketKey(documentName: string, socketId: string): string {
    return `${documentName}\0${socketId}`
  }
}

function accessInput(context: DohcHocuspocusContext): AtomAccessInput {
  return {
    workspaceId: context.workspaceId,
    atomId: context.atomId,
    userId: context.userId,
    actorKind: context.actorKind,
    authzVersion: context.authzVersion,
  }
}

function setConnectionReadOnly(
  data:
    | onAuthenticatePayload<DohcHocuspocusContext>
    | onTokenSyncPayload<DohcHocuspocusContext>,
  readOnly: boolean,
): void {
  const connection =
    data.connectionConfig ??
    (data as unknown as { connection?: { readOnly: boolean } }).connection
  if (!connection) {
    throw new Error('Missing Hocuspocus connection configuration')
  }
  connection.readOnly = readOnly

  const liveConnection = (data as onTokenSyncPayload<DohcHocuspocusContext>)
    .connection
  if (liveConnection) liveConnection.readOnly = readOnly
}

function isPersistableSyncPayload(type: number): boolean {
  return type === YJS_SYNC_STEP2 || type === YJS_UPDATE
}

function assertValidYjsUpdate(payload: Uint8Array): void {
  const probe = new Y.Doc()
  try {
    Y.applyUpdate(probe, payload)
  } catch (cause) {
    throw new Error('Invalid Yjs update payload', { cause })
  } finally {
    probe.destroy()
  }
}

function assertTokenFresh(context: DohcHocuspocusContext): void {
  if (
    typeof context.tokenExpiresAt === 'number' &&
    context.tokenExpiresAt <= Math.floor(Date.now() / 1000)
  ) {
    throw new Error('Collab token expired')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, maxLength)
}

function sanitizeAwarenessState(
  state: Record<string, unknown>,
): Record<string, unknown> | null {
  const sanitized: Record<string, unknown> = {}
  if (isRecord(state.user)) {
    const id = cleanString(state.user.id, 128)
    const color = cleanString(state.user.color, 32)
    if (id && color) {
      sanitized.user = {
        id,
        name: cleanString(state.user.name, 80) ?? 'You',
        color,
      }
    }
  }

  if (isRecord(state.cursor)) {
    sanitized.cursor = {
      anchor: state.cursor.anchor,
      head: state.cursor.head,
    }
  }

  return Object.keys(sanitized).length ? sanitized : null
}

export function createHocuspocusHooks({
  jwtSecret,
  acl,
  store,
  logger,
  revocations,
  projectionWorker,
  projectionDebounceMs,
}: CreateHocuspocusHooksOptions): DohcHocuspocusHooks {
  const sequences = new AppliedSequenceTracker()
  const projections =
    projectionWorker ??
    createProjectionWorker({
      store,
      acl,
      logger,
      debounceMs: projectionDebounceMs,
    })

  async function authenticateDocumentToken(
    documentName: string,
    tokenValue: string,
  ): Promise<{ context: DohcHocuspocusContext; canWrite: boolean }> {
    const token = await verifyCollabToken(tokenValue, jwtSecret)
    const doc = decodeDocName(documentName)

    if (token.ws !== doc.workspaceId) {
      throw new Error('Collab token workspace does not match document')
    }

    const currentVersion = await acl.getWorkspaceAuthzVersion({
      workspaceId: doc.workspaceId,
      atomId: doc.atomId,
      userId: token.sub,
      actorKind: token.actorKind,
      authzVersion: token.authzVersion,
    })
    if (currentVersion !== token.authzVersion) {
      throw new Error('Collab token authzVersion is stale')
    }

    const context: DohcHocuspocusContext = {
      userId: token.sub,
      workspaceId: doc.workspaceId,
      atomId: doc.atomId,
      actorKind: token.actorKind,
      authzVersion: token.authzVersion,
      tokenExpiresAt: token.exp,
    }

    const canRead = await acl.canReadAtom(accessInput(context))
    if (!canRead) {
      throw new Error('Missing read access for document')
    }

    return {
      context,
      canWrite: await acl.canWriteAtom(accessInput(context)),
    }
  }

  return {
    async onAuthenticate(data) {
      const { context, canWrite } = await authenticateDocumentToken(
        data.documentName,
        data.token,
      )
      if (!canWrite) {
        setConnectionReadOnly(data, true)
      }

      return context
    },

    async onTokenSync(data) {
      const previous = data.context
      const { context, canWrite } = await authenticateDocumentToken(
        data.documentName,
        data.token,
      )

      if (
        context.userId !== previous.userId ||
        context.workspaceId !== previous.workspaceId ||
        context.atomId !== previous.atomId ||
        context.actorKind !== previous.actorKind
      ) {
        throw new Error('Collab token identity changed for live connection')
      }

      setConnectionReadOnly(data, !canWrite)
      return context
    },

    async connected(data) {
      revocations?.registerConnection?.({
        workspaceId: data.context.workspaceId,
        userId: data.context.userId,
        connection: data.connection,
      })
    },

    async onLoadDocument(data) {
      const context = data.context
      if (!context) {
        throw new Error('Missing Hocuspocus context for document load')
      }
      assertTokenFresh(context)

      const canRead = await acl.canReadAtom(accessInput(context))
      if (!canRead) {
        throw new Error('Missing read access for document')
      }

      if (!(await store.hasDocumentState(data.documentName))) {
        const bootstrap = await acl.loadAtomBootstrap?.(accessInput(context))
        if (bootstrap?.markdown !== undefined) {
          const document = markdownToYDoc(bootstrap.markdown)
          const stored = await store.storeSnapshotIfMissing(data.documentName, document, {
            lastSeq: 0,
          })
          if (stored) {
            sequences.setLoadedSequence(data.documentName, 0)
            return document
          }
        }
      }

      const document = await store.loadDocument(data.documentName)
      sequences.setLoadedSequence(
        data.documentName,
        await store.latestSequence(data.documentName),
      )
      return document
    },

    async beforeHandleMessage() {},

    async beforeHandleAwareness(data) {
      const context = data.context
      if (!context) {
        throw new Error('Missing Hocuspocus context for awareness update')
      }
      assertTokenFresh(context)

      const input = accessInput(context)
      const canRead = await acl.canReadAtom(input)
      if (!canRead) {
        throw new Error('Missing read access for document')
      }

      const canWrite = await acl.canWriteAtom(input)
      if (!canWrite || data.connection?.readOnly) {
        data.states.clear()
        return
      }

      for (const [clientId, state] of data.states) {
        const clean = sanitizeAwarenessState(state)
        if (clean) data.states.set(clientId, clean)
        else data.states.delete(clientId)
      }
    },

    async beforeSync(data) {
      const context = data.context
      assertTokenFresh(context)
      const canRead = await acl.canReadAtom(accessInput(context))
      if (!canRead) {
        throw new Error('Missing read access for document')
      }

      if (!isPersistableSyncPayload(data.type)) return
      if (!data.payload.byteLength) return
      if (data.connection.readOnly) return

      const canWrite = await acl.canWriteAtom(accessInput(context))
      if (!canWrite) {
        throw new Error('Missing write access for document')
      }

      assertValidYjsUpdate(data.payload)
      const persisted = await store.appendUpdate({
        documentName: data.documentName,
        update: data.payload,
        actorId: context.userId,
        socketId: data.connection.socketId,
      })
      sequences.markPending(
        data.documentName,
        data.connection.socketId,
        persisted.seq,
      )
    },

    async onStoreDocument(data) {
      const lastSeq = sequences.latestContiguous(data.documentName)
      if (lastSeq === undefined) {
        logger.warn('skipping hocuspocus snapshot without applied sequence', {
          documentName: data.documentName,
        })
        return
      }

      return store.storeSnapshot(data.documentName, data.document, { lastSeq })
    },

    async onChange(data) {
      if (data.socketId) {
        sequences.markApplied(data.documentName, data.socketId)
      }
      const document = (data as { document?: Y.Doc }).document
      if (document) {
        projections.schedule({
          documentName: data.documentName,
          document,
          context: data.context,
          ydocSeq:
            sequences.latestContiguous(data.documentName) ??
            (await store.latestSequence(data.documentName)),
        })
      }
      logger.info('hocuspocus document changed', {
        documentName: data.documentName,
        updateBytes: data.update.byteLength,
        userId: data.context?.userId,
      })
    },

    async onAwarenessUpdate(data) {
      logger.info('hocuspocus awareness updated', {
        documentName: data.documentName,
        added: data.added.length,
        updated: data.updated.length,
        removed: data.removed.length,
      })
    },

    async onDisconnect(data) {
      revocations?.unregisterSocket?.(data.socketId)
    },
  } satisfies DohcHocuspocusHooks
}

export type DohcOnAuthenticatePayload = onAuthenticatePayload<DohcHocuspocusContext>
export type DohcConnectedPayload = connectedPayload<DohcHocuspocusContext>
export type DohcOnLoadDocumentPayload = onLoadDocumentPayload<DohcHocuspocusContext>
export type DohcOnTokenSyncPayload = onTokenSyncPayload<DohcHocuspocusContext>
export type DohcBeforeHandleMessagePayload =
  beforeHandleMessagePayload<DohcHocuspocusContext>
export type DohcBeforeHandleAwarenessPayload =
  beforeHandleAwarenessPayload<DohcHocuspocusContext>
export type DohcBeforeSyncPayload = beforeSyncPayload<DohcHocuspocusContext>
export type DohcOnStoreDocumentPayload = onStoreDocumentPayload<DohcHocuspocusContext>
export type DohcOnChangePayload = onChangePayload<DohcHocuspocusContext>
export type DohcOnAwarenessUpdatePayload =
  onAwarenessUpdatePayload<DohcHocuspocusContext>
export type DohcOnDisconnectPayload = onDisconnectPayload<DohcHocuspocusContext>
