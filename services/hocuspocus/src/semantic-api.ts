import * as Y from 'yjs'
import { encodeDocName } from './doc-name.js'
import type { CollabActorKind } from './auth.js'
import type { HocuspocusAcl, HocuspocusLogger } from './hooks.js'
import { markdownToYDoc } from './import-export.js'
import type { PostgresYDocStore } from './persistence.js'
import {
  applyAnchoredReplacement,
  applyInsertAfterHeading,
  createAnchorsForText,
} from './suggestions.js'

export type SemanticApiHandlerOptions = {
  adminToken: string
  acl: HocuspocusAcl
  store: PostgresYDocStore
  logger: HocuspocusLogger
  getLiveDocument?: (documentName: string) => Y.Doc | null | undefined
}

type ReplaceRangePayload = {
  operation: 'replaceRange'
  operationId: string
  workspaceId: string
  atomId: string
  actor: {
    userId: string
    actorKind: CollabActorKind
    authzVersion: number
  }
  anchorStart: string
  anchorEnd: string
  replacement: string
  expectedText?: string
  expectedPrefix?: string
  expectedSuffix?: string
}

type InsertTextPayload = {
  operation: 'insertText'
  operationId: string
  workspaceId: string
  atomId: string
  actor: {
    userId: string
    actorKind: CollabActorKind
    authzVersion: number
  }
  anchor: string
  text: string
}

type InsertAfterHeadingPayload = {
  operation: 'insertAfterHeading'
  operationId: string
  workspaceId: string
  atomId: string
  actor: {
    userId: string
    actorKind: CollabActorKind
    authzVersion: number
  }
  headingText: string
  content: string
}

type CreateAnchorsForTextPayload = {
  operation: 'createAnchorsForText'
  workspaceId: string
  atomId: string
  actor: {
    userId: string
    actorKind: CollabActorKind
    authzVersion: number
  }
  expectedText: string
}

type CreateAtomPayload = {
  operation: 'createAtom'
  operationId: string
  workspaceId: string
  path: string
  content: string
  actor: {
    userId: string
    actorKind: CollabActorKind
    authzVersion: number
  }
}

type SemanticPayload =
  | ReplaceRangePayload
  | InsertTextPayload
  | InsertAfterHeadingPayload

type SemanticRequestPayload =
  | SemanticPayload
  | CreateAnchorsForTextPayload
  | CreateAtomPayload

const ACTOR_KINDS = new Set<CollabActorKind>(['user', 'agent'])

