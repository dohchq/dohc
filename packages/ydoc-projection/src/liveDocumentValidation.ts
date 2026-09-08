import {
  exceedsLiveMarkdownLimit,
  parseLiveDocumentKey,
  type LiveDocumentKey,
  type LiveUpdateStructRange,
} from '@dohc/live-session-contract'
import { liveDocumentKindForPath } from '@dohc/workspace-contracts/live-documents'
import { validateUserWritePath } from '@dohc/workspace-core/paths'
import { digest as sha256 } from 'lib0/hash/sha256'
import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from 'y-prosemirror'
import * as Y from 'yjs'
import {
  getDohcProseMirrorSchema,
  getDohcYDocFrontmatter,
  markdownToYDoc,
  yDocToMarkdown,
} from './import-export.js'
import {
  validateRegistrationCutForProjection,
  type OrderedLiveUpdateCutPolicy,
  type OrderedLiveUpdateCutFinalizeResult,
  type RegistrationTopology,
} from './orderedLiveUpdateCut.js'

const INPUT_FIELDS = ['document', 'currentPath', 'checkpoint'] as const
const DOCUMENT_FIELDS = ['workspaceId', 'mainVersionId', 'objectId', 'lineageClaimId'] as const
const POLICY_FIELDS = [
  'maxStructVisits',
  'maxValueNodeVisits',
  'maxDecodedPayloadByteVisits',
  'maxStructClientGroupVisits',
  'maxDeleteClientGroupVisits',
  'maxDeleteIntervalVisits',
  'maxIndexOperations',
] as const
const MAX_DEPTH = 128
const MAX_NODES = 262_144
const MIN_INT64 = -(1n << 63n)
const MAX_INT64 = (1n << 63n) - 1n
const SHARED_BIGINT_KEY = '$dohcBigInt'
const PUBLIC_ROOTS = new Set(['body', 'frontmatter', 'meta'])
const META_KEYS = new Set([
  'schemaVersion', 'dohcMarkdownCrlf',
  'dohcTaggedFrontmatterPrefix', 'dohcTaggedFrontmatterBaseline',
])
const ByteArray = Uint8Array
const typedArrayPrototype = Object.getPrototypeOf(ByteArray.prototype) as object
const byteTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!
const byteBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!
const byteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!
const bufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
const setBytes = ByteArray.prototype.set
const utf8 = new TextEncoder()

const LIVE_MARKDOWN_VALIDATION_REFUSALS = [
  'invalid-input', 'invalid-update', 'invalid-schema', 'projection-mutated', 'capacity-refused',
] as const
export type LiveMarkdownValidationRefusal = (typeof LIVE_MARKDOWN_VALIDATION_REFUSALS)[number]
export interface LiveMarkdownRegistrationInput {
  readonly document: LiveDocumentKey
  readonly currentPath: string
  readonly checkpoint: Uint8Array
}
export interface LiveMarkdownRegistrationEvidence {
  readonly version: 1
  readonly document: LiveDocumentKey
  readonly currentPath: string
  readonly checkpoint: {
    readonly bytes: Uint8Array
    readonly updateDigest: string
    readonly ranges: readonly LiveUpdateStructRange[]
  }
  readonly projectedMarkdown: string
  readonly projectedMarkdownSha256: string
  readonly projectedMarkdownByteLength: number
  readonly stateUpdate: Uint8Array
  readonly stateUpdateSha256: string
  readonly stateUpdateByteLength: number
  readonly stateVector: Uint8Array
  readonly stateVectorSha256: string
}
type RefusedRegistration = {
  readonly kind: 'refused'
  readonly reason: LiveMarkdownValidationRefusal
  readonly source: 'call' | 'registration-input'
}
export type LiveMarkdownRegistrationResult =
  | { readonly kind: 'accepted'; readonly evidence: LiveMarkdownRegistrationEvidence }
  | RefusedRegistration

