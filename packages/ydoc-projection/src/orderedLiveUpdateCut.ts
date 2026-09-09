import {
  LIVE_UPDATE_YJS_CLIENT_ID_MAX,
  LIVE_UPDATE_YJS_END_CLOCK_MAX,
  LIVE_UPDATE_YJS_START_CLOCK_MAX,
  type LiveUpdateStructRange,
} from '@dohc/live-session-contract'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { digest as sha256 } from 'lib0/hash/sha256'
import * as string from 'lib0/string'
import * as Y from 'yjs'
import {
  parseBoundedV1Json,
  type BoundedV1JsonBudget,
} from './boundedV1Json.js'

export interface OrderedLiveUpdateCutPolicy {
  readonly maxStructVisits: number
  readonly maxValueNodeVisits: number
  readonly maxDecodedPayloadByteVisits: number
  readonly maxStructClientGroupVisits: number
  readonly maxDeleteClientGroupVisits: number
  readonly maxDeleteIntervalVisits: number
  readonly maxIndexOperations: number
}

export interface OrderedLiveUpdateCutUsage {
  readonly rawInputBytes: number
  readonly decoderPasses: number
  readonly structVisits: number
  readonly valueNodeVisits: number
  readonly decodedPayloadByteVisits: number
  readonly structClientGroupVisits: number
  readonly deleteClientGroupVisits: number
  readonly deleteIntervalVisits: number
  readonly indexOperations: number
  readonly hashedBytes: number
  readonly stateVectorByteVisits: number
  readonly measuredStateByteVisits: number
}

export type OwnedLiveUpdateCutInput =
  | {
      readonly mode: 'registration'
      readonly checkpoint: Uint8Array
    }
  | {
      readonly mode: 'journal-candidate'
      readonly checkpoint: Uint8Array
      readonly suffix: readonly Uint8Array[]
      readonly candidate: Uint8Array
    }

export type OrderedLiveUpdateCutFailureStage =
  | { readonly kind: 'call' }
  | { readonly kind: 'input'; readonly role: 'checkpoint' }
  | { readonly kind: 'input'; readonly role: 'suffix'; readonly index: number }
  | { readonly kind: 'input'; readonly role: 'candidate' }
  | { readonly kind: 'final' }

export type OrderedLiveUpdateCutRefusalReason =
  | 'invalid-input'
  | 'invalid-update'
  | 'invalid-schema'
  | 'projection-mutated'
  | 'capacity-refused'

export interface ValidatedCutInputEvidence {
  readonly updateDigest: string
  readonly ranges: readonly LiveUpdateStructRange[]
}

export type OrderedLiveUpdateCutRefusal = {
  readonly kind: 'refused'
  readonly reason: OrderedLiveUpdateCutRefusalReason
  readonly stage: OrderedLiveUpdateCutFailureStage
  readonly usage: OrderedLiveUpdateCutUsage
}

export type OrderedLiveUpdateCutFinalizeResult =
  | {
      readonly kind: 'accepted'
      readonly stateUpdate: Uint8Array
      readonly stateVector: Uint8Array
      readonly usage: OrderedLiveUpdateCutUsage
    }
  | OrderedLiveUpdateCutRefusal

interface AcceptedCutCommon {
  readonly document: Y.Doc
  readonly usage: OrderedLiveUpdateCutUsage
  readonly finishAfterProjection: () => OrderedLiveUpdateCutFinalizeResult
}

export type ValidatedLiveUpdateCut =
  | (AcceptedCutCommon & {
      readonly mode: 'registration'
      readonly checkpoint: ValidatedCutInputEvidence
    })
  | (AcceptedCutCommon & {
      readonly mode: 'journal-candidate'
      readonly checkpointDigest: string
      readonly checkpointRanges: readonly LiveUpdateStructRange[]
      readonly suffixDigests: readonly string[]
      readonly candidate: ValidatedCutInputEvidence
    })

export type OrderedLiveUpdateCutResult =
  | { readonly kind: 'accepted'; readonly cut: ValidatedLiveUpdateCut }
  | OrderedLiveUpdateCutRefusal

export type ProjectionTopology =
  | {
      readonly kind: 'compatible'
      readonly bodyHasActiveItem: boolean
      readonly canonicalZeroStructSeed: boolean
    }
  | { readonly kind: 'incompatible' }

export type RegistrationCutForProjectionResult =
  | {
      readonly kind: 'accepted'
      readonly cut: Extract<ValidatedLiveUpdateCut, { mode: 'registration' }>
      readonly topology: ProjectionTopology
    }
  | OrderedLiveUpdateCutRefusal

export type JournalCutForProjectionResult =
  | {
      readonly kind: 'accepted'
      readonly cut: Extract<ValidatedLiveUpdateCut, { mode: 'journal-candidate' }>
      readonly topology: ProjectionTopology
    }
  | OrderedLiveUpdateCutRefusal

const POLICY_FIELDS = [
  'maxStructVisits',
  'maxValueNodeVisits',
  'maxDecodedPayloadByteVisits',
  'maxStructClientGroupVisits',
  'maxDeleteClientGroupVisits',
  'maxDeleteIntervalVisits',
  'maxIndexOperations',
] as const
const REGISTRATION_FIELDS = ['mode', 'checkpoint'] as const
const JOURNAL_FIELDS = ['mode', 'checkpoint', 'suffix', 'candidate'] as const
const MAX_UPDATE_BYTES = 20 * 1024 * 1024
const MAX_STATE_BYTES = 20 * 1024 * 1024
export const MAX_OLD_SUFFIX_ENTRIES = 4_094
const MAX_TOTAL_CUT_BYTES = 62_914_559
const MAX_DEPTH = 128
const nativeJsonParse = JSON.parse
const utf8Encoder = new TextEncoder()

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
const typedArrayTagGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)?.get
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'buffer',
)?.get
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteOffset',
)?.get
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength',
)?.get
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get
const arrayBufferResizableGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'resizable',
)?.get

interface MutableUsage {
  rawInputBytes: number
  decoderPasses: number
  structVisits: number
  valueNodeVisits: number
  decodedPayloadByteVisits: number
  structClientGroupVisits: number
  deleteClientGroupVisits: number
  deleteIntervalVisits: number
  indexOperations: number
  hashedBytes: number
  stateVectorByteVisits: number
  measuredStateByteVisits: number
}

type CappedUsage = Pick<MutableUsage,
  | 'structVisits'
  | 'valueNodeVisits'
  | 'decodedPayloadByteVisits'
  | 'structClientGroupVisits'
  | 'deleteClientGroupVisits'
  | 'deleteIntervalVisits'
  | 'indexOperations'
>

type DecoderUsage = Omit<CappedUsage, 'indexOperations'>

const CAPPED_USAGE_FIELDS = [
  'structVisits',
  'valueNodeVisits',
  'decodedPayloadByteVisits',
  'structClientGroupVisits',
  'deleteClientGroupVisits',
  'deleteIntervalVisits',
  'indexOperations',
] as const

const DECODER_USAGE_FIELDS = CAPPED_USAGE_FIELDS.slice(0, 6) as readonly (
  keyof DecoderUsage
)[]

const POLICY_FOR_USAGE: Record<keyof CappedUsage, keyof OrderedLiveUpdateCutPolicy> = {
  structVisits: 'maxStructVisits',
  valueNodeVisits: 'maxValueNodeVisits',
  decodedPayloadByteVisits: 'maxDecodedPayloadByteVisits',
  structClientGroupVisits: 'maxStructClientGroupVisits',
  deleteClientGroupVisits: 'maxDeleteClientGroupVisits',
  deleteIntervalVisits: 'maxDeleteIntervalVisits',
  indexOperations: 'maxIndexOperations',
}

const ZERO_USAGE: OrderedLiveUpdateCutUsage = Object.freeze({
  rawInputBytes: 0,
  decoderPasses: 0,
  structVisits: 0,
  valueNodeVisits: 0,
  decodedPayloadByteVisits: 0,
  structClientGroupVisits: 0,
  deleteClientGroupVisits: 0,
  deleteIntervalVisits: 0,
  indexOperations: 0,
  hashedBytes: 0,
  stateVectorByteVisits: 0,
  measuredStateByteVisits: 0,
})

function frozenStage(
  stage: OrderedLiveUpdateCutFailureStage,
): OrderedLiveUpdateCutFailureStage {
  return Object.freeze({ ...stage }) as OrderedLiveUpdateCutFailureStage
}

class CutFailure extends Error {
  readonly stage: OrderedLiveUpdateCutFailureStage

  constructor(
    readonly reason: OrderedLiveUpdateCutRefusalReason,
    stage: OrderedLiveUpdateCutFailureStage,
  ) {
    super(reason)
    this.stage = frozenStage(stage)
  }
}

function fail(
  reason: OrderedLiveUpdateCutRefusalReason,
  stage: OrderedLiveUpdateCutFailureStage,
): never {
  throw new CutFailure(reason, stage)
}

function safeNonnegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function checkedPlainAdd(
  current: number,
  delta: number,
  reason: OrderedLiveUpdateCutRefusalReason,
  stage: OrderedLiveUpdateCutFailureStage,
): number {
  if (!safeNonnegative(current) || !safeNonnegative(delta)) fail(reason, stage)
  if (delta > Number.MAX_SAFE_INTEGER - current) fail(reason, stage)
  return current + delta
}

function checkedPlainMultiply(
  count: number,
  width: number,
  reason: OrderedLiveUpdateCutRefusalReason,
  stage: OrderedLiveUpdateCutFailureStage,
): number {
  if (!safeNonnegative(count) || !safeNonnegative(width)) fail(reason, stage)
  if (count !== 0 && width > Math.floor(Number.MAX_SAFE_INTEGER / count)) {
    fail(reason, stage)
  }
  return count * width
}

function checkedProjectedAdd(
  current: number,
  delta: number,
  policy: number,
  stage: OrderedLiveUpdateCutFailureStage,
): number {
  if (!safeNonnegative(current)) fail('capacity-refused', stage)
  if (!safeNonnegative(delta)) fail('capacity-refused', stage)
  if (!safeNonnegative(policy)) fail('capacity-refused', stage)
  if (current > policy) fail('capacity-refused', stage)
  const remaining = policy - current
  if (delta > remaining) fail('capacity-refused', stage)
  return current + delta
}

class ValidationBudget {
  private readonly counters: MutableUsage = {
    rawInputBytes: 0,
    decoderPasses: 0,
    structVisits: 0,
    valueNodeVisits: 0,
    decodedPayloadByteVisits: 0,
    structClientGroupVisits: 0,
    deleteClientGroupVisits: 0,
    deleteIntervalVisits: 0,
    indexOperations: 0,
    hashedBytes: 0,
    stateVectorByteVisits: 0,
    measuredStateByteVisits: 0,
  }

  constructor(readonly policy: OrderedLiveUpdateCutPolicy) {}

  chargeRawInputBytes(length: number, stage: OrderedLiveUpdateCutFailureStage): void {
    this.counters.rawInputBytes = checkedPlainAdd(
      this.counters.rawInputBytes,
      length,
      'capacity-refused',
      stage,
    )
  }

  startDecoderPass(stage: OrderedLiveUpdateCutFailureStage): void {
    this.counters.decoderPasses = checkedPlainAdd(
      this.counters.decoderPasses,
      1,
      'capacity-refused',
      stage,
    )
  }

  visitStruct(stage: OrderedLiveUpdateCutFailureStage): void {
    this.chargeCapped('structVisits', 1, stage)
  }

  visitValueNode(stage: OrderedLiveUpdateCutFailureStage): void {
    this.chargeCapped('valueNodeVisits', 1, stage)
  }

  visitDecodedPayloadBytes(
    length: number,
    stage: OrderedLiveUpdateCutFailureStage,
  ): void {
    this.chargeCapped(
      'decodedPayloadByteVisits',
      length,
      stage,
    )
  }

  visitStructClientGroup(stage: OrderedLiveUpdateCutFailureStage): void {
    this.chargeCapped('structClientGroupVisits', 1, stage)
  }

  visitDeleteClientGroup(stage: OrderedLiveUpdateCutFailureStage): void {
    this.chargeCapped('deleteClientGroupVisits', 1, stage)
  }

  visitDeleteInterval(stage: OrderedLiveUpdateCutFailureStage): void {
    this.chargeCapped('deleteIntervalVisits', 1, stage)
  }

  visitIndexOperation(stage: OrderedLiveUpdateCutFailureStage): void {
    this.chargeCapped('indexOperations', 1, stage)
  }

  chargeHashedBytes(length: number, stage: OrderedLiveUpdateCutFailureStage): void {
    this.counters.hashedBytes = checkedPlainAdd(
      this.counters.hashedBytes,
      length,
      'capacity-refused',
      stage,
    )
  }

  chargeStateVectorBytes(
    length: number,
    stage: OrderedLiveUpdateCutFailureStage,
  ): void {
    this.counters.stateVectorByteVisits = checkedPlainAdd(
      this.counters.stateVectorByteVisits,
      length,
      'capacity-refused',
      stage,
    )
  }

  chargeMeasuredStateBytes(
    length: number,
    stage: OrderedLiveUpdateCutFailureStage,
  ): void {
    this.counters.measuredStateByteVisits = checkedPlainAdd(
      this.counters.measuredStateByteVisits,
      length,
      'capacity-refused',
      stage,
    )
  }

  refuseCapacity(): never {
    return fail('capacity-refused', { kind: 'final' })
  }

  cappedSnapshot(): CappedUsage {
    return {
      structVisits: this.counters.structVisits,
      valueNodeVisits: this.counters.valueNodeVisits,
      decodedPayloadByteVisits: this.counters.decodedPayloadByteVisits,
      structClientGroupVisits: this.counters.structClientGroupVisits,
      deleteClientGroupVisits: this.counters.deleteClientGroupVisits,
      deleteIntervalVisits: this.counters.deleteIntervalVisits,
      indexOperations: this.counters.indexOperations,
    }
  }

  decoderSnapshot(): DecoderUsage {
    const capped = this.cappedSnapshot()
    return {
      structVisits: capped.structVisits,
      valueNodeVisits: capped.valueNodeVisits,
      decodedPayloadByteVisits: capped.decodedPayloadByteVisits,
      structClientGroupVisits: capped.structClientGroupVisits,
      deleteClientGroupVisits: capped.deleteClientGroupVisits,
      deleteIntervalVisits: capped.deleteIntervalVisits,
    }
  }