export function createSemanticApiHandler({
  adminToken,
  acl,
  store,
  logger,
  getLiveDocument,
}: SemanticApiHandlerOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/apply/')) {
      return jsonResponse({ ok: false, error: 'not found' }, 404)
    }
    if (request.headers.get('authorization') !== `Bearer ${adminToken}`) {
      return jsonResponse({ ok: false, error: 'unauthorized' }, 401)
    }
    if (request.method === 'GET' && url.pathname === '/apply/preflight') {
      return jsonResponse({
        ok: true,
        service: 'dohc-hocuspocus',
        semanticWrites: true,
      })
    }
    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'not found' }, 404)
    }

    const body = await readJsonObject(request)
    const payload = parseSemanticPayload(url.pathname, body)
    if (!payload) {
      return jsonResponse({ ok: false, error: 'invalid request' }, 400)
    }

    if (payload.operation === 'createAtom') {
      return handleCreateAtom({
        payload,
        acl,
        store,
        logger,
        getLiveDocument,
      })
    }

    const accessInput = {
      workspaceId: payload.workspaceId,
      atomId: payload.atomId,
      userId: payload.actor.userId,
      actorKind: payload.actor.actorKind,
      authzVersion: payload.actor.authzVersion,
    }
    if (!(await acl.canWriteAtom(accessInput))) {
      return jsonResponse({ ok: false, error: 'forbidden' }, 403)
    }

    const documentName = encodeDocName({
      workspaceId: payload.workspaceId,
      atomId: payload.atomId,
    })
    const operationKey =
      'operationId' in payload
        ? semanticOperationKey(documentName, payload.operationId)
        : null
    if (operationKey) {
      const existing = await store.getSemanticOperation(operationKey)
      if (existing) {
        return jsonResponse({
          ...(existing.response as Record<string, unknown>),
          deduped: true,
        })
      }
    }
    const auditBase = {
      operation: payload.operation,
      workspaceId: payload.workspaceId,
      atomId: payload.atomId,
      documentName,
      actorId: payload.actor.userId,
      actorKind: payload.actor.actorKind,
      authzVersion: payload.actor.authzVersion,
      anchorSummary: anchorSummaryForPayload(payload),
    }
    const liveDocument = getUsableLiveDocument(
      getLiveDocument?.(documentName) ?? null,
    )
    const doc = liveDocument
      ? cloneYDoc(liveDocument)
      : await store.loadDocument(documentName)
    if (payload.operation === 'createAnchorsForText') {
      const anchors = createAnchorsForText(doc, payload.expectedText)
      if (!anchors) {
        return jsonResponse(
          {
            ok: false,
            operation: payload.operation,
            workspaceId: payload.workspaceId,
            atomId: payload.atomId,
            documentName,
            actorId: payload.actor.userId,
            actorKind: payload.actor.actorKind,
            reason: 'anchor-text-not-found',
          },
          409,
        )
      }
      return jsonResponse({
        ok: true,
        atomId: payload.atomId,
        ...anchors,
      })
    }
    const beforeStateVector = Y.encodeStateVector(liveDocument ?? doc)
    const result = applySemanticEdit(doc, payload)
    if (!result.ok) {
      const response = {
        ok: false,
        ...auditBase,
        operationId: payload.operationId,
        reason: result.reason,
        actualText: 'actualText' in result ? result.actualText : undefined,
        attemptedAt: new Date().toISOString(),
      }
      return jsonResponse(response, 409)
    }

    const update = Y.encodeStateAsUpdate(doc, beforeStateVector)
    const response = {
      ok: true,
      ...auditBase,
      operationId: payload.operationId,
      updateBytes: update.byteLength,
      appliedAt: new Date().toISOString(),
    }
    if (update.byteLength > 0) {
      const persisted = await store.appendUpdateAndRecordSemanticOperation({
        documentName,
        update,
        actorId: payload.actor.userId,
        socketId: null,
        operationId: operationKey ?? payload.operationId,
        response,
      })
      if (persisted.deduped) {
        return jsonResponse({
          ...(persisted.operation.response as Record<string, unknown>),
          deduped: true,
        })
      }
      if (liveDocument) {
        Y.applyUpdate(liveDocument, update, {
          source: 'local',
          skipStoreHooks: true,
          context: accessInput,
        })
      }
    } else {
      await store.recordSemanticOperation(
        operationKey ?? payload.operationId,
        response,
      )
    }
    logger.info('semantic operation applied', {
      operationId: payload.operationId,
      operation: payload.operation,
      documentName,
      updateBytes: update.byteLength,
    })
    return jsonResponse(response)
  }
}

async function handleCreateAtom({
  payload,
  acl,
  store,
  logger,
  getLiveDocument,
}: {
  payload: CreateAtomPayload
  acl: HocuspocusAcl
  store: PostgresYDocStore
  logger: HocuspocusLogger
  getLiveDocument?: (documentName: string) => Y.Doc | null | undefined
}): Promise<Response> {
  const operationScope = `create:${payload.workspaceId}:${payload.path}`
  const operationKey = semanticOperationKey(operationScope, payload.operationId)
  const existing = await store.getSemanticOperation(operationKey)
  if (existing) {
    return jsonResponse({
      ...(existing.response as Record<string, unknown>),
      deduped: true,
    })
  }

  if (!acl.createAtom) {
    return jsonResponse({ ok: false, error: 'createAtom unavailable' }, 503)
  }

  const created = await acl.createAtom({
    workspaceId: payload.workspaceId,
    path: payload.path,
    content: payload.content,
    userId: payload.actor.userId,
    actorKind: payload.actor.actorKind,
    authzVersion: payload.actor.authzVersion,
  })
  if (!created.ok) {
    const status =
      created.reason === 'forbidden'
        ? 403
        : created.reason === 'already-exists'
          ? 409
          : 400
    return jsonResponse(
      {
        ok: false,
        operation: payload.operation,
        workspaceId: payload.workspaceId,
        path: payload.path,
        actorId: payload.actor.userId,
        actorKind: payload.actor.actorKind,
        reason: created.reason,
        attemptedAt: new Date().toISOString(),
      },
      status,
    )
  }

  const documentName = encodeDocName({
    workspaceId: payload.workspaceId,
    atomId: created.atomId,
  })
  const doc = markdownToYDoc(created.markdown)
  await store.storeSnapshotIfMissing(documentName, doc, { lastSeq: 0 })
  const update = Y.encodeStateAsUpdate(doc)
  const liveDocument = getUsableLiveDocument(
    getLiveDocument?.(documentName) ?? null,
  )
  if (liveDocument) {
    Y.applyUpdate(liveDocument, update, {
      source: 'local',
      skipStoreHooks: true,
      context: {
        workspaceId: payload.workspaceId,
        atomId: created.atomId,
        userId: payload.actor.userId,
        actorKind: payload.actor.actorKind,
        authzVersion: payload.actor.authzVersion,
      },
    })
  }

  const response = {
    ok: true,
    operation: payload.operation,
    workspaceId: payload.workspaceId,
    atomId: created.atomId,
    path: payload.path,
    documentName,
    actorId: payload.actor.userId,
    actorKind: payload.actor.actorKind,
    authzVersion: payload.actor.authzVersion,
    operationId: payload.operationId,
    anchorSummary: {
      path: payload.path,
      contentBytes: payload.content.length,
    },
    updateBytes: update.byteLength,
    appliedAt: new Date().toISOString(),
  }
  await store.recordSemanticOperation(operationKey, response)
  logger.info('semantic createAtom applied', {
    operationId: payload.operationId,
    documentName,
    path: payload.path,
    updateBytes: update.byteLength,
  })
  return jsonResponse(response)
}