class Refusal extends Error {
  constructor(readonly reason: LiveMarkdownValidationRefusal) { super(reason) }
}
function refuse(reason: LiveMarkdownValidationRefusal): never { throw new Refusal(reason) }
function refusal(reason: LiveMarkdownValidationRefusal, source: RefusedRegistration['source']): RefusedRegistration {
  return Object.freeze({ kind: 'refused', reason, source })
}
function exactDataFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) refuse('invalid-input')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) refuse('invalid-input')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) {
    refuse('invalid-input')
  }
  const snapshot: Record<string, unknown> = Object.create(null)
  for (const field of fields) {
    const descriptor = descriptors[field]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) refuse('invalid-input')
    snapshot[field] = descriptor.value
  }
  return snapshot
}
function captureBytes(value: unknown): Uint8Array {
  if (Reflect.apply(byteTag, value, []) !== 'Uint8Array') refuse('invalid-input')
  const buffer = Reflect.apply(byteBuffer, value, []) as ArrayBuffer
  const offset = Reflect.apply(byteOffset, value, []) as number
  const length = Reflect.apply(byteLength, value, []) as number
  const backingLength = Reflect.apply(bufferLength, buffer, []) as number
  if (
    length <= 0 || !Number.isSafeInteger(length) || !Number.isSafeInteger(offset)
    || offset < 0 || offset > backingLength || length > backingLength - offset
    || (bufferResizable !== undefined && Reflect.apply(bufferResizable, buffer, []) === true)
  ) refuse('invalid-input')
  return new ByteArray(buffer, offset, length)
}
function copyBytes(value: Uint8Array): Uint8Array {
  const copy = new ByteArray(Reflect.apply(byteLength, value, []) as number)
  Reflect.apply(setBytes, copy, [value])
  return copy
}
function sha256Hex(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function createLiveMarkdownRegistrationValidator(
  policy: OrderedLiveUpdateCutPolicy,
): (input: unknown) => LiveMarkdownRegistrationResult {
  let ownedPolicy: OrderedLiveUpdateCutPolicy
  try {
    const snapshot = exactDataFields(policy, POLICY_FIELDS)
    for (const field of POLICY_FIELDS) {
      const value = snapshot[field]
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) refuse('invalid-input')
    }
    ownedPolicy = Object.freeze(snapshot) as unknown as OrderedLiveUpdateCutPolicy
  } catch { throw new TypeError('Registration validation requires an exact, positive work policy.') }

  return (input): LiveMarkdownRegistrationResult => {
    let document: LiveDocumentKey, currentPath: string, checkpointValue: unknown
    try {
      const snapshot = exactDataFields(input, INPUT_FIELDS)
      document = Object.freeze(parseLiveDocumentKey(exactDataFields(snapshot.document, DOCUMENT_FIELDS)))
      if (document.mainVersionId !== 'main' || typeof snapshot.currentPath !== 'string') refuse('invalid-input')
      currentPath = snapshot.currentPath
      const path = validateUserWritePath(currentPath)
      if (!path.ok || path.normalized !== currentPath || liveDocumentKindForPath(currentPath) !== 'richdoc') {
        refuse('invalid-input')
      }
      checkpointValue = snapshot.checkpoint
    } catch { return refusal('invalid-input', 'call') }

    let checkpoint: Uint8Array
    try { checkpoint = captureBytes(checkpointValue) }
    catch { return refusal('invalid-input', 'registration-input') }
    const result = validateRegistrationCutForProjection({ mode: 'registration', checkpoint }, ownedPolicy)
    if (result.kind === 'refused') return refusal(result.reason, 'registration-input')
    const { cut, topology } = result
    let pending: RefusedRegistration | undefined
    let projectedMarkdown = '', checkpointCopy: Uint8Array | undefined
    let finalized: OrderedLiveUpdateCutFinalizeResult | undefined
    try {
      checkpointCopy = copyBytes(checkpoint)
      if (sha256Hex(checkpointCopy) !== cut.checkpoint.updateDigest) refuse('invalid-update')
      if (topology.kind !== 'compatible') refuse('invalid-schema')
      projectedMarkdown = validatePublicState(cut.document, topology)
    } catch (error) {
      pending = refusal(error instanceof Refusal ? error.reason : 'invalid-schema', 'registration-input')
    } finally {
      try { finalized = cut.finishAfterProjection() }
      catch { pending = refusal('projection-mutated', 'registration-input') }
      finally {
        try { if (!cut.document.isDestroyed) cut.document.destroy() }
        catch { pending = refusal('projection-mutated', 'registration-input') }
      }
    }
    if (finalized?.kind === 'refused') return refusal(finalized.reason, 'registration-input')
    if (pending) return pending
    if (finalized?.kind !== 'accepted' || checkpointCopy === undefined) return refusal('projection-mutated', 'registration-input')

    const ownedCheckpoint = checkpointCopy
    const stateUpdate = copyBytes(finalized.stateUpdate), stateVector = copyBytes(finalized.stateVector)
    const markdownBytes = utf8.encode(projectedMarkdown)
    const evidence: LiveMarkdownRegistrationEvidence = Object.freeze({
      version: 1,
      document,
      currentPath,
      checkpoint: Object.freeze({
        get bytes() { return copyBytes(ownedCheckpoint) },
        updateDigest: cut.checkpoint.updateDigest,
        ranges: Object.freeze(cut.checkpoint.ranges.map(range => Object.freeze({ ...range }))),
      }),
      projectedMarkdown,
      projectedMarkdownSha256: sha256Hex(markdownBytes),
      projectedMarkdownByteLength: markdownBytes.byteLength,
      get stateUpdate() { return copyBytes(stateUpdate) },
      stateUpdateSha256: sha256Hex(stateUpdate),
      stateUpdateByteLength: stateUpdate.byteLength,
      get stateVector() { return copyBytes(stateVector) },
      stateVectorSha256: sha256Hex(stateVector),
    })
    return Object.freeze({ kind: 'accepted', evidence })
  }
}