  snapshot(): OrderedLiveUpdateCutUsage {
    return Object.freeze({ ...this.counters })
  }

  private chargeCapped(
    field: keyof CappedUsage,
    delta: number,
    stage: OrderedLiveUpdateCutFailureStage,
  ): void {
    const policyField = POLICY_FOR_USAGE[field]
    this.counters[field] = checkedProjectedAdd(
      this.counters[field],
      delta,
      this.policy[policyField],
      stage,
    )
  }
}

interface InputBytes {
  readonly stage: OrderedLiveUpdateCutFailureStage
  readonly bytes: Uint8Array
}

interface RegistrationSnapshot {
  readonly mode: 'registration'
  readonly entries: readonly [InputBytes]
}

interface JournalSnapshot {
  readonly mode: 'journal-candidate'
  readonly entries: readonly InputBytes[]
  readonly suffixCount: number
}

type InputSnapshot = RegistrationSnapshot | JournalSnapshot

function exactRecord(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('invalid-input', { kind: 'call' })
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail('invalid-input', { kind: 'call' })
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== fields.length
    || keys.some(key => typeof key !== 'string' || !fields.includes(key))
  ) {
    fail('invalid-input', { kind: 'call' })
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      fail('invalid-input', { kind: 'call' })
    }
    result[field] = descriptor.value
  }
  return result
}

function snapshotPolicy(value: unknown): OrderedLiveUpdateCutPolicy {
  const record = exactRecord(value, POLICY_FIELDS)
  const policy = Object.create(null) as Record<string, number>
  for (const field of POLICY_FIELDS) {
    const candidate = record[field]
    if (
      typeof candidate !== 'number'
      || !Number.isSafeInteger(candidate)
      || candidate <= 0
    ) {
      fail('invalid-input', { kind: 'call' })
    }
    policy[field] = candidate
  }
  return Object.freeze(policy) as unknown as OrderedLiveUpdateCutPolicy
}

function localOwnedView(
  value: unknown,
  stage: OrderedLiveUpdateCutFailureStage,
): Uint8Array {
  try {
    if (
      typedArrayTagGetter === undefined
      || typedArrayBufferGetter === undefined
      || typedArrayByteOffsetGetter === undefined
      || typedArrayByteLengthGetter === undefined
      || arrayBufferByteLengthGetter === undefined
      || Reflect.apply(typedArrayTagGetter, value, []) !== 'Uint8Array'
    ) {
      fail('invalid-input', stage)
    }
    const buffer = Reflect.apply(typedArrayBufferGetter, value, []) as ArrayBuffer
    const offset = Reflect.apply(typedArrayByteOffsetGetter, value, []) as number
    const length = Reflect.apply(typedArrayByteLengthGetter, value, []) as number
    const backingLength = Reflect.apply(arrayBufferByteLengthGetter, buffer, []) as number
    if (
      length <= 0
      || !safeNonnegative(offset)
      || !safeNonnegative(length)
      || !safeNonnegative(backingLength)
      || offset > backingLength
      || length > backingLength - offset
      || (
        arrayBufferResizableGetter !== undefined
        && Reflect.apply(arrayBufferResizableGetter, buffer, []) === true
      )
    ) {
      fail('invalid-input', stage)
    }
    if (length > MAX_UPDATE_BYTES) fail('capacity-refused', stage)
    const view = new Uint8Array(buffer, offset, length)
    if (
      view === value
      || Reflect.apply(typedArrayBufferGetter, view, []) !== buffer
      || Reflect.apply(typedArrayByteOffsetGetter, view, []) !== offset
      || Reflect.apply(typedArrayByteLengthGetter, view, []) !== length
    ) {
      fail('invalid-input', stage)
    }
    return view
  } catch (error) {
    if (error instanceof CutFailure) throw error
    return fail('invalid-input', stage)
  }
}

function snapshotSuffix(
  value: unknown,
  budget: ValidationBudget,
): InputBytes[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('invalid-input', { kind: 'call' })
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (
    lengthDescriptor === undefined
    || !Object.hasOwn(lengthDescriptor, 'value')
    || lengthDescriptor.value !== value.length
  ) {
    fail('invalid-input', { kind: 'call' })
  }
  const length = value.length
  if (!safeNonnegative(length)) fail('invalid-input', { kind: 'call' })
  if (length > MAX_OLD_SUFFIX_ENTRIES) {
    fail('capacity-refused', { kind: 'input', role: 'suffix', index: 4094 })
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length !== length + 1 || keys.some((key) => {
    if (key === 'length') return false
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) return true
    const index = Number(key)
    return !Number.isSafeInteger(index) || index < 0 || index >= length
  })) {
    fail('invalid-input', { kind: 'call' })
  }

  const suffix: InputBytes[] = []
  let total = 0
  for (let index = 0; index < length; index += 1) {
    const stage = { kind: 'input', role: 'suffix', index } as const
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      fail('invalid-input', { kind: 'call' })
    }
    const bytes = localOwnedView(descriptor.value, stage)
    if (bytes.byteLength >= MAX_UPDATE_BYTES - total) {
      fail('capacity-refused', stage)
    }
    total += bytes.byteLength
    budget.chargeRawInputBytes(bytes.byteLength, stage)
    suffix.push({ stage: frozenStage(stage), bytes })
  }
  return suffix
}

function snapshotInput(
  inputValue: unknown,
  budget: ValidationBudget,
  expectedMode?: OwnedLiveUpdateCutInput['mode'],
): InputSnapshot {
  if (typeof inputValue !== 'object' || inputValue === null || Array.isArray(inputValue)) {
    fail('invalid-input', { kind: 'call' })
  }
  const modeDescriptor = Object.getOwnPropertyDescriptor(inputValue, 'mode')
  if (
    modeDescriptor === undefined
    || modeDescriptor.enumerable !== true
    || !Object.hasOwn(modeDescriptor, 'value')
  ) {
    fail('invalid-input', { kind: 'call' })
  }
  if (expectedMode !== undefined && modeDescriptor.value !== expectedMode) fail('invalid-input', { kind: 'call' })
  if (modeDescriptor.value === 'registration') {
    const record = exactRecord(inputValue, REGISTRATION_FIELDS)
    const stage = { kind: 'input', role: 'checkpoint' } as const
    const checkpoint = localOwnedView(record.checkpoint, stage)
    budget.chargeRawInputBytes(checkpoint.byteLength, stage)
    return {
      mode: 'registration',
      entries: [{ stage: frozenStage(stage), bytes: checkpoint }],
    }
  }
  if (modeDescriptor.value === 'journal-candidate') {
    const record = exactRecord(inputValue, JOURNAL_FIELDS)
    const checkpointStage = { kind: 'input', role: 'checkpoint' } as const
    const checkpoint = localOwnedView(record.checkpoint, checkpointStage)
    budget.chargeRawInputBytes(checkpoint.byteLength, checkpointStage)
    const suffix = snapshotSuffix(record.suffix, budget)
    const candidateStage = { kind: 'input', role: 'candidate' } as const
    const candidate = localOwnedView(record.candidate, candidateStage)
    budget.chargeRawInputBytes(candidate.byteLength, candidateStage)
    const total = budget.snapshot().rawInputBytes
    if (total > MAX_TOTAL_CUT_BYTES) fail('capacity-refused', candidateStage)
    return {
      mode: 'journal-candidate',
      entries: [
        { stage: frozenStage(checkpointStage), bytes: checkpoint },
        ...suffix,
        { stage: frozenStage(candidateStage), bytes: candidate },
      ],
      suffixCount: suffix.length,
    }
  }
  return fail('invalid-input', { kind: 'call' })
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function bytesHex(bytes: Uint8Array): string {
  let result = ''
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0')
  return result
}

function hashHex(
  bytes: Uint8Array,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): string {
  budget.chargeHashedBytes(bytes.byteLength, stage)
  return bytesHex(sha256(bytes))
}

interface ExtendedUtf8Measurement {
  readonly byteLength: number
  readonly hasLoneSurrogate: boolean
}

function measureExtendedUtf8(value: string): ExtendedUtf8Measurement {
  let byteLength = 0
  let hasLoneSurrogate = false
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit <= 0x7f) byteLength += 1
    else if (unit <= 0x7ff) byteLength += 2
    else if (
      unit >= 0xd800
      && unit <= 0xdbff
      && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff
    ) {
      byteLength += 4
      index += 1
    } else {
      byteLength += 3
      if (unit >= 0xd800 && unit <= 0xdfff) hasLoneSurrogate = true
    }
  }
  return { byteLength, hasLoneSurrogate }
}

function utf8Length(value: string): number {
  return measureExtendedUtf8(value).byteLength
}

function decodeUtf8(bytes: Uint8Array, stage: OrderedLiveUpdateCutFailureStage): string {
  try {
    return string.decodeUtf8(bytes)
  } catch {
    return fail('invalid-update', stage)
  }
}

function stableSort<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): T[] {
  if (values.length < 2) {
    if (values.length === 1) budget.visitIndexOperation(stage)
    return Array.from(values)
  }
  let source = Array.from(values)
  let target = new Array<T>(source.length)
  for (let width = 1; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += width * 2) {
      const middle = Math.min(start + width, source.length)
      const end = Math.min(start + width * 2, source.length)
      let left = start
      let right = middle
      let output = start
      while (left < middle || right < end) {
        let takeLeft: boolean
        if (right >= end) takeLeft = true
        else if (left >= middle) takeLeft = false
        else {
          budget.visitIndexOperation(stage)
          takeLeft = compare(source[left] as T, source[right] as T) <= 0
        }
        target[output] = source[takeLeft ? left++ : right++] as T
        budget.visitIndexOperation(stage)
        output += 1
      }
    }
    const swap = source
    source = target
    target = swap
  }
  return source
}

function compareBytes(
  left: Uint8Array,
  right: Uint8Array,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): number {
  const length = Math.min(left.byteLength, right.byteLength)
  for (let index = 0; index < length; index += 1) {
    budget.visitIndexOperation(stage)
    const difference = (left[index] as number) - (right[index] as number)
    if (difference !== 0) return difference
  }
  budget.visitIndexOperation(stage)
  return left.byteLength - right.byteLength
}

function varUintBytes(value: number): number {
  if (!safeNonnegative(value)) throw new RangeError('invalid varUint')
  let current = value
  let length = 1
  while (current >= 128) {
    current = Math.floor(current / 128)
    length += 1
  }
  return length
}

function varIntBytes(value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError('invalid varInt')
  let current = Object.is(value, -0) ? 0 : Math.abs(value)
  let length = 1
  current = Math.floor(current / 64)
  while (current > 0) {
    current = Math.floor(current / 128)
    length += 1
  }
  return length
}

const TREE_HASH_DOMAIN = 0x79
const TREE_HASH_BYTES = 32
const EMPTY_BYTES = new Uint8Array(0)
const TREE_TAG = Object.freeze({
  anyUndefined: 0,
  anyNull: 1,
  anyFalse: 2,
  anyTrue: 3,
  anyNumber: 4,
  anyBigInt: 5,
  anyString: 6,
  anyBinary: 7,
  anyArray: 8,
  anyMap: 9,
  jsonNull: 10,
  jsonFalse: 11,
  jsonTrue: 12,
  jsonNumber: 13,
  jsonString: 14,
  jsonArray: 15,
  jsonMap: 16,
})

function writeVarUintAt(target: Uint8Array, offset: number, value: number): number {
  let current = value
  let cursor = offset
  while (current >= 128) {
    target[cursor++] = (current & 0x7f) | 0x80
    current = Math.floor(current / 128)
  }
  target[cursor++] = current
  return cursor
}

function allocateHashInput(
  length: number,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): Uint8Array {
  if (!safeNonnegative(length)) fail('capacity-refused', stage)
  budget.chargeHashedBytes(length, stage)
  return new Uint8Array(length)
}

function digestHashInput(
  input: Uint8Array,
  offset: number,
  stage: OrderedLiveUpdateCutFailureStage,
): Uint8Array {
  if (offset !== input.byteLength) fail('invalid-update', stage)
  return sha256(input)
}

function scalarTreeDigest(
  tag: number,
  payload: Uint8Array,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): Uint8Array {
  let length = checkedPlainAdd(2, varUintBytes(payload.byteLength), 'capacity-refused', stage)
  length = checkedPlainAdd(length, payload.byteLength, 'capacity-refused', stage)
  const input = allocateHashInput(length, budget, stage)
  input[0] = TREE_HASH_DOMAIN
  input[1] = tag
  let offset = writeVarUintAt(input, 2, payload.byteLength)
  input.set(payload, offset)
  offset += payload.byteLength
  return digestHashInput(input, offset, stage)
}

function writeExtendedUtf8(target: Uint8Array, offset: number, value: string): number {
  let cursor = offset
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit <= 0x7f) {
      target[cursor++] = unit
    } else if (unit <= 0x7ff) {
      target[cursor++] = 0xc0 | (unit >>> 6)
      target[cursor++] = 0x80 | (unit & 0x3f)
    } else if (
      unit >= 0xd800
      && unit <= 0xdbff
      && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff
    ) {
      const low = value.charCodeAt(++index)
      const codePoint = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00)
      target[cursor++] = 0xf0 | (codePoint >>> 18)
      target[cursor++] = 0x80 | ((codePoint >>> 12) & 0x3f)
      target[cursor++] = 0x80 | ((codePoint >>> 6) & 0x3f)
      target[cursor++] = 0x80 | (codePoint & 0x3f)
    } else if (unit >= 0xd800 && unit <= 0xdfff) {
      target[cursor++] = 0xff
      target[cursor++] = unit >>> 8
      target[cursor++] = unit & 0xff
    } else {
      target[cursor++] = 0xe0 | (unit >>> 12)
      target[cursor++] = 0x80 | ((unit >>> 6) & 0x3f)
      target[cursor++] = 0x80 | (unit & 0x3f)
    }
  }
  return cursor
}

function extendedUtf8Bytes(
  value: string,
  measurement: ExtendedUtf8Measurement,
): Uint8Array {
  const result = new Uint8Array(measurement.byteLength)
  const offset = writeExtendedUtf8(result, 0, value)
  if (offset !== result.byteLength) throw new RangeError('invalid extended UTF-8 length')
  return result
}

