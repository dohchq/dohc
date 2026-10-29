import {digest} from 'lib0/hash/sha256'
import {updateYFragment, yXmlFragmentToProseMirrorRootNode} from 'y-prosemirror'
import * as Y from 'yjs'
import {readMarkdownSourceWitness} from './artifact-markdown.js'
import {sameFrontmatterValue, FRONTMATTER_SOURCE_META_KEY, MARKDOWN_CRLF_META_KEY} from './frontmatter.js'
import {recordFrontmatterSourceItems, writeFrontmatterMap} from './frontmatter-map.js'
import {DOHC_SCHEMA_VERSION, getDohcProseMirrorSchema, getDohcYDocFrontmatter, markdownToYDoc, MarkdownNestingRefusal, yDocToMarkdown} from './import-export.js'
import {createLiveMarkdownJournalValidator, isProseMirrorSchemaError, type LiveMarkdownRegistrationInput} from './liveDocumentValidation.js'
import type {OrderedLiveUpdateCutPolicy} from './orderedLiveUpdateCut.js'

const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_UPDATE_BYTES = 20 * 1024 * 1024
const utf8 = new TextEncoder()
const sha = (bytes: Uint8Array) => Array.from(digest(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
const textSha = (text: string) => sha(utf8.encode(text))
const schema = getDohcProseMirrorSchema()
const root = (doc: Y.Doc) => yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('body'), schema)
function checkRoot(node: ReturnType<typeof root>): void {
  try {if (node.childCount > 0) node.check()}
  catch (error) {
    if (!isProseMirrorSchemaError(error)) throw error
    throw new Refusal('invalid-schema')
  }
}

/** source must be the engine's compared snapshot, never a value read from witness metadata. */
export interface EngineMarkdownInput extends LiveMarkdownRegistrationInput {
  readonly source: Uint8Array
  readonly nativeFold?: boolean
}
type Reason = 'invalid-source' | 'invalid-update' | 'invalid-schema' | 'witness-mismatch'
  | 'reading-mismatch' | 'capacity-refused' | 'journal-refused'
type Refused = {readonly kind: 'refused'; readonly reason: Reason}
interface Proof {
  readonly canonical: string
  readonly sourceSha256: string
  readonly sourceByteLength: number
  readonly projectionSha256: string
  readonly stateSha256: string
  readonly stateVector: Uint8Array
}
export type EngineMarkdownProof = (Proof & {readonly kind: 'accepted' | 'expired'}) | Refused
export type EngineMarkdownConstruction = (Proof & {readonly kind: 'accepted'; readonly delta: Uint8Array}) | Refused
class Refusal extends Error {constructor(readonly reason: Reason) {super(reason)}}
function requireReading(condition: boolean, reason: Reason): asserts condition {
  if (!condition) throw new Refusal(reason)
}
function checkInput(input: EngineMarkdownInput): {source: string; input: EngineMarkdownInput} {
  const raw = input.source
  requireReading(raw instanceof Uint8Array, 'invalid-source')
  const bytes = new Uint8Array(raw)
  requireReading(bytes.length <= MAX_SOURCE_BYTES, 'invalid-source')
  let source: string
  try {source = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes)}
  catch (error) {
    if (!(error instanceof TypeError)) throw error
    throw new Refusal('invalid-source')
  }
  const rawCheckpoint = input.checkpoint
  requireReading(rawCheckpoint instanceof Uint8Array, 'invalid-update')
  const checkpoint = new Uint8Array(rawCheckpoint)
  requireReading(checkpoint.length > 0 && checkpoint.length <= MAX_UPDATE_BYTES, 'invalid-update')
  return {source, input: {source: bytes, checkpoint, document: input.document, currentPath: input.currentPath,
    nativeFold: input.nativeFold}}
}
// ProseMirror drops hidden Yjs state; this comparison is sound only with the strict journal check afterward.
function compareReadings(actual: Y.Doc, imported: Y.Doc): void {
  const actualRoot = root(actual), importedRoot = root(imported)
  checkRoot(actualRoot); checkRoot(importedRoot)
  requireReading(actualRoot.eq(importedRoot)
    && sameFrontmatterValue(getDohcYDocFrontmatter(actual), getDohcYDocFrontmatter(imported)), 'reading-mismatch')
}
function refused(error: unknown): Refused {
  // A source nested past the live document contract's limits has no reading.
  if (error instanceof MarkdownNestingRefusal) return {kind: 'refused', reason: 'invalid-schema'}
  if (!(error instanceof Refusal)) throw error
  return {kind: 'refused', reason: error.reason}
}
function setIfChanged(meta: Y.Map<unknown>, key: string, value: unknown): void {
  if (meta.get(key) !== value) meta.set(key, value)
}

