import {
  LIVE_UPDATE_YJS_CLIENT_ID_MAX,
  LIVE_UPDATE_YJS_END_CLOCK_MAX,
  LIVE_UPDATE_YJS_START_CLOCK_MAX,
} from '@dohc/live-session-contract'
import * as encoding from 'lib0/encoding'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const yjsProbe = vi.hoisted(() => ({
  documentConstructions: 0,
  readUpdateV2Calls: 0,
  encodeStateAsUpdateCalls: 0,
  encodeStateVectorCalls: 0,
  digestViews: [] as Uint8Array[],
  beforeEncodeStateVector: undefined as (() => void) | undefined,
}))

vi.mock('yjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('yjs')>()
  class ProbedDoc extends actual.Doc {
    constructor(options?: ConstructorParameters<typeof actual.Doc>[0]) {
      super(options)
      yjsProbe.documentConstructions += 1
    }
  }
  return {
    ...actual,
    Doc: ProbedDoc,
    readUpdateV2: (...args: Parameters<typeof actual.readUpdateV2>) => {
      yjsProbe.readUpdateV2Calls += 1
      return actual.readUpdateV2(...args)
    },
    encodeStateAsUpdate: (...args: Parameters<typeof actual.encodeStateAsUpdate>) => {
      yjsProbe.encodeStateAsUpdateCalls += 1
      return actual.encodeStateAsUpdate(...args)
    },
    encodeStateVector: (...args: Parameters<typeof actual.encodeStateVector>) => {
      yjsProbe.encodeStateVectorCalls += 1
      yjsProbe.beforeEncodeStateVector?.()
      return actual.encodeStateVector(...args)
    },
  }
})

vi.mock('lib0/hash/sha256', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lib0/hash/sha256')>()
  return {
    ...actual,
    digest: (input: Uint8Array): Uint8Array => {
      yjsProbe.digestViews.push(input)
      return actual.digest(input)
    },
  }
})

import * as Y from 'yjs'
import * as orderedCut from './orderedLiveUpdateCut.js'
import { parseBoundedV1Json } from './boundedV1Json.js'
import {
  validateOrderedLiveUpdateCut,
  validateRegistrationCutForProjection,
  validateJournalCutForProjection,
  type OrderedLiveUpdateCutFailureStage,
  type OrderedLiveUpdateCutFinalizeResult,
  type OrderedLiveUpdateCutPolicy,
  type OrderedLiveUpdateCutRefusal,
  type OrderedLiveUpdateCutResult,
} from './orderedLiveUpdateCut.js'

const UNBOUNDED_FIXTURE_POLICY: OrderedLiveUpdateCutPolicy = {
  maxStructVisits: Number.MAX_SAFE_INTEGER,
  maxValueNodeVisits: Number.MAX_SAFE_INTEGER,
  maxDecodedPayloadByteVisits: Number.MAX_SAFE_INTEGER,
  maxStructClientGroupVisits: Number.MAX_SAFE_INTEGER,
  maxDeleteClientGroupVisits: Number.MAX_SAFE_INTEGER,
  maxDeleteIntervalVisits: Number.MAX_SAFE_INTEGER,
  maxIndexOperations: Number.MAX_SAFE_INTEGER,
}

describe('registration projection topology', () => {
  function checkpointOf(write: (document: Y.Doc) => void): Uint8Array {
    const document = new Y.Doc({ gc: false })
    document.clientID = 1
    try {
      write(document)
      return Y.encodeStateAsUpdate(document)
    } finally { document.destroy() }
  }

  function projection(checkpoint: Uint8Array, policy = highPolicy()) {
    const result = validateRegistrationCutForProjection({ mode: 'registration', checkpoint }, policy)
    expect(result.kind === 'refused' ? `${result.reason}:${stageName(result.stage)}` : result.kind)
      .toBe('accepted')
    if (result.kind !== 'accepted') throw new Error(result.reason)
    return result
  }

  it('distinguishes hidden keyed body state from a valid empty checkpoint', () => {
    const sender = new Y.Doc({ gc: false })
    sender.clientID = 1
    sender.getMap('meta').set('schemaVersion', 1)
    sender.getMap('body').set('hidden', 42)
    const malformed = Y.encodeStateAsUpdate(sender)
    sender.destroy()
    const generic = accepted(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: malformed }, highPolicy(),
    ))
    try {
      expect(generic.document.getXmlFragment('body').length).toBe(0)
      expect(generic.document.getXmlFragment('body').toArray()).toEqual([])
      expect(generic.document.getMap('meta').toJSON()).toEqual({ schemaVersion: 1 })
      expect(() => generic.document.getMap('body')).toThrow(/different constructor/)
      expect(generic.finishAfterProjection().kind).toBe('accepted')
    } finally { generic.document.destroy() }

    const validateProjection = Reflect.get(orderedCut, 'validateRegistrationCutForProjection')
    expect(validateProjection, 'private registration projection proof is missing').toBeTypeOf('function')
    for (const [checkpoint, expected] of [
      [malformed, { kind: 'incompatible' }],
      [new Uint8Array([0, 0]), { kind: 'compatible', bodyHasActiveItem: false, canonicalZeroStructSeed: true }],
    ] as const) {
      const result = validateProjection({ mode: 'registration', checkpoint }, highPolicy())
      expect(result.kind).toBe('accepted')
      if (result.kind !== 'accepted') throw new Error(result.reason)
      try {
        expect(result.topology).toEqual(expected)
        expect(result.cut.finishAfterProjection().kind).toBe('accepted')
      } finally { result.cut.document.destroy() }
    }
  })

  it('accepts metadata, XML children and nested frontmatter containers', () => {
    const metadata = checkpointOf(document => document.getMap('meta').set('schemaVersion', 1))
    const populated = checkpointOf(document => {
      document.getMap('meta').set('schemaVersion', 1)
      const element = new Y.XmlElement('paragraph')
      document.getXmlFragment('body').insert(0, [element])
      element.setAttribute('align', 'left')
      const text = new Y.XmlText()
      element.insert(0, [text])
      text.insert(0, 'hello')
      text.format(0, 3, { bold: true })
      const map = new Y.Map<unknown>()
      document.getMap('frontmatter').set('nested', map)
      const array = new Y.Array<unknown>()
      map.set('values', array)
      array.push([1, { plain: ['value'] }, new Y.Map([['key', 'value']])])
    })
    for (const [checkpoint, bodyHasActiveItem] of [[metadata, false], [populated, true]] as const) {
      const result = projection(checkpoint)
      try {
        expect(result.topology).toEqual({ kind: 'compatible', bodyHasActiveItem, canonicalZeroStructSeed: false })
        expect(Object.isFrozen(result)).toBe(true)
        expect(Object.isFrozen(result.topology)).toBe(true)
        expect(Object.isFrozen(result.cut)).toBe(true)
        expect(result.cut.finishAfterProjection().kind).toBe('accepted')
      } finally { result.cut.document.destroy() }
    }
  })

  it('checks active state while preserving deleted roots and container history', () => {
    const checkpoint = checkpointOf(document => {
      const hidden = document.getMap('body')
      hidden.set('gone', new Y.Map([['hidden', new Y.Text('old')]]))
      hidden.delete('gone')
      document.getMap('other').set('gone', 1)
      document.getMap('other').delete('gone')
      const frontmatter = document.getMap('frontmatter')
      frontmatter.set('replacement', new Y.Text('old'))
      frontmatter.set('replacement', 'current')
    })
    const result = projection(checkpoint)
    try {
      expect(result.topology).toEqual({ kind: 'compatible', bodyHasActiveItem: false, canonicalZeroStructSeed: false })
      expect(result.cut.document.getMap('frontmatter').get('replacement')).toBe('current')
      expect(result.cut.finishAfterProjection().kind).toBe('accepted')
    } finally { result.cut.document.destroy() }
  })

  it('enforces exact index budgets before return and during the real finalizer', () => {
    const checkpoint = updateWithText('budget')
    const measured = projection(checkpoint)
    const initial = measured.cut.usage.indexOperations
    const total = measured.cut.finishAfterProjection().usage.indexOperations
    measured.cut.document.destroy()
    const initialExact = projection(checkpoint, highPolicy({ maxIndexOperations: initial }))
    try {
      refused(initialExact.cut.finishAfterProjection(), 'capacity-refused', { kind: 'final' })
      refused(initialExact.cut.finishAfterProjection(), 'invalid-input', { kind: 'call' })
    } finally { initialExact.cut.document.destroy() }
    const destroy = vi.spyOn(Y.Doc.prototype, 'destroy')
    try {
      refused(validateRegistrationCutForProjection({ mode: 'registration', checkpoint },
        highPolicy({ maxIndexOperations: initial - 1 })), 'capacity-refused', { kind: 'final' })
      expect(destroy).toHaveBeenCalledTimes(1)
    } finally { destroy.mockRestore() }
    for (const [limit, kind] of [[total, 'accepted'], [total - 1, 'refused']] as const) {
      const result = projection(checkpoint, highPolicy({ maxIndexOperations: limit }))
      try { expect(result.cut.finishAfterProjection().kind).toBe(kind) }
      finally { result.cut.document.destroy() }
    }
  })

})