interface ElementFingerprint {
  kind: 'element'
  nodeName: string
  attributes: [string, unknown][]
  children: XmlFingerprint[]
}
interface TextFingerprint {
  kind: 'text'
  delta: { insert: string; attributes: [string, unknown][] }[]
}
type XmlFingerprint = ElementFingerprint | TextFingerprint

class ProjectionBudget {
  nodes = 0

  consume(depth: number): void {
    if (depth > MAX_DEPTH) refuse('capacity-refused')
    this.consumeNode()
  }

  consumeNode(): void {
    this.nodes += 1
    if (this.nodes > MAX_NODES) refuse('capacity-refused')
  }

  get remaining(): number {
    return MAX_NODES - this.nodes
  }
}

function isSharedBigInt(value: Y.Map<unknown>): boolean {
  return value.size === 1
    && typeof value.get(SHARED_BIGINT_KEY) === 'bigint'
}

function visitPublicValue(
  value: unknown,
  depth: number,
  budget: ProjectionBudget,
  ancestors: Set<object>,
): void {
  budget.consume(depth)
  if (
    value === null
    || typeof value === 'boolean'
    || typeof value === 'string'
    || typeof value === 'number'
  ) {
    return
  }
  if (typeof value === 'bigint') {
    if (value < MIN_INT64 || value > MAX_INT64) refuse('invalid-schema')
    return
  }
  if (typeof value !== 'object') refuse('invalid-schema')
  if (value instanceof Uint8Array || value instanceof Y.Doc) {
    refuse('invalid-schema')
  }
  if (ancestors.has(value)) refuse('invalid-schema')
  ancestors.add(value)
  try {
    if (value instanceof Y.Map) {
      if (isSharedBigInt(value)) {
        const integer = value.get(SHARED_BIGINT_KEY) as bigint
        if (integer < MIN_INT64 || integer > MAX_INT64) refuse('invalid-schema')
        return
      }
      const normalizedKeys = new Set<string>()
      for (const [key, child] of value.entries()) {
        const normalized = /^\$\$+dohcBigInt$/.test(key) ? key.slice(1) : key
        if (normalizedKeys.has(normalized)) refuse('invalid-schema')
        normalizedKeys.add(normalized)
        visitPublicValue(child, depth + 1, budget, ancestors)
      }
      return
    }
    if (value instanceof Y.Array) {
      if (value.length > budget.remaining) refuse('capacity-refused')
      for (const child of value.toArray()) {
        visitPublicValue(child, depth + 1, budget, ancestors)
      }
      return
    }
    if (value instanceof Y.AbstractType) refuse('invalid-schema')
    if (Array.isArray(value)) {
      if (value.length > budget.remaining) refuse('capacity-refused')
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        refuse('invalid-schema')
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index)
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
          refuse('invalid-schema')
        }
        visitPublicValue(descriptor.value, depth + 1, budget, ancestors)
      }
      return
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      refuse('invalid-schema')
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') refuse('invalid-schema')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')
      ) {
        refuse('invalid-schema')
      }
      visitPublicValue(descriptor.value, depth + 1, budget, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

function sortedValueEntries(value: Record<string, unknown>): [string, unknown][] {
  return Object.keys(value)
    .sort()
    .map(key => [key, value[key]])
}

function validBodyAttribute(nodeName: string, key: string, value: unknown): boolean {
  switch (`${nodeName}.${key}`) {
    case 'wikilink.target':
    case 'inlineAtom.atomId': case 'inlineAtom.params': case 'inlineAtom.source':
    case 'callout.calloutType': case 'callout.title':
    case 'mathInline.tex': case 'mathBlock.tex':
    case 'image.src': case 'image.alt': case 'escapedPunctuation.value':
      return typeof value === 'string'
    case 'wikilink.label': case 'image.title': case 'codeBlock.language':
    case 'orderedList.type':
      return value === null || typeof value === 'string'
    case 'callout.fold':
      return value === '' || value === '+' || value === '-'
    case 'heading.level':
      return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6
    case 'orderedList.start':
    case 'tableCell.colspan': case 'tableCell.rowspan':
    case 'tableHeader.colspan': case 'tableHeader.rowspan':
      return typeof value === 'number' && Number.isFinite(value)
    case 'taskItem.checked':
      return typeof value === 'boolean'
    case 'tableCell.colwidth': case 'tableHeader.colwidth':
      return value === null || (Array.isArray(value)
        && value.every(width => typeof width === 'number' && (Number.isFinite(width) || Number.isNaN(width))))
    case 'tableCell.align': case 'tableHeader.align':
      return value === null || value === 'left' || value === 'right' || value === 'center'
    case 'tableRow.height':
      return value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0)
    default:
      return true
  }
}