function stringTreeDigest(
  tag: number,
  value: string,
  measurement: ExtendedUtf8Measurement,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): Uint8Array {
  const payloadLength = measurement.byteLength
  let length = checkedPlainAdd(2, varUintBytes(payloadLength), 'capacity-refused', stage)
  length = checkedPlainAdd(length, payloadLength, 'capacity-refused', stage)
  const input = allocateHashInput(length, budget, stage)
  input[0] = TREE_HASH_DOMAIN
  input[1] = tag
  const payloadOffset = writeVarUintAt(input, 2, payloadLength)
  const offset = writeExtendedUtf8(input, payloadOffset, value)
  return digestHashInput(input, offset, stage)
}

function arrayTreeDigest(
  tag: number,
  children: readonly Uint8Array[],
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): Uint8Array {
  const digestBytes = checkedPlainMultiply(
    children.length,
    TREE_HASH_BYTES,
    'capacity-refused',
    stage,
  )
  let length = checkedPlainAdd(2, varUintBytes(children.length), 'capacity-refused', stage)
  length = checkedPlainAdd(length, digestBytes, 'capacity-refused', stage)
  const input = allocateHashInput(length, budget, stage)
  input[0] = TREE_HASH_DOMAIN
  input[1] = tag
  let offset = writeVarUintAt(input, 2, children.length)
  for (const child of children) {
    if (child.byteLength !== TREE_HASH_BYTES) fail('invalid-update', stage)
    input.set(child, offset)
    offset += TREE_HASH_BYTES
  }
  return digestHashInput(input, offset, stage)
}

interface TreeMapEntry {
  readonly key: Uint8Array
  readonly digest: Uint8Array
}

function mapTreeDigest(
  tag: number,
  entries: readonly TreeMapEntry[],
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): Uint8Array {
  let length = checkedPlainAdd(2, varUintBytes(entries.length), 'capacity-refused', stage)
  for (const entry of entries) {
    length = checkedPlainAdd(
      length,
      varUintBytes(entry.key.byteLength),
      'capacity-refused',
      stage,
    )
    length = checkedPlainAdd(length, entry.key.byteLength, 'capacity-refused', stage)
    length = checkedPlainAdd(length, TREE_HASH_BYTES, 'capacity-refused', stage)
  }
  const input = allocateHashInput(length, budget, stage)
  input[0] = TREE_HASH_DOMAIN
  input[1] = tag
  let offset = writeVarUintAt(input, 2, entries.length)
  for (const entry of entries) {
    if (entry.digest.byteLength !== TREE_HASH_BYTES) fail('invalid-update', stage)
    offset = writeVarUintAt(input, offset, entry.key.byteLength)
    input.set(entry.key, offset)
    offset += entry.key.byteLength
    input.set(entry.digest, offset)
    offset += TREE_HASH_BYTES
  }
  return digestHashInput(input, offset, stage)
}

function numberBytes(value: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setFloat64(0, value, false)
  return bytes
}

function bigintBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigInt64(0, value, false)
  return bytes
}

interface HashedAnyNode {
  readonly value: unknown
  readonly digest: Uint8Array
}

function readBoundedString(
  decoder: decoding.Decoder,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): string {
  const bytes = decoding.readVarUint8Array(decoder)
  budget.visitDecodedPayloadBytes(bytes.byteLength, stage)
  return decodeUtf8(bytes, stage)
}

function readBoundedText(
  decoder: decoding.Decoder,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): { readonly value: string; readonly bytes: Uint8Array } {
  const bytes = decoding.readVarUint8Array(decoder)
  budget.visitDecodedPayloadBytes(bytes.byteLength, stage)
  return { value: decodeUtf8(bytes, stage), bytes }
}

function readAnyValue(
  decoder: decoding.Decoder,
  depth: number,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): unknown {
  if (depth > MAX_DEPTH) fail('capacity-refused', stage)
  budget.visitValueNode(stage)
  const tag = decoding.readUint8(decoder)
  switch (tag) {
    case 127:
      return undefined
    case 126:
      return null
    case 125:
      return decoding.readVarInt(decoder)
    case 124: {
      const value = decoding.readFloat32(decoder)
      if (Number.isNaN(value)) fail('invalid-update', stage)
      return value
    }
    case 123:
      return decoding.readFloat64(decoder)
    case 122:
      return decoding.readBigInt64(decoder) as bigint
    case 121:
      return false
    case 120:
      return true
    case 119:
      return readBoundedString(decoder, budget, stage)
    case 118: {
      const length = decoding.readVarUint(decoder)
      const value: Record<string, unknown> = Object.create(null)
      const keys = new Set<string>()
      for (let index = 0; index < length; index += 1) {
        const key = readBoundedString(decoder, budget, stage)
        if (key === '__proto__' || keys.has(key)) fail('invalid-update', stage)
        keys.add(key)
        value[key] = readAnyValue(decoder, depth + 1, budget, stage)
      }
      return value
    }
    case 117: {
      const length = decoding.readVarUint(decoder)
      const value: unknown[] = []
      for (let index = 0; index < length; index += 1) {
        value.push(readAnyValue(decoder, depth + 1, budget, stage))
      }
      return value
    }
    case 116: {
      const view = decoding.readVarUint8Array(decoder)
      budget.visitDecodedPayloadBytes(view.byteLength, stage)
      return Uint8Array.from(view)
    }
    default:
      return fail('invalid-update', stage)
  }
}

function readHashedAnyNode(
  decoder: decoding.Decoder,
  depth: number,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): HashedAnyNode {
  if (depth > MAX_DEPTH) fail('capacity-refused', stage)
  budget.visitValueNode(stage)
  const tag = decoding.readUint8(decoder)
  switch (tag) {
    case 127:
      return {
        value: undefined,
        digest: scalarTreeDigest(TREE_TAG.anyUndefined, EMPTY_BYTES, budget, stage),
      }
    case 126:
      return {
        value: null,
        digest: scalarTreeDigest(TREE_TAG.anyNull, EMPTY_BYTES, budget, stage),
      }
    case 125: {
      const value = decoding.readVarInt(decoder)
      return {
        value,
        digest: scalarTreeDigest(TREE_TAG.anyNumber, numberBytes(value), budget, stage),
      }
    }
    case 124: {
      const value = decoding.readFloat32(decoder)
      if (Number.isNaN(value)) fail('invalid-update', stage)
      return {
        value,
        digest: scalarTreeDigest(TREE_TAG.anyNumber, numberBytes(value), budget, stage),
      }
    }
    case 123: {
      const position = decoder.pos
      const value = decoding.readFloat64(decoder)
      const raw = new Uint8Array(decoder.arr.buffer, decoder.arr.byteOffset + position, 8)
      return {
        value,
        digest: scalarTreeDigest(TREE_TAG.anyNumber, raw, budget, stage),
      }
    }
    case 122: {
      const value = decoding.readBigInt64(decoder) as bigint
      return {
        value,
        digest: scalarTreeDigest(TREE_TAG.anyBigInt, bigintBytes(value), budget, stage),
      }
    }
    case 121:
      return {
        value: false,
        digest: scalarTreeDigest(TREE_TAG.anyFalse, EMPTY_BYTES, budget, stage),
      }
    case 120:
      return {
        value: true,
        digest: scalarTreeDigest(TREE_TAG.anyTrue, EMPTY_BYTES, budget, stage),
      }
    case 119: {
      const bounded = readBoundedText(decoder, budget, stage)
      return {
        value: bounded.value,
        digest: scalarTreeDigest(TREE_TAG.anyString, bounded.bytes, budget, stage),
      }
    }
    case 118: {
      const length = decoding.readVarUint(decoder)
      const value: Record<string, unknown> = Object.create(null)
      const keys = new Set<string>()
      const entries: TreeMapEntry[] = []
      for (let index = 0; index < length; index += 1) {
        const key = readBoundedText(decoder, budget, stage)
        if (key.value === '__proto__' || keys.has(key.value)) fail('invalid-update', stage)
        keys.add(key.value)
        const child = readHashedAnyNode(decoder, depth + 1, budget, stage)
        value[key.value] = child.value
        entries.push({ key: key.bytes, digest: child.digest })
      }
      const sorted = stableSort(
        entries,
        (left, right) => compareBytes(left.key, right.key, budget, stage),
        budget,
        stage,
      )
      return {
        value,
        digest: mapTreeDigest(TREE_TAG.anyMap, sorted, budget, stage),
      }
    }
    case 117: {
      const length = decoding.readVarUint(decoder)
      const value: unknown[] = []
      const digests: Uint8Array[] = []
      for (let index = 0; index < length; index += 1) {
        const child = readHashedAnyNode(decoder, depth + 1, budget, stage)
        value.push(child.value)
        digests.push(child.digest)
      }
      return {
        value,
        digest: arrayTreeDigest(TREE_TAG.anyArray, digests, budget, stage),
      }
    }
    case 116: {
      const view = decoding.readVarUint8Array(decoder)
      budget.visitDecodedPayloadBytes(view.byteLength, stage)
      return {
        value: Uint8Array.from(view),
        digest: scalarTreeDigest(TREE_TAG.anyBinary, view, budget, stage),
      }
    }
    default:
      return fail('invalid-update', stage)
  }
}

interface JsonTreeMapEntry extends TreeMapEntry {
  readonly sortKey: Uint8Array
}

function jsonTreeDigest(
  value: unknown,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
  depth = 0,
): Uint8Array {
  if (depth > MAX_DEPTH) fail('capacity-refused', stage)
  budget.visitValueNode(stage)
  if (value === null) return scalarTreeDigest(TREE_TAG.jsonNull, EMPTY_BYTES, budget, stage)
  if (value === false) return scalarTreeDigest(TREE_TAG.jsonFalse, EMPTY_BYTES, budget, stage)
  if (value === true) return scalarTreeDigest(TREE_TAG.jsonTrue, EMPTY_BYTES, budget, stage)
  if (typeof value === 'number') {
    return scalarTreeDigest(TREE_TAG.jsonNumber, numberBytes(value), budget, stage)
  }
  if (typeof value === 'string') {
    const measurement = measureExtendedUtf8(value)
    budget.visitDecodedPayloadBytes(measurement.byteLength, stage)
    return stringTreeDigest(TREE_TAG.jsonString, value, measurement, budget, stage)
  }
  if (Array.isArray(value)) {
    const digests = value.map(child => jsonTreeDigest(child, budget, stage, depth + 1))
    return arrayTreeDigest(TREE_TAG.jsonArray, digests, budget, stage)
  }
  if (typeof value === 'object' && value !== null) {
    const entries: JsonTreeMapEntry[] = []
    for (const key of Object.keys(value)) {
      const measurement = measureExtendedUtf8(key)
      budget.visitDecodedPayloadBytes(measurement.byteLength, stage)
      const sortKey = utf8Encoder.encode(key)
      let framedKey: Uint8Array = sortKey
      if (measurement.hasLoneSurrogate) {
        budget.visitDecodedPayloadBytes(measurement.byteLength, stage)
        framedKey = extendedUtf8Bytes(key, measurement)
      }
      entries.push({
        sortKey,
        key: framedKey,
        digest: jsonTreeDigest(
          (value as Record<string, unknown>)[key],
          budget,
          stage,
          depth + 1,
        ),
      })
    }
    const sorted = stableSort(
      entries,
      (left, right) => (
        compareBytes(left.sortKey, right.sortKey, budget, stage)
        || compareBytes(left.key, right.key, budget, stage)
      ),
      budget,
      stage,
    )
    return mapTreeDigest(TREE_TAG.jsonMap, sorted, budget, stage)
  }
  return fail('invalid-update', stage)
}

interface DecoderEvidenceSink {
  decoder?: decoding.Decoder
  readonly anyFingerprints: string[]
  readonly jsonFingerprints: string[]
  fingerprintOnlyUsage: DecoderUsage
}

function strictDecoderClass(
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
  captureFingerprints: boolean,
  sink: DecoderEvidenceSink,
): typeof Y.UpdateDecoderV1 {
  return class StrictUpdateDecoderV1 extends Y.UpdateDecoderV1 {
    private readonly structClients = new Set<number>()
    private readonly deleteClients = new Set<number>()

    constructor(decoder: decoding.Decoder) {
      super(decoder)
      sink.decoder = decoder
    }

    readInfo(): number {
      budget.visitStruct(stage)
      const info = super.readInfo()
      if ((info & 0x1f) === 2) fail('invalid-schema', stage)
      return info
    }

    readClient(): number {
      budget.visitStructClientGroup(stage)
      const client = super.readClient()
      if (
        !portableInteger(client, 0, LIVE_UPDATE_YJS_CLIENT_ID_MAX)
        || this.structClients.has(client)
      ) {
        fail('invalid-update', stage)
      }
      this.structClients.add(client)
      return client
    }

    resetDsCurVal(): void {
      super.resetDsCurVal()
      const clone = decoding.clone(this.restDecoder)
      let client: number
      try {
        client = decoding.readVarUint(clone)
      } catch {
        return fail('invalid-update', stage)
      }
      budget.visitDeleteClientGroup(stage)
      if (
        !portableInteger(client, 0, LIVE_UPDATE_YJS_CLIENT_ID_MAX)
        || this.deleteClients.has(client)
      ) {
        fail('invalid-update', stage)
      }
      this.deleteClients.add(client)
    }

    readDsClock(): number {
      budget.visitDeleteInterval(stage)
      const clock = super.readDsClock()
      if (!portableInteger(clock, 0, LIVE_UPDATE_YJS_START_CLOCK_MAX)) {
        fail('invalid-update', stage)
      }
      return clock
    }

    readDsLen(): number {
      const length = super.readDsLen()
      if (!portableInteger(length, 1, LIVE_UPDATE_YJS_END_CLOCK_MAX)) {
        fail('invalid-update', stage)
      }
      return length
    }

    readString(): string {
      return readBoundedString(this.restDecoder, budget, stage)
    }

    readKey(): string {
      return readBoundedString(this.restDecoder, budget, stage)
    }

    readBuf(): Uint8Array {
      const view = decoding.readVarUint8Array(this.restDecoder)
      budget.visitDecodedPayloadBytes(view.byteLength, stage)
      return Uint8Array.from(view)
    }

    readAny(): unknown {
      if (captureFingerprints) {
        const node = readHashedAnyNode(this.restDecoder, 0, budget, stage)
        sink.anyFingerprints.push(bytesHex(node.digest))
        return node.value
      }
      return readAnyValue(this.restDecoder, 0, budget, stage)
    }

    readJSON(): unknown {
      const view = decoding.readVarUint8Array(this.restDecoder)
      const scannerBudget: BoundedV1JsonBudget = {
        visitValueNode: () => budget.visitValueNode(stage),
        visitDecodedPayloadBytes: length => {
          budget.visitDecodedPayloadBytes(length, stage)
        },
        refuseCapacity: () => fail('capacity-refused', stage),
      }
      let value: unknown
      try {
        value = parseBoundedV1Json(view, scannerBudget, nativeJsonParse)
      } catch (error) {
        if (error instanceof CutFailure) throw error
        return fail('invalid-update', stage)
      }
      if (captureFingerprints) {
        const beforeFingerprint = budget.decoderSnapshot()
        sink.jsonFingerprints.push(bytesHex(jsonTreeDigest(value, budget, stage)))
        const fingerprintDelta = decoderDelta(
          budget.decoderSnapshot(),
          beforeFingerprint,
          stage,
        )
        sink.fingerprintOnlyUsage = addDecoderUsage(
          sink.fingerprintOnlyUsage,
          fingerprintDelta,
          stage,
        )
      }
      return value
    }
  }
}

function portableInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function checkedDelta(
  after: number,
  before: number,
  stage: OrderedLiveUpdateCutFailureStage,
): number {
  if (!safeNonnegative(after) || !safeNonnegative(before) || after < before) {
    fail('capacity-refused', stage)
  }
  return after - before
}

function cappedDelta(
  after: CappedUsage,
  before: CappedUsage,
  stage: OrderedLiveUpdateCutFailureStage,
): CappedUsage {
  return {
    structVisits: checkedDelta(after.structVisits, before.structVisits, stage),
    valueNodeVisits: checkedDelta(after.valueNodeVisits, before.valueNodeVisits, stage),
    decodedPayloadByteVisits: checkedDelta(
      after.decodedPayloadByteVisits,
      before.decodedPayloadByteVisits,
      stage,
    ),
    structClientGroupVisits: checkedDelta(
      after.structClientGroupVisits,
      before.structClientGroupVisits,
      stage,
    ),
    deleteClientGroupVisits: checkedDelta(
      after.deleteClientGroupVisits,
      before.deleteClientGroupVisits,
      stage,
    ),
    deleteIntervalVisits: checkedDelta(
      after.deleteIntervalVisits,
      before.deleteIntervalVisits,
      stage,
    ),
    indexOperations: checkedDelta(after.indexOperations, before.indexOperations, stage),
  }
}

function decoderDelta(
  after: DecoderUsage,
  before: DecoderUsage,
  stage: OrderedLiveUpdateCutFailureStage,
): DecoderUsage {
  return {
    structVisits: checkedDelta(after.structVisits, before.structVisits, stage),
    valueNodeVisits: checkedDelta(after.valueNodeVisits, before.valueNodeVisits, stage),
    decodedPayloadByteVisits: checkedDelta(
      after.decodedPayloadByteVisits,
      before.decodedPayloadByteVisits,
      stage,
    ),
    structClientGroupVisits: checkedDelta(
      after.structClientGroupVisits,
      before.structClientGroupVisits,
      stage,
    ),
    deleteClientGroupVisits: checkedDelta(
      after.deleteClientGroupVisits,
      before.deleteClientGroupVisits,
      stage,
    ),
    deleteIntervalVisits: checkedDelta(
      after.deleteIntervalVisits,
      before.deleteIntervalVisits,
      stage,
    ),
  }
}

function zeroDecoderUsage(): DecoderUsage {
  return {
    structVisits: 0,
    valueNodeVisits: 0,
    decodedPayloadByteVisits: 0,
    structClientGroupVisits: 0,
    deleteClientGroupVisits: 0,
    deleteIntervalVisits: 0,
  }
}

function addDecoderUsage(
  left: DecoderUsage,
  right: DecoderUsage,
  stage: OrderedLiveUpdateCutFailureStage,
): DecoderUsage {
  const result = zeroDecoderUsage()
  for (const field of DECODER_USAGE_FIELDS) {
    ;(result as Record<keyof DecoderUsage, number>)[field] = checkedPlainAdd(
      left[field],
      right[field],
      'capacity-refused',
      stage,
    )
  }
  return result
}

function subtractDecoderUsage(
  total: DecoderUsage,
  subtrahend: DecoderUsage,
  stage: OrderedLiveUpdateCutFailureStage,
): DecoderUsage {
  const result = zeroDecoderUsage()
  for (const field of DECODER_USAGE_FIELDS) {
    ;(result as Record<keyof DecoderUsage, number>)[field] = checkedDelta(
      total[field],
      subtrahend[field],
      stage,
    )
  }
  return result
}

function decoderUsageEqual(left: DecoderUsage, right: DecoderUsage): boolean {
  return DECODER_USAGE_FIELDS.every(field => left[field] === right[field])
}

interface NumericRange {
  readonly clientId: number
  readonly startClock: number
  readonly endClock: number
}

type ParentIdentity =
  | { readonly kind: 'root'; readonly name: string }
  | { readonly kind: 'item'; readonly client: number; readonly clock: number }
  | { readonly kind: 'none' }

interface Placement {
  readonly origin: string
  readonly rightOrigin: string
  readonly parent: ParentIdentity
  readonly parentSub: string | null
}

type LiveContent =
  | { readonly kind: 'string'; readonly text: string }
  | { readonly kind: 'tokens'; readonly tokens: readonly string[] }

interface LiveSpan extends NumericRange {
  readonly content: LiveContent
  readonly contentOffset: number
  readonly placement: Placement
}

interface IntegrationNode extends NumericRange {
  readonly ordinal: number
  readonly placement: Placement | null
}

interface NormalizedInput {
  readonly ranges: readonly LiveUpdateStructRange[]
  readonly structuralRanges: readonly NumericRange[]
  readonly integrationNodes: readonly IntegrationNode[]
  readonly skipRanges: readonly NumericRange[]
  readonly liveSpans: readonly LiveSpan[]
  readonly tombstones: readonly NumericRange[]
  readonly deleteRanges: readonly NumericRange[]
  readonly rawDeleteEndpoints: ReadonlyMap<number, readonly number[]>
  readonly unsafePoints: ReadonlyMap<number, readonly number[]>
  readonly structBoundaries: ReadonlyMap<number, readonly number[]>
  readonly decoderForecast: DecoderUsage
}

interface DecodedOwnedInput {
  readonly normalized: NormalizedInput
  readonly updateDigest: string
}

function idIdentity(id: Y.ID | null): string {
  return id === null ? '-' : `${id.client}:${id.clock}`
}

function validateId(
  id: Y.ID | null,
  stage: OrderedLiveUpdateCutFailureStage,
): void {
  if (
    id !== null
    && (
      !portableInteger(id.client, 0, LIVE_UPDATE_YJS_CLIENT_ID_MAX)
      || !portableInteger(id.clock, 0, LIVE_UPDATE_YJS_START_CLOCK_MAX)
    )
  ) {
    fail('invalid-update', stage)
  }
}

function rangeForStruct(
  struct: Y.Item | Y.GC | Y.Skip,
  stage: OrderedLiveUpdateCutFailureStage,
): NumericRange {
  const startClock = struct.id.clock
  const length = struct.length
  if (
    !portableInteger(struct.id.client, 0, LIVE_UPDATE_YJS_CLIENT_ID_MAX)
    || !portableInteger(startClock, 0, LIVE_UPDATE_YJS_START_CLOCK_MAX)
    || !portableInteger(length, 1, LIVE_UPDATE_YJS_END_CLOCK_MAX)
    || length > LIVE_UPDATE_YJS_END_CLOCK_MAX - startClock
  ) {
    fail('invalid-update', stage)
  }
  const endClock = startClock + length
  if (!portableInteger(endClock, 1, LIVE_UPDATE_YJS_END_CLOCK_MAX)) {
    fail('invalid-update', stage)
  }
  return { clientId: struct.id.client, startClock, endClock }
}

function parentIdentity(
  parent: string | Y.ID | Y.AbstractType<unknown> | null,
  stage: OrderedLiveUpdateCutFailureStage,
): ParentIdentity {
  if (typeof parent === 'string') return { kind: 'root', name: parent }
  if (parent === null) return { kind: 'none' }
  if (parent instanceof Y.AbstractType) fail('invalid-update', stage)
  validateId(parent, stage)
  return { kind: 'item', client: parent.client, clock: parent.clock }
}

function itemPlacement(
  item: Y.Item,
  stage: OrderedLiveUpdateCutFailureStage,
): Placement {
  validateId(item.origin, stage)
  validateId(item.rightOrigin, stage)
  if (item.parentSub !== null && typeof item.parentSub !== 'string') {
    fail('invalid-update', stage)
  }
  return {
    origin: idIdentity(item.origin),
    rightOrigin: idIdentity(item.rightOrigin),
    parent: parentIdentity(item.parent, stage),
    parentSub: item.parentSub,
  }
}

function typeToken(
  type: Y.AbstractType<unknown>,
  stage: OrderedLiveUpdateCutFailureStage,
): string {
  if (type instanceof Y.XmlHook) fail('invalid-schema', stage)
  if (type instanceof Y.XmlElement) return `xml-element:${type.nodeName}`
  if (type instanceof Y.XmlText) return 'xml-text'
  if (type instanceof Y.XmlFragment) return 'xml-fragment'
  if (type instanceof Y.Text) return 'text'
  if (type instanceof Y.Map) return 'map'
  if (type instanceof Y.Array) return 'array'
  return fail('invalid-schema', stage)
}

function tokenForBytes(
  kind: string,
  bytes: Uint8Array,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): string {
  return `${kind}:${hashHex(bytes, budget, stage)}`
}

function normalizedItemContent(
  item: Y.Item,
  sink: DecoderEvidenceSink,
  cursors: { any: number; json: number },
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): LiveContent | null {
  const content = item.content
  if (content instanceof Y.ContentDeleted) return null
  if (content instanceof Y.ContentString) {
    if (content.str.length !== item.length || content.str.length === 0) {
      fail('invalid-update', stage)
    }
    return { kind: 'string', text: content.str }
  }
  if (content instanceof Y.ContentAny) {
    if (content.arr.length !== item.length || content.arr.length === 0) {
      fail('invalid-update', stage)
    }
    const tokens: string[] = []
    for (let index = 0; index < content.arr.length; index += 1) {
      const fingerprint = sink.anyFingerprints[cursors.any++]
      if (fingerprint === undefined) fail('invalid-update', stage)
      tokens.push(`any:${fingerprint}`)
    }
    return { kind: 'tokens', tokens }
  }
  if (item.length !== 1) fail('invalid-update', stage)
  if (content instanceof Y.ContentBinary) {
    return {
      kind: 'tokens',
      tokens: [tokenForBytes('binary', content.content, budget, stage)],
    }
  }
  if (content instanceof Y.ContentEmbed) {
    const fingerprint = sink.jsonFingerprints[cursors.json++]
    if (fingerprint === undefined) fail('invalid-update', stage)
    return { kind: 'tokens', tokens: [`embed:${fingerprint}`] }
  }
  if (content instanceof Y.ContentFormat) {
    const fingerprint = sink.jsonFingerprints[cursors.json++]
    if (fingerprint === undefined) fail('invalid-update', stage)
    budget.visitDecodedPayloadBytes(utf8Length(content.key), stage)
    return {
      kind: 'tokens',
      tokens: [`format:${bytesHex(utf8Encoder.encode(content.key))}:${fingerprint}`],
    }
  }
  if (content instanceof Y.ContentType) {
    return { kind: 'tokens', tokens: [`type:${typeToken(content.type, stage)}`] }
  }
  if (content instanceof Y.ContentDoc) {
    const fingerprint = sink.anyFingerprints[cursors.any++]
    if (fingerprint === undefined) fail('invalid-update', stage)
    budget.visitDecodedPayloadBytes(utf8Length(content.doc.guid), stage)
    return {
      kind: 'tokens',
      tokens: [`doc:${bytesHex(utf8Encoder.encode(content.doc.guid))}:${fingerprint}`],
    }
  }
  if (content instanceof Y.ContentJSON) fail('invalid-schema', stage)
  return fail('invalid-schema', stage)
}

function rangeCompare(left: NumericRange, right: NumericRange): number {
  return left.clientId - right.clientId
    || left.startClock - right.startClock
    || left.endClock - right.endClock
}

function normalizeRanges(
  ranges: readonly NumericRange[],
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): NumericRange[] {
  const sorted = stableSort(ranges, rangeCompare, budget, stage)
  const result: NumericRange[] = []
  for (const range of sorted) {
    const last = result[result.length - 1]
    budget.visitIndexOperation(stage)
    if (
      last !== undefined
      && last.clientId === range.clientId
      && range.startClock <= last.endClock
    ) {
      budget.visitIndexOperation(stage)
      result[result.length - 1] = {
        clientId: last.clientId,
        startClock: last.startClock,
        endClock: Math.max(last.endClock, range.endClock),
      }
    } else {
      result.push({ ...range })
    }
  }
  return result
}

function groupPoints(
  points: readonly { clientId: number; clock: number }[],
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): ReadonlyMap<number, readonly number[]> {
  const sorted = stableSort(
    points,
    (left, right) => left.clientId - right.clientId || left.clock - right.clock,
    budget,
    stage,
  )
  const grouped = new Map<number, number[]>()
  for (const point of sorted) {
    const client = grouped.get(point.clientId) ?? []
    if (client[client.length - 1] !== point.clock) client.push(point.clock)
    grouped.set(point.clientId, client)
  }
  return grouped
}

function normalizedEvidenceRanges(
  ranges: readonly NumericRange[],
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): readonly LiveUpdateStructRange[] {
  return Object.freeze(normalizeRanges(ranges, budget, stage).map(range => Object.freeze({
    clientId: range.clientId,
    startClock: range.startClock,
    endClock: range.endClock,
  })))
}