beforeEach(() => resetProbe())

function resetProbe(): void {
  yjsProbe.documentConstructions = 0
  yjsProbe.readUpdateV2Calls = 0
  yjsProbe.encodeStateAsUpdateCalls = 0
  yjsProbe.encodeStateVectorCalls = 0
  yjsProbe.digestViews.length = 0
  yjsProbe.beforeEncodeStateVector = undefined
}

function accepted(result: OrderedLiveUpdateCutResult) {
  expect(result.kind === 'refused' ? `${result.reason}:${stageName(result.stage)}` : result.kind)
    .toBe('accepted')
  if (result.kind !== 'accepted') throw new Error(`${result.reason}:${stageName(result.stage)}`)
  return result.cut
}

function refused(
  result: OrderedLiveUpdateCutResult | OrderedLiveUpdateCutFinalizeResult,
  reason?: OrderedLiveUpdateCutRefusal['reason'],
  stage?: OrderedLiveUpdateCutFailureStage,
): OrderedLiveUpdateCutRefusal {
  expect(result.kind).toBe('refused')
  if (result.kind !== 'refused') throw new Error('accepted unexpectedly')
  if (reason !== undefined) expect(result.reason).toBe(reason)
  if (stage !== undefined) expect(result.stage).toEqual(stage)
  return result
}

function stageName(stage: OrderedLiveUpdateCutFailureStage): string {
  if (stage.kind !== 'input') return stage.kind
  return stage.role === 'suffix' ? `${stage.role}:${stage.index}` : stage.role
}

function highPolicy(
  overrides: Partial<OrderedLiveUpdateCutPolicy> = {},
): OrderedLiveUpdateCutPolicy {
  return { ...UNBOUNDED_FIXTURE_POLICY, ...overrides }
}

function updateWithText(text: string): Uint8Array {
  const source = new Y.Doc({ gc: false })
  const xmlText = new Y.XmlText()
  xmlText.insert(0, text)
  source.getXmlFragment('body').insert(0, [xmlText])
  return Y.encodeStateAsUpdate(source)
}

function journalWithTwoDeltas(): {
  checkpoint: Uint8Array
  suffix: Uint8Array
  candidate: Uint8Array
} {
  const complete = new Y.Doc({ gc: false })
  const body = complete.getXmlFragment('body')
  const text = new Y.XmlText()
  text.insert(0, 'a')
  body.insert(0, [text])
  const checkpoint = Y.encodeStateAsUpdate(complete)
  const checkpointVector = Y.encodeStateVector(complete)
  text.insert(1, 'b')
  const suffix = Y.encodeStateAsUpdate(complete, checkpointVector)
  const suffixVector = Y.encodeStateVector(complete)
  text.insert(2, 'c')
  const candidate = Y.encodeStateAsUpdate(complete, suffixVector)
  return { checkpoint, suffix, candidate }
}

function makeStructUpdate(
  clientId: number,
  startClock: number,
  structs: readonly (Y.Item | Y.GC | Y.Skip)[],
  deletes: readonly { clientId: number; startClock: number; length: number }[] = [],
): Uint8Array {
  const encoder = new Y.UpdateEncoderV1()
  encoding.writeVarUint(encoder.restEncoder, structs.length === 0 ? 0 : 1)
  if (structs.length > 0) {
    encoding.writeVarUint(encoder.restEncoder, structs.length)
    encoder.writeClient(clientId)
    encoding.writeVarUint(encoder.restEncoder, startClock)
    for (const struct of structs) struct.write(encoder, 0)
  }
  const byClient = new Map<number, typeof deletes>()
  for (const entry of deletes) {
    const current = byClient.get(entry.clientId) ?? []
    byClient.set(entry.clientId, [...current, entry])
  }
  encoding.writeVarUint(encoder.restEncoder, byClient.size)
  for (const [deleteClient, entries] of byClient) {
    encoder.resetDsCurVal()
    encoding.writeVarUint(encoder.restEncoder, deleteClient)
    encoding.writeVarUint(encoder.restEncoder, entries.length)
    for (const entry of entries) {
      encoder.writeDsClock(entry.startClock)
      encoder.writeDsLen(entry.length)
    }
  }
  return encoder.toUint8Array()
}

function makeMultiClientStructUpdate(
  groups: readonly {
    clientId: number
    startClock: number
    structs: readonly (Y.Item | Y.GC | Y.Skip)[]
  }[],
  deletes: readonly { clientId: number; startClock: number; length: number }[] = [],
): Uint8Array {
  const encoder = new Y.UpdateEncoderV1()
  encoding.writeVarUint(encoder.restEncoder, groups.length)
  for (const group of groups) {
    encoding.writeVarUint(encoder.restEncoder, group.structs.length)
    encoder.writeClient(group.clientId)
    encoding.writeVarUint(encoder.restEncoder, group.startClock)
    for (const struct of group.structs) struct.write(encoder, 0)
  }
  const byClient = new Map<number, typeof deletes>()
  for (const entry of deletes) {
    const current = byClient.get(entry.clientId) ?? []
    byClient.set(entry.clientId, [...current, entry])
  }
  encoding.writeVarUint(encoder.restEncoder, byClient.size)
  for (const [deleteClient, entries] of byClient) {
    encoder.resetDsCurVal()
    encoding.writeVarUint(encoder.restEncoder, deleteClient)
    encoding.writeVarUint(encoder.restEncoder, entries.length)
    for (const entry of entries) {
      encoder.writeDsClock(entry.startClock)
      encoder.writeDsLen(entry.length)
    }
  }
  return encoder.toUint8Array()
}