function applySemanticEdit(
  doc: Y.Doc,
  payload: SemanticPayload,
):
  | ReturnType<typeof applyAnchoredReplacement>
  | ReturnType<typeof applyInsertAfterHeading> {
  if (payload.operation === 'replaceRange') {
    return applyAnchoredReplacement(doc, payload)
  }
  if (payload.operation === 'insertText') {
    return applyAnchoredReplacement(doc, {
      anchorStart: payload.anchor,
      anchorEnd: payload.anchor,
      replacement: payload.text,
    })
  }
  return applyInsertAfterHeading(doc, payload)
}

export function semanticOperationKey(
  scope: string,
  operationId: string,
): string {
  return `${encodeURIComponent(scope)}::${encodeURIComponent(operationId)}`
}

function anchorSummaryForPayload(
  payload: SemanticRequestPayload,
): Record<string, unknown> {
  if (payload.operation === 'replaceRange') {
    return {
      anchorStartBytes: payload.anchorStart.length,
      anchorEndBytes: payload.anchorEnd.length,
      expectedTextBytes: payload.expectedText?.length ?? 0,
      expectedPrefixBytes: payload.expectedPrefix?.length ?? 0,
      expectedSuffixBytes: payload.expectedSuffix?.length ?? 0,
      replacementBytes: payload.replacement.length,
    }
  }
  if (payload.operation === 'insertText') {
    return {
      anchorBytes: payload.anchor.length,
      textBytes: payload.text.length,
    }
  }
  if (payload.operation === 'insertAfterHeading') {
    return {
      headingText: payload.headingText,
      contentBytes: payload.content.length,
    }
  }
  if (payload.operation === 'createAtom') {
    return {
      path: payload.path,
      contentBytes: payload.content.length,
    }
  }
  return {
    expectedTextBytes: payload.expectedText.length,
  }
}

function getUsableLiveDocument(doc: Y.Doc | null): Y.Doc | null {
  if (!doc) return null
  if ((doc as { isDestroyed?: boolean }).isDestroyed === true) return null
  return doc
}

function cloneYDoc(doc: Y.Doc): Y.Doc {
  const clone = new Y.Doc()
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc))
  return clone
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json()
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return null
    }
    return body as Record<string, unknown>
  } catch {
    return null
  }
}

function parseSemanticPayload(
  pathname: string,
  body: Record<string, unknown> | null,
): SemanticRequestPayload | null {
  if (pathname === '/apply/replaceRange') return parseReplaceRangePayload(body)
  if (pathname === '/apply/insertText') return parseInsertTextPayload(body)
  if (pathname === '/apply/insertAfterHeading') {
    return parseInsertAfterHeadingPayload(body)
  }
  if (pathname === '/apply/createAnchorsForText') {
    return parseCreateAnchorsForTextPayload(body)
  }
  if (pathname === '/apply/createAtom') return parseCreateAtomPayload(body)
  return null
}

