import {digest} from 'lib0/hash/sha256'
import * as Y from 'yjs'
import {yDocToArtifactMarkdown} from './artifact-markdown.js'
import {markdownToYDoc, yDocToMarkdown} from './import-export.js'

const SEED_CLIENT_DOMAIN = 'dohc:ydoc-seed-client:v1'
const utf8 = new TextEncoder()
const hash = (text: string) => Array.from(digest(utf8.encode(text)), byte => byte.toString(16).padStart(2, '0')).join('')

export interface SeedClientIdInput {
  readonly workspaceId: string
  readonly versionId: string
  readonly objectId: string
  readonly contentKind: 'plaintext' | 'richdoc' | 'scene'
  readonly headMomentId: string
  readonly headBlobSha256: string
}

/**
 * `dohc_engine_collab::seed_client_id`: every writer that seeds one head moment
 * seeds it under the same Yjs client, so their seeds are the same lineage.
 */
export function seedClientId(input: SeedClientIdInput): number {
  const fields = [input.workspaceId, input.versionId, input.objectId, input.contentKind, input.headMomentId, input.headBlobSha256]
    .map(field => utf8.encode(field))
  const domain = utf8.encode(SEED_CLIENT_DOMAIN)
  const preimage = new Uint8Array(fields.reduce((length, field) => length + 8 + field.length, domain.length))
  const view = new DataView(preimage.buffer)
  preimage.set(domain)
  let offset = domain.length
  for (const field of fields) {
    view.setBigUint64(offset, BigInt(field.length))
    preimage.set(field, offset + 8)
    offset += 8 + field.length
  }
  return seedClientIdFromDigest(digest(preimage))
}

/** The first four digest bytes as a nonzero Yjs client. */
export function seedClientIdFromDigest(sha256: Uint8Array): number {
  return Math.max(1, new DataView(sha256.buffer, sha256.byteOffset, 4).getUint32(0))
}

/**
 * The first Y.Doc base for captured Markdown. When the projection does not
 * reproduce the file, the base carries the file as its source witness, so the
 * engine settles the same bytes the file held.
 */
export function encodeRichdocSeed(markdown: string, clientID: number): Uint8Array {
  const doc = markdownToYDoc(markdown, {clientID})
  try {
    let projection: string | undefined
    try {
      projection = yDocToMarkdown(doc)
    } catch {
      // The serializer rejects some accepted imports. They can still open,
      // but cannot carry an exact-source witness yet.
    }
    if (projection !== undefined && projection !== markdown) {
      const meta = doc.getMap('meta')
      meta.set('dohcMarkdownSource', markdown)
      meta.set('dohcMarkdownSourceSha256', hash(markdown))
      meta.set('dohcMarkdownSourceProjectionSha256', hash(projection))
    }
    return Y.encodeStateAsUpdate(doc)
  } finally {
    doc.destroy()
  }
}

/**
 * The file a seed settles to. A witness for a spelling the engine may read
 * differently, such as an autolink, settles the projection instead.
 */
export function richdocSeedFile(update: Uint8Array): string {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, update)
    return yDocToArtifactMarkdown(doc)
  } finally {
    doc.destroy()
  }
}