function validateMarkAttributes(name: string, value: unknown): void {
  // y-prosemirror appends an eight-character hash to nonexclusive mark names.
  const markName = /(.*)(--[a-zA-Z0-9+/=]{8})$/.exec(name)?.[1] ?? name
  if (markName !== 'link' || value === null || typeof value !== 'object') return
  for (const key of ['href', 'target', 'rel', 'class', 'title']) {
    const attribute = (value as Record<string, unknown>)[key]
    if (attribute !== undefined && attribute !== null && typeof attribute !== 'string') refuse('invalid-schema')
  }
}

function bodyFingerprint(
  body: Y.XmlFragment,
  budget: ProjectionBudget | null,
): XmlFingerprint[] {
  if (budget !== null && body.length > budget.remaining) refuse('capacity-refused')
  return body.toArray().map(child => xmlFingerprint(child, 0, budget))
}

function xmlFingerprint(
  value: Y.XmlElement | Y.XmlText | Y.XmlHook,
  depth: number,
  budget: ProjectionBudget | null,
): XmlFingerprint {
  if (value instanceof Y.XmlHook) refuse('invalid-schema')
  if (value instanceof Y.XmlElement) {
    budget?.consume(depth)
    if (budget !== null && value.length > budget.remaining) refuse('capacity-refused')
    const attributes = value.getAttributes() as Record<string, unknown>
    const entries = sortedValueEntries(attributes)
    for (const [key, attribute] of entries) {
      if (budget !== null) {
        visitPublicValue(attribute, depth + 1, budget, new Set())
        if (!validBodyAttribute(value.nodeName, key, attribute)) refuse('invalid-schema')
      }
    }
    return {
      kind: 'element',
      nodeName: value.nodeName,
      attributes: entries,
      children: value.toArray().map(child => xmlFingerprint(child, depth + 1, budget)),
    }
  }
  if (!(value instanceof Y.XmlText)) refuse('invalid-schema')
  budget?.consume(depth)
  const delta = value.toDelta()
  const runs: TextFingerprint['delta'] = []
  for (const run of delta) {
    if (typeof run.insert !== 'string' || run.insert.length === 0) {
      refuse('invalid-schema')
    }
    budget?.consumeNode()
    const attributes = (run.attributes ?? {}) as Record<string, unknown>
    const entries = sortedValueEntries(attributes)
    for (const [name, attribute] of entries) {
      if (budget !== null) {
        visitPublicValue(attribute, depth + 2, budget, new Set())
        validateMarkAttributes(name, attribute)
      }
    }
    runs.push({ insert: run.insert, attributes: entries })
  }
  return { kind: 'text', delta: runs }
}

function semanticEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    return left.every((value, index) => semanticEqual(value, right[index]))
  }
  if (
    left === null
    || right === null
    || typeof left !== 'object'
    || typeof right !== 'object'
  ) {
    return false
  }
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index]
      && semanticEqual(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      )
    ))
}