function gcUpdate(clientId: number, startClock: number, length: number): Uint8Array {
  return makeStructUpdate(
    clientId,
    startClock,
    [new Y.GC(Y.createID(clientId, startClock), length)],
  )
}

function skipUpdate(clientId: number, startClock: number, length: number): Uint8Array {
  return makeStructUpdate(
    clientId,
    startClock,
    [new Y.Skip(Y.createID(clientId, startClock), length)],
  )
}

function withTrailingByte(update: Uint8Array): Uint8Array {
  const trailing = new Uint8Array(update.byteLength + 1)
  trailing.set(update)
  trailing[trailing.byteLength - 1] = 0
  return trailing
}

function repeatedStructClientUpdate(clientId: number): Uint8Array {
  const encoder = new Y.UpdateEncoderV1()
  encoding.writeVarUint(encoder.restEncoder, 2)
  for (const clock of [0, 1]) {
    encoding.writeVarUint(encoder.restEncoder, 1)
    encoder.writeClient(clientId)
    encoding.writeVarUint(encoder.restEncoder, clock)
    new Y.GC(Y.createID(clientId, clock), 1).write(encoder, 0)
  }
  encoding.writeVarUint(encoder.restEncoder, 0)
  return encoder.toUint8Array()
}

function repeatedDeleteClientUpdate(clientId: number): Uint8Array {
  const encoder = new Y.UpdateEncoderV1()
  encoding.writeVarUint(encoder.restEncoder, 0)
  encoding.writeVarUint(encoder.restEncoder, 2)
  for (const clock of [0, 1]) {
    encoder.resetDsCurVal()
    encoding.writeVarUint(encoder.restEncoder, clientId)
    encoding.writeVarUint(encoder.restEncoder, 1)
    encoder.writeDsClock(clock)
    encoder.writeDsLen(1)
  }
  return encoder.toUint8Array()
}

function replacementItemUpdate(
  originalUpdate: Uint8Array,
  content: ConstructorParameters<typeof Y.Item>[7],
): Uint8Array {
  const original = firstItem(originalUpdate)
  return replacementItemFrom(original, content)
}

function firstItem(originalUpdate: Uint8Array): Y.Item {
  const original = Y.decodeUpdate(originalUpdate).structs
    .find((struct): struct is Y.Item => struct instanceof Y.Item)
  if (original === undefined) throw new Error('fixture lacks an Item')
  return original
}

function replacementItemFrom(
  original: Y.Item,
  content: ConstructorParameters<typeof Y.Item>[7] = original.content,
  overrides: Partial<{
    origin: Y.ID | null
    rightOrigin: Y.ID | null
    parent: ConstructorParameters<typeof Y.Item>[5]
    parentSub: string | null
  }> = {},
): Uint8Array {
  return makeStructUpdate(original.id.client, original.id.clock, [new Y.Item(
    Y.createID(original.id.client, original.id.clock),
    null,
    overrides.origin === undefined ? original.origin : overrides.origin,
    null,
    overrides.rightOrigin === undefined ? original.rightOrigin : overrides.rightOrigin,
    overrides.parent === undefined ? original.parent : overrides.parent,
    overrides.parentSub === undefined ? original.parentSub : overrides.parentSub,
    content,
  )])
}

function firstStringItem(update: Uint8Array): Y.Item & { content: Y.ContentString } {
  const item = Y.decodeUpdate(update).structs.find(
    (struct): struct is Y.Item & { content: Y.ContentString } => (
      struct instanceof Y.Item && struct.content instanceof Y.ContentString
    ),
  )
  if (item === undefined) throw new Error('fixture lacks ContentString')
  return item
}

function slicedStringResend(
  original: Y.Item & { content: Y.ContentString },
  offset: number,
  overrides: Partial<{
    origin: Y.ID | null
    rightOrigin: Y.ID | null
    parent: ConstructorParameters<typeof Y.Item>[5]
    parentSub: string | null
  }> = {},
): Uint8Array {
  const clock = original.id.clock + offset
  return makeStructUpdate(original.id.client, clock, [new Y.Item(
    Y.createID(original.id.client, clock),
    null,
    overrides.origin === undefined
      ? Y.createID(original.id.client, clock - 1)
      : overrides.origin,
    null,
    overrides.rightOrigin === undefined ? original.rightOrigin : overrides.rightOrigin,
    overrides.parent === undefined ? null : overrides.parent,
    overrides.parentSub === undefined ? null : overrides.parentSub,
    new Y.ContentString(original.content.str.slice(offset)),
  )])
}

function exactDeletedBinaryUpdate(targetBytes: number): Uint8Array {
  let payloadLength = targetBytes - 128
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const document = new Y.Doc({ gc: false })
    document.getXmlFragment('body')
    document.getMap('meta')
    const map = document.getMap<unknown>('frontmatter')
    map.set('discarded', new Uint8Array(payloadLength))
    map.delete('discarded')
    const update = Y.encodeStateAsUpdate(document)
    if (update.byteLength === targetBytes) return update
    payloadLength += targetBytes - update.byteLength
  }
  throw new Error(`could not produce ${targetBytes} update bytes`)
}

function oneClientDenseResendUpdate(clientId: number, count: number): Uint8Array {
  return makeStructUpdate(
    clientId,
    0,
    Array.from({ length: count * 2 }, (_, clock) => (
      clock % 2 === 0
        ? new Y.GC(Y.createID(clientId, clock), 1)
        : new Y.Skip(Y.createID(clientId, clock), 1)
    )),
  )
}

function float64NaNOffset(update: Uint8Array): number {
  for (let index = 0; index + 8 < update.byteLength; index += 1) {
    if (update[index] !== 123) continue
    const value = new DataView(
      update.buffer,
      update.byteOffset + index + 1,
      8,
    ).getFloat64(0, false)
    if (Number.isNaN(value)) return index
  }
  throw new Error('fixture lacks float64 NaN')
}

function alternateFloat64NaN(update: Uint8Array): Uint8Array {
  const changed = Uint8Array.from(update)
  const offset = float64NaNOffset(changed)
  changed[offset + 8] = (changed[offset + 8] as number) ^ 1
  return changed
}

function float32NaNFromFloat64(update: Uint8Array): Uint8Array {
  const offset = float64NaNOffset(update)
  const changed = new Uint8Array(update.byteLength - 4)
  changed.set(update.subarray(0, offset), 0)
  changed.set([124, 0x7f, 0xc0, 0, 0], offset)
  changed.set(update.subarray(offset + 9), offset + 5)
  return changed
}

