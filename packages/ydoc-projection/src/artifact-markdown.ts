import {exceedsLiveMarkdownLimit, exceedsUtf8Bytes} from '@dohc/live-session-contract'
import {digest} from 'lib0/hash/sha256'
import type * as Y from 'yjs'
import {markdownToYDoc, yDocToMarkdown} from './import-export.js'
import {canPreserveMarkdownSource} from './artifact-markdown-guard.js'

export const SOURCE_META_KEYS = ['dohcMarkdownSource', 'dohcMarkdownSourceSha256', 'dohcMarkdownSourceProjectionSha256'] as const
const utf8 = new TextEncoder()
const hash = (text: string) => Array.from(digest(utf8.encode(text)), byte => byte.toString(16).padStart(2, '0')).join('')
type Witness = {source: string; sourceSha: string; projectionSha: string}

/** Validate retained metadata independently of whether its projection is current. */
export function readMarkdownSourceWitness(metadata: Record<string, unknown>): Witness | 'absent' | 'invalid' {
  const fields = SOURCE_META_KEYS.filter(key => Object.hasOwn(metadata, key)).length
  if (fields === 0) return 'absent'
  const [source, sourceSha, projectionSha] = SOURCE_META_KEYS.map(key => metadata[key])
  if (fields !== 3 || typeof source !== 'string'
    || typeof sourceSha !== 'string' || !/^[0-9a-f]{64}$/.test(sourceSha)
    || typeof projectionSha !== 'string' || !/^[0-9a-f]{64}$/.test(projectionSha)
    || exceedsUtf8Bytes(source, 10 * 1024 * 1024) || hash(source) !== sourceSha) return 'invalid'
  return {source, sourceSha, projectionSha}
}

type Resolution = {kind: 'verified'; markdown: string}
  | {kind: 'absent' | 'invalid' | 'stale' | 'capacity-refused' | 'unverified' | 'import-failed'}
type Cache = {tuple: unknown[]; canonicalSha: string; result: Resolution}
const resolved = new WeakMap<Y.Doc, Cache>()

/** The journal decides whether an unverified active witness must refuse or drop. */
export function resolveMarkdownSource(doc: Y.Doc, canonical: string, validatedWitness?: ReturnType<typeof readMarkdownSourceWitness>, fatalUnexpectedErrors = false): Resolution {
  const meta = doc.getMap('meta')
  if (!SOURCE_META_KEYS.some(key => meta.has(key))) return {kind: 'absent'}
  const tuple = SOURCE_META_KEYS.map(key => meta.get(key))
  const canonicalSha = hash(canonical)
  const cached = resolved.get(doc)
  if (cached?.canonicalSha === canonicalSha && tuple.every((value, index) => value === cached.tuple[index])) return cached.result
  let result: Resolution
  // Stale text is never imported. Journal metadata validation still checks its integrity.
  if (tuple[2] !== canonicalSha) result = {kind: 'stale'}
  else {
    const witness = validatedWitness ?? readMarkdownSourceWitness(Object.fromEntries(SOURCE_META_KEYS.filter(key => meta.has(key)).map(key => [key, meta.get(key)])))
    if (witness === 'absent' || witness === 'invalid') result = {kind: witness}
    else if (exceedsLiveMarkdownLimit(witness.source)) result = {kind: 'capacity-refused'}
    else {
      try {
        const imported = markdownToYDoc(witness.source)
        try {
          result = yDocToMarkdown(imported) === canonical
            ? {kind: 'verified', markdown: witness.source}
            : {kind: 'unverified'}
        } finally { imported.destroy() }
      } catch (error) { if (fatalUnexpectedErrors) throw error; result = {kind: 'import-failed'} }
    }
  }
  resolved.set(doc, {tuple, canonicalSha, result})
  return result
}

/** File text while a complete witness proves it; otherwise the current canonical output. */
export function yDocToArtifactMarkdown(doc: Y.Doc): string {
  return artifactMarkdown(doc)
}

/** Bounded content proofs for short-lived documents; no document or source is retained. */
export function createArtifactMarkdownProjector(): (doc: Y.Doc) => string {
  const proofs = new Map<string, true>()
  return doc => artifactMarkdown(doc, proofs)
}

function artifactMarkdown(doc: Y.Doc, proofs?: Map<string, true>): string {
  const canonical = yDocToMarkdown(doc)
  if (!SOURCE_META_KEYS.some(key => doc.getMap('meta').has(key))) return canonical
  const meta = doc.getMap('meta')
  const source = meta.get('dohcMarkdownSource')
  if (!canPreserveMarkdownSource(source)) return canonical
  if (!proofs) {
    const result = resolveMarkdownSource(doc, canonical)
    return result.kind === 'verified' ? result.markdown : canonical
  }
  const canonicalSha = hash(canonical)
  if (meta.get('dohcMarkdownSourceProjectionSha256') !== canonicalSha) return canonical
  const witness = readMarkdownSourceWitness(Object.fromEntries(SOURCE_META_KEYS.filter(key => meta.has(key)).map(key => [key, meta.get(key)])))
  if (witness === 'absent' || witness === 'invalid') return canonical
  const key = witness.sourceSha + canonicalSha
  if (proofs.has(key)) return witness.source
  const result = resolveMarkdownSource(doc, canonical, witness)
  if (result.kind === 'verified') {
    if (proofs.size === 8) proofs.delete(proofs.keys().next().value!)
    proofs.set(key, true)
  }
  return result.kind === 'verified' ? result.markdown : canonical
}