function normalizeDecodedInput(
  decoded: ReturnType<typeof Y.decodeUpdateV2>,
  sink: DecoderEvidenceSink,
  decoderForecast: DecoderUsage,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
  checkpoint: boolean,
): NormalizedInput {
  const structuralRanges: NumericRange[] = []
  const integrationNodes: IntegrationNode[] = []
  const skipRanges: NumericRange[] = []
  const liveSpans: LiveSpan[] = []
  const tombstones: NumericRange[] = []
  const unsafe: { clientId: number; clock: number }[] = []
  const boundaries: { clientId: number; clock: number }[] = []
  const cursors = { any: 0, json: 0 }

  for (let ordinal = 0; ordinal < decoded.structs.length; ordinal += 1) {
    const struct = decoded.structs[ordinal] as Y.Item | Y.GC | Y.Skip
    const range = rangeForStruct(struct, stage)
    boundaries.push({ clientId: range.clientId, clock: range.startClock })
    boundaries.push({ clientId: range.clientId, clock: range.endClock })
    if (struct instanceof Y.Skip) {
      if (checkpoint) fail('invalid-update', stage)
      skipRanges.push(range)
      continue
    }
    structuralRanges.push(range)
    if (struct instanceof Y.GC) {
      integrationNodes.push({ ...range, ordinal, placement: null })
      tombstones.push(range)
      continue
    }
    if (!(struct instanceof Y.Item)) fail('invalid-update', stage)
    const placement = itemPlacement(struct, stage)
    integrationNodes.push({ ...range, ordinal, placement })
    const content = normalizedItemContent(
      struct,
      sink,
      cursors,
      budget,
      stage,
    )
    if (struct.content instanceof Y.ContentDeleted) {
      tombstones.push(range)
    } else if (content !== null) {
      liveSpans.push({ ...range, content, contentOffset: 0, placement })
      if (content.kind === 'string') {
        for (let index = 1; index < content.text.length; index += 1) {
          const previous = content.text.charCodeAt(index - 1)
          const current = content.text.charCodeAt(index)
          if (
            previous >= 0xd800
            && previous <= 0xdbff
            && current >= 0xdc00
            && current <= 0xdfff
          ) {
            unsafe.push({ clientId: range.clientId, clock: range.startClock + index })
          }
        }
      }
    }
  }
  if (
    cursors.any !== sink.anyFingerprints.length
    || cursors.json !== sink.jsonFingerprints.length
  ) {
    fail('invalid-update', stage)
  }

  const deleteRanges: NumericRange[] = []
  const deleteEndpoints: { clientId: number; clock: number }[] = []
  for (const [clientId, intervals] of decoded.ds.clients) {
    if (!portableInteger(clientId, 0, LIVE_UPDATE_YJS_CLIENT_ID_MAX)) {
      fail('invalid-update', stage)
    }
    for (const interval of intervals) {
      if (
        !portableInteger(interval.clock, 0, LIVE_UPDATE_YJS_START_CLOCK_MAX)
        || !portableInteger(interval.len, 1, LIVE_UPDATE_YJS_END_CLOCK_MAX)
        || interval.len > LIVE_UPDATE_YJS_END_CLOCK_MAX - interval.clock
      ) {
        fail('invalid-update', stage)
      }
      deleteRanges.push({
        clientId,
        startClock: interval.clock,
        endClock: interval.clock + interval.len,
      })
      deleteEndpoints.push({ clientId, clock: interval.clock })
      deleteEndpoints.push({ clientId, clock: interval.clock + interval.len })
    }
  }

  return {
    ranges: normalizedEvidenceRanges(structuralRanges, budget, stage),
    structuralRanges: normalizeRanges(structuralRanges, budget, stage),
    integrationNodes,
    skipRanges: normalizeRanges(skipRanges, budget, stage),
    liveSpans: stableSort(liveSpans, rangeCompare, budget, stage),
    tombstones: normalizeRanges(tombstones, budget, stage),
    deleteRanges: normalizeRanges(deleteRanges, budget, stage),
    rawDeleteEndpoints: groupPoints(deleteEndpoints, budget, stage),
    unsafePoints: groupPoints(unsafe, budget, stage),
    structBoundaries: groupPoints(boundaries, budget, stage),
    decoderForecast,
  }
}

function decodeOwnedInput(
  entry: InputBytes,
  budget: ValidationBudget,
  checkpoint: boolean,
): DecodedOwnedInput {
  const updateDigest = hashHex(entry.bytes, budget, entry.stage)
  budget.startDecoderPass(entry.stage)
  const before = budget.decoderSnapshot()
  const sink: DecoderEvidenceSink = {
    anyFingerprints: [],
    jsonFingerprints: [],
    fingerprintOnlyUsage: zeroDecoderUsage(),
  }
  const Decoder = strictDecoderClass(budget, entry.stage, true, sink)
  let decoded: ReturnType<typeof Y.decodeUpdateV2>
  try {
    decoded = Y.decodeUpdateV2(entry.bytes, Decoder)
    if (sink.decoder === undefined || decoding.hasContent(sink.decoder)) {
      fail('invalid-update', entry.stage)
    }
  } catch (error) {
    if (error instanceof CutFailure) throw error
    return fail('invalid-update', entry.stage)
  }
  const evidenceDecoderUsage = decoderDelta(
    budget.decoderSnapshot(),
    before,
    entry.stage,
  )
  const forecast = subtractDecoderUsage(
    evidenceDecoderUsage,
    sink.fingerprintOnlyUsage,
    entry.stage,
  )
  return {
    normalized: normalizeDecodedInput(
      decoded,
      sink,
      forecast,
      budget,
      entry.stage,
      checkpoint,
    ),
    updateDigest,
  }
}

function mapRanges(ranges: readonly NumericRange[]): Map<number, NumericRange[]> {
  const result = new Map<number, NumericRange[]>()
  for (const range of ranges) {
    const client = result.get(range.clientId) ?? []
    client.push(range)
    result.set(range.clientId, client)
  }
  return result
}

function rangeCovered(
  ranges: readonly NumericRange[],
  startClock: number,
  endClock: number,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): boolean {
  let low = 0
  let high = ranges.length
  while (low < high) {
    const middle = (low + high) >>> 1
    budget.visitIndexOperation(stage)
    if ((ranges[middle] as NumericRange).endClock <= startClock) low = middle + 1
    else high = middle
  }
  let cursor = startClock
  for (let index = low; index < ranges.length; index += 1) {
    const range = ranges[index] as NumericRange
    budget.visitIndexOperation(stage)
    if (range.startClock > cursor) return false
    if (range.endClock > cursor) cursor = range.endClock
    if (cursor >= endClock) return true
  }
  return false
}

function pointPresent(
  points: readonly number[],
  point: number,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): boolean {
  let low = 0
  let high = points.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const current = points[middle] as number
    budget.visitIndexOperation(stage)
    if (current === point) return true
    if (current < point) low = middle + 1
    else high = middle - 1
  }
  return false
}

function requireCoveredIdentity(
  identity: string,
  available: ReadonlyMap<number, readonly NumericRange[]>,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): void {
  if (identity === '-') return
  const separator = identity.indexOf(':')
  if (separator <= 0) fail('invalid-update', stage)
  const clientId = Number(identity.slice(0, separator))
  const clock = Number(identity.slice(separator + 1))
  if (
    !portableInteger(clientId, 0, LIVE_UPDATE_YJS_CLIENT_ID_MAX)
    || !portableInteger(clock, 0, LIVE_UPDATE_YJS_START_CLOCK_MAX)
    || !rangeCovered(
      available.get(clientId) ?? [],
      clock,
      clock + 1,
      budget,
      stage,
    )
  ) fail('invalid-update', stage)
}

interface ClosureNode extends IntegrationNode {
  readonly outgoing: number[]
  indegree: number
}

interface ProviderInterval {
  readonly startClock: number
  readonly endClock: number
  readonly nodeIndex: number
}

interface ClosureDependency {
  readonly clientId: number
  readonly clock: number
}

function priorStructuralEnds(
  structural: ReadonlyMap<number, readonly NumericRange[]>,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): Map<number, number> {
  const result = new Map<number, number>()
  for (const [clientId, ranges] of structural) {
    budget.visitIndexOperation(stage)
    let endClock = 0
    for (const range of ranges) {
      budget.visitIndexOperation(stage)
      if (range.startClock !== endClock) fail('invalid-update', stage)
      endClock = range.endClock
      budget.visitIndexOperation(stage)
    }
    result.set(clientId, endClock)
    budget.visitIndexOperation(stage)
  }
  return result
}

function closureDependencyId(
  identity: string,
  stage: OrderedLiveUpdateCutFailureStage,
): ClosureDependency | undefined {
  if (identity === '-') return undefined
  const separator = identity.indexOf(':')
  if (separator <= 0) fail('invalid-update', stage)
  const clientId = Number(identity.slice(0, separator))
  const clock = Number(identity.slice(separator + 1))
  if (
    !portableInteger(clientId, 0, LIVE_UPDATE_YJS_CLIENT_ID_MAX)
    || !portableInteger(clock, 0, LIVE_UPDATE_YJS_START_CLOCK_MAX)
  ) fail('invalid-update', stage)
  return { clientId, clock }
}

function addClosureEdge(
  nodes: readonly ClosureNode[],
  providerIndex: number,
  dependentIndex: number,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): void {
  budget.visitIndexOperation(stage)
  const provider = nodes[providerIndex]
  budget.visitIndexOperation(stage)
  const dependent = nodes[dependentIndex]
  if (provider === undefined || dependent === undefined) fail('invalid-update', stage)
  budget.visitIndexOperation(stage)
  provider.outgoing.push(dependentIndex)
  budget.visitIndexOperation(stage)
  dependent.indegree = checkedPlainAdd(
    dependent.indegree,
    1,
    'capacity-refused',
    stage,
  )
}

function findProvider(
  providers: ReadonlyMap<number, readonly ProviderInterval[]>,
  clientId: number,
  clock: number,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): number | undefined {
  budget.visitIndexOperation(stage)
  const intervals = providers.get(clientId) ?? []
  let low = 0
  let high = intervals.length
  while (true) {
    budget.visitIndexOperation(stage)
    if (low >= high) break
    const middle = (low + high) >>> 1
    budget.visitIndexOperation(stage)
    const interval = intervals[middle] as ProviderInterval
    budget.visitIndexOperation(stage)
    if (interval.startClock <= clock) low = middle + 1
    else high = middle
  }
  budget.visitIndexOperation(stage)
  if (low === 0) return undefined
  const candidate = intervals[low - 1] as ProviderInterval
  budget.visitIndexOperation(stage)
  return clock < candidate.endClock ? candidate.nodeIndex : undefined
}

function addExplicitClosureDependency(
  nodes: readonly ClosureNode[],
  dependentIndex: number,
  dependency: ClosureDependency | undefined,
  priorEnds: ReadonlyMap<number, number>,
  providers: ReadonlyMap<number, readonly ProviderInterval[]>,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): void {
  budget.visitIndexOperation(stage)
  if (dependency === undefined) return
  budget.visitIndexOperation(stage)
  const priorEnd = priorEnds.get(dependency.clientId) ?? 0
  budget.visitIndexOperation(stage)
  if (dependency.clock < priorEnd) return
  const providerIndex = findProvider(
    providers,
    dependency.clientId,
    dependency.clock,
    budget,
    stage,
  )
  if (providerIndex === undefined) fail('invalid-update', stage)
  addClosureEdge(nodes, providerIndex, dependentIndex, budget, stage)
}

function proveDependencyClosure(
  priorStructural: ReadonlyMap<number, readonly NumericRange[]>,
  inputNodes: readonly IntegrationNode[],
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): void {
  const priorEnds = priorStructuralEnds(priorStructural, budget, stage)
  const nodes: ClosureNode[] = []
  const providers = new Map<number, ProviderInterval[]>()
  const currentEnds = new Map<number, number>()
  const previousNodes = new Map<number, number>()

  for (const inputNode of inputNodes) {
    budget.visitIndexOperation(stage)
    const nodeIndex = nodes.length
    budget.visitIndexOperation(stage)
    const node: ClosureNode = { ...inputNode, outgoing: [], indegree: 0 }
    nodes.push(node)

    budget.visitIndexOperation(stage)
    const previousNode = previousNodes.get(node.clientId)
    if (previousNode !== undefined) {
      addClosureEdge(nodes, previousNode, nodeIndex, budget, stage)
    }
    budget.visitIndexOperation(stage)
    previousNodes.set(node.clientId, nodeIndex)

    budget.visitIndexOperation(stage)
    const priorEnd = priorEnds.get(node.clientId) ?? 0
    budget.visitIndexOperation(stage)
    const currentEnd = currentEnds.get(node.clientId) ?? priorEnd
    budget.visitIndexOperation(stage)
    if (node.startClock > currentEnd) fail('invalid-update', stage)
    if (node.endClock > currentEnd) {
      budget.visitIndexOperation(stage)
      const clientProviders = providers.get(node.clientId) ?? []
      budget.visitIndexOperation(stage)
      clientProviders.push({
        startClock: currentEnd,
        endClock: node.endClock,
        nodeIndex,
      })
      budget.visitIndexOperation(stage)
      providers.set(node.clientId, clientProviders)
      budget.visitIndexOperation(stage)
      currentEnds.set(node.clientId, node.endClock)
    }
  }

  for (let dependentIndex = 0; dependentIndex < nodes.length; dependentIndex += 1) {
    budget.visitIndexOperation(stage)
    const node = nodes[dependentIndex] as ClosureNode
    const placement = node.placement
    if (placement === null) continue
    addExplicitClosureDependency(
      nodes,
      dependentIndex,
      closureDependencyId(placement.origin, stage),
      priorEnds,
      providers,
      budget,
      stage,
    )
    addExplicitClosureDependency(
      nodes,
      dependentIndex,
      closureDependencyId(placement.rightOrigin, stage),
      priorEnds,
      providers,
      budget,
      stage,
    )
    addExplicitClosureDependency(
      nodes,
      dependentIndex,
      placement.parent.kind === 'item'
        ? { clientId: placement.parent.client, clock: placement.parent.clock }
        : undefined,
      priorEnds,
      providers,
      budget,
      stage,
    )
  }

  const queue: number[] = []
  for (let index = 0; index < nodes.length; index += 1) {
    budget.visitIndexOperation(stage)
    const node = nodes[index] as ClosureNode
    budget.visitIndexOperation(stage)
    if (node.indegree === 0) {
      budget.visitIndexOperation(stage)
      queue.push(index)
    }
  }
  let head = 0
  let completed = 0
  while (true) {
    budget.visitIndexOperation(stage)
    if (head >= queue.length) break
    const providerIndex = queue[head++] as number
    budget.visitIndexOperation(stage)
    const provider = nodes[providerIndex] as ClosureNode
    completed = checkedPlainAdd(completed, 1, 'capacity-refused', stage)
    budget.visitIndexOperation(stage)
    for (let edgeIndex = 0; ; edgeIndex += 1) {
      budget.visitIndexOperation(stage)
      if (edgeIndex >= provider.outgoing.length) break
      budget.visitIndexOperation(stage)
      const dependentIndex = provider.outgoing[edgeIndex] as number
      budget.visitIndexOperation(stage)
      const dependent = nodes[dependentIndex] as ClosureNode
      budget.visitIndexOperation(stage)
      if (dependent.indegree <= 0) fail('invalid-update', stage)
      budget.visitIndexOperation(stage)
      dependent.indegree -= 1
      budget.visitIndexOperation(stage)
      if (dependent.indegree === 0) {
        budget.visitIndexOperation(stage)
        queue.push(dependentIndex)
      }
    }
  }
  budget.visitIndexOperation(stage)
  if (completed !== nodes.length) fail('invalid-update', stage)
}