/** Construction requires version-1 checkpoints. Snapshot authority and the 50 KB admission cap belong to the engine. */
export function createEngineMarkdownReader(policy: OrderedLiveUpdateCutPolicy) {
  const journal = createLiveMarkdownJournalValidator(policy, true)
  function validate(input: EngineMarkdownInput, delta: Uint8Array, doc: Y.Doc, canonical: string,
    expired = false): Proof & {readonly kind: 'accepted'} {
    requireReading(delta.length <= MAX_UPDATE_BYTES, 'capacity-refused')
    const result = journal({document: input.document, currentPath: input.currentPath,
      checkpoint: input.checkpoint, suffix: [], candidate: delta})
    requireReading(result.kind === 'accepted', 'journal-refused')
    const sourceSha256 = sha(input.source)
    const expected = expired ? utf8.encode(canonical) : input.source
    requireReading(result.evidence.projectedMarkdownSha256 === sha(expected)
      && result.evidence.projectedMarkdownByteLength === expected.length, 'witness-mismatch')
    return {kind: 'accepted', canonical, sourceSha256, sourceByteLength: input.source.length, projectionSha256: textSha(canonical),
      stateSha256: result.evidence.stateUpdateSha256, stateVector: Y.encodeStateVector(doc)}
  }
  return {
    construct(input: EngineMarkdownInput): EngineMarkdownConstruction {
      let doc: Y.Doc | undefined, imported: Y.Doc | undefined
      try {
        const checked = checkInput(input), source = checked.source
        input = checked.input
        doc = new Y.Doc({gc: false})
        Y.applyUpdate(doc, input.checkpoint)
        requireReading(doc.getMap('meta').get('schemaVersion') === DOHC_SCHEMA_VERSION, 'invalid-schema')
        const before = Y.encodeStateVector(doc)
        const updates: Uint8Array[] = []
        doc.on('update', (update: Uint8Array) => updates.push(update))
        imported = markdownToYDoc(source)
        const target = root(imported)
        checkRoot(target)
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
        const native = input.nativeFold === true
        if (native) requireReading(!meta.has('dohcMarkdownSourceReader') && source === canonical, 'reading-mismatch')
        doc.transact(() => {
          updateYFragment(doc!, fragment, target, {mapping, isOMark: new Map()})
          for (const key of frontmatter.keys()) if (!Object.hasOwn(sourceValues, key)) frontmatter.delete(key)
          writeFrontmatterMap(frontmatter, Object.fromEntries(Object.entries(sourceValues)
            .filter(([key, value]) => !Object.hasOwn(oldValues, key) || !sameFrontmatterValue(value, oldValues[key]))))
          for (const key of [FRONTMATTER_SOURCE_META_KEY, MARKDOWN_CRLF_META_KEY]) {
            if (sourceMeta.has(key)) setIfChanged(meta, key, sourceMeta.get(key))
            else meta.delete(key)
          }
          recordFrontmatterSourceItems(frontmatter, meta)
          if (native) {
            for (const key of ['dohcMarkdownSource', 'dohcMarkdownSourceSha256',
              'dohcMarkdownSourceProjectionSha256', 'dohcMarkdownSourceReader']) meta.delete(key)
          } else {
            setIfChanged(meta, 'dohcMarkdownSource', source)
            setIfChanged(meta, 'dohcMarkdownSourceSha256', sha(input.source))
            setIfChanged(meta, 'dohcMarkdownSourceProjectionSha256', textSha(canonical))
            setIfChanged(meta, 'dohcMarkdownSourceReader', 1)
          }
        })
        compareReadings(doc, imported)
        // Full-state encoding repeats historical deletes even for a no-op; keep only this construction's updates.
        const delta = Y.diffUpdate(Y.mergeUpdates(updates), before)
        return {...validate(input, delta, doc, canonical), delta}
      } catch (error) {return refused(error)}
      finally {doc?.destroy(); imported?.destroy()}
    },
    prove(input: EngineMarkdownInput): EngineMarkdownProof {
      let doc: Y.Doc | undefined, imported: Y.Doc | undefined, earlier: Y.Doc | undefined
      try {
        const checked = checkInput(input), source = checked.source
        input = checked.input
        doc = new Y.Doc({gc: false}); Y.applyUpdate(doc, input.checkpoint)
        const witness = readMarkdownSourceWitness(Object.fromEntries(doc.getMap('meta').entries()))
        requireReading(witness !== 'absent' && witness !== 'invalid', 'witness-mismatch')
        const canonical = yDocToMarkdown(doc)
        imported = markdownToYDoc(source)
        if (doc.getMap('meta').get('dohcMarkdownSourceReader') === 1
          && (witness.source !== source || !root(doc).eq(root(imported)))) {
          // Expiry needs a valid old reading and a strict proof of the current state.
          requireReading(utf8.encode(witness.source).length <= MAX_SOURCE_BYTES, 'capacity-refused')
          earlier = witness.source === source ? undefined : markdownToYDoc(witness.source)
          requireReading(textSha(yDocToMarkdown(earlier ?? imported)) === witness.projectionSha, 'witness-mismatch')
          return {...validate(input, new Uint8Array([0, 0]), doc, canonical, true), kind: 'expired'}
        }
        requireReading(witness.source === source, 'witness-mismatch')
        compareReadings(doc, imported)
        // A no-op candidate gives existing state the journal's strict, non-dropping check.
        return validate(input, new Uint8Array([0, 0]), doc, canonical)
      } catch (error) {return refused(error)}
      finally {doc?.destroy(); imported?.destroy(); earlier?.destroy()}
    },
  }
}