function validateMetadata(meta: Y.Map<unknown>, zeroStructSeed: boolean): Record<string, unknown> {
  const snapshot: Record<string, unknown> = Object.create(null)
  for (const [key, value] of meta.entries()) {
    if (!META_KEYS.has(key)) refuse('invalid-schema')
    snapshot[key] = value
  }
  if (Object.hasOwn(snapshot, 'schemaVersion')) {
    if (snapshot.schemaVersion !== 1) refuse('invalid-schema')
  } else if (!zeroStructSeed) refuse('invalid-schema')
  if (Object.hasOwn(snapshot, 'dohcMarkdownCrlf') && snapshot.dohcMarkdownCrlf !== true) {
    refuse('invalid-schema')
  }
  const hasPrefix = Object.hasOwn(snapshot, 'dohcTaggedFrontmatterPrefix')
  const hasBaseline = Object.hasOwn(snapshot, 'dohcTaggedFrontmatterBaseline')
  if (hasPrefix !== hasBaseline || (hasPrefix && (
    typeof snapshot.dohcTaggedFrontmatterPrefix !== 'string'
    || typeof snapshot.dohcTaggedFrontmatterBaseline !== 'string'
  ))) refuse('invalid-schema')
  return snapshot
}

function validatePublicState(
  scratch: Y.Doc,
  topology: Extract<RegistrationTopology, { kind: 'compatible' }>,
): string {
  if (
    scratch.share.size !== 3 || [...scratch.share.keys()].some(key => !PUBLIC_ROOTS.has(key))
    || !(scratch.share.get('body') instanceof Y.XmlFragment)
    || !(scratch.share.get('frontmatter') instanceof Y.Map)
    || !(scratch.share.get('meta') instanceof Y.Map)
  ) refuse('invalid-schema')
  const body = scratch.getXmlFragment('body')
  const frontmatter = scratch.getMap('frontmatter')
  const meta = scratch.getMap('meta')
  const zeroStructSeed = topology.canonicalZeroStructSeed
    && !topology.bodyHasActiveItem && body.length === 0 && frontmatter.size === 0 && meta.size === 0
  const metadata = validateMetadata(meta, zeroStructSeed)
  const budget = new ProjectionBudget()
  for (const value of frontmatter.values()) visitPublicValue(value, 0, budget, new Set())
  const originalFingerprint = bodyFingerprint(body, budget)
  const frontmatterSnapshot = getDohcYDocFrontmatter(scratch)
  let rootNode: ReturnType<typeof yXmlFragmentToProseMirrorRootNode>
  try {
    rootNode = yXmlFragmentToProseMirrorRootNode(body, getDohcProseMirrorSchema())
    if (!topology.bodyHasActiveItem) {
      const json = rootNode.toJSON()
      if (Object.keys(json).length !== 1 || json.type !== 'doc') refuse('invalid-schema')
    } else rootNode.check()
  } catch (error) {
    if (error instanceof Refusal) throw error
    refuse('invalid-schema')
  }

  if (topology.bodyHasActiveItem) {
    const rebuilt = new Y.Doc({ gc: false })
    try {
      const rebuiltBody = rebuilt.getXmlFragment('body')
      prosemirrorJSONToYXmlFragment(getDohcProseMirrorSchema(), rootNode.toJSON(), rebuiltBody)
      if (!semanticEqual(originalFingerprint, bodyFingerprint(rebuiltBody, null))) refuse('invalid-schema')
    } catch (error) {
      if (error instanceof Refusal) throw error
      refuse('invalid-schema')
    } finally { rebuilt.destroy() }
  }

  const projectedMarkdown = yDocToMarkdown(scratch)
  if (exceedsLiveMarkdownLimit(projectedMarkdown)) refuse('capacity-refused')
  if (metadata.dohcMarkdownCrlf === true && !projectedMarkdown.includes('\r\n')) refuse('invalid-schema')
  if (!zeroStructSeed) {
    const reimported = markdownToYDoc(projectedMarkdown)
    try {
      if (!semanticEqual(frontmatterSnapshot, getDohcYDocFrontmatter(reimported))) refuse('invalid-schema')
      if (!semanticEqual(metadata, Object.fromEntries(reimported.getMap('meta').entries()))) refuse('invalid-schema')
    } finally { reimported.destroy() }
  }
  return projectedMarkdown
}