function parseReplaceRangePayload(
  body: Record<string, unknown> | null,
): ReplaceRangePayload | null {
  if (!body) return null
  if (
    typeof body.operationId !== 'string' ||
    typeof body.workspaceId !== 'string' ||
    typeof body.atomId !== 'string' ||
    typeof body.anchorStart !== 'string' ||
    typeof body.anchorEnd !== 'string' ||
    typeof body.replacement !== 'string'
  ) {
    return null
  }
  if (
    typeof body.actor !== 'object' ||
    body.actor === null ||
    Array.isArray(body.actor)
  ) {
    return null
  }
  const actor = body.actor as Record<string, unknown>
  if (
    typeof actor.userId !== 'string' ||
    typeof actor.actorKind !== 'string' ||
    !ACTOR_KINDS.has(actor.actorKind as CollabActorKind) ||
    typeof actor.authzVersion !== 'number'
  ) {
    return null
  }

  return {
    operation: 'replaceRange',
    operationId: body.operationId,
    workspaceId: body.workspaceId,
    atomId: body.atomId,
    actor: {
      userId: actor.userId,
      actorKind: actor.actorKind as CollabActorKind,
      authzVersion: actor.authzVersion,
    },
    anchorStart: body.anchorStart,
    anchorEnd: body.anchorEnd,
    replacement: body.replacement,
    expectedText:
      typeof body.expectedText === 'string' ? body.expectedText : undefined,
    expectedPrefix:
      typeof body.expectedPrefix === 'string' ? body.expectedPrefix : undefined,
    expectedSuffix:
      typeof body.expectedSuffix === 'string' ? body.expectedSuffix : undefined,
  }
}

function parseInsertTextPayload(
  body: Record<string, unknown> | null,
): InsertTextPayload | null {
  if (!body) return null
  const actor = parseActor(body.actor)
  if (
    !actor ||
    typeof body.operationId !== 'string' ||
    typeof body.workspaceId !== 'string' ||
    typeof body.atomId !== 'string' ||
    typeof body.anchor !== 'string' ||
    typeof body.text !== 'string'
  ) {
    return null
  }
  return {
    operation: 'insertText',
    operationId: body.operationId,
    workspaceId: body.workspaceId,
    atomId: body.atomId,
    actor,
    anchor: body.anchor,
    text: body.text,
  }
}

function parseInsertAfterHeadingPayload(
  body: Record<string, unknown> | null,
): InsertAfterHeadingPayload | null {
  if (!body) return null
  const actor = parseActor(body.actor)
  if (
    !actor ||
    typeof body.operationId !== 'string' ||
    typeof body.workspaceId !== 'string' ||
    typeof body.atomId !== 'string' ||
    typeof body.headingText !== 'string' ||
    typeof body.content !== 'string'
  ) {
    return null
  }
  return {
    operation: 'insertAfterHeading',
    operationId: body.operationId,
    workspaceId: body.workspaceId,
    atomId: body.atomId,
    actor,
    headingText: body.headingText,
    content: body.content,
  }
}

function parseCreateAnchorsForTextPayload(
  body: Record<string, unknown> | null,
): CreateAnchorsForTextPayload | null {
  if (!body) return null
  const actor = parseActor(body.actor)
  if (
    !actor ||
    typeof body.workspaceId !== 'string' ||
    typeof body.atomId !== 'string' ||
    typeof body.expectedText !== 'string'
  ) {
    return null
  }
  return {
    operation: 'createAnchorsForText',
    workspaceId: body.workspaceId,
    atomId: body.atomId,
    actor,
    expectedText: body.expectedText,
  }
}

function parseCreateAtomPayload(
  body: Record<string, unknown> | null,
): CreateAtomPayload | null {
  if (!body) return null
  const actor = parseActor(body.actor)
  if (
    !actor ||
    typeof body.operationId !== 'string' ||
    typeof body.workspaceId !== 'string' ||
    typeof body.path !== 'string' ||
    typeof body.content !== 'string'
  ) {
    return null
  }
  return {
    operation: 'createAtom',
    operationId: body.operationId,
    workspaceId: body.workspaceId,
    path: body.path,
    content: body.content,
    actor,
  }
}

function parseActor(actor: unknown): SemanticRequestPayload['actor'] | null {
  if (typeof actor !== 'object' || actor === null || Array.isArray(actor)) {
    return null
  }
  const record = actor as Record<string, unknown>
  if (
    typeof record.userId !== 'string' ||
    typeof record.actorKind !== 'string' ||
    !ACTOR_KINDS.has(record.actorKind as CollabActorKind) ||
    typeof record.authzVersion !== 'number'
  ) {
    return null
  }
  return {
    userId: record.userId,
    actorKind: record.actorKind as CollabActorKind,
    authzVersion: record.authzVersion,
  }
}