describe('validateOrderedLiveUpdateCut', () => {
  it('validates one owned registration cut with measured bounded evidence', () => {
    const checkpoint = updateWithText('hello')
    resetProbe()
    const cut = accepted(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint },
      UNBOUNDED_FIXTURE_POLICY,
    ))
    expect(cut.mode).toBe('registration')
    if (cut.mode !== 'registration') return
    expect(cut.checkpoint.updateDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(cut.checkpoint.ranges.length).toBeGreaterThan(0)
    expect(cut.usage.rawInputBytes).toBe(checkpoint.byteLength)
    expect(cut.usage.hashedBytes).toBe(checkpoint.byteLength)
    expect(cut.usage.decoderPasses).toBe(3)
    expect(cut.usage.stateVectorByteVisits).toBeGreaterThan(0)
    expect(cut.usage.measuredStateByteVisits).toBeGreaterThan(0)
    expect(yjsProbe.documentConstructions).toBe(1)
    expect(yjsProbe.readUpdateV2Calls).toBe(1)
    expect(yjsProbe.encodeStateVectorCalls).toBe(1)
    const finalized = cut.finishAfterProjection()
    expect(finalized.kind).toBe('accepted')
    expect(finalized.usage.decoderPasses).toBe(4)
    expect(finalized.usage.stateVectorByteVisits)
      .toBe(cut.usage.stateVectorByteVisits * 2)
    expect(finalized.usage.measuredStateByteVisits)
      .toBe(cut.usage.measuredStateByteVisits * 2)
    if (finalized.kind === 'accepted') {
      expect(finalized.stateUpdate).not.toBe(checkpoint)
      expect(Y.encodeStateVectorFromUpdate(finalized.stateUpdate)).toEqual(finalized.stateVector)
    }
    const second = cut.finishAfterProjection()
    expect(second).toEqual({
      kind: 'refused', reason: 'invalid-input', stage: { kind: 'call' },
      usage: finalized.usage,
    })
    expect(yjsProbe.readUpdateV2Calls).toBe(1)
    expect(yjsProbe.encodeStateVectorCalls).toBe(2)
  })

  it('folds checkpoint, suffix, and candidate in logical order with role-minimal evidence', () => {
    const updates = journalWithTwoDeltas()
    resetProbe()
    const cut = accepted(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint: updates.checkpoint,
      suffix: [updates.suffix], candidate: updates.candidate,
    }, highPolicy()))
    expect(cut.mode).toBe('journal-candidate')
    if (cut.mode !== 'journal-candidate') return
    expect(cut.checkpointDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(cut.suffixDigests).toHaveLength(1)
    expect(cut.candidate.updateDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(cut.candidate.ranges.length).toBeGreaterThan(0)
    expect('checkpoint' in cut).toBe(false)
    expect('suffix' in cut).toBe(false)
    expect(cut.usage.decoderPasses).toBe(7)
    expect(yjsProbe.readUpdateV2Calls).toBe(3)
    expect(yjsProbe.encodeStateVectorCalls).toBe(1)
    expect(cut.document.getXmlFragment('body').toString()).toBe('abc')
    expect(cut.finishAfterProjection().kind).toBe('accepted')
    expect(yjsProbe.encodeStateVectorCalls).toBe(2)
  })

  it('refuses reversed dependencies instead of relying on Yjs pending integration', () => {
    const updates = journalWithTwoDeltas()
    resetProbe()
    const rejection = refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint: updates.suffix,
      suffix: [], candidate: updates.checkpoint,
    }, highPolicy()), 'invalid-update', { kind: 'input', role: 'checkpoint' })
    expect(rejection.usage.decoderPasses).toBe(1)
    expect(yjsProbe.documentConstructions).toBe(0)
    expect(yjsProbe.readUpdateV2Calls).toBe(0)
  })

  it('rejects hostile call records and pins public refusal shapes', () => {
    const valid = updateWithText('shape')
    const callCases: unknown[] = [
      null, [], { mode: 'registration' },
      { mode: 'unknown', checkpoint: valid },
      { mode: 'registration', checkpoint: valid, extra: true },
      Object.assign(Object.create({ inherited: true }), {
        mode: 'registration', checkpoint: valid,
      }),
    ]
    for (const input of callCases) {
      refused(validateOrderedLiveUpdateCut(
        input as Parameters<typeof validateOrderedLiveUpdateCut>[0], highPolicy(),
      ), 'invalid-input', { kind: 'call' })
    }
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: new Uint8Array() }, highPolicy(),
    ), 'invalid-input', { kind: 'input', role: 'checkpoint' })
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: withTrailingByte(valid) }, highPolicy(),
    ), 'invalid-update', { kind: 'input', role: 'checkpoint' })
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: valid }, highPolicy({ maxStructVisits: 1 }),
    ), 'capacity-refused', { kind: 'input', role: 'checkpoint' })
    const acceptedCut = accepted(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: valid }, highPolicy(),
    ))
    acceptedCut.document.transact(() => undefined)
    expect(acceptedCut.finishAfterProjection()).toMatchObject({
      kind: 'refused', reason: 'projection-mutated', stage: { kind: 'final' },
    })
  })

  it('requires an exact positive plain policy without invoking accessors', () => {
    const checkpoint = updateWithText('policy')
    const invalid: unknown[] = [
      { ...highPolicy(), maxStructVisits: 0 },
      { ...highPolicy(), maxStructVisits: -1 },
      { ...highPolicy(), maxStructVisits: 1.5 },
      ...[-0, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(maxStructVisits => ({
        ...highPolicy(), maxStructVisits,
      })),
      { ...highPolicy(), extra: 1 },
      Object.create(highPolicy()),
    ]
    for (const policy of invalid) {
      const result = validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint }, policy as OrderedLiveUpdateCutPolicy,
      )
      const rejection = refused(result, 'invalid-input', { kind: 'call' })
      expect(rejection.usage.rawInputBytes).toBe(0)
    }
    let reads = 0
    const accessorPolicy = { ...highPolicy() } as Record<string, unknown>
    Object.defineProperty(accessorPolicy, 'maxStructVisits', {
      enumerable: true,
      get: () => { reads += 1; return 100 },
    })
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint },
      accessorPolicy as unknown as OrderedLiveUpdateCutPolicy,
    ), 'invalid-input', { kind: 'call' })
    expect(reads).toBe(0)
  })

  it('normalizes an exact Uint8Array to a clean same-buffer view without reading traps', () => {
    const checkpoint = updateWithText('view')
    const backing = new ArrayBuffer(checkpoint.byteLength + 8)
    const hostile = new Uint8Array(backing, 3, checkpoint.byteLength)
    hostile.set(checkpoint)
    let trapReads = 0
    for (const name of [
      'constructor', 'slice', 'subarray', 'buffer', 'byteOffset', 'byteLength',
      'length', Symbol.iterator, Symbol.toStringTag,
    ]) {
      Object.defineProperty(hostile, name, {
        configurable: true,
        get: () => { trapReads += 1; throw new Error('trap') },
      })
    }
    resetProbe()
    expect(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: hostile }, highPolicy(),
    ).kind).toBe('accepted')
    expect(trapReads).toBe(0)
    const digestView = yjsProbe.digestViews[0]
    expect(digestView).toBeDefined()
    if (digestView === undefined) return
    expect(digestView === hostile).toBe(false)
    expect(digestView.buffer).toBe(backing)
    expect(digestView.byteOffset).toBe(3)
    expect(digestView.byteLength).toBe(checkpoint.byteLength)
  })

  it('rejects malformed/truncated/trailing updates at the causal input stage', () => {
    const checkpoint = updateWithText('checkpoint')
    for (const malformed of [new Uint8Array([1]), checkpoint.slice(0, -1), withTrailingByte(checkpoint)]) {
      refused(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint: malformed }, highPolicy(),
      ), 'invalid-update', { kind: 'input', role: 'checkpoint' })
    }
    refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint,
      suffix: [withTrailingByte(checkpoint)], candidate: checkpoint,
    }, highPolicy()), 'invalid-update', { kind: 'input', role: 'suffix', index: 0 })
  })

  it('rejects repeated client sections, zero ranges, and ContentJSON strictly', () => {
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: repeatedStructClientUpdate(5_001) },
      highPolicy(),
    ), 'invalid-update', { kind: 'input', role: 'checkpoint' })
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: repeatedDeleteClientUpdate(5_002) },
      highPolicy(),
    ), 'invalid-update', { kind: 'input', role: 'checkpoint' })
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: gcUpdate(5_003, 0, 0) }, highPolicy(),
    ), 'invalid-update', { kind: 'input', role: 'checkpoint' })

    const ordinary = updateWithText('json')
    refused(validateOrderedLiveUpdateCut({
      mode: 'registration',
      checkpoint: replacementItemUpdate(ordinary, new Y.ContentJSON([{ allowed: true }])),
    }, highPolicy()), 'invalid-schema', { kind: 'input', role: 'checkpoint' })
  })

  it('accepts every supported Any family and accounts nested payloads cumulatively', () => {
    const source = new Y.Doc({ gc: false })
    const map = source.getMap<unknown>('frontmatter')
    const values: unknown[] = [
      undefined, null, true, false, 1, 1.25, -0, Number.NaN, 1n, 'text',
      new Uint8Array([1, 2, 3]),
      ['nested', { safe: Number.POSITIVE_INFINITY }],
      { z: 1, a: Number.NEGATIVE_INFINITY },
    ]
    values.forEach((value, index) => map.set(String(index), value))
    const checkpoint = Y.encodeStateAsUpdate(source)
    const cut = accepted(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy(),
    ))
    expect(cut.usage.valueNodeVisits).toBeGreaterThan(values.length)
    expect(cut.usage.decodedPayloadByteVisits).toBeGreaterThan(0)
    expect(cut.finishAfterProjection().kind).toBe('accepted')
  })

  it('charges exact struct, value, client-group, and delete-interval visits cumulatively', () => {
    const clientId = 6_101
    const checkpoint = makeStructUpdate(
      clientId,
      0,
      [new Y.GC(Y.createID(clientId, 0), 1)],
      [{ clientId, startClock: 0, length: 1 }],
    )
    const cut = accepted(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy(),
    ))
    expect(cut.usage).toMatchObject({
      decoderPasses: 3,
      structVisits: 3,
      structClientGroupVisits: 3,
      deleteClientGroupVisits: 3,
      deleteIntervalVisits: 3,
    })
    for (const field of [
      'maxStructVisits',
      'maxStructClientGroupVisits',
      'maxDeleteClientGroupVisits',
      'maxDeleteIntervalVisits',
    ] as const) {
      expect(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint }, highPolicy({ [field]: 3 }),
      ).kind).toBe('accepted')
      refused(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint }, highPolicy({ [field]: 2 }),
      ), 'capacity-refused', { kind: 'final' })
      resetProbe()
      refused(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint }, highPolicy({ [field]: 1 }),
      ), 'capacity-refused', { kind: 'input', role: 'checkpoint' })
      expect(yjsProbe.documentConstructions).toBe(0)
      expect(yjsProbe.readUpdateV2Calls).toBe(0)
    }

    const ordinary = updateWithText('value')
    const anyUpdate = replacementItemUpdate(ordinary, new Y.ContentAny([1]))
    const anyCut = accepted(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: anyUpdate }, highPolicy(),
    ))
    expect(anyCut.usage.valueNodeVisits).toBe(3)
    expect(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: anyUpdate },
      highPolicy({ maxValueNodeVisits: 3 }),
    ).kind).toBe('accepted')
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: anyUpdate },
      highPolicy({ maxValueNodeVisits: 2 }),
    ), 'capacity-refused', { kind: 'final' })
  })

  it('preserves Any variants, map order normalization, and raw float64 NaN bits', () => {
    const ordinary = updateWithText('any')
    const orderedMap = Object.assign(Object.create(null), { a: 1, b: true })
    const reversedMap = Object.assign(Object.create(null), { b: true, a: 1 })
    const firstMap = replacementItemUpdate(ordinary, new Y.ContentAny([orderedMap]))
    const secondMap = replacementItemUpdate(ordinary, new Y.ContentAny([reversedMap]))
    expect(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint: firstMap, suffix: [], candidate: secondMap,
    }, highPolicy()).kind).toBe('accepted')

    const firstNaN = replacementItemUpdate(ordinary, new Y.ContentAny([Number.NaN]))
    const secondNaN = alternateFloat64NaN(firstNaN)
    expect(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: firstNaN }, highPolicy(),
    ).kind).toBe('accepted')
    expect(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: secondNaN }, highPolicy(),
    ).kind).toBe('accepted')
    refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint: firstNaN, suffix: [], candidate: secondNaN,
    }, highPolicy()), 'invalid-update', { kind: 'input', role: 'candidate' })
    refused(validateOrderedLiveUpdateCut({
      mode: 'registration', checkpoint: float32NaNFromFloat64(firstNaN),
    }, highPolicy()), 'invalid-update', { kind: 'input', role: 'checkpoint' })
  })

  it('accepts exact resends, covered Skip, and huge GC without per-clock expansion', () => {
    const checkpoint = updateWithText('resend')
    const first = Y.decodeUpdate(checkpoint).structs[0]
    expect(first).toBeDefined()
    if (first === undefined) return
    const coveredSkip = skipUpdate(first.id.client, first.id.clock, 1)
    const hugeGc = gcUpdate(8_881, 0, 4_294_967_295)
    expect(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint,
      suffix: [checkpoint, coveredSkip], candidate: hugeGc,
    }, highPolicy()).kind).toBe('accepted')
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: skipUpdate(9_991, 0, 1) }, highPolicy(),
    ), 'invalid-update', { kind: 'input', role: 'checkpoint' })
    refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [],
      candidate: makeStructUpdate(7, 0, [], [{ clientId: 99_991, startClock: 0, length: 1 }]),
    }, highPolicy()), 'invalid-update', { kind: 'input', role: 'candidate' })
  })

  it('pins every portable client/start/end clock boundary without interval expansion', () => {
    expect(validateOrderedLiveUpdateCut(
      {
        mode: 'registration',
        checkpoint: gcUpdate(LIVE_UPDATE_YJS_CLIENT_ID_MAX, 0, 1),
      },
      highPolicy(),
    ).kind).toBe('accepted')
    expect(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate',
      checkpoint: gcUpdate(7, 0, LIVE_UPDATE_YJS_START_CLOCK_MAX),
      suffix: [],
      candidate: gcUpdate(7, LIVE_UPDATE_YJS_START_CLOCK_MAX, 1),
    }, highPolicy()).kind).toBe('accepted')

    for (const checkpoint of [
      gcUpdate(LIVE_UPDATE_YJS_CLIENT_ID_MAX + 1, 0, 1),
      gcUpdate(7, LIVE_UPDATE_YJS_START_CLOCK_MAX + 1, 1),
      gcUpdate(7, 0, LIVE_UPDATE_YJS_END_CLOCK_MAX + 1),
    ]) {
      refused(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint }, highPolicy(),
      ), 'invalid-update', { kind: 'input', role: 'checkpoint' })
    }
  })

  it('refuses a replay conflict that ordinary Yjs integration would discard', () => {
    const checkpoint = updateWithText('same')
    const first = Y.decodeUpdate(checkpoint).structs
      .find((struct): struct is Y.Item => struct instanceof Y.Item)
    expect(first).toBeDefined()
    if (first === undefined) return
    const conflict = new Y.Item(
      Y.createID(first.id.client, first.id.clock), null, first.origin, null,
      first.rightOrigin, first.parent, first.parentSub, new Y.ContentString('different'),
    )
    refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [],
      candidate: makeStructUpdate(first.id.client, first.id.clock, [conflict]),
    }, highPolicy()), 'invalid-update', { kind: 'input', role: 'candidate' })
  })

  it('accepts semantic depth 128 and refuses depth 129 for Any binary and JSON strings', () => {
    const nested = (leaf: unknown, depth: number): unknown => {
      let value = leaf
      for (let level = 0; level < depth; level += 1) value = [value]
      return value
    }
    const original = firstItem(updateWithText('depth-boundary'))
    const anyAt128 = replacementItemFrom(
      original,
      new Y.ContentAny([nested(new Uint8Array([1, 2, 3]), 128)]),
    )
    expect(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: anyAt128 }, highPolicy(),
    ).kind).toBe('accepted')
    const anyAt129 = replacementItemFrom(
      original,
      new Y.ContentAny([nested(new Uint8Array([1, 2, 3]), 129)]),
    )
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: anyAt129 }, highPolicy(),
    ), 'capacity-refused', { kind: 'input', role: 'checkpoint' })

    const jsonAt128 = replacementItemFrom(
      original,
      new Y.ContentEmbed(nested('leaf', 128) as object),
    )
    expect(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: jsonAt128 }, highPolicy(),
    ).kind).toBe('accepted')
    const jsonAt129 = replacementItemFrom(
      original,
      new Y.ContentEmbed(nested('leaf', 129) as object),
    )
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: jsonAt129 }, highPolicy(),
    ), 'capacity-refused', { kind: 'input', role: 'checkpoint' })
  })

  it('pins parent, origins, parentSub, and continuation placement parity', () => {
    const checkpoint = updateWithText('placement')
    const first = firstItem(checkpoint)
    const conflicts = [
      replacementItemFrom(first, first.content, {
        parent: 'frontmatter' as unknown as ConstructorParameters<typeof Y.Item>[5],
      }),
      replacementItemFrom(first, first.content, { origin: Y.createID(90_001, 0) }),
      replacementItemFrom(first, first.content, { rightOrigin: Y.createID(90_002, 0) }),
      replacementItemFrom(first, first.content, { parentSub: 'other' }),
    ]
    for (const candidate of conflicts) {
      refused(validateOrderedLiveUpdateCut({
        mode: 'journal-candidate', checkpoint, suffix: [], candidate,
      }, highPolicy()), 'invalid-update', { kind: 'input', role: 'candidate' })
    }

    const textItem = firstStringItem(checkpoint)
    expect(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [],
      candidate: slicedStringResend(textItem, 1),
    }, highPolicy()).kind).toBe('accepted')
    refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [],
      candidate: slicedStringResend(textItem, 1, { origin: null, parent: textItem.parent }),
    }, highPolicy()), 'invalid-update', { kind: 'input', role: 'candidate' })
  })

  it('guards astral interiors, raw delete endpoints, and retires deleted unsafe points', () => {
    const checkpoint = updateWithText('💩')
    const stringItem = firstStringItem(checkpoint)
    const clientId = stringItem.id.client
    const startClock = stringItem.id.clock
    const interiorSkip = skipUpdate(clientId, startClock + 1, 1)
    refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [], candidate: interiorSkip,
    }, highPolicy()), 'invalid-update', { kind: 'input', role: 'candidate' })

    for (const deletion of [
      { clientId, startClock, length: 1 },
      { clientId, startClock: startClock + 1, length: 1 },
    ]) {
      refused(validateOrderedLiveUpdateCut({
        mode: 'journal-candidate', checkpoint, suffix: [],
        candidate: makeStructUpdate(1, 0, [], [deletion]),
      }, highPolicy()), 'invalid-update', { kind: 'input', role: 'candidate' })
    }

    const fullDelete = makeStructUpdate(1, 0, [], [{
      clientId, startClock, length: 2,
    }])
    expect(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [fullDelete], candidate: interiorSkip,
    }, highPolicy()).kind).toBe('accepted')
  })

  it('requires complete delete coverage for ContentDeleted and GC and prevents resurrection', () => {
    const checkpoint = updateWithText('abc')
    const original = firstStringItem(checkpoint)
    const clientId = original.id.client
    const startClock = original.id.clock
    const deletedItem = new Y.Item(
      Y.createID(clientId, startClock), null, original.origin, null,
      original.rightOrigin, original.parent, original.parentSub,
      new Y.ContentDeleted(3),
    )
    const deletedWithoutCoverage = makeStructUpdate(clientId, startClock, [deletedItem])
    const deletedPartial = makeStructUpdate(clientId, startClock, [deletedItem], [{
      clientId, startClock, length: 2,
    }])
    const deletedComplete = makeStructUpdate(clientId, startClock, [deletedItem], [{
      clientId, startClock, length: 3,
    }])
    for (const candidate of [deletedWithoutCoverage, deletedPartial]) {
      refused(validateOrderedLiveUpdateCut({
        mode: 'journal-candidate', checkpoint, suffix: [], candidate,
      }, highPolicy()), 'invalid-update', { kind: 'input', role: 'candidate' })
    }
    const noResurrection = accepted(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint,
      suffix: [deletedComplete, replacementItemFrom(original)],
      candidate: makeStructUpdate(clientId, startClock, [
        new Y.GC(Y.createID(clientId, startClock), 3),
      ]),
    }, highPolicy()))
    expect(noResurrection.document.getXmlFragment('body').toString()).toBe('')

    const gc = new Y.GC(Y.createID(clientId, startClock), 3)
    const gcPartial = makeStructUpdate(clientId, startClock, [gc], [{
      clientId, startClock, length: 2,
    }])
    const gcComplete = makeStructUpdate(clientId, startClock, [gc], [{
      clientId, startClock, length: 3,
    }])
    refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [], candidate: gcPartial,
    }, highPolicy()), 'invalid-update', { kind: 'input', role: 'candidate' })
    expect(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [], candidate: gcComplete,
    }, highPolicy()).kind).toBe('accepted')
  })

  it('rejects a same-input dependency cycle before scratch state', () => {
    const leftId = Y.createID(88_001, 0)
    const rightId = Y.createID(88_002, 0)
    const checkpoint = makeMultiClientStructUpdate([
      {
        clientId: leftId.client,
        startClock: 0,
        structs: [new Y.Item(
          leftId, null, rightId, null, null,
          'body' as unknown as ConstructorParameters<typeof Y.Item>[5],
          null, new Y.ContentString('l'),
        )],
      },
      {
        clientId: rightId.client,
        startClock: 0,
        structs: [new Y.Item(
          rightId, null, leftId, null, null,
          'body' as unknown as ConstructorParameters<typeof Y.Item>[5],
          null, new Y.ContentString('r'),
        )],
      },
    ])
    resetProbe()
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy(),
    ), 'invalid-update', { kind: 'input', role: 'checkpoint' })
    expect(yjsProbe.documentConstructions).toBe(0)
    expect(yjsProbe.readUpdateV2Calls).toBe(0)
    expect(yjsProbe.encodeStateVectorCalls).toBe(0)
    expect(yjsProbe.encodeStateAsUpdateCalls).toBe(0)
  })

  it('accepts lawful same-input forward references', () => {
    const dependencyId = Y.createID(88_003, 0)
    const dependentId = Y.createID(88_004, 0)
    const checkpoint = makeMultiClientStructUpdate([
      {
        clientId: dependentId.client,
        startClock: 0,
        structs: [new Y.Item(
          dependentId, null, dependencyId, null, null,
          'body' as unknown as ConstructorParameters<typeof Y.Item>[5],
          null, new Y.ContentString('after'),
        )],
      },
      {
        clientId: dependencyId.client,
        startClock: 0,
        structs: [new Y.Item(
          dependencyId, null, null, null, null,
          'body' as unknown as ConstructorParameters<typeof Y.Item>[5],
          null, new Y.ContentString('before'),
        )],
      },
    ])
    expect(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy(),
    ).kind).toBe('accepted')
  })

  it('refuses dirty transaction/destroy before final proof work', () => {
    for (const dirty of ['transaction', 'destroy'] as const) {
      const checkpoint = updateWithText(dirty)
      resetProbe()
      const cut = accepted(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint }, highPolicy(),
      ))
      const readCalls = yjsProbe.readUpdateV2Calls
      const encodeCalls = yjsProbe.encodeStateAsUpdateCalls
      if (dirty === 'transaction') cut.document.transact(() => undefined)
      else cut.document.destroy()
      const result = cut.finishAfterProjection()
      expect(result).toMatchObject({
        kind: 'refused', reason: 'projection-mutated', stage: { kind: 'final' },
      })
      expect(yjsProbe.readUpdateV2Calls).toBe(readCalls)
      expect(yjsProbe.encodeStateAsUpdateCalls).toBe(encodeCalls)
      expect(result.usage).toEqual(cut.usage)
      expect(cut.finishAfterProjection().usage).toBe(result.usage)
    }
  })

  it.each(['proof'])(
    'consumes the finalizer before reentrant %s work', phase => {
      const checkpoint = updateWithText('reentrant')
      const cut = accepted(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint }, highPolicy(),
      ))
      if (phase === 'dirty-detach') cut.document.transact(() => undefined)
      const before = {
        constructions: yjsProbe.documentConstructions,
        applies: yjsProbe.readUpdateV2Calls,
        vectors: yjsProbe.encodeStateVectorCalls,
        encodes: yjsProbe.encodeStateAsUpdateCalls,
      }
      const nested: OrderedLiveUpdateCutFinalizeResult[] = []
      let didReenter = false
      const reenter = () => {
        // One entry keeps a broken finalizer from recursing without a bound.
        if (didReenter) return
        didReenter = true
        nested.push(cut.finishAfterProjection())
      }
      const originalOff = cut.document.off.bind(cut.document)
      const off = vi.spyOn(cut.document, 'off').mockImplementation((...args) => {
        if (phase === 'detach' || phase === 'dirty-detach') reenter()
        return originalOff(...args)
      })
      if (phase === 'proof' || phase === 'failed-proof') {
        yjsProbe.beforeEncodeStateVector = () => {
          reenter()
          if (phase === 'failed-proof') throw new Error('injected proof failure')
        }
      }
      try {
        const result = cut.finishAfterProjection()
        expect(nested).toHaveLength(1)
        expect(nested[0]).toMatchObject({ kind: 'refused', reason: 'invalid-input', stage: { kind: 'call' } })
        expect(nested[0]?.usage).toBe(cut.usage)
        expect(off.mock.calls.map(([event]) => event)).toEqual(expect.arrayContaining(['beforeTransaction', 'destroy']))
        if (phase === 'dirty-detach' || phase === 'failed-proof') {
          refused(result, 'projection-mutated', { kind: 'final' })
        } else {
          expect(result.kind).toBe('accepted')
        }
        expect(yjsProbe.documentConstructions).toBe(before.constructions)
        expect(yjsProbe.readUpdateV2Calls).toBe(before.applies)
        expect(yjsProbe.encodeStateVectorCalls - before.vectors).toBe(phase === 'dirty-detach' ? 0 : 1)
        expect(yjsProbe.encodeStateAsUpdateCalls - before.encodes).toBe(
          phase === 'dirty-detach' || phase === 'failed-proof' ? 0 : 1,
        )
        const repeated = refused(cut.finishAfterProjection(), 'invalid-input', { kind: 'call' })
        expect(repeated.usage).toBe(result.usage)
        expect(off).toHaveBeenCalledTimes(2)
      } finally {
        yjsProbe.beforeEncodeStateVector = undefined
        off.mockRestore()
        cut.document.destroy()
      }
    },
  )

})

