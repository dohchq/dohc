import type {
  Configuration,
  beforeHandleMessagePayload,
  beforeSyncPayload,
  connectedPayload,
  onAuthenticatePayload,
  onChangePayload,
  onDisconnectPayload,
  onLoadDocumentPayload,
  onStoreDocumentPayload,
} from '@hocuspocus/server'
import * as Y from 'yjs'
import { decodeDocName } from './doc-name.js'
import { verifyCollabToken, type CollabActorKind } from './auth.js'
import type { PostgresYDocStore } from './persistence.js'

export type DohcHocuspocusContext = {
  userId: string
  workspaceId: string
  atomId: string
  actorKind: CollabActorKind
  authzVersion: number
}

export type AtomAccessInput = {
  workspaceId: string
  atomId: string
  userId: string
  actorKind: CollabActorKind
  authzVersion: number
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
}

type DohcHocuspocusHooks = {
  onAuthenticate: NonNullable<
    Configuration<DohcHocuspocusContext>['onAuthenticate']
  >
  connected: NonNullable<Configuration<DohcHocuspocusContext>['connected']>
  onLoadDocument: NonNullable<
    Configuration<DohcHocuspocusContext>['onLoadDocument']
  >
  beforeHandleMessage: NonNullable<
    Configuration<DohcHocuspocusContext>['beforeHandleMessage']
  >
  beforeSync: NonNullable<Configuration<DohcHocuspocusContext>['beforeSync']>
  onStoreDocument: NonNullable<
    Configuration<DohcHocuspocusContext>['onStoreDocument']
  >
  onChange: NonNullable<Configuration<DohcHocuspocusContext>['onChange']>
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

function setReadOnly(data: onAuthenticatePayload<DohcHocuspocusContext>): void {
  const connection =
    data.connectionConfig ??
    (data as unknown as { connection?: { readOnly: boolean } }).connection
  if (!connection) {
    throw new Error('Missing Hocuspocus connection configuration')
  }
  connection.readOnly = true
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

export function createHocuspocusHooks({
  jwtSecret,
  acl,
  store,
  logger,
  revocations,
}: CreateHocuspocusHooksOptions): DohcHocuspocusHooks {
  const sequences = new AppliedSequenceTracker()

  return {
    async onAuthenticate(data) {
      const token = await verifyCollabToken(data.token, jwtSecret)
      const doc = decodeDocName(data.documentName)

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
      }

      const canRead = await acl.canReadAtom(accessInput(context))
      if (!canRead) {
        throw new Error('Missing read access for document')
      }

      const canWrite = await acl.canWriteAtom(accessInput(context))
      if (!canWrite) {
        setReadOnly(data)
      }

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

      const canRead = await acl.canReadAtom(accessInput(context))
      if (!canRead) {
        throw new Error('Missing read access for document')
      }

      const document = await store.loadDocument(data.documentName)
      sequences.setLoadedSequence(
        data.documentName,
        await store.latestSequence(data.documentName),
      )
      return document
    },

    async beforeHandleMessage() {},

    async beforeSync(data) {
      if (!isPersistableSyncPayload(data.type)) return
      if (!data.payload.byteLength) return
      if (data.connection.readOnly) return

      const context = data.context
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
      logger.info('hocuspocus document changed', {
        documentName: data.documentName,
        updateBytes: data.update.byteLength,
        userId: data.context?.userId,
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
export type DohcBeforeHandleMessagePayload =
  beforeHandleMessagePayload<DohcHocuspocusContext>
export type DohcBeforeSyncPayload = beforeSyncPayload<DohcHocuspocusContext>
export type DohcOnStoreDocumentPayload = onStoreDocumentPayload<DohcHocuspocusContext>
export type DohcOnChangePayload = onChangePayload<DohcHocuspocusContext>
export type DohcOnDisconnectPayload = onDisconnectPayload<DohcHocuspocusContext>