function placementAt(span: LiveSpan, clock: number): Placement {
  if (clock === span.startClock) return span.placement
  return {
    origin: `${span.clientId}:${clock - 1}`,
    rightOrigin: span.placement.rightOrigin,
    parent: { kind: 'none' },
    parentSub: null,
  }
}

function parentEqual(left: ParentIdentity, right: ParentIdentity): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'none') return true
  if (left.kind === 'root' && right.kind === 'root') return left.name === right.name
  return left.kind === 'item'
    && right.kind === 'item'
    && left.client === right.client
    && left.clock === right.clock
}

function placementEqual(left: Placement, right: Placement): boolean {
  return left.origin === right.origin
    && left.rightOrigin === right.rightOrigin
    && parentEqual(left.parent, right.parent)
    && left.parentSub === right.parentSub
}

function contentEqualAt(
  left: LiveSpan,
  right: LiveSpan,
  startClock: number,
  endClock: number,
): boolean {
  if (left.content.kind !== right.content.kind) return false
  const leftOffset = left.contentOffset + startClock - left.startClock
  const rightOffset = right.contentOffset + startClock - right.startClock
  const length = endClock - startClock
  if (left.content.kind === 'string' && right.content.kind === 'string') {
    for (let index = 0; index < length; index += 1) {
      if (
        left.content.text.charCodeAt(leftOffset + index)
        !== right.content.text.charCodeAt(rightOffset + index)
      ) return false
    }
    return true
  }
  if (left.content.kind === 'tokens' && right.content.kind === 'tokens') {
    for (let index = 0; index < length; index += 1) {
      if (
        left.content.tokens[leftOffset + index]
        !== right.content.tokens[rightOffset + index]
      ) return false
    }
    return true
  }
  return false
}

function compareLiveOverlap(
  established: LiveSpan,
  candidate: LiveSpan,
  startClock: number,
  endClock: number,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): void {
  budget.visitIndexOperation(stage)
  if (!contentEqualAt(established, candidate, startClock, endClock)) {
    fail('invalid-update', stage)
  }
  if (!placementEqual(
    placementAt(established, startClock),
    placementAt(candidate, startClock),
  )) fail('invalid-update', stage)
  if (
    endClock > startClock + 1
    && !placementEqual(
      placementAt(established, startClock + 1),
      placementAt(candidate, startClock + 1),
    )
  ) fail('invalid-update', stage)
}

function slicedSpan(span: LiveSpan, startClock: number, endClock: number): LiveSpan {
  if (startClock === span.startClock && endClock === span.endClock) return span
  return {
    clientId: span.clientId,
    startClock,
    endClock,
    content: span.content,
    contentOffset: span.contentOffset + startClock - span.startClock,
    placement: placementAt(span, startClock),
  }
}

function subtractFromSpan(
  span: LiveSpan,
  blocked: readonly NumericRange[],
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): LiveSpan[] {
  const result: LiveSpan[] = []
  let cursor = span.startClock
  let low = 0
  let high = blocked.length
  while (low < high) {
    const middle = (low + high) >>> 1
    budget.visitIndexOperation(stage)
    if ((blocked[middle] as NumericRange).endClock <= cursor) low = middle + 1
    else high = middle
  }
  for (let index = low; index < blocked.length && cursor < span.endClock; index += 1) {
    const range = blocked[index] as NumericRange
    budget.visitIndexOperation(stage)
    if (range.startClock >= span.endClock) break
    if (range.startClock > cursor) {
      const end = Math.min(range.startClock, span.endClock)
      result.push(slicedSpan(span, cursor, end))
      budget.visitIndexOperation(stage)
    }
    if (range.endClock > cursor) cursor = Math.min(span.endClock, range.endClock)
  }
  if (cursor < span.endClock) {
    result.push(slicedSpan(span, cursor, span.endClock))
    budget.visitIndexOperation(stage)
  }
  return result
}

function retireSpans(
  spans: readonly LiveSpan[],
  deletes: ReadonlyMap<number, readonly NumericRange[]>,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): LiveSpan[] {
  const result: LiveSpan[] = []
  for (const span of spans) {
    for (const fragment of subtractFromSpan(
      span,
      deletes.get(span.clientId) ?? [],
      budget,
      stage,
    )) {
      result.push(fragment)
    }
  }
  return stableSort(result, rangeCompare, budget, stage)
}

function mergePointLists(
  left: readonly number[],
  right: readonly number[],
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): number[] {
  const result: number[] = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftValue = left[leftIndex]
    const rightValue = right[rightIndex]
    let value: number
    if (leftValue !== undefined && rightValue !== undefined) {
      budget.visitIndexOperation(stage)
    }
    if (rightValue === undefined || (leftValue !== undefined && leftValue <= rightValue)) {
      value = leftValue as number
      leftIndex += 1
    } else {
      value = rightValue
      rightIndex += 1
    }
    budget.visitIndexOperation(stage)
    if (result.length > 0) budget.visitIndexOperation(stage)
    if (result[result.length - 1] !== value) result.push(value)
  }
  return result
}

function rangesEquivalent(
  left: readonly NumericRange[],
  right: readonly NumericRange[],
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): boolean {
  budget.visitIndexOperation(stage)
  return left.length === right.length && left.every((range, index) => {
    budget.visitIndexOperation(stage)
    const other = right[index]
    return other !== undefined
      && range.clientId === other.clientId
      && range.startClock === other.startClock
      && range.endClock === other.endClock
  })
}

class ReplayFrontier {
  private structural = new Map<number, NumericRange[]>()
  private live = new Map<number, LiveSpan[]>()
  private deletes = new Map<number, NumericRange[]>()
  private unsafe = new Map<number, number[]>()
  private rawDeleteEndpoints = new Map<number, number[]>()

  apply(
    input: NormalizedInput,
    budget: ValidationBudget,
    stage: OrderedLiveUpdateCutFailureStage,
  ): void {
    proveDependencyClosure(this.structural, input.integrationNodes, budget, stage)
    for (const skip of input.skipRanges) {
      if (!rangeCovered(
        this.structural.get(skip.clientId) ?? [],
        skip.startClock,
        skip.endClock,
        budget,
        stage,
      )) fail('invalid-update', stage)
    }

    const candidateStructural = mapRanges(input.structuralRanges)
    const available = new Map<number, NumericRange[]>()
    const structuralClients = new Set([
      ...this.structural.keys(),
      ...candidateStructural.keys(),
    ])
    for (const clientId of structuralClients) {
      available.set(clientId, normalizeRanges([
        ...(this.structural.get(clientId) ?? []),
        ...(candidateStructural.get(clientId) ?? []),
      ], budget, stage))
    }
    for (const span of input.liveSpans) {
      requireCoveredIdentity(span.placement.origin, available, budget, stage)
      requireCoveredIdentity(span.placement.rightOrigin, available, budget, stage)
      if (span.placement.parent.kind === 'item') {
        if (!rangeCovered(
          available.get(span.placement.parent.client) ?? [],
          span.placement.parent.clock,
          span.placement.parent.clock + 1,
          budget,
          stage,
        )) fail('invalid-update', stage)
      }
    }
    for (const range of input.deleteRanges) {
      if (!rangeCovered(
        available.get(range.clientId) ?? [],
        range.startClock,
        range.endClock,
        budget,
        stage,
      )) fail('invalid-update', stage)
    }

    for (const [clientId, boundaries] of input.structBoundaries) {
      const priorUnsafe = this.unsafe.get(clientId) ?? []
      const ownUnsafe = input.unsafePoints.get(clientId) ?? []
      for (const boundary of boundaries) {
        if (
          pointPresent(priorUnsafe, boundary, budget, stage)
          || pointPresent(ownUnsafe, boundary, budget, stage)
        ) fail('invalid-update', stage)
      }
    }
    for (const [clientId, endpoints] of input.rawDeleteEndpoints) {
      const priorUnsafe = this.unsafe.get(clientId) ?? []
      const ownUnsafe = input.unsafePoints.get(clientId) ?? []
      for (const endpoint of endpoints) {
        if (
          pointPresent(priorUnsafe, endpoint, budget, stage)
          || pointPresent(ownUnsafe, endpoint, budget, stage)
        ) fail('invalid-update', stage)
      }
    }
    for (const [clientId, points] of input.unsafePoints) {
      const oldEndpoints = this.rawDeleteEndpoints.get(clientId) ?? []
      for (const point of points) {
        if (pointPresent(oldEndpoints, point, budget, stage)) {
          fail('invalid-update', stage)
        }
      }
    }

    const candidateLive = new Map<number, LiveSpan[]>()
    for (const span of input.liveSpans) {
      const client = candidateLive.get(span.clientId) ?? []
      client.push(span)
      candidateLive.set(span.clientId, client)
    }
    for (const [clientId, candidates] of candidateLive) {
      const established = this.live.get(clientId) ?? []
      let establishedIndex = 0
      for (const candidate of candidates) {
        while (
          establishedIndex < established.length
          && (established[establishedIndex] as LiveSpan).endClock <= candidate.startClock
        ) {
          budget.visitIndexOperation(stage)
          establishedIndex += 1
        }
        for (
          let index = establishedIndex;
          index < established.length;
          index += 1
        ) {
          const current = established[index] as LiveSpan
          budget.visitIndexOperation(stage)
          if (current.startClock >= candidate.endClock) break
          const start = Math.max(current.startClock, candidate.startClock)
          const end = Math.min(current.endClock, candidate.endClock)
          if (start < end) compareLiveOverlap(current, candidate, start, end, budget, stage)
        }
      }
    }

    const ownDeleteMap = mapRanges(input.deleteRanges)
    let tombstoneClient = -1
    let establishedStart = 0
    for (const tombstone of input.tombstones) {
      if (tombstone.clientId !== tombstoneClient) {
        tombstoneClient = tombstone.clientId
        establishedStart = 0
      }
      const established = this.live.get(tombstone.clientId) ?? []
      while (
        establishedStart < established.length
        && (established[establishedStart] as LiveSpan).endClock <= tombstone.startClock
      ) {
        budget.visitIndexOperation(stage)
        establishedStart += 1
      }
      for (let index = establishedStart; index < established.length; index += 1) {
        const span = established[index] as LiveSpan
        budget.visitIndexOperation(stage)
        if (span.startClock >= tombstone.endClock) break
        const start = Math.max(span.startClock, tombstone.startClock)
        const end = Math.min(span.endClock, tombstone.endClock)
        if (
          start < end
          && !rangeCovered(
            ownDeleteMap.get(tombstone.clientId) ?? [],
            start,
            end,
            budget,
            stage,
          )
        ) fail('invalid-update', stage)
      }
    }

    this.structural = available
    for (const [clientId, candidates] of candidateLive) {
      const existing = this.live.get(clientId) ?? []
      const blocked = normalizeRanges([
        ...existing,
        ...(this.deletes.get(clientId) ?? []),
      ], budget, stage)
      const additions: LiveSpan[] = []
      for (const span of candidates) {
        for (const fragment of subtractFromSpan(span, blocked, budget, stage)) {
          additions.push(fragment)
        }
      }
      this.live.set(
        clientId,
        stableSort([...existing, ...additions], rangeCompare, budget, stage),
      )
    }

    for (const [clientId, points] of input.unsafePoints) {
      const retained = points.filter(point => !rangeCovered(
        this.deletes.get(clientId) ?? [],
        point,
        point + 1,
        budget,
        stage,
      ))
      this.unsafe.set(
        clientId,
        mergePointLists(
          this.unsafe.get(clientId) ?? [],
          retained,
          budget,
          stage,
        ),
      )
    }

    const candidateDeletes = mapRanges(normalizeRanges([
      ...input.deleteRanges,
      ...input.tombstones,
    ], budget, stage))
    for (const [clientId, ranges] of candidateDeletes) {
      this.deletes.set(clientId, normalizeRanges([
        ...(this.deletes.get(clientId) ?? []),
        ...ranges,
      ], budget, stage))
    }
    this.live = mapLive(retireSpans(
      Array.from(this.live.values()).flat(),
      this.deletes,
      budget,
      stage,
    ))
    for (const [clientId, points] of this.unsafe) {
      const retained = points.filter(point => !rangeCovered(
        this.deletes.get(clientId) ?? [],
        point,
        point + 1,
        budget,
        stage,
      ))
      if (retained.length === 0) this.unsafe.delete(clientId)
      else this.unsafe.set(clientId, retained)
    }
    for (const [clientId, endpoints] of input.rawDeleteEndpoints) {
      this.rawDeleteEndpoints.set(
        clientId,
        mergePointLists(
          this.rawDeleteEndpoints.get(clientId) ?? [],
          endpoints,
          budget,
          stage,
        ),
      )
    }
  }

  expectedEnds(
    budget: ValidationBudget,
    stage: OrderedLiveUpdateCutFailureStage,
  ): Map<number, number> {
    const result = new Map<number, number>()
    for (const [clientId, ranges] of this.structural) {
      if (ranges.length === 0) continue
      let cursor = 0
      for (const range of ranges) {
        budget.visitIndexOperation(stage)
        if (range.startClock !== cursor) fail('invalid-update', stage)
        cursor = range.endClock
      }
      result.set(clientId, cursor)
    }
    return result
  }

  equivalent(
    other: ReplayFrontier,
    budget: ValidationBudget,
    stage: OrderedLiveUpdateCutFailureStage,
  ): boolean {
    if (!rangeMapEquivalent(this.structural, other.structural, budget, stage)) return false
    if (!rangeMapEquivalent(this.deletes, other.deletes, budget, stage)) return false
    if (!pointMapEquivalent(this.unsafe, other.unsafe, budget, stage)) return false
    const clients = new Set([...this.live.keys(), ...other.live.keys()])
    for (const clientId of clients) {
      const left = this.live.get(clientId) ?? []
      const right = other.live.get(clientId) ?? []
      let leftIndex = 0
      let rightIndex = 0
      let leftClock = left[0]?.startClock ?? 0
      let rightClock = right[0]?.startClock ?? 0
      while (leftIndex < left.length && rightIndex < right.length) {
        const leftSpan = left[leftIndex] as LiveSpan
        const rightSpan = right[rightIndex] as LiveSpan
        budget.visitIndexOperation(stage)
        if (leftClock !== rightClock) return false
        const end = Math.min(leftSpan.endClock, rightSpan.endClock)
        compareLiveOverlap(
          leftSpan,
          rightSpan,
          leftClock,
          end,
          budget,
          stage,
        )
        if (leftSpan.endClock === end) {
          leftIndex += 1
          leftClock = left[leftIndex]?.startClock ?? end
        } else leftClock = end
        if (rightSpan.endClock === end) {
          rightIndex += 1
          rightClock = right[rightIndex]?.startClock ?? end
        } else rightClock = end
      }
      if (leftIndex !== left.length || rightIndex !== right.length) return false
    }
    return true
  }

}