describe('parseBoundedV1Json', () => {
  function parse(
    source: string | Uint8Array,
    limits: { nodes?: number; bytes?: number } = {},
    nativeParse: (text: string) => unknown = JSON.parse,
  ): { value: unknown; nodes: number; bytes: number } {
    let nodes = 0
    let bytes = 0
    const value = parseBoundedV1Json(source, {
      visitValueNode: () => {
        nodes += 1
        if (nodes > (limits.nodes ?? Number.MAX_SAFE_INTEGER)) throw new Error('nodes')
      },
      visitDecodedPayloadBytes: (length) => {
        bytes += length
        if (bytes > (limits.bytes ?? Number.MAX_SAFE_INTEGER)) throw new Error('bytes')
      },
      refuseCapacity: () => { throw new Error('depth') },
    }, nativeParse)
    return { value, nodes, bytes }
  }

  it('matches native JSON for scalars, arrays, objects, escapes, and numbers', () => {
    const values = [
      'null', 'true', 'false', '0', '-0', '1.25e+2', '"text"',
      '"\\uD800"',
      '[null,true,"astral 💩",-12.5]',
      '{"__proto__":1,"escaped\\u006bey":"\\uD83D\\uDCA9"}',
    ]
    for (const source of values) expect(parse(source).value).toEqual(JSON.parse(source))
  })

  it('rejects semantic duplicates, syntax, and fatal UTF-8 before native parse', () => {
    let nativeCalls = 0
    const native = (text: string): unknown => { nativeCalls += 1; return JSON.parse(text) }
    for (const source of [
      '{"key":1,"k\\u0065y":2}', '{"a":1,}', '[1,]', '01',
    ]) {
      expect(() => parseBoundedV1Json(source, {
        visitValueNode: () => undefined,
        visitDecodedPayloadBytes: () => undefined,
        refuseCapacity: () => { throw new Error('capacity') },
      }, native)).toThrow()
    }
    expect(nativeCalls).toBe(0)
    expect(() => parseBoundedV1Json(new Uint8Array([0x22, 0xc0, 0x22]), {
      visitValueNode: () => undefined,
      visitDecodedPayloadBytes: () => undefined,
      refuseCapacity: () => { throw new Error('capacity') },
    }, native)).toThrow()
    expect(() => parseBoundedV1Json(
      new Uint8Array([0xef, 0xbb, 0xbf, 0x74, 0x72, 0x75, 0x65]),
      {
        visitValueNode: () => undefined,
        visitDecodedPayloadBytes: () => undefined,
        refuseCapacity: () => { throw new Error('capacity') },
      },
      native,
    )).toThrow()
    expect(nativeCalls).toBe(0)
  })

  it('aggregates nodes and decoded UTF-8 bytes with exact one-over refusal', () => {
    const source = '{"a":["x",true],"astral":"💩"}'
    const measured = parse(source)
    expect(measured.nodes).toBe(5)
    expect(measured.bytes).toBe(12)
    expect(() => parse(source, { nodes: measured.nodes - 1 })).toThrow('nodes')
    expect(() => parse(source, { bytes: measured.bytes - 1 })).toThrow('bytes')
    expect(parse(source, { nodes: measured.nodes, bytes: measured.bytes }).value)
      .toEqual(JSON.parse(source))
  })

  it('enforces portable nesting depth before native parse', () => {
    const source = `${'['.repeat(129)}null${']'.repeat(129)}`
    let nativeCalls = 0
    expect(() => parseBoundedV1Json(source, {
      visitValueNode: () => undefined,
      visitDecodedPayloadBytes: () => undefined,
      refuseCapacity: () => { throw new Error('depth') },
    }, (text) => { nativeCalls += 1; return JSON.parse(text) })).toThrow('depth')
    expect(nativeCalls).toBe(0)
  })
})

