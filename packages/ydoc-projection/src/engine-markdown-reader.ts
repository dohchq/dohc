import {digest} from 'lib0/hash/sha256'
import {updateYFragment, yXmlFragmentToProseMirrorRootNode} from 'y-prosemirror'
import * as Y from 'yjs'
import {readMarkdownSourceWitness} from './artifact-markdown.js'
import {sameFrontmatterValue, FRONTMATTER_SOURCE_META_KEY, MARKDOWN_CRLF_META_KEY} from './frontmatter.js'
import {recordFrontmatterSourceItems, writeFrontmatterMap} from './frontmatter-map.js'
import {getDohcProseMirrorSchema, getDohcYDocFrontmatter, markdownToYDoc, yDocToMarkdown} from './import-export.js'
import {createLiveMarkdownJournalValidator, type LiveMarkdownRegistrationInput} from './liveDocumentValidation.js'
import type {OrderedLiveUpdateCutPolicy} from './orderedLiveUpdateCut.js'

const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_UPDATE_BYTES = 20 * 1024 * 1024
const utf8 = new TextEncoder()
const sha = (bytes: Uint8Array) => Array.from(digest(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
const textSha = (text: string) => sha(utf8.encode(text))
const schema = getDohcProseMirrorSchema()
const root = (doc: Y.Doc) => yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('body'), schema)

/** source must be the engine's compared snapshot, never a value read from witness metadata. */
export interface EngineMarkdownInput extends LiveMarkdownRegistrationInput {readonly source: string}
type Reason = 'invalid-source' | 'invalid-update' | 'invalid-schema' | 'witness-mismatch'
  | 'reading-mismatch' | 'capacity-refused' | 'journal-refused'
type Refused = {readonly kind: 'refused'; readonly reason: Reason}
interface Proof {
  readonly kind: 'accepted'
  readonly canonical: string
  readonly sourceSha256: string
  readonly projectionSha256: string
  readonly stateSha256: string
  readonly stateVector: Uint8Array
}
export type EngineMarkdownProof = Proof | Refused
export type EngineMarkdownConstruction = (Proof & {readonly delta: Uint8Array}) | Refused
class Refusal extends Error {constructor(readonly reason: Reason) {super(reason)}}
function requireReading(condition: boolean, reason: Reason): asserts condition {
  if (!condition) throw new Refusal(reason)
}
function checkInput(input: EngineMarkdownInput): void {
  requireReading(typeof input.source === 'string' && input.source.isWellFormed()
    && input.source.length <= MAX_SOURCE_BYTES && utf8.encode(input.source).length <= MAX_SOURCE_BYTES, 'invalid-source')
  requireReading(input.checkpoint instanceof Uint8Array && input.checkpoint.length > 0
    && input.checkpoint.length <= MAX_UPDATE_BYTES, 'invalid-update')
}
function compareReadings(actual: Y.Doc, imported: Y.Doc): void {
  const actualRoot = root(actual), importedRoot = root(imported)
  actualRoot.check(); importedRoot.check()
  requireReading(actualRoot.eq(importedRoot)
    && sameFrontmatterValue(getDohcYDocFrontmatter(actual), getDohcYDocFrontmatter(imported)), 'reading-mismatch')
}
function refused(error: unknown): Refused {
  return {kind: 'refused', reason: error instanceof Refusal ? error.reason : 'invalid-schema'}
}

/** Pure construction/reading proofs. Snapshot authority and the 50 KB admission cap belong to the engine. */
export function createEngineMarkdownReader(policy: OrderedLiveUpdateCutPolicy) {
  const journal = createLiveMarkdownJournalValidator(policy)
  function validate(input: EngineMarkdownInput, delta: Uint8Array, doc: Y.Doc, canonical: string): Proof {
    requireReading(delta.length <= MAX_UPDATE_BYTES, 'capacity-refused')
    const result = journal({document: input.document, currentPath: input.currentPath,
      checkpoint: input.checkpoint, suffix: [], candidate: delta})
    requireReading(result.kind === 'accepted', 'journal-refused')
    const sourceSha256 = textSha(input.source)
    requireReading(result.evidence.projectedMarkdownSha256 === sourceSha256
      && result.evidence.projectedMarkdownByteLength === utf8.encode(input.source).length, 'witness-mismatch')
    return {kind: 'accepted', canonical, sourceSha256, projectionSha256: textSha(canonical),
      stateSha256: result.evidence.stateUpdateSha256, stateVector: Y.encodeStateVector(doc)}
  }
  return {
    construct(input: EngineMarkdownInput): EngineMarkdownConstruction {
      let doc: Y.Doc | undefined, imported: Y.Doc | undefined
      try {
        checkInput(input)
        doc = new Y.Doc({gc: false})
        Y.applyUpdate(doc, input.checkpoint)
        const before = Y.encodeStateVector(doc)
        imported = markdownToYDoc(input.source)
        const target = root(imported)
        target.check()
        const beforeRoot = root(doc), fragment = doc.getXmlFragment('body')
        // Reuse equal prefix/suffix blocks, as document-edit does outside its changed range.
        const mapping = new Map<Y.XmlElement, typeof target>()
        const elements = fragment.toArray()
        let prefix = 0, suffix = 0
        while (prefix < Math.min(beforeRoot.childCount, target.childCount)
          && beforeRoot.child(prefix).eq(target.child(prefix))) {
          mapping.set(elements[prefix] as Y.XmlElement, target.child(prefix)); prefix++
        }
        while (suffix < Math.min(beforeRoot.childCount, target.childCount) - prefix
          && beforeRoot.child(beforeRoot.childCount - suffix - 1).eq(target.child(target.childCount - suffix - 1))) {
          mapping.set(elements[elements.length - suffix - 1] as Y.XmlElement, target.child(target.childCount - suffix - 1)); suffix++
        }
        const sourceValues = getDohcYDocFrontmatter(imported), oldValues = getDohcYDocFrontmatter(doc)
        const meta = doc.getMap('meta'), sourceMeta = imported.getMap('meta'), frontmatter = doc.getMap('frontmatter')
        const canonical = yDocToMarkdown(imported)
        doc.transact(() => {
          updateYFragment(doc!, fragment, target, {mapping, isOMark: new Map()})
          for (const key of frontmatter.keys()) if (!Object.hasOwn(sourceValues, key)) frontmatter.delete(key)
          writeFrontmatterMap(frontmatter, Object.fromEntries(Object.entries(sourceValues)
            .filter(([key, value]) => !Object.hasOwn(oldValues, key) || !sameFrontmatterValue(value, oldValues[key]))))
          meta.set('schemaVersion', 1)
          for (const key of [FRONTMATTER_SOURCE_META_KEY, MARKDOWN_CRLF_META_KEY]) {
            if (sourceMeta.has(key)) meta.set(key, sourceMeta.get(key))
            else meta.delete(key)
          }
          recordFrontmatterSourceItems(frontmatter, meta)
          meta.set('dohcMarkdownSource', input.source)
          meta.set('dohcMarkdownSourceSha256', textSha(input.source))
          meta.set('dohcMarkdownSourceProjectionSha256', textSha(canonical))
        })
        compareReadings(doc, imported)
        requireReading(yDocToMarkdown(doc) === canonical, 'reading-mismatch')
        const delta = Y.encodeStateAsUpdate(doc, before)
        return {...validate(input, delta, doc, canonical), delta}
      } catch (error) {return refused(error)}
      finally {doc?.destroy(); imported?.destroy()}
    },
    prove(input: EngineMarkdownInput): EngineMarkdownProof {
      let doc: Y.Doc | undefined, imported: Y.Doc | undefined
      try {
        checkInput(input)
        doc = new Y.Doc({gc: false}); Y.applyUpdate(doc, input.checkpoint)
        const witness = readMarkdownSourceWitness(Object.fromEntries(doc.getMap('meta').entries()))
        requireReading(witness !== 'absent' && witness !== 'invalid', 'witness-mismatch')
        const canonical = yDocToMarkdown(doc)
        requireReading(witness.source === input.source
          && witness.projectionSha === textSha(canonical), 'witness-mismatch')
        imported = markdownToYDoc(input.source)
        compareReadings(doc, imported)
        requireReading(yDocToMarkdown(imported) === canonical, 'reading-mismatch')
        // A no-op candidate gives existing state the journal's strict, non-dropping check.
        return validate(input, new Uint8Array([0, 0]), doc, canonical)
      } catch (error) {return refused(error)}
      finally {doc?.destroy(); imported?.destroy()}
    },
  }
}