function mapLive(spans: readonly LiveSpan[]): Map<number, LiveSpan[]> {
  const result = new Map<number, LiveSpan[]>()
  for (const span of spans) {
    const client = result.get(span.clientId) ?? []
    client.push(span)
    result.set(span.clientId, client)
  }
  return result
}

function rangeMapEquivalent(
  left: ReadonlyMap<number, readonly NumericRange[]>,
  right: ReadonlyMap<number, readonly NumericRange[]>,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): boolean {
  budget.visitIndexOperation(stage)
  if (left.size !== right.size) return false
  for (const [clientId, ranges] of left) {
    budget.visitIndexOperation(stage)
    if (!rangesEquivalent(
      ranges,
      right.get(clientId) ?? [],
      budget,
      stage,
    )) return false
  }
  return true
}

function pointMapEquivalent(
  left: ReadonlyMap<number, readonly number[]>,
  right: ReadonlyMap<number, readonly number[]>,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): boolean {
  budget.visitIndexOperation(stage)
  if (left.size !== right.size) return false
  for (const [clientId, points] of left) {
    budget.visitIndexOperation(stage)
    const other = right.get(clientId)
    if (other === undefined) return false
    budget.visitIndexOperation(stage)
    if (points.length !== other.length) return false
    for (let index = 0; index < points.length; index += 1) {
      budget.visitIndexOperation(stage)
      if (points[index] !== other[index]) return false
    }
  }
  return true
}

function anyEncodedLength(value: unknown): number {
  if (typeof value === 'string') {
    const length = utf8Length(value)
    return 1 + varUintBytes(length) + length
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value) && Math.abs(value) <= 0x7fffffff) {
      return 1 + varIntBytes(value)
    }
    const float = new DataView(new ArrayBuffer(4))
    float.setFloat32(0, value)
    return 1 + (float.getFloat32(0) === value ? 4 : 8)
  }
  if (typeof value === 'bigint') return 9
  if (typeof value === 'boolean' || value === null || value === undefined) return 1
  if (Array.isArray(value)) {
    let length = 1 + varUintBytes(value.length)
    for (const child of value) length += anyEncodedLength(child)
    return length
  }
  if (value instanceof Uint8Array) {
    return 1 + varUintBytes(value.byteLength) + value.byteLength
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value)
    let length = 1 + varUintBytes(keys.length)
    for (const key of keys) {
      const keyLength = utf8Length(key)
      length += varUintBytes(keyLength) + keyLength
      length += anyEncodedLength((value as Record<string, unknown>)[key])
    }
    return length
  }
  return 1
}

class MeasurementComplete extends Error {
  constructor(readonly length: number) {
    super('measurement-complete')
  }
}

class CountingUpdateEncoderV1 extends Y.UpdateEncoderV1 {
  private methodBytes = 0

  constructor(
    private readonly budget: ValidationBudget,
    private readonly stage: OrderedLiveUpdateCutFailureStage,
  ) {
    super()
  }

  private add(length: number): void {
    this.methodBytes = checkedPlainAdd(
      this.methodBytes,
      length,
      'capacity-refused',
      this.stage,
    )
  }

  writeLeftID(id: Y.ID): void {
    this.add(varUintBytes(id.client) + varUintBytes(id.clock))
  }

  writeRightID(id: Y.ID): void {
    this.add(varUintBytes(id.client) + varUintBytes(id.clock))
  }

  writeClient(client: number): void {
    this.add(varUintBytes(client))
  }

  writeInfo(_info: number): void {
    this.add(1)
  }

  writeString(value: string): void {
    const length = utf8Length(value)
    this.add(varUintBytes(length) + length)
  }

  writeParentInfo(_isYKey: boolean): void {
    this.add(1)
  }

  writeTypeRef(info: number): void {
    this.add(varUintBytes(info))
  }

  writeLen(length: number): void {
    this.add(varUintBytes(length))
  }

  writeAny(value: unknown): void {
    this.add(anyEncodedLength(value))
  }

  writeBuf(value: Uint8Array): void {
    this.add(varUintBytes(value.byteLength) + value.byteLength)
  }

  writeJSON(value: unknown): void {
    const source = JSON.stringify(value)
    if (source === undefined) fail('invalid-update', this.stage)
    const length = utf8Length(source)
    this.add(varUintBytes(length) + length)
  }

  writeKey(value: string): void {
    const length = utf8Length(value)
    this.add(varUintBytes(length) + length)
  }

  writeDsClock(clock: number): void {
    this.add(varUintBytes(clock))
  }

  writeDsLen(length: number): void {
    this.add(varUintBytes(length))
  }

  toUint8Array(): never {
    const length = checkedPlainAdd(
      this.methodBytes,
      encoding.length(this.restEncoder),
      'capacity-refused',
      this.stage,
    )
    this.budget.chargeMeasuredStateBytes(length, this.stage)
    if (length > MAX_STATE_BYTES) fail('capacity-refused', this.stage)
    throw new MeasurementComplete(length)
  }
}

function measureState(
  document: Y.Doc,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): number {
  const counter = new CountingUpdateEncoderV1(budget, stage)
  try {
    Y.encodeStateAsUpdateV2(document, undefined, counter)
  } catch (error) {
    if (error instanceof MeasurementComplete) return error.length
    throw error
  }
  return fail('invalid-update', stage)
}

function stateVectorLength(expectedEnds: ReadonlyMap<number, number>): number {
  let length = varUintBytes(expectedEnds.size)
  for (const [client, clock] of expectedEnds) {
    length += varUintBytes(client) + varUintBytes(clock)
  }
  return length
}

function verifyStateVector(
  document: Y.Doc,
  expected: ReplayFrontier,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): Uint8Array {
  const ends = expected.expectedEnds(budget, stage)
  const expectedLength = stateVectorLength(ends)
  if (!safeNonnegative(expectedLength) || expectedLength > MAX_STATE_BYTES) {
    fail('capacity-refused', stage)
  }
  const vector = Y.encodeStateVector(document)
  budget.chargeStateVectorBytes(vector.byteLength, stage)
  if (vector.byteLength !== expectedLength) fail('invalid-update', stage)
  let decoded: Map<number, number>
  try {
    decoded = Y.decodeStateVector(vector)
  } catch {
    return fail('invalid-update', stage)
  }
  if (decoded.size !== ends.size) fail('invalid-update', stage)
  for (const [client, clock] of ends) {
    if (decoded.get(client) !== clock) fail('invalid-update', stage)
  }
  return vector
}

interface ProjectionTopologyCapture {
  value?: ProjectionTopology
}

interface TopologyPlacement {
  readonly parent: Exclude<ParentIdentity, { kind: 'none' }>
  readonly parentSub: string | null
}

interface TopologyScope {
  readonly active: boolean
  readonly compatible: boolean
}

function proveProjectionTopology(
  decoded: ReturnType<typeof Y.decodeUpdateV2>,
  normalized: NormalizedInput,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
): ProjectionTopology {
  const providers = new Map<number, ProviderInterval[]>()
  for (const node of stableSort(normalized.integrationNodes, rangeCompare, budget, stage)) {
    budget.visitIndexOperation(stage)
    const group = providers.get(node.clientId) ?? []
    budget.visitIndexOperation(stage)
    group.push({ startClock: node.startClock, endClock: node.endClock, nodeIndex: node.ordinal })
    budget.visitIndexOperation(stage)
    providers.set(node.clientId, group)
  }
  const deletes = new Map<number, NumericRange[]>()
  for (const range of normalized.deleteRanges) {
    budget.visitIndexOperation(stage)
    const group = deletes.get(range.clientId) ?? []
    budget.visitIndexOperation(stage)
    group.push(range)
    budget.visitIndexOperation(stage)
    deletes.set(range.clientId, group)
  }
  const placements = new Map<number, TopologyPlacement | null>()
  const provider = (id: ClosureDependency): number => {
    const index = findProvider(providers, id.clientId, id.clock, budget, stage)
    if (index === undefined) fail('invalid-update', stage)
    return index
  }
  const placement = (start: number): TopologyPlacement | null => {
    const chain: number[] = []
    const pending = new Set<number>()
    let index = start
    let resolved: TopologyPlacement | null
    while (true) {
      budget.visitIndexOperation(stage)
      if (placements.has(index)) {
        budget.visitIndexOperation(stage)
        resolved = placements.get(index) ?? null
        break
      }
      budget.visitIndexOperation(stage)
      if (pending.has(index)) fail('invalid-update', stage)
      budget.visitIndexOperation(stage)
      pending.add(index)
      budget.visitIndexOperation(stage)
      chain.push(index)
      budget.visitIndexOperation(stage)
      const node = normalized.integrationNodes[index]
      if (node === undefined) fail('invalid-update', stage)
      const own = node.placement
      if (own === null) { resolved = null; break }
      if (own.parent.kind !== 'none') {
        resolved = { parent: own.parent, parentSub: own.parentSub }
        break
      }
      const inherited = closureDependencyId(own.origin, stage)
        ?? closureDependencyId(own.rightOrigin, stage)
      if (inherited === undefined) { resolved = null; break }
      index = provider(inherited)
    }
    for (const member of chain) {
      budget.visitIndexOperation(stage)
      budget.visitIndexOperation(stage)
      placements.set(member, resolved)
    }
    return resolved
  }
  const xmlChild = (item: Y.Item): boolean => item.content instanceof Y.ContentType
    && (item.content.type instanceof Y.XmlElement || item.content.type instanceof Y.XmlText)
  const valueChild = (item: Y.Item): boolean => item.content instanceof Y.ContentAny
    || (item.content instanceof Y.ContentType
      && (item.content.type instanceof Y.Map || item.content.type instanceof Y.Array))
  const compatibleChild = (
    item: Y.Item,
    parent: string | Y.AbstractType<unknown> | undefined,
    keyed: boolean,
  ): boolean => {
    budget.visitIndexOperation(stage)
    if (parent === 'body') return !keyed && xmlChild(item)
    if (parent === 'meta') return keyed && item.content instanceof Y.ContentAny
    if (parent === 'frontmatter' || parent instanceof Y.Map) return keyed && valueChild(item)
    if (parent instanceof Y.Array) return !keyed && valueChild(item)
    if (parent instanceof Y.XmlElement) {
      return keyed ? item.content instanceof Y.ContentAny : xmlChild(item)
    }
    if (parent instanceof Y.XmlText) {
      return !keyed && (item.content instanceof Y.ContentString || item.content instanceof Y.ContentFormat)
    }
    return false
  }
  const scopes = new Map<number, TopologyScope>()
  const inactive: TopologyScope = { active: false, compatible: true }
  const incompatible: TopologyScope = { active: true, compatible: false }
  let bodyHasActiveItem = false
  const scope = (start: number): TopologyScope => {
    const chain: number[] = []
    const pending = new Set<number>()
    let index = start
    while (true) {
      budget.visitIndexOperation(stage)
      if (scopes.has(index)) break
      budget.visitIndexOperation(stage)
      if (pending.has(index)) fail('invalid-update', stage)
      budget.visitIndexOperation(stage)
      pending.add(index)
      budget.visitIndexOperation(stage)
      const node = normalized.integrationNodes[index]
      budget.visitIndexOperation(stage)
      const item = decoded.structs[index]
      if (node === undefined || item === undefined) fail('invalid-update', stage)
      budget.visitIndexOperation(stage)
      const deletedRanges = deletes.get(node.clientId) ?? []
      if (!(item instanceof Y.Item) || item.content instanceof Y.ContentDeleted
        || rangeCovered(deletedRanges, node.startClock, node.endClock, budget, stage)) {
        budget.visitIndexOperation(stage)
        scopes.set(index, inactive)
        break
      }
      const own = placement(index)
      budget.visitIndexOperation(stage)
      if (own === null) { scopes.set(index, incompatible); break }
      budget.visitIndexOperation(stage)
      chain.push(index)
      if (own.parent.kind === 'root') break
      index = provider({ clientId: own.parent.client, clock: own.parent.clock })
    }
    while (chain.length > 0) {
      budget.visitIndexOperation(stage)
      const current = chain.pop() as number
      budget.visitIndexOperation(stage)
      const item = decoded.structs[current]
      const own = placement(current)
      if (!(item instanceof Y.Item) || own === null) fail('invalid-update', stage)
      let parent: string | Y.AbstractType<unknown> | undefined
      if (own.parent.kind === 'root') {
        parent = own.parent.name
        if (parent === 'body') bodyHasActiveItem = true
      } else {
        const parentIndex = provider({ clientId: own.parent.client, clock: own.parent.clock })
        budget.visitIndexOperation(stage)
        const parentScope = scopes.get(parentIndex)
        if (parentScope === undefined) fail('invalid-update', stage)
        if (!parentScope.active) {
          budget.visitIndexOperation(stage)
          scopes.set(current, inactive)
          continue
        }
        if (!parentScope.compatible) {
          budget.visitIndexOperation(stage)
          scopes.set(current, incompatible)
          continue
        }
        budget.visitIndexOperation(stage)
        const parentItem = decoded.structs[parentIndex]
        parent = parentItem instanceof Y.Item && parentItem.content instanceof Y.ContentType
          ? parentItem.content.type : undefined
      }
      const compatible = compatibleChild(item, parent, own.parentSub !== null)
      budget.visitIndexOperation(stage)
      scopes.set(current, { active: true, compatible })
    }
    budget.visitIndexOperation(stage)
    const result = scopes.get(start)
    if (result === undefined) fail('invalid-update', stage)
    return result
  }
  for (let index = 0; index < decoded.structs.length; index += 1) {
    budget.visitIndexOperation(stage)
    if (!scope(index).compatible) return Object.freeze({ kind: 'incompatible' })
  }
  return Object.freeze({
    kind: 'compatible',
    bodyHasActiveItem,
    canonicalZeroStructSeed: decoded.structs.length === 0 && decoded.ds.clients.size === 0,
  })
}