describe('[held-boundary] ordered cut portable limits', () => {
  it('pins exact and one-over 20 MiB entry/state boundaries', () => {
    const exact = exactDeletedBinaryUpdate(20 * 1024 * 1024)
    expect(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: exact }, highPolicy(),
    ).kind).toBe('accepted')

    const over = new Uint8Array(exact.byteLength + 1)
    over.set(exact)
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: over }, highPolicy(),
    ), 'capacity-refused', { kind: 'input', role: 'checkpoint' })

    const almost = exactDeletedBinaryUpdate((20 * 1024 * 1024) - 1)
    const empty = Y.encodeStateAsUpdate(new Y.Doc({ gc: false }))
    expect(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint: empty,
      suffix: [almost], candidate: empty,
    }, highPolicy()).kind).toBe('accepted')
    refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint: empty,
      suffix: [exact], candidate: empty,
    }, highPolicy()), 'capacity-refused', { kind: 'input', role: 'suffix', index: 0 })

    resetProbe()
    const overState = refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint: exact, suffix: [],
      candidate: gcUpdate(91_001, 0, 1),
    }, highPolicy()), 'capacity-refused', { kind: 'final' })
    expect(overState.usage.measuredStateByteVisits).toBeGreaterThan(20 * 1024 * 1024)
    expect(yjsProbe.encodeStateAsUpdateCalls).toBe(0)
  })

  it('keeps dense nonmergeable client ranges bounded and charged', () => {
    const clientId = 100_000
    const checkpoint = gcUpdate(clientId, 0, 64)
    const candidate = oneClientDenseResendUpdate(clientId, 32)
    const cut = accepted(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [], candidate,
    }, highPolicy()))
    expect(cut.mode).toBe('journal-candidate')
    if (cut.mode !== 'journal-candidate') return
    expect(cut.candidate.ranges).toHaveLength(32)
    expect(cut.usage.structVisits).toBe(131)
    expect(cut.usage.indexOperations).toBeGreaterThan(320)
    expect(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [], candidate,
    }, highPolicy({ maxIndexOperations: cut.usage.indexOperations })).kind).toBe('accepted')
    expect(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [], candidate,
    }, highPolicy({ maxIndexOperations: cut.usage.indexOperations - 1 }))).toMatchObject({
      kind: 'refused',
      reason: 'capacity-refused',
    })
  })
})

describe('journal projection topology', () => {

  it('preserves generic journal results while proving incompatible final topology', () => {
    const doc = new Y.Doc({ gc: false })
    doc.getMap('body').set('hidden', 1)
    const candidate = Y.encodeStateAsUpdate(doc)
    doc.destroy()
    const input = { mode: 'journal-candidate' as const, checkpoint: new Uint8Array([0, 0]), suffix: [], candidate }
    resetProbe()
    const generic = accepted(validateOrderedLiveUpdateCut(input, highPolicy()))
    const calls = { ...yjsProbe, digestViews: yjsProbe.digestViews.length }
    resetProbe()
    const result = validateJournalCutForProjection(input, highPolicy())
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    try {
      expect({ ...yjsProbe, digestViews: yjsProbe.digestViews.length }).toEqual(calls)
      expect(result.topology).toEqual({ kind: 'incompatible' })
      expect(result.cut.usage).toEqual({ ...generic.usage, indexOperations: result.cut.usage.indexOperations })
      expect(result.cut.usage.indexOperations).toBeGreaterThan(generic.usage.indexOperations)
      expect(result.cut.candidate).toEqual(generic.mode === 'journal-candidate' ? generic.candidate : null)
      expect(result.cut.finishAfterProjection().kind).toBe('accepted')
      expect(generic.finishAfterProjection().kind).toBe('accepted')
    } finally { result.cut.document.destroy(); generic.document.destroy() }
  })

  it('closes journal scratch when the specialized complete proof exceeds its budget', () => {
    const input = { mode: 'journal-candidate' as const, checkpoint: updateWithText('budget'), suffix: [], candidate: new Uint8Array([0, 0]) }
    const measured = validateJournalCutForProjection(input, highPolicy())
    expect(measured.kind).toBe('accepted')
    if (measured.kind !== 'accepted') return
    const limit = measured.cut.usage.indexOperations - 1
    measured.cut.finishAfterProjection()
    measured.cut.document.destroy()
    const destroy = vi.spyOn(Y.Doc.prototype, 'destroy')
    try {
      refused(validateJournalCutForProjection(input, highPolicy({ maxIndexOperations: limit })), 'capacity-refused', { kind: 'final' })
      expect(destroy).toHaveBeenCalledTimes(1)
    } finally { destroy.mockRestore() }
  })

})