function decodeCompleteState(
  bytes: Uint8Array,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
  topology?: ProjectionTopologyCapture,
): ReplayFrontier {
  budget.startDecoderPass(stage)
  const sink: DecoderEvidenceSink = {
    anyFingerprints: [],
    jsonFingerprints: [],
    fingerprintOnlyUsage: zeroDecoderUsage(),
  }
  const Decoder = strictDecoderClass(budget, stage, true, sink)
  let decoded: ReturnType<typeof Y.decodeUpdateV2>
  try {
    decoded = Y.decodeUpdateV2(bytes, Decoder)
    if (sink.decoder === undefined || decoding.hasContent(sink.decoder)) {
      fail('invalid-update', stage)
    }
  } catch (error) {
    if (error instanceof CutFailure) throw error
    return fail('invalid-update', stage)
  }
  const normalized = normalizeDecodedInput(
    decoded,
    sink,
    {
      structVisits: 0,
      valueNodeVisits: 0,
      decodedPayloadByteVisits: 0,
      structClientGroupVisits: 0,
      deleteClientGroupVisits: 0,
      deleteIntervalVisits: 0,
    },
    budget,
    stage,
    true,
  )
  const frontier = new ReplayFrontier()
  frontier.apply(normalized, budget, stage)
  if (topology !== undefined) topology.value = proveProjectionTopology(decoded, normalized, budget, stage)
  return frontier
}

interface CompleteProof {
  readonly stateUpdate: Uint8Array
  readonly stateVector: Uint8Array
}

function completeProof(
  document: Y.Doc,
  expected: ReplayFrontier,
  budget: ValidationBudget,
  stage: OrderedLiveUpdateCutFailureStage,
  topology?: ProjectionTopologyCapture,
): CompleteProof {
  const stateVector = verifyStateVector(document, expected, budget, stage)
  const measured = measureState(document, budget, stage)
  const stateUpdate = Y.encodeStateAsUpdate(document)
  if (stateUpdate.byteLength !== measured || stateUpdate.byteLength > MAX_STATE_BYTES) {
    fail('invalid-update', stage)
  }
  const decodedFrontier = decodeCompleteState(stateUpdate, budget, stage, topology)
  if (!expected.equivalent(decodedFrontier, budget, stage)) {
    fail('invalid-update', stage)
  }
  return { stateUpdate, stateVector }
}

function applyOwnedInput(
  entry: InputBytes,
  forecast: DecoderUsage,
  document: Y.Doc,
  budget: ValidationBudget,
): void {
  budget.startDecoderPass(entry.stage)
  const before = budget.decoderSnapshot()
  const rawDecoder = decoding.createDecoder(entry.bytes)
  const sink: DecoderEvidenceSink = {
    anyFingerprints: [],
    jsonFingerprints: [],
    fingerprintOnlyUsage: zeroDecoderUsage(),
  }
  const Decoder = strictDecoderClass(budget, entry.stage, false, sink)
  const strictDecoder = new Decoder(rawDecoder)
  try {
    Y.readUpdateV2(rawDecoder, document, null, strictDecoder)
    if (decoding.hasContent(rawDecoder)) fail('invalid-update', entry.stage)
  } catch (error) {
    if (error instanceof CutFailure) throw error
    return fail('invalid-update', entry.stage)
  }
  const observed = decoderDelta(budget.decoderSnapshot(), before, entry.stage)
  if (!decoderUsageEqual(observed, forecast)) fail('invalid-update', entry.stage)
}

function addProjectedContribution(
  current: CappedUsage,
  delta: CappedUsage,
  policy: OrderedLiveUpdateCutPolicy,
  stage: OrderedLiveUpdateCutFailureStage,
): CappedUsage {
  const next = {} as CappedUsage
  for (const field of CAPPED_USAGE_FIELDS) {
    ;(next as Record<keyof CappedUsage, number>)[field] = checkedProjectedAdd(
      current[field],
      delta[field],
      policy[POLICY_FOR_USAGE[field]],
      stage,
    )
  }
  return next
}

function decoderAsCapped(forecast: DecoderUsage): CappedUsage {
  return { ...forecast, indexOperations: 0 }
}

function cappedUsageEqual(left: CappedUsage, right: CappedUsage): boolean {
  return CAPPED_USAGE_FIELDS.every(field => left[field] === right[field])
}

function frozenInputEvidence(
  updateDigest: string,
  ranges: readonly LiveUpdateStructRange[],
): ValidatedCutInputEvidence {
  return Object.freeze({
    updateDigest,
    ranges,
  })
}

function refusalResult(
  failure: CutFailure,
  usage: OrderedLiveUpdateCutUsage,
): OrderedLiveUpdateCutRefusal {
  return Object.freeze({
    kind: 'refused',
    reason: failure.reason,
    stage: frozenStage(failure.stage),
    usage,
  })
}

interface DirtyLatch {
  dirty: boolean
}

type BeforeTransactionListener = (transaction: Y.Transaction, document: Y.Doc) => void
type DestroyListener = (document: Y.Doc) => void

interface ProofState {
  readonly document: Y.Doc
  readonly initialStateUpdate: Uint8Array
  readonly initialStateVector: Uint8Array
  readonly expectedFrontiers: ReplayFrontier
  readonly budget: ValidationBudget
  readonly beforeTransactionListener: BeforeTransactionListener
  readonly destroyListener: DestroyListener
  readonly dirtyLatch: DirtyLatch
}

function createFinalizer(
  acceptedProofState: ProofState,
  acceptedUsage: OrderedLiveUpdateCutUsage,
): () => OrderedLiveUpdateCutFinalizeResult {
  let proofState: ProofState | undefined = acceptedProofState
  let lastUsage = acceptedUsage

  return (): OrderedLiveUpdateCutFinalizeResult => {
    const state = proofState
    proofState = undefined
    if (state === undefined) {
      return refusalResult(
        new CutFailure('invalid-input', { kind: 'call' }),
        lastUsage,
      )
    }

    state.document.off('beforeTransaction', state.beforeTransactionListener)
    state.document.off('destroy', state.destroyListener)
    if (state.dirtyLatch.dirty) {
      const result = refusalResult(
        new CutFailure('projection-mutated', { kind: 'final' }),
        state.budget.snapshot(),
      )
      lastUsage = result.usage
      return result
    }

    try {
      const proof = completeProof(
        state.document,
        state.expectedFrontiers,
        state.budget,
        { kind: 'final' },
      )
      if (
        !bytesEqual(proof.stateUpdate, state.initialStateUpdate)
        || !bytesEqual(proof.stateVector, state.initialStateVector)
      ) {
        fail('projection-mutated', { kind: 'final' })
      }
      lastUsage = state.budget.snapshot()
      return Object.freeze({
        kind: 'accepted',
        stateUpdate: Uint8Array.from(proof.stateUpdate),
        stateVector: Uint8Array.from(proof.stateVector),
        usage: lastUsage,
      })
    } catch (error) {
      const failure = error instanceof CutFailure
        ? error.reason === 'capacity-refused'
          ? error
          : new CutFailure('projection-mutated', { kind: 'final' })
        : new CutFailure('projection-mutated', { kind: 'final' })
      const result = refusalResult(failure, state.budget.snapshot())
      lastUsage = result.usage
      return result
    }
  }
}

export function validateOrderedLiveUpdateCut(
  input: OwnedLiveUpdateCutInput,
  policy: OrderedLiveUpdateCutPolicy,
): OrderedLiveUpdateCutResult {
  return validateCut(input, policy)
}

export function validateRegistrationCutForProjection(
  input: Extract<OwnedLiveUpdateCutInput, { mode: 'registration' }>,
  policy: OrderedLiveUpdateCutPolicy,
): RegistrationCutForProjectionResult {
  return validateCut(input, policy, 'registration') as RegistrationCutForProjectionResult
}

export function validateJournalCutForProjection(
  input: Extract<OwnedLiveUpdateCutInput, { mode: 'journal-candidate' }>,
  policy: OrderedLiveUpdateCutPolicy,
): JournalCutForProjectionResult {
  return validateCut(input, policy, 'journal-candidate') as JournalCutForProjectionResult
}

function validateCut(
  input: OwnedLiveUpdateCutInput,
  policy: OrderedLiveUpdateCutPolicy,
  projectionMode?: OwnedLiveUpdateCutInput['mode'],
): OrderedLiveUpdateCutResult | RegistrationCutForProjectionResult | JournalCutForProjectionResult {
  const hostileInput: unknown = input
  const hostilePolicy: unknown = policy
  let budget: ValidationBudget | undefined
  let projectionDocument: Y.Doc | undefined
  try {
    const ownedPolicy = snapshotPolicy(hostilePolicy)
    budget = new ValidationBudget(ownedPolicy)
    const snapshot = snapshotInput(hostileInput, budget, projectionMode)
    const preEvidenceUsage = budget.cappedSnapshot()
    let projectedUsage = { ...preEvidenceUsage }
    const frontier = new ReplayFrontier()
    const inputEvidence: ValidatedCutInputEvidence[] = []
    const evidenceDeltas: CappedUsage[] = []
    const applyForecasts: DecoderUsage[] = []

    for (let index = 0; index < snapshot.entries.length; index += 1) {
      const entry = snapshot.entries[index] as InputBytes
      const before = budget.cappedSnapshot()
      const decoded = decodeOwnedInput(entry, budget, index === 0)
      frontier.apply(decoded.normalized, budget, entry.stage)
      const after = budget.cappedSnapshot()
      const evidenceDelta = cappedDelta(after, before, entry.stage)
      projectedUsage = addProjectedContribution(
        projectedUsage,
        evidenceDelta,
        ownedPolicy,
        entry.stage,
      )
      projectedUsage = addProjectedContribution(
        projectedUsage,
        decoderAsCapped(decoded.normalized.decoderForecast),
        ownedPolicy,
        entry.stage,
      )
      inputEvidence.push({ updateDigest: decoded.updateDigest, ranges: decoded.normalized.ranges })
      evidenceDeltas.push(evidenceDelta)
      applyForecasts.push(decoded.normalized.decoderForecast)
    }

    const lastStage = (snapshot.entries[snapshot.entries.length - 1] as InputBytes).stage
    let fromParts = { ...preEvidenceUsage }
    for (let index = 0; index < snapshot.entries.length; index += 1) {
      const stage = (snapshot.entries[index] as InputBytes).stage
      fromParts = addProjectedContribution(
        fromParts,
        evidenceDeltas[index] as CappedUsage,
        ownedPolicy,
        stage,
      )
      fromParts = addProjectedContribution(
        fromParts,
        decoderAsCapped(applyForecasts[index] as DecoderUsage),
        ownedPolicy,
        stage,
      )
    }
    let fromActual = budget.cappedSnapshot()
    for (let index = 0; index < snapshot.entries.length; index += 1) {
      fromActual = addProjectedContribution(
        fromActual,
        decoderAsCapped(applyForecasts[index] as DecoderUsage),
        ownedPolicy,
        (snapshot.entries[index] as InputBytes).stage,
      )
    }
    if (
      !cappedUsageEqual(projectedUsage, fromParts)
      || !cappedUsageEqual(projectedUsage, fromActual)
    ) fail('invalid-update', lastStage)

    const document = new Y.Doc({ gc: false })
    if (projectionMode !== undefined) projectionDocument = document
    document.getXmlFragment('body')
    document.getMap('frontmatter')
    document.getMap('meta')
    for (let index = 0; index < snapshot.entries.length; index += 1) {
      applyOwnedInput(
        snapshot.entries[index] as InputBytes,
        applyForecasts[index] as DecoderUsage,
        document,
        budget,
      )
    }

    const topology: ProjectionTopologyCapture | undefined = projectionMode !== undefined ? {} : undefined
    const initialProof = completeProof(document, frontier, budget, { kind: 'final' }, topology)
    const dirtyLatch: DirtyLatch = { dirty: false }
    const beforeTransactionListener: BeforeTransactionListener = () => {
      dirtyLatch.dirty = true
    }
    const destroyListener: DestroyListener = () => {
      dirtyLatch.dirty = true
    }
    document.on('beforeTransaction', beforeTransactionListener)
    document.on('destroy', destroyListener)
    const acceptedUsage = budget.snapshot()
    const finishAfterProjection = createFinalizer({
      document,
      initialStateUpdate: initialProof.stateUpdate,
      initialStateVector: initialProof.stateVector,
      expectedFrontiers: frontier,
      budget,
      beforeTransactionListener,
      destroyListener,
      dirtyLatch,
    }, acceptedUsage)

    let cut: ValidatedLiveUpdateCut
    if (snapshot.mode === 'registration') {
      const checkpoint = inputEvidence[0] as ValidatedCutInputEvidence
      cut = Object.freeze({
        mode: 'registration' as const,
        document,
        usage: acceptedUsage,
        finishAfterProjection,
        checkpoint: frozenInputEvidence(checkpoint.updateDigest, checkpoint.ranges),
      })
    } else {
      const candidate = inputEvidence[inputEvidence.length - 1] as ValidatedCutInputEvidence
      cut = Object.freeze({
        mode: 'journal-candidate' as const,
        document,
        usage: acceptedUsage,
        finishAfterProjection,
        checkpointDigest: (inputEvidence[0] as ValidatedCutInputEvidence).updateDigest,
        checkpointRanges: frozenInputEvidence((inputEvidence[0] as ValidatedCutInputEvidence).updateDigest, (inputEvidence[0] as ValidatedCutInputEvidence).ranges).ranges,
        suffixDigests: Object.freeze(
          inputEvidence.slice(1, 1 + snapshot.suffixCount).map(entry => entry.updateDigest),
        ),
        candidate: frozenInputEvidence(
          candidate.updateDigest,
          candidate.ranges,
        ),
      })
    }
    if (topology !== undefined) {
      if (topology.value === undefined) fail('invalid-update', { kind: 'final' })
      projectionDocument = undefined
      return Object.freeze({ kind: 'accepted', cut, topology: topology.value })
    }
    return Object.freeze({ kind: 'accepted', cut })
  } catch (error) {
    projectionDocument?.destroy()
    const failure = error instanceof CutFailure
      ? error
      : new CutFailure('invalid-input', { kind: 'call' })
    return refusalResult(failure, budget?.snapshot() ?? ZERO_USAGE)
  }
}
