import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Script, createContext } from 'node:vm'
import {
  LIVE_UPDATE_YJS_CLIENT_ID_MAX,
  LIVE_UPDATE_YJS_END_CLOCK_MAX,
  LIVE_UPDATE_YJS_START_CLOCK_MAX,
} from '@dohc/live-session-contract'
import * as encoding from 'lib0/encoding'
import * as ts from 'typescript/unstable/ast'
import { API as TypeScriptApi } from 'typescript/unstable/sync'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const yjsProbe = vi.hoisted(() => ({
  documentConstructions: 0,
  readUpdateV2Calls: 0,
  encodeStateAsUpdateCalls: 0,
  encodeStateVectorCalls: 0,
  digestViews: [] as Uint8Array[],
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
import { parseBoundedV1Json } from './boundedV1Json.js'
import {
  validateOrderedLiveUpdateCut,
  type OrderedLiveUpdateCutFailureStage,
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

const ORDERED_CUT_SOURCE = fileURLToPath(new URL('./orderedLiveUpdateCut.ts', import.meta.url))
const BOUNDED_JSON_SOURCE = fileURLToPath(new URL('./boundedV1Json.ts', import.meta.url))
const PACKAGE_INDEX_SOURCE = fileURLToPath(new URL('./index.ts', import.meta.url))
const PACKAGE_JSON_SOURCE = fileURLToPath(new URL('../package.json', import.meta.url))

beforeEach(() => resetProbe())

function resetProbe(): void {
  yjsProbe.documentConstructions = 0
  yjsProbe.readUpdateV2Calls = 0
  yjsProbe.encodeStateAsUpdateCalls = 0
  yjsProbe.encodeStateVectorCalls = 0
  yjsProbe.digestViews.length = 0
}

function accepted(result: OrderedLiveUpdateCutResult) {
  expect(result.kind === 'refused' ? `${result.reason}:${stageName(result.stage)}` : result.kind)
    .toBe('accepted')
  if (result.kind !== 'accepted') throw new Error(`${result.reason}:${stageName(result.stage)}`)
  return result.cut
}

function refused(
  result: OrderedLiveUpdateCutResult,
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

function assertNormalizationByteBudget(
  checkpoint: Uint8Array,
  value: string,
  decoderBytes: number,
  copiesPerEvidence: number,
): void {
  const copyBytes = new TextEncoder().encode(value).byteLength
  const normalizationBytes = copyBytes * copiesPerEvidence
  const exact = decoderBytes * 3 + normalizationBytes * 2
  const paired = decoderBytes * 2 + normalizationBytes
  const input = { mode: 'registration', checkpoint } as const
  const cut = accepted(validateOrderedLiveUpdateCut(input, highPolicy()))
  expect(cut.usage.decodedPayloadByteVisits).toBe(exact)
  expect(validateOrderedLiveUpdateCut(input, highPolicy({
    maxDecodedPayloadByteVisits: exact,
  })).kind).toBe('accepted')
  refused(validateOrderedLiveUpdateCut(input, highPolicy({
    maxDecodedPayloadByteVisits: exact - 1,
  })), 'capacity-refused', { kind: 'final' })
  resetProbe()
  refused(validateOrderedLiveUpdateCut(input, highPolicy({
    maxDecodedPayloadByteVisits: paired,
  })), 'capacity-refused', { kind: 'final' })
  expect(yjsProbe.readUpdateV2Calls).toBe(1)
  resetProbe()
  refused(validateOrderedLiveUpdateCut(input, highPolicy({
    maxDecodedPayloadByteVisits: paired - 1,
  })), 'capacity-refused', { kind: 'input', role: 'checkpoint' })
  expect(yjsProbe.documentConstructions).toBe(0)

  const originalEncode = TextEncoder.prototype.encode
  let copies = 0
  const spy = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, valueToEncode) {
    if (valueToEncode === value) copies += 1
    return originalEncode.call(this, valueToEncode)
  })
  try {
    const rejection = refused(validateOrderedLiveUpdateCut(input, highPolicy({
      maxDecodedPayloadByteVisits: decoderBytes + copyBytes - 1,
    })), 'capacity-refused', { kind: 'input', role: 'checkpoint' })
    expect(rejection.usage.decodedPayloadByteVisits).toBe(decoderBytes)
    expect(copies).toBe(0)
  } finally {
    spy.mockRestore()
  }
}

function updateWithText(text: string): Uint8Array {
  const source = new Y.Doc({ gc: false })
  const xmlText = new Y.XmlText()
  xmlText.insert(0, text)
  source.getXmlFragment('body').insert(0, [xmlText])
  return Y.encodeStateAsUpdate(source)
}

function updateWithFormatKey(key: string): Uint8Array {
  const source = new Y.Doc({ gc: false })
  const text = new Y.XmlText()
  source.getXmlFragment('body').insert(0, [text])
  text.insert(0, 'x')
  text.format(0, 1, { [key]: true })
  return Y.encodeStateAsUpdate(source)
}

function updateWithBinary(bytes: Uint8Array): Uint8Array {
  const source = new Y.Doc({ gc: false })
  source.getMap<unknown>('frontmatter').set('binary', bytes)
  return Y.encodeStateAsUpdate(source)
}

function replaceWireBytes(
  update: Uint8Array,
  original: Uint8Array,
  replacement: Uint8Array,
): Uint8Array {
  if (original.byteLength !== replacement.byteLength) throw new Error('length mismatch')
  outer: for (let index = 0; index + original.byteLength <= update.byteLength; index += 1) {
    for (let offset = 0; offset < original.byteLength; offset += 1) {
      if (update[index + offset] !== original[offset]) continue outer
    }
    const result = Uint8Array.from(update)
    result.set(replacement, index)
    return result
  }
  throw new Error('wire payload not found')
}

function prefixJsonWithBom(update: Uint8Array, json: string): Uint8Array {
  const payload = new TextEncoder().encode(json)
  if (payload.byteLength >= 125) throw new Error('fixture length must use one-byte varUint')
  outer: for (let index = 1; index + payload.byteLength <= update.byteLength; index += 1) {
    if (update[index - 1] !== payload.byteLength) continue
    for (let offset = 0; offset < payload.byteLength; offset += 1) {
      if (update[index + offset] !== payload[offset]) continue outer
    }
    const result = new Uint8Array(update.byteLength + 3)
    result.set(update.subarray(0, index - 1))
    result[index - 1] = payload.byteLength + 3
    result.set([0xef, 0xbb, 0xbf], index)
    result.set(update.subarray(index), index + 3)
    return result
  }
  throw new Error('JSON wire payload not found')
}

function replaceJsonPayload(
  update: Uint8Array,
  originalJson: string,
  replacementJson: string,
): Uint8Array {
  const original = new TextEncoder().encode(originalJson)
  const replacement = new TextEncoder().encode(replacementJson)
  if (original.byteLength >= 125 || replacement.byteLength >= 125) {
    throw new Error('fixture lengths must use one-byte varUint')
  }
  outer: for (let index = 1; index + original.byteLength <= update.byteLength; index += 1) {
    if (update[index - 1] !== original.byteLength) continue
    for (let offset = 0; offset < original.byteLength; offset += 1) {
      if (update[index + offset] !== original[offset]) continue outer
    }
    const result = new Uint8Array(update.byteLength - original.byteLength + replacement.byteLength)
    result.set(update.subarray(0, index - 1))
    result[index - 1] = replacement.byteLength
    result.set(replacement, index)
    result.set(update.subarray(index + original.byteLength), index + replacement.byteLength)
    return result
  }
  throw new Error('JSON wire payload not found')
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

function jsonItemUpdate(values: readonly unknown[]): Uint8Array {
  const clientId = 77_001
  const structs = values.map((value, index) => new Y.Item(
    Y.createID(clientId, index),
    null,
    null,
    null,
    null,
    'frontmatter' as unknown as ConstructorParameters<typeof Y.Item>[5],
    `json-${index}`,
    new Y.ContentEmbed(value as object),
  ))
  return makeStructUpdate(clientId, 0, structs)
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

function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = []
  const visit = (current: ts.Node): void => {
    result.push(current)
    current.forEachChild(visit)
  }
  visit(node)
  return result
}

function parsedSources(
  paths: readonly string[],
  override?: { path: string; text: string },
): Map<string, ts.SourceFile> {
  const api = new TypeScriptApi({
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    fs: override === undefined ? undefined : {
      readFile: path => path.replaceAll('\\', '/').toLowerCase() === override.path.replaceAll('\\', '/').toLowerCase()
        ? override.text
        : undefined,
    },
  })
  let snapshot: ReturnType<TypeScriptApi['updateSnapshot']> | undefined
  try {
    snapshot = api.updateSnapshot({ openFiles: [...paths] })
    const result = new Map<string, ts.SourceFile>()
    for (const path of paths) {
      const project = snapshot.getDefaultProjectForFile(path)
      const source = project?.program.getSourceFile(path)
      if (source === undefined) throw new Error(`TypeScript did not parse ${path}`)
      result.set(path, source)
    }
    return result
  } finally {
    snapshot?.dispose()
    api.close()
  }
}

function namedFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const declaration = source.statements.find(
    (statement): statement is ts.FunctionDeclaration => (
      ts.isFunctionDeclaration(statement) && statement.name?.text === name
    ),
  )
  if (declaration?.body === undefined) throw new Error(`missing function ${name}`)
  return declaration
}

function writesTo(
  scope: ts.Node,
  names: Set<string>,
): (ts.BinaryExpression | ts.PrefixUnaryExpression | ts.PostfixUnaryExpression)[] {
  for (const node of descendants(scope)) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const root = rootIdentifier(node.initializer)
      if (root !== undefined && names.has(root)) names.add(node.name.text)
    }
  }
  return descendants(scope).filter(
    (node): node is ts.BinaryExpression | ts.PrefixUnaryExpression | ts.PostfixUnaryExpression => {
      if (ts.isBinaryExpression(node)) {
        return ts.isAssignmentOperator(node.operatorToken.kind)
          && names.has(rootIdentifier(node.left) ?? '')
      }
      return (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
        && names.has(rootIdentifier(node.operand) ?? '')
    },
  )
}

function assertProjectedWrites(sourceAst: ts.SourceFile): void {
  const validate = namedFunction(sourceAst, 'validateOrderedLiveUpdateCut')
  const projectedNames = new Set(['projectedUsage', 'fromParts', 'fromActual'])
  const projectedAssignments = writesTo(validate, projectedNames)
  expect(projectedAssignments.length).toBeGreaterThan(0)
  for (const assignment of projectedAssignments) {
    expect(ts.isBinaryExpression(assignment)).toBe(true)
    if (!ts.isBinaryExpression(assignment)) throw new Error('unchecked projected increment')
    expect(assignment.operatorToken.kind).toBe(ts.SyntaxKind.EqualsToken)
    expect(ts.isCallExpression(assignment.right)).toBe(true)
    if (ts.isCallExpression(assignment.right)) {
      expect(assignment.right.expression.getText(sourceAst)).toBe('addProjectedContribution')
    }
  }
  for (const node of descendants(validate)) {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.PlusToken) continue
    const names = descendants(node).filter(ts.isIdentifier).map(identifier => identifier.text)
    expect(names.some(name => projectedNames.has(name))).toBe(false)
  }
  const contribution = namedFunction(sourceAst, 'addProjectedContribution')
  const componentAssignments = writesTo(contribution, new Set(['next', 'current', 'delta']))
  expect(componentAssignments).toHaveLength(1)
  const assignment = componentAssignments[0]!
  expect(ts.isBinaryExpression(assignment)).toBe(true)
  if (!ts.isBinaryExpression(assignment)) throw new Error('unchecked component increment')
  expect(assignment.operatorToken.kind).toBe(ts.SyntaxKind.EqualsToken)
  expect(ts.isCallExpression(assignment.right)).toBe(true)
  if (ts.isCallExpression(assignment.right)) {
    expect(assignment.right.expression.getText(sourceAst)).toBe('checkedProjectedAdd')
  }
  expect(writesTo(namedFunction(sourceAst, 'checkedProjectedAdd'), new Set([
    'current', 'delta', 'policy',
  ]))).toHaveLength(0)
}

function rootIdentifier(expression: ts.Expression): string | undefined {
  let current = expression
  while (true) {
    if (
      ts.isPropertyAccessExpression(current)
      || ts.isElementAccessExpression(current)
      || ts.isAsExpression(current)
      || ts.isParenthesizedExpression(current)
      || ts.isNonNullExpression(current)
    ) {
      current = current.expression
      continue
    }
    break
  }
  return ts.isIdentifier(current) ? current.text : undefined
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

  it('keeps the typed call surface closed to a generic update list', () => {
    const checkpoint = updateWithText('typed')
    if (false) {
      // @ts-expect-error The internal seam accepts only the two owned cut arms.
      validateOrderedLiveUpdateCut([checkpoint], highPolicy())
    }
    expect(true).toBe(true)
  })

  it('requires an exact positive plain policy without invoking accessors', () => {
    const checkpoint = updateWithText('policy')
    const invalid: unknown[] = [
      { ...highPolicy(), maxStructVisits: 0 },
      { ...highPolicy(), maxStructVisits: -1 },
      { ...highPolicy(), maxStructVisits: 1.5 },
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

  it('accepts a foreign-realm Uint8Array and rejects every nearby byte brand', () => {
    const checkpoint = updateWithText('realm')
    const context = createContext({ bytes: Array.from(checkpoint) })
    const foreign = new Script(`
      const buffer = new ArrayBuffer(bytes.length + 7)
      const view = new Uint8Array(buffer, 4, bytes.length)
      view.set(bytes)
      view
    `).runInContext(context) as Uint8Array
    resetProbe()
    expect(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: foreign }, highPolicy(),
    ).kind).toBe('accepted')
    expect(yjsProbe.digestViews[0]?.buffer).toBe(foreign.buffer)
    expect(yjsProbe.digestViews[0]?.byteOffset).toBe(4)
    const wrongViews: unknown[] = [
      new Int8Array(2), new Uint8ClampedArray(2), new Int16Array(2),
      new Uint16Array(2), new Int32Array(2), new Uint32Array(2),
      new Float32Array(2), new Float64Array(2), new BigInt64Array(2),
      new BigUint64Array(2), new DataView(new ArrayBuffer(2)),
      new Proxy(checkpoint, {}),
    ]
    for (const value of wrongViews) {
      refused(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint: value as Uint8Array }, highPolicy(),
      ), 'invalid-input', { kind: 'input', role: 'checkpoint' })
    }
  })

  it('rejects SharedArrayBuffer, detached, and resizable backing stores', () => {
    const checkpoint = updateWithText('backing')
    const shared = new Uint8Array(new SharedArrayBuffer(checkpoint.byteLength))
    shared.set(checkpoint)
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: shared }, highPolicy(),
    ), 'invalid-input', { kind: 'input', role: 'checkpoint' })

    const detachedBuffer = new ArrayBuffer(checkpoint.byteLength)
    const detached = new Uint8Array(detachedBuffer)
    detached.set(checkpoint)
    structuredClone(detachedBuffer, { transfer: [detachedBuffer] })
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: detached }, highPolicy(),
    ), 'invalid-input', { kind: 'input', role: 'checkpoint' })

    type ResizableArrayBufferConstructor = new (
      length: number,
      options: { maxByteLength: number },
    ) => ArrayBuffer
    const ResizableArrayBuffer = ArrayBuffer as unknown as ResizableArrayBufferConstructor
    const resizableBuffer = new ResizableArrayBuffer(checkpoint.byteLength, {
      maxByteLength: checkpoint.byteLength + 1,
    })
    const resizable = new Uint8Array(resizableBuffer)
    resizable.set(checkpoint)
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: resizable }, highPolicy(),
    ), 'invalid-input', { kind: 'input', role: 'checkpoint' })
  })

  it('rejects sparse/accessor suffixes without executing user code', () => {
    const checkpoint = updateWithText('checkpoint')
    const candidate = updateWithText('candidate')
    const sparse = new Array<Uint8Array>(1)
    refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: sparse, candidate,
    }, highPolicy()), 'invalid-input', { kind: 'call' })
    let reads = 0
    const accessor: Uint8Array[] = [checkpoint]
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get: () => { reads += 1; return checkpoint },
    })
    refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: accessor, candidate,
    }, highPolicy()), 'invalid-input', { kind: 'call' })
    expect(reads).toBe(0)
    const nonEnumerable: Uint8Array[] = [checkpoint]
    Object.defineProperty(nonEnumerable, '0', { enumerable: false, value: checkpoint })
    refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: nonEnumerable, candidate,
    }, highPolicy()), 'invalid-input', { kind: 'call' })
    refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [new Uint8Array()], candidate,
    }, highPolicy()), 'invalid-input', { kind: 'input', role: 'suffix', index: 0 })
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

  it('preflights ContentEmbed and ContentFormat JSON syntax, duplicates, UTF-8, and BOM', () => {
    const encoder = new TextEncoder()
    const embedJson = '{"a":1,"b":2}'
    const embed = replacementItemUpdate(
      updateWithText('embed'),
      new Y.ContentEmbed({ a: 1, b: 2 }),
    )
    const duplicate = replaceWireBytes(
      embed,
      encoder.encode(embedJson),
      encoder.encode('{"a":1,"a":2}'),
    )
    const malformed = replaceWireBytes(
      embed,
      encoder.encode(embedJson),
      encoder.encode('{"a":1,"b":2,'),
    )
    const badUtf8 = replaceWireBytes(
      embed,
      encoder.encode(embedJson),
      Uint8Array.from([...encoder.encode(embedJson.slice(0, -1)), 0xc0]),
    )
    const bom = prefixJsonWithBom(embed, embedJson)
    for (const checkpoint of [duplicate, malformed, badUtf8, bom]) {
      refused(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint }, highPolicy(),
      ), 'invalid-update', { kind: 'input', role: 'checkpoint' })
    }

    const format = updateWithFormatKey('format-key')
    const invalidFormatJson = replaceWireBytes(
      format,
      encoder.encode('true'),
      new Uint8Array([0xc0, 0x72, 0x75, 0x65]),
    )
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: invalidFormatJson }, highPolicy(),
    ), 'invalid-update', { kind: 'input', role: 'checkpoint' })
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

  it('dry-counts every public v1 writer family and placement shape exactly', () => {
    const source = new Y.Doc({ gc: false, guid: 'root-guid' })
    const body = source.getXmlFragment('body')
    const element = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    body.insert(0, [element])
    element.insert(0, [text])
    text.insert(0, 'formatted')
    text.format(0, text.length, { bold: true })
    const map = source.getMap<unknown>('frontmatter')
    map.set('binary', new Uint8Array([1, 2, 3]))
    map.set('nested-type', new Y.Map())
    map.set('deleted', 'gone')
    map.delete('deleted')
    source.getMap('meta').set('schemaVersion', 1)
    const checkpoint = Y.encodeStateAsUpdate(source)
    resetProbe()

    const cut = accepted(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy(),
    ))
    expect(cut.usage.measuredStateByteVisits).toBeGreaterThan(0)
    expect(yjsProbe.encodeStateAsUpdateCalls).toBe(1)
    const result = cut.finishAfterProjection()
    expect(result.kind).toBe('accepted')
    expect(yjsProbe.encodeStateAsUpdateCalls).toBe(2)
    if (result.kind === 'accepted') {
      expect(result.stateUpdate.byteLength).toBe(cut.usage.measuredStateByteVisits)
    }

    const docUpdate = replacementItemUpdate(
      updateWithText('doc'),
      new Y.ContentDoc(new Y.Doc({ guid: 'child-guid', meta: { safe: true } })),
    )
    const docCut = accepted(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: docUpdate }, highPolicy(),
    ))
    expect(docCut.finishAfterProjection().kind).toBe('accepted')
  })

  it('charges exact readString, readKey, and readBuf payload budgets', () => {
    const fixtures = [
      { checkpoint: updateWithText('payload'), exact: 33, paired: 22 },
      // Two ten-byte keys are copied in each evidence normalization, never during apply.
      { checkpoint: updateWithFormatKey('format-key'), exact: 75 + 40, paired: 50 + 20 },
      {
        checkpoint: updateWithBinary(new Uint8Array([1, 2, 3, 4, 5])),
        exact: 66,
        paired: 44,
      },
    ]
    for (const { checkpoint, exact, paired } of fixtures) {
      const cut = accepted(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint }, highPolicy(),
      ))
      expect(cut.usage.decodedPayloadByteVisits).toBe(exact)
      expect(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint },
        highPolicy({ maxDecodedPayloadByteVisits: exact }),
      ).kind).toBe('accepted')
      const oneLess = refused(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint },
        highPolicy({ maxDecodedPayloadByteVisits: exact - 1 }),
      ), 'capacity-refused', { kind: 'final' })
      expect(oneLess.usage.decodedPayloadByteVisits).toBeLessThan(exact)

      resetProbe()
      refused(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint },
        highPolicy({ maxDecodedPayloadByteVisits: paired }),
      ), 'capacity-refused', { kind: 'final' })
      expect(yjsProbe.documentConstructions).toBe(1)
      expect(yjsProbe.readUpdateV2Calls).toBe(1)

      resetProbe()
      refused(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint },
        highPolicy({ maxDecodedPayloadByteVisits: paired - 1 }),
      ), 'capacity-refused', { kind: 'input', role: 'checkpoint' })
      expect(yjsProbe.documentConstructions).toBe(0)
      expect(yjsProbe.readUpdateV2Calls).toBe(0)
    }
  })

  it('charges ContentFormat key normalization before encoding with exact byte limits', () => {
    // Each wire pass decodes body (4), text (1), and two ten-byte format keys.
    assertNormalizationByteBudget(updateWithFormatKey('format-key'), 'format-key', 25, 2)
  })

  it('charges ContentDoc GUID normalization before encoding with exact byte limits', () => {
    const guid = 'child-guid-💩'
    const checkpoint = makeStructUpdate(44_001, 0, [new Y.Item(
      Y.createID(44_001, 0), null, null, null, null,
      'frontmatter' as unknown as ConstructorParameters<typeof Y.Item>[5],
      'child', new Y.ContentDoc(new Y.Doc({ guid })),
    )])
    // Each wire pass decodes frontmatter (11), child (5), and the UTF-8 GUID (15).
    assertNormalizationByteBudget(checkpoint, guid, 31, 1)
  })

  it('aggregates scanner and canonical JSON work across several roots', () => {
    const checkpoint = jsonItemUpdate([
      { alpha: 'x' },
      { beta: 'y' },
    ])
    const cut = accepted(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy(),
    ))
    const placementBytesPerPass = (11 + 6) * 2
    const jsonBytesPerPass = (5 + 1) + (4 + 1)
    const scannerPasses = 3
    const canonicalPasses = 2
    const exactNodes = (4 * scannerPasses) + (4 * canonicalPasses)
    const exactBytes = (
      (placementBytesPerPass + jsonBytesPerPass) * scannerPasses
      + (jsonBytesPerPass * canonicalPasses)
    )
    const pairedNodes = 12
    const pairedBytes = (
      (placementBytesPerPass + jsonBytesPerPass) * 2
      + jsonBytesPerPass
    )
    expect(exactNodes).toBe(20)
    expect(exactBytes).toBe(157)
    expect(cut.usage.valueNodeVisits).toBe(exactNodes)
    expect(cut.usage.decodedPayloadByteVisits).toBe(exactBytes)
    expect(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint },
      highPolicy({
        maxValueNodeVisits: exactNodes,
        maxDecodedPayloadByteVisits: exactBytes,
      }),
    ).kind).toBe('accepted')
    const nodeOneLess = refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint },
      highPolicy({ maxValueNodeVisits: exactNodes - 1 }),
    ), 'capacity-refused', { kind: 'final' })
    expect(nodeOneLess.usage.valueNodeVisits).toBe(exactNodes - 1)
    const byteOneLess = refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint },
      highPolicy({ maxDecodedPayloadByteVisits: exactBytes - 1 }),
    ), 'capacity-refused', { kind: 'final' })
    expect(byteOneLess.usage.decodedPayloadByteVisits).toBe(exactBytes - 1)

    for (const [exactPolicy, oneLessPolicy] of [
      [
        { maxValueNodeVisits: pairedNodes },
        { maxValueNodeVisits: pairedNodes - 1 },
      ],
      [
        { maxDecodedPayloadByteVisits: pairedBytes },
        { maxDecodedPayloadByteVisits: pairedBytes - 1 },
      ],
    ] as const) {
      resetProbe()
      refused(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint }, highPolicy(exactPolicy),
      ), 'capacity-refused', { kind: 'final' })
      expect(yjsProbe.documentConstructions).toBe(1)
      resetProbe()
      refused(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint }, highPolicy(oneLessPolicy),
      ), 'capacity-refused', { kind: 'input', role: 'checkpoint' })
      expect(yjsProbe.documentConstructions).toBe(0)
    }
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

  it('refuses hostile Any map keys before integrating them', () => {
    const ordinary = updateWithText('hostile-key')
    const hostile: Record<string, unknown> = Object.create(null)
    hostile.__proto__ = true
    refused(validateOrderedLiveUpdateCut({
      mode: 'registration',
      checkpoint: replacementItemUpdate(ordinary, new Y.ContentAny([hostile])),
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

  it('pins exact resends and cross-kind conflicts for every live content family', () => {
    const base = updateWithText('x')
    const original = firstItem(base)
    const contentUpdates = [
      replacementItemFrom(original, new Y.ContentString('x')),
      replacementItemFrom(original, new Y.ContentAny([1])),
      replacementItemFrom(original, new Y.ContentBinary(new Uint8Array([1]))),
      replacementItemFrom(original, new Y.ContentEmbed({ safe: true })),
      replacementItemFrom(original, new Y.ContentFormat('bold', true)),
      replacementItemFrom(original, new Y.ContentType(new Y.Map())),
      replacementItemFrom(
        original,
        new Y.ContentDoc(new Y.Doc({ guid: 'content-doc', meta: { safe: true } })),
      ),
    ]
    for (let index = 0; index < contentUpdates.length; index += 1) {
      const checkpoint = contentUpdates[index] as Uint8Array
      expect(validateOrderedLiveUpdateCut({
        mode: 'journal-candidate', checkpoint, suffix: [], candidate: checkpoint,
      }, highPolicy()).kind).toBe('accepted')
      const conflicting = contentUpdates[(index + 1) % contentUpdates.length] as Uint8Array
      refused(validateOrderedLiveUpdateCut({
        mode: 'journal-candidate', checkpoint, suffix: [], candidate: conflicting,
      }, highPolicy()), 'invalid-update', { kind: 'input', role: 'candidate' })
    }

    refused(validateOrderedLiveUpdateCut({
      mode: 'registration',
      checkpoint: replacementItemFrom(
        original,
        new Y.ContentType(new Y.XmlHook('forbidden-hook')),
      ),
    }, highPolicy()), 'invalid-schema', { kind: 'input', role: 'checkpoint' })
  })

  it('rejects same-kind payload mutations and accepts reordered JSON objects', () => {
    const original = firstItem(updateWithText('payload-kinds'))
    const pairs: readonly [Uint8Array, Uint8Array][] = [
      [
        replacementItemFrom(original, new Y.ContentBinary(new Uint8Array([1, 2]))),
        replacementItemFrom(original, new Y.ContentBinary(new Uint8Array([1, 3]))),
      ],
      [
        replacementItemFrom(original, new Y.ContentType(new Y.Map())),
        replacementItemFrom(original, new Y.ContentType(new Y.Array())),
      ],
      [
        replacementItemFrom(
          original,
          new Y.ContentDoc(new Y.Doc({ guid: 'doc-a', meta: { version: 1 } })),
        ),
        replacementItemFrom(
          original,
          new Y.ContentDoc(new Y.Doc({ guid: 'doc-b', meta: { version: 1 } })),
        ),
      ],
      [
        replacementItemFrom(original, new Y.ContentEmbed({ nested: { value: 1 } })),
        replacementItemFrom(original, new Y.ContentEmbed({ nested: { value: 2 } })),
      ],
      [
        replacementItemFrom(original, new Y.ContentFormat('weight', { value: 1 })),
        replacementItemFrom(original, new Y.ContentFormat('weight', { value: 2 })),
      ],
    ]
    for (const [checkpoint, candidate] of pairs) {
      refused(validateOrderedLiveUpdateCut({
        mode: 'journal-candidate', checkpoint, suffix: [], candidate,
      }, highPolicy()), 'invalid-update', { kind: 'input', role: 'candidate' })
    }

    const ordered = replacementItemFrom(
      original,
      new Y.ContentEmbed({ alpha: 1, beta: { first: true, second: false } }),
    )
    const reordered = replacementItemFrom(
      original,
      new Y.ContentEmbed({ beta: { second: false, first: true }, alpha: 1 }),
    )
    expect(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint: ordered, suffix: [], candidate: reordered,
    }, highPolicy()).kind).toBe('accepted')

    for (const [left, right] of [
      ['\uD800', '\uD801'],
      ['\uD800', '\uFFFD'],
      [{ ['\uD800']: 1 }, { ['\uD801']: 1 }],
      [{ ['\uD800']: 1 }, { ['\uFFFD']: 1 }],
    ] as const) {
      const checkpoint = replacementItemFrom(original, new Y.ContentEmbed(left))
      const candidate = replacementItemFrom(original, new Y.ContentEmbed(right))
      refused(validateOrderedLiveUpdateCut({
        mode: 'journal-candidate', checkpoint, suffix: [], candidate,
      }, highPolicy()), 'invalid-update', { kind: 'input', role: 'candidate' })
    }

    const plainKeyJson = '{"key":1}'
    const escapedKeyJson = '{"\\u006bey":1}'
    const plainKey = replacementItemFrom(original, new Y.ContentEmbed({ key: 1 }))
    const escapedKey = replaceJsonPayload(plainKey, plainKeyJson, escapedKeyJson)
    expect(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint: plainKey, suffix: [], candidate: escapedKey,
    }, highPolicy()).kind).toBe('accepted')

    for (const [plain, escaped, plainJson, escapedJson] of [
      ['\uD800', '\uD800', '"\\ud800"', '"\\uD800"'],
      ['💩', '💩', '"💩"', '"\\ud83d\\udca9"'],
      [{ ['\uD800']: 1 }, { ['\uD800']: 1 }, '{"\\ud800":1}', '{"\\uD800":1}'],
    ] as const) {
      const checkpoint = replacementItemFrom(original, new Y.ContentEmbed(plain))
      const candidate = replaceJsonPayload(
        replacementItemFrom(original, new Y.ContentEmbed(escaped)),
        plainJson,
        escapedJson,
      )
      expect(validateOrderedLiveUpdateCut({
        mode: 'journal-candidate', checkpoint, suffix: [], candidate,
      }, highPolicy()).kind).toBe('accepted')
    }
  })

  it('pins canonical tree frames, digest counts, and linear leaf hashing', () => {
    const treeInputs = (value: unknown): {
      readonly cut: ReturnType<typeof accepted>
      readonly inputs: Uint8Array[]
      readonly rawBytes: number
    } => {
      resetProbe()
      const checkpoint = jsonItemUpdate([value])
      const cut = accepted(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint }, highPolicy(),
      ))
      return {
        cut,
        inputs: yjsProbe.digestViews
          .filter(view => view[0] === 0x79)
          .map(view => Uint8Array.from(view)),
        rawBytes: checkpoint.byteLength,
      }
    }

    for (const [value, tag] of [
      [null, 10],
      [false, 11],
      [true, 12],
      [0, 13],
      ['', 14],
      [[], 15],
      [{}, 16],
    ] as const) {
      const proof = treeInputs(value)
      expect(proof.inputs).toHaveLength(2)
      expect(proof.inputs[0]?.subarray(0, 2)).toEqual(new Uint8Array([0x79, tag]))
      expect(proof.inputs[1]).toEqual(proof.inputs[0])
      expect(yjsProbe.digestViews).toHaveLength(3)
      expect(proof.cut.usage.hashedBytes).toBe(
        proof.rawBytes + (proof.inputs[0]?.byteLength ?? 0) * 2,
      )
    }

    const arrayProof = treeInputs([null, true])
    const arrayFrames = arrayProof.inputs.filter(input => input[1] === 15)
    expect(arrayProof.inputs).toHaveLength(6)
    expect(arrayFrames).toHaveLength(2)
    expect(arrayFrames[0]?.byteLength).toBe(67)
    expect(arrayFrames[0]?.subarray(0, 3)).toEqual(new Uint8Array([0x79, 15, 2]))

    const mapProof = treeInputs({ b: false, a: null })
    const mapFrames = mapProof.inputs.filter(input => input[1] === 16)
    expect(mapProof.inputs).toHaveLength(6)
    expect(mapFrames).toHaveLength(2)
    expect(mapFrames[0]?.byteLength).toBe(71)
    expect(mapFrames[0]?.subarray(0, 5)).toEqual(new Uint8Array([0x79, 16, 2, 1, 0x61]))
    expect(mapFrames[0]?.subarray(37, 39)).toEqual(new Uint8Array([1, 0x62]))

    const surrogateKeyProof = treeInputs({ ['\uD800']: null })
    const surrogateMap = surrogateKeyProof.inputs.find(input => input[1] === 16)
    const replacementKeyProof = treeInputs({ ['\uFFFD']: null })
    expect(replacementKeyProof.cut.usage.decodedPayloadByteVisits).toBe(66)
    expect(surrogateKeyProof.cut.usage.decodedPayloadByteVisits).toBe(72)
    expect(surrogateKeyProof.cut.usage.decodedPayloadByteVisits).toBe(
      replacementKeyProof.cut.usage.decodedPayloadByteVisits + 6,
    )
    expect(surrogateMap?.subarray(0, 7)).toEqual(
      new Uint8Array([0x79, 16, 1, 3, 0xff, 0xd8, 0x00]),
    )

    const nested = (leaf: string): unknown => {
      let value: unknown = leaf
      for (let depth = 0; depth < 128; depth += 1) value = [value]
      return value
    }
    const shortLeaf = treeInputs(nested('a')).inputs
    const longLeaf = treeInputs(nested('bb')).inputs
    expect(shortLeaf).toHaveLength(258)
    expect(longLeaf).toHaveLength(258)
    expect(longLeaf.reduce((sum, input) => sum + input.byteLength, 0)).toBe(
      shortLeaf.reduce((sum, input) => sum + input.byteLength, 0) + 2,
    )
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

  it('isolates origin and right-origin parity with covered dependency IDs', () => {
    const targetDocument = new Y.Doc({ gc: false })
    const targetText = new Y.XmlText()
    targetDocument.getXmlFragment('body').insert(0, [targetText])
    targetDocument.transact(() => targetText.insert(0, 'a'))
    targetDocument.transact(() => targetText.insert(0, 'b'))
    const targetUpdate = Y.encodeStateAsUpdate(targetDocument)
    const coveredUpdate = updateWithText('covered-placement')
    const target = Y.decodeUpdate(targetUpdate).structs.find(
      (struct): struct is Y.Item => (
        struct instanceof Y.Item
        && (struct.origin !== null || struct.rightOrigin !== null)
      ),
    )
    const covered = Y.decodeUpdate(coveredUpdate).structs.find(
      (struct): struct is Y.Item => struct instanceof Y.Item,
    )
    if (target === undefined || covered === undefined) throw new Error('missing placement Item')
    expect(target.origin !== null || target.rightOrigin !== null).toBe(true)
    expect(covered.id.client).not.toBe(target.id.client)
    const checkpoint = Y.mergeUpdates([targetUpdate, coveredUpdate])
    const mergedStructs = Y.decodeUpdate(checkpoint).structs
    const containsId = (id: Y.ID): boolean => mergedStructs.some(struct => (
      struct.id.client === id.client
      && struct.id.clock <= id.clock
      && id.clock < struct.id.clock + struct.length
    ))
    const originalReference = target.origin ?? target.rightOrigin
    if (originalReference === null) throw new Error('missing original placement reference')
    expect(containsId(originalReference)).toBe(true)
    expect(containsId(covered.id)).toBe(true)
    for (const candidate of [
      replacementItemFrom(target, target.content, { origin: covered.id }),
      replacementItemFrom(target, target.content, { rightOrigin: covered.id }),
    ]) {
      resetProbe()
      refused(validateOrderedLiveUpdateCut({
        mode: 'journal-candidate', checkpoint, suffix: [], candidate,
      }, highPolicy()), 'invalid-update', { kind: 'input', role: 'candidate' })
      expect(yjsProbe.documentConstructions).toBe(0)
      expect(yjsProbe.readUpdateV2Calls).toBe(0)
    }
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

  it('pins final state-vector content and rejects uncovered effects before ordinary encoding', () => {
    const checkpoint = makeStructUpdate(71, 0, [new Y.GC(Y.createID(71, 0), 2)])
    const candidate = makeStructUpdate(72, 0, [new Y.GC(Y.createID(72, 0), 3)])
    const cut = accepted(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [], candidate,
    }, highPolicy()))
    const final = cut.finishAfterProjection()
    expect(final.kind).toBe('accepted')
    if (final.kind === 'accepted') {
      expect(Y.decodeStateVector(final.stateVector)).toEqual(new Map([
        [71, 2],
        [72, 3],
      ]))
    }

    resetProbe()
    const uncovered = makeStructUpdate(1, 0, [], [{
      clientId: 98_001, startClock: 0, length: 1,
    }])
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: uncovered }, highPolicy(),
    ), 'invalid-update', { kind: 'input', role: 'checkpoint' })
    expect(yjsProbe.documentConstructions).toBe(0)
    expect(yjsProbe.readUpdateV2Calls).toBe(0)
    expect(yjsProbe.encodeStateAsUpdateCalls).toBe(0)
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

  it('rejects right-origin and item-parent dependency cycles before scratch state', () => {
    const leftId = Y.createID(88_011, 0)
    const rightId = Y.createID(88_012, 0)
    const cycles = [
      makeMultiClientStructUpdate([
        {
          clientId: leftId.client,
          startClock: 0,
          structs: [new Y.Item(
            leftId, null, null, null, rightId, null, null,
            new Y.ContentString('left'),
          )],
        },
        {
          clientId: rightId.client,
          startClock: 0,
          structs: [new Y.Item(
            rightId, null, null, null, leftId, null, null,
            new Y.ContentString('right'),
          )],
        },
      ]),
      makeMultiClientStructUpdate([
        {
          clientId: leftId.client,
          startClock: 0,
          structs: [new Y.Item(
            leftId, null, null, null, null, rightId, null,
            new Y.ContentString('left'),
          )],
        },
        {
          clientId: rightId.client,
          startClock: 0,
          structs: [new Y.Item(
            rightId, null, null, null, null, leftId, null,
            new Y.ContentString('right'),
          )],
        },
      ]),
    ]
    for (const checkpoint of cycles) {
      resetProbe()
      refused(validateOrderedLiveUpdateCut(
        { mode: 'registration', checkpoint }, highPolicy(),
      ), 'invalid-update', { kind: 'input', role: 'checkpoint' })
      expect(yjsProbe.documentConstructions).toBe(0)
      expect(yjsProbe.readUpdateV2Calls).toBe(0)
      expect(yjsProbe.encodeStateVectorCalls).toBe(0)
      expect(yjsProbe.encodeStateAsUpdateCalls).toBe(0)
    }
  })

  it('rejects a same-client future dependency cycle before scratch state', () => {
    const clientId = 88_021
    const checkpoint = makeStructUpdate(clientId, 0, [
      new Y.Item(
        Y.createID(clientId, 0), null, Y.createID(clientId, 1), null, null,
        'body' as unknown as ConstructorParameters<typeof Y.Item>[5],
        null, new Y.ContentString('a'),
      ),
      new Y.Item(
        Y.createID(clientId, 1), null, null, null, null,
        'body' as unknown as ConstructorParameters<typeof Y.Item>[5],
        null, new Y.ContentString('b'),
      ),
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

  it('retains GC and ContentDeleted nodes in dependency closure', () => {
    const gcId = Y.createID(88_031, 0)
    const deletedId = Y.createID(88_032, 0)
    const tailId = Y.createID(88_033, 0)
    const checkpoint = makeMultiClientStructUpdate([
      {
        clientId: gcId.client,
        startClock: 0,
        structs: [new Y.GC(gcId, 1)],
      },
      {
        clientId: deletedId.client,
        startClock: 0,
        structs: [new Y.Item(
          deletedId, null, gcId, null, null, null, null,
          new Y.ContentDeleted(1),
        )],
      },
      {
        clientId: tailId.client,
        startClock: 0,
        structs: [new Y.Item(
          tailId, null, deletedId, null, null, null, null,
          new Y.ContentDeleted(1),
        )],
      },
    ], [
      { clientId: deletedId.client, startClock: 0, length: 1 },
      { clientId: tailId.client, startClock: 0, length: 1 },
    ])
    expect(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy(),
    ).kind).toBe('accepted')

    const missingGc = gcUpdate(gcId.client, 1, 1)
    resetProbe()
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint: missingGc }, highPolicy(),
    ), 'invalid-update', { kind: 'input', role: 'checkpoint' })
    expect(yjsProbe.documentConstructions).toBe(0)
    expect(yjsProbe.readUpdateV2Calls).toBe(0)
  })

  it('rejects ContentDeleted cycles before scratch state', () => {
    const leftId = Y.createID(88_041, 0)
    const rightId = Y.createID(88_042, 0)
    const checkpoint = makeMultiClientStructUpdate([
      {
        clientId: leftId.client,
        startClock: 0,
        structs: [new Y.Item(
          leftId, null, rightId, null, null, null, null,
          new Y.ContentDeleted(1),
        )],
      },
      {
        clientId: rightId.client,
        startClock: 0,
        structs: [new Y.Item(
          rightId, null, leftId, null, null, null, null,
          new Y.ContentDeleted(1),
        )],
      },
    ], [
      { clientId: leftId.client, startClock: 0, length: 1 },
      { clientId: rightId.client, startClock: 0, length: 1 },
    ])
    resetProbe()
    refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy(),
    ), 'invalid-update', { kind: 'input', role: 'checkpoint' })
    expect(yjsProbe.documentConstructions).toBe(0)
    expect(yjsProbe.readUpdateV2Calls).toBe(0)
  })

  it('accepts a partial resend tail and blocks a cyclic duplicate node', () => {
    const clientId = 88_051
    const checkpoint = gcUpdate(clientId, 0, 1)
    const tail = makeStructUpdate(clientId, 0, [new Y.GC(Y.createID(clientId, 0), 2)])
    expect(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [], candidate: tail,
    }, highPolicy()).kind).toBe('accepted')

    const itemClient = 88_052
    const root = makeStructUpdate(itemClient, 0, [new Y.Item(
      Y.createID(itemClient, 0), null, null, null, null,
      'body' as unknown as ConstructorParameters<typeof Y.Item>[5],
      null, new Y.ContentString('root'),
    )])
    const cyclicDuplicate = makeStructUpdate(itemClient, 0, [
      new Y.Item(
        Y.createID(itemClient, 0), null, Y.createID(itemClient, 1), null, null,
        null, null, new Y.ContentString('root'),
      ),
      new Y.Item(
        Y.createID(itemClient, 1), null, null, null, null,
        'body' as unknown as ConstructorParameters<typeof Y.Item>[5],
        null, new Y.ContentString('tail'),
      ),
    ])
    resetProbe()
    refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint: root, suffix: [], candidate: cyclicDuplicate,
    }, highPolicy()), 'invalid-update', { kind: 'input', role: 'candidate' })
    expect(yjsProbe.documentConstructions).toBe(0)
    expect(yjsProbe.readUpdateV2Calls).toBe(0)
    expect(yjsProbe.encodeStateVectorCalls).toBe(0)
    expect(yjsProbe.encodeStateAsUpdateCalls).toBe(0)
  })

  it('pins the dependency graph exact index-operation budget', () => {
    const dependencyId = Y.createID(88_061, 0)
    const dependentId = Y.createID(88_062, 0)
    const checkpoint = makeMultiClientStructUpdate([
      {
        clientId: dependentId.client,
        startClock: 0,
        structs: [new Y.Item(
          dependentId, null, dependencyId, null, null,
          'body' as unknown as ConstructorParameters<typeof Y.Item>[5],
          null, new Y.ContentString('dependent'),
        )],
      },
      {
        clientId: dependencyId.client,
        startClock: 0,
        structs: [new Y.Item(
          dependencyId, null, null, null, null,
          'body' as unknown as ConstructorParameters<typeof Y.Item>[5],
          null, new Y.ContentString('provider'),
        )],
      },
    ])
    const totalIndexOperations = 225
    const graphIndexOperations = 105
    const exact = accepted(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy(),
    ))
    expect(exact.usage.indexOperations).toBe(totalIndexOperations)
    const graphExact = refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy({
        maxIndexOperations: graphIndexOperations,
      }),
    ), 'capacity-refused', { kind: 'final' })
    expect(graphExact.usage.indexOperations).toBe(graphIndexOperations)
    const oneLess = refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy({
        maxIndexOperations: graphIndexOperations - 1,
      }),
    ), 'capacity-refused', { kind: 'input', role: 'checkpoint' })
    expect(oneLess.usage.indexOperations).toBe(graphIndexOperations - 1)
  })

  it('refuses before scratch construction or apply when the paired forecast crosses', () => {
    const checkpoint = gcUpdate(4_201, 0, 1)
    resetProbe()
    const rejection = refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy({ maxStructVisits: 1 }),
    ), 'capacity-refused', { kind: 'input', role: 'checkpoint' })
    expect(rejection.usage.structVisits).toBe(1)
    expect(rejection.usage.decoderPasses).toBe(1)
    expect(yjsProbe.documentConstructions).toBe(0)
    expect(yjsProbe.readUpdateV2Calls).toBe(0)
    expect(yjsProbe.encodeStateAsUpdateCalls).toBe(0)
  })

  it('checks a prefix pair before candidate evidence begins', () => {
    const checkpoint = makeStructUpdate(
      4_202,
      0,
      Array.from({ length: 6 }, (_, clock) => (
        new Y.GC(Y.createID(4_202, clock), 1)
      )),
    )
    const candidate = makeStructUpdate(
      4_203,
      0,
      Array.from({ length: 5 }, (_, clock) => (
        new Y.GC(Y.createID(4_203, clock), 1)
      )),
    )
    resetProbe()
    const rejection = refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [], candidate,
    }, highPolicy({ maxStructVisits: 10 })), 'capacity-refused', {
      kind: 'input', role: 'checkpoint',
    })
    expect(rejection.usage.structVisits).toBe(6)
    expect(rejection.usage.decoderPasses).toBe(1)
    expect(rejection.usage.hashedBytes).toBe(checkpoint.byteLength)
    expect(yjsProbe.digestViews).toHaveLength(1)
    expect(yjsProbe.documentConstructions).toBe(0)
    expect(yjsProbe.readUpdateV2Calls).toBe(0)
  })

  it('attributes a later pair crossing to candidate with evidence-only usage', () => {
    const checkpoint = makeStructUpdate(4_204, 0, [
      new Y.GC(Y.createID(4_204, 0), 1),
      new Y.GC(Y.createID(4_204, 1), 1),
    ])
    const candidate = makeStructUpdate(
      4_205,
      0,
      Array.from({ length: 7 }, (_, clock) => (
        new Y.GC(Y.createID(4_205, clock), 1)
      )),
    )
    resetProbe()
    const rejection = refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [], candidate,
    }, highPolicy({ maxStructVisits: 10 })), 'capacity-refused', {
      kind: 'input', role: 'candidate',
    })
    expect(rejection.usage.structVisits).toBe(9)
    expect(rejection.usage.decoderPasses).toBe(2)
    expect(yjsProbe.digestViews).toHaveLength(2)
    expect(yjsProbe.documentConstructions).toBe(0)
    expect(yjsProbe.readUpdateV2Calls).toBe(0)
  })

  it('stops at the first infeasible suffix without candidate evidence', () => {
    const checkpoint = gcUpdate(4_210, 0, 1)
    const suffix0 = gcUpdate(4_211, 0, 1)
    const suffix1 = makeStructUpdate(4_212, 0, [
      new Y.GC(Y.createID(4_212, 0), 1),
      new Y.GC(Y.createID(4_212, 1), 1),
    ])
    const candidate = gcUpdate(4_213, 0, 1)
    resetProbe()
    const rejection = refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [suffix0, suffix1], candidate,
    }, highPolicy({ maxStructVisits: 7 })), 'capacity-refused', {
      kind: 'input', role: 'suffix', index: 1,
    })
    expect(rejection.usage.structVisits).toBe(4)
    expect(rejection.usage.decoderPasses).toBe(3)
    expect(yjsProbe.digestViews).toHaveLength(3)
    expect(yjsProbe.documentConstructions).toBe(0)
    expect(yjsProbe.readUpdateV2Calls).toBe(0)
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

  it('retains backing content through empty suffixes and repeated partial deletions', () => {
    const ast = parsedSources([ORDERED_CUT_SOURCE]).get(ORDERED_CUT_SOURCE)!
    const slice = namedFunction(ast, 'slicedSpan')
    expect(descendants(slice).filter(node => (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'slice'
    ))).toHaveLength(0)
    expect(slice.getText(ast)).toContain('content: span.content')
    expect(slice.getText(ast)).toContain('return span')

    for (const length of [16, 64]) {
      for (const deletions of [0, 3]) {
        const source = new Y.Doc({ gc: false })
        const values = new Y.Array<number>()
        source.getMap('frontmatter').set('items', values)
        values.insert(0, Array.from({ length }, (_, index) => index))
        const checkpoint = Y.encodeStateAsUpdate(source)
        const suffix: Uint8Array[] = Array.from({ length: 5 }, () => new Uint8Array([0, 0]))
        for (let index = 0; index < deletions; index += 1) {
          const vector = Y.encodeStateVector(source)
          values.delete(1, 1)
          suffix.push(Y.encodeStateAsUpdate(source, vector))
        }
        const cut = accepted(validateOrderedLiveUpdateCut({
          mode: 'journal-candidate', checkpoint, suffix, candidate: new Uint8Array([0, 0]),
        }, highPolicy()))
        expect(cut.document.getMap('frontmatter').toJSON()).toEqual({ items: values.toArray() })
        expect(cut.finishAfterProjection().kind).toBe('accepted')
      }
    }
  })

  it('bounds alternating tombstone overlap work independently of the observed usage', () => {
    for (const count of [64, 2_048]) {
      const clientId = 44_000
      const items = Array.from({ length: count * 2 }, (_, clock) => new Y.Item(
        Y.createID(clientId, clock), null, null, null, null,
        'frontmatter' as unknown as ConstructorParameters<typeof Y.Item>[5],
        `key-${clock}`, new Y.ContentAny([clock]),
      ))
      const checkpoint = makeStructUpdate(clientId, 0, items)
      const candidate = makeStructUpdate(clientId, 0, items.map((item, clock) => (
        clock % 2 === 0 ? new Y.GC(item.id, 1) : new Y.Skip(item.id, 1)
      )), Array.from({ length: count }, (_, index) => ({
        clientId, startClock: index * 2, length: 1,
      })))
      // 128 visits per range per merge level allows the decoder, replay, and final proof sweeps.
      const bound = 128 * count * (Math.ceil(Math.log2(count * 2)) + 1)
      const cut = accepted(validateOrderedLiveUpdateCut({
        mode: 'journal-candidate', checkpoint, suffix: [], candidate,
      }, highPolicy()))
      expect(cut.usage.indexOperations).toBeLessThanOrEqual(bound)
      const actual = cut.document.getMap('frontmatter').toJSON()
      expect(Object.keys(actual)).toHaveLength(count)
      for (let clock = 1; clock < count * 2; clock += 2) {
        expect(actual[`key-${clock}`]).toBe(clock)
      }
    }
  })

  it('charges an exact deterministic index total for replay merges and final equality', () => {
    const checkpoint = updateWithText('index')
    const cut = accepted(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy(),
    ))
    const evidenceAndFrontierOperations = 119
    const finalProofOperations = 130
    const exactIndexOperations = evidenceAndFrontierOperations + finalProofOperations
    expect(exactIndexOperations).toBe(249)
    expect(cut.usage.indexOperations).toBe(exactIndexOperations)
    expect(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy({
        maxIndexOperations: exactIndexOperations,
      }),
    ).kind).toBe('accepted')
    const oneLess = refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy({
        maxIndexOperations: exactIndexOperations - 1,
      }),
    ), 'capacity-refused', { kind: 'final' })
    expect(oneLess.usage.indexOperations).toBe(exactIndexOperations - 1)

    resetProbe()
    const evidenceExact = refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy({
        maxIndexOperations: evidenceAndFrontierOperations,
      }),
    ), 'capacity-refused', { kind: 'final' })
    expect(evidenceExact.usage.indexOperations).toBe(evidenceAndFrontierOperations)
    expect(yjsProbe.documentConstructions).toBe(1)
    resetProbe()
    const evidenceOneLess = refused(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy({
        maxIndexOperations: evidenceAndFrontierOperations - 1,
      }),
    ), 'capacity-refused', { kind: 'input', role: 'checkpoint' })
    expect(evidenceOneLess.usage.indexOperations).toBe(evidenceAndFrontierOperations - 1)
    expect(yjsProbe.documentConstructions).toBe(0)
  })

  it('charges point merge comparisons, moves, and final point equality exactly', () => {
    const document = new Y.Doc({ gc: false })
    const text = new Y.XmlText()
    document.getXmlFragment('body').insert(0, [text])
    text.insert(0, '💩')
    const checkpoint = Y.encodeStateAsUpdate(document)
    const checkpointVector = Y.encodeStateVector(document)
    text.insert(text.length, '💩')
    const suffix = Y.encodeStateAsUpdate(document, checkpointVector)
    const item = firstStringItem(checkpoint)
    const deletion = makeStructUpdate(1, 0, [], [{
      clientId: item.id.client,
      startClock: item.id.clock,
      length: item.length,
    }])
    const cut = accepted(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [suffix], candidate: deletion,
    }, highPolicy()))
    const exactIndexOperations = 521
    expect(cut.usage.indexOperations).toBe(exactIndexOperations)
    expect(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [suffix], candidate: deletion,
    }, highPolicy({ maxIndexOperations: exactIndexOperations })).kind).toBe('accepted')
    const oneLess = refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [suffix], candidate: deletion,
    }, highPolicy({ maxIndexOperations: exactIndexOperations - 1 })), 'capacity-refused', {
      kind: 'final',
    })
    expect(oneLess.usage.indexOperations).toBe(exactIndexOperations - 1)
  })

  it('returns frozen, non-aliased evidence and proof outputs with no prefix ranges', () => {
    const checkpoint = updateWithText('aliases')
    const original = Uint8Array.from(checkpoint)
    const cut = accepted(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy(),
    ))
    checkpoint.fill(0)
    expect(cut.mode).toBe('registration')
    if (cut.mode !== 'registration') return
    expect(Object.isFrozen(cut)).toBe(true)
    expect(Object.isFrozen(cut.usage)).toBe(true)
    expect(Object.isFrozen(cut.checkpoint)).toBe(true)
    expect(Object.isFrozen(cut.checkpoint.ranges)).toBe(true)
    expect('prefixRanges' in cut).toBe(false)
    const finished = cut.finishAfterProjection()
    expect(finished.kind).toBe('accepted')
    if (finished.kind !== 'accepted') return
    const stateCopy = Uint8Array.from(finished.stateUpdate)
    finished.stateUpdate.fill(0)
    expect(original.some(byte => byte !== 0)).toBe(true)
    expect(stateCopy.some(byte => byte !== 0)).toBe(true)
    expect(cut.finishAfterProjection().usage).toBe(finished.usage)
  })

  it('freezes and de-aliases journal evidence and refusal diagnostics', () => {
    const updates = journalWithTwoDeltas()
    const checkpoint = Uint8Array.from(updates.checkpoint)
    const suffix = Uint8Array.from(updates.suffix)
    const candidate = Uint8Array.from(updates.candidate)
    const cut = accepted(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [suffix], candidate,
    }, highPolicy()))
    expect(cut.mode).toBe('journal-candidate')
    if (cut.mode !== 'journal-candidate') return
    expect(Object.isFrozen(cut)).toBe(true)
    expect(Object.isFrozen(cut.usage)).toBe(true)
    expect(Object.isFrozen(cut.suffixDigests)).toBe(true)
    expect(Object.isFrozen(cut.candidate)).toBe(true)
    expect(Object.isFrozen(cut.candidate.ranges)).toBe(true)
    const checkpointDigest = cut.checkpointDigest
    const suffixDigests = [...cut.suffixDigests]
    const candidateDigest = cut.candidate.updateDigest
    const candidateRanges = cut.candidate.ranges.map(range => ({ ...range }))
    checkpoint.fill(0)
    suffix.fill(0)
    candidate.fill(0)
    expect(cut.checkpointDigest).toBe(checkpointDigest)
    expect(cut.suffixDigests).toEqual(suffixDigests)
    expect(cut.candidate.updateDigest).toBe(candidateDigest)
    expect(cut.candidate.ranges).toEqual(candidateRanges)

    const rejection = refused(validateOrderedLiveUpdateCut({
      mode: 'registration', checkpoint: withTrailingByte(updates.checkpoint),
    }, highPolicy()), 'invalid-update', { kind: 'input', role: 'checkpoint' })
    expect(Object.isFrozen(rejection)).toBe(true)
    expect(Object.isFrozen(rejection.stage)).toBe(true)
    expect(Object.isFrozen(rejection.usage)).toBe(true)
  })

  it('rejects compound and unary projected writes in the static proof', () => {
    const source = readFileSync(ORDERED_CUT_SOURCE, 'utf8')
    const start = source.indexOf('function addProjectedContribution(')
    const insertion = source.indexOf('  return next', start)
    for (const write of [
      'next.structVisits += 1', 'next.structVisits -= 1',
      'next.structVisits++', '--next.structVisits',
    ]) {
      const text = source.slice(0, insertion) + `  ${write}\n` + source.slice(insertion)
      const ast = parsedSources([ORDERED_CUT_SOURCE], { path: ORDERED_CUT_SOURCE, text })
        .get(ORDERED_CUT_SOURCE)!
      expect(ast.getText(ast)).toContain(write)
      expect(() => assertProjectedWrites(ast), write).toThrow()
    }
  })

  it('keeps the deep module private and the two static safety proofs intact', () => {
    const source = readFileSync(ORDERED_CUT_SOURCE, 'utf8')
    const jsonSource = readFileSync(BOUNDED_JSON_SOURCE, 'utf8')
    const asts = parsedSources([ORDERED_CUT_SOURCE, BOUNDED_JSON_SOURCE])
    const sourceAst = asts.get(ORDERED_CUT_SOURCE)
    const jsonAst = asts.get(BOUNDED_JSON_SOURCE)
    if (sourceAst === undefined || jsonAst === undefined) throw new Error('missing parsed source')
    expect(readFileSync(PACKAGE_INDEX_SOURCE, 'utf8')).not.toContain('orderedLiveUpdateCut')
    expect(readFileSync(PACKAGE_JSON_SOURCE, 'utf8')).not.toContain('orderedLiveUpdateCut')
    expect(source).toContain("import * as string from 'lib0/string'")
    expect(jsonSource).toContain("import * as string from 'lib0/string'")
    for (const ast of [sourceAst, jsonAst]) {
      const utf8Calls = descendants(ast).filter((node): node is ts.CallExpression => (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'string'
        && node.expression.name.text === 'decodeUtf8'
      ))
      expect(utf8Calls).toHaveLength(1)
      expect(descendants(ast).filter(
        node => ts.isIdentifier(node) && node.text === 'TextDecoder',
      )).toHaveLength(0)
    }
    expect(source).not.toMatch(/\.sort\s*\(/)
    expect(source).not.toMatch(/Y\.(?:decodeUpdate|readUpdate|applyUpdate|applyUpdateV2)\s*\(/)
    expect(source).toContain('Y.decodeUpdateV2(')
    expect(source).toContain('Y.readUpdateV2(')
    expect(source.match(/export function /g)).toHaveLength(1)

    const finalizer = namedFunction(sourceAst, 'createFinalizer')
    const finalizerBindings = finalizer.body!.statements
      .filter(ts.isVariableStatement)
      .flatMap(statement => statement.declarationList.declarations)
      .map(declaration => declaration.name.getText(sourceAst))
    expect(finalizerBindings).toEqual(['proofState', 'lastUsage'])
    const finalizerReturn = finalizer.body!.statements.find(ts.isReturnStatement)
    expect(finalizerReturn?.expression !== undefined && ts.isArrowFunction(finalizerReturn.expression))
      .toBe(true)
    if (finalizerReturn?.expression === undefined || !ts.isArrowFunction(finalizerReturn.expression)) {
      throw new Error('missing finalizer closure')
    }
    const capturedParameters = descendants(finalizerReturn.expression.body)
      .filter((node): node is ts.Identifier => ts.isIdentifier(node))
      .map(identifier => identifier.text)
      .filter(name => name === 'acceptedProofState' || name === 'acceptedUsage')
    expect(capturedParameters).toEqual([])
    const proofAliases = descendants(finalizerReturn.expression.body)
      .filter((node): node is ts.VariableDeclaration => (
        ts.isVariableDeclaration(node)
        && node.initializer !== undefined
        && (
          ts.isIdentifier(node.initializer)
          || ts.isPropertyAccessExpression(node.initializer)
          || ts.isElementAccessExpression(node.initializer)
        )
        && ['proofState', 'state'].includes(rootIdentifier(node.initializer) ?? '')
      ))
      .map(declaration => ({
        name: declaration.name.getText(sourceAst),
        source: rootIdentifier(declaration.initializer as ts.Expression),
      }))
    expect(proofAliases).toEqual([{ name: 'state', source: 'proofState' }])
    const finalizerText = finalizerReturn.expression.body.getText(sourceAst)
    const transfer = finalizerText.indexOf('const state = proofState')
    const release = finalizerText.indexOf('proofState = undefined', transfer)
    const detach = finalizerText.indexOf("state.document.off('beforeTransaction'", transfer)
    const dirty = finalizerText.indexOf('state.dirtyLatch.dirty', transfer)
    const proof = finalizerText.indexOf('completeProof(', transfer)
    expect(transfer).toBeGreaterThan(-1)
    expect(release).toBeGreaterThan(transfer)
    expect(release).toBeLessThan(detach)
    expect(release).toBeLessThan(dirty)
    expect(release).toBeLessThan(proof)

    const helper = namedFunction(sourceAst, 'checkedProjectedAdd')
    const helperStatements = helper.body!.statements
    const guardedOperands = helperStatements.slice(0, 3).map((statement) => {
      expect(ts.isIfStatement(statement)).toBe(true)
      if (!ts.isIfStatement(statement)) throw new Error('missing operand guard')
      const calls = descendants(statement.expression).filter(ts.isCallExpression)
      expect(calls).toHaveLength(1)
      const call = calls[0] as ts.CallExpression
      expect(call.expression.getText(sourceAst)).toBe('safeNonnegative')
      expect(statement.thenStatement.getText(sourceAst)).toContain(
        "fail('capacity-refused', stage)",
      )
      return call.arguments[0]?.getText(sourceAst)
    })
    expect(guardedOperands).toEqual(['current', 'delta', 'policy'])
    const helperText = helper.body!.getText(sourceAst)
    const currentPolicy = helperText.indexOf('current > policy')
    const subtraction = helperText.indexOf('policy - current')
    const deltaRemaining = helperText.indexOf('delta > remaining')
    const addition = helperText.indexOf('current + delta')
    expect(currentPolicy).toBeGreaterThan(helperStatements[2]!.end - helper.body!.pos)
    expect(subtraction).toBeGreaterThan(currentPolicy)
    expect(deltaRemaining).toBeGreaterThan(subtraction)
    expect(addition).toBeGreaterThan(deltaRemaining)
    expect(descendants(helper).filter(node => (
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ))).toHaveLength(1)

    assertProjectedWrites(sourceAst)

    expect(descendants(sourceAst).filter(
      node => ts.isIdentifier(node) && node.text === 'CanonicalBytes',
    )).toHaveLength(0)
    expect(source).not.toMatch(/\.append\s*\(/)
    const canonicalFunctions = [
      'scalarTreeDigest',
      'stringTreeDigest',
      'arrayTreeDigest',
      'mapTreeDigest',
      'readHashedAnyNode',
      'jsonTreeDigest',
    ].map(name => namedFunction(sourceAst, name))
    for (const fn of canonicalFunctions) {
      const numberArrays = descendants(fn).filter(node => (
        (ts.isArrayTypeNode(node)
          && node.elementType.kind === ts.SyntaxKind.NumberKeyword)
        || (ts.isTypeReferenceNode(node)
          && node.typeName.getText(sourceAst) === 'Array'
          && node.typeArguments?.[0]?.kind === ts.SyntaxKind.NumberKeyword)
      ))
      expect(numberArrays).toHaveLength(0)
    }
    const hashedAny = namedFunction(sourceAst, 'readHashedAnyNode')
    const float64Cases = descendants(hashedAny).filter((node): node is ts.CaseClause => (
      ts.isCaseClause(node) && node.expression.getText(sourceAst) === '123'
    ))
    expect(float64Cases).toHaveLength(1)
    const float64Case = float64Cases[0] as ts.CaseClause
    const float64Blocks = float64Case.statements.filter(ts.isBlock)
    expect(float64Blocks).toHaveLength(1)
    const float64Block = float64Blocks[0] as ts.Block
    const float64Bindings = float64Block.statements
      .filter(ts.isVariableStatement)
      .flatMap(statement => statement.declarationList.declarations)
    const float64Binding = (name: string): ts.VariableDeclaration => {
      const matches = float64Bindings.filter(declaration => declaration.name.getText(sourceAst) === name)
      expect(matches).toHaveLength(1)
      return matches[0] as ts.VariableDeclaration
    }
    const positionBinding = float64Binding('position')
    expect(positionBinding.initializer?.getText(sourceAst)).toBe('decoder.pos')
    const valueBinding = float64Binding('value')
    expect(valueBinding.initializer !== undefined && ts.isCallExpression(valueBinding.initializer))
      .toBe(true)
    if (valueBinding.initializer === undefined || !ts.isCallExpression(valueBinding.initializer)) {
      throw new Error('missing float64 read')
    }
    expect(valueBinding.initializer.expression.getText(sourceAst)).toBe('decoding.readFloat64')
    expect(valueBinding.initializer.arguments.map(argument => argument.getText(sourceAst)))
      .toEqual(['decoder'])
    const rawBinding = float64Binding('raw')
    expect(rawBinding.initializer !== undefined && ts.isNewExpression(rawBinding.initializer))
      .toBe(true)
    if (rawBinding.initializer === undefined || !ts.isNewExpression(rawBinding.initializer)) {
      throw new Error('missing raw float64 view')
    }
    expect(rawBinding.initializer.expression.getText(sourceAst)).toBe('Uint8Array')
    expect(rawBinding.initializer.arguments?.map(argument => argument.getText(sourceAst))).toEqual([
      'decoder.arr.buffer',
      'decoder.arr.byteOffset + position',
      '8',
    ])
    const float64StatementIndex = (declaration: ts.VariableDeclaration): number => (
      float64Block.statements.findIndex(statement => (
        ts.isVariableStatement(statement)
        && statement.declarationList.declarations.some(candidate => candidate === declaration)
      ))
    )
    const positionStatementIndex = float64StatementIndex(positionBinding)
    const valueStatementIndex = float64StatementIndex(valueBinding)
    const rawStatementIndex = float64StatementIndex(rawBinding)
    expect(positionStatementIndex + 1).toBe(valueStatementIndex)
    expect(valueStatementIndex + 1).toBe(rawStatementIndex)
    const float64Digests = descendants(float64Case).filter((node): node is ts.CallExpression => (
      ts.isCallExpression(node) && node.expression.getText(sourceAst) === 'scalarTreeDigest'
    ))
    expect(float64Digests).toHaveLength(1)
    expect(float64Digests[0]?.arguments[1]?.getText(sourceAst)).toBe('raw')
    expect(descendants(float64Case).filter((node): node is ts.CallExpression => (
      ts.isCallExpression(node) && node.expression.getText(sourceAst) === 'numberBytes'
    ))).toHaveLength(0)
    const arrayDigest = namedFunction(sourceAst, 'arrayTreeDigest')
    expect(arrayDigest.parameters[1]?.type?.getText(sourceAst)).toBe('readonly Uint8Array[]')
    expect(descendants(arrayDigest).filter((node): node is ts.CallExpression => (
      ts.isCallExpression(node)
      && node.expression.getText(sourceAst) === 'input.set'
    )).map(call => call.arguments[0]?.getText(sourceAst))).toEqual(['child'])
    const mapDigest = namedFunction(sourceAst, 'mapTreeDigest')
    expect(descendants(mapDigest).filter((node): node is ts.CallExpression => (
      ts.isCallExpression(node)
      && node.expression.getText(sourceAst) === 'input.set'
    )).map(call => call.arguments[0]?.getText(sourceAst))).toEqual([
      'entry.key',
      'entry.digest',
    ])
    const allocator = namedFunction(sourceAst, 'allocateHashInput')
    const allocatorText = allocator.body!.getText(sourceAst)
    expect(allocatorText.indexOf('budget.chargeHashedBytes')).toBeGreaterThan(-1)
    expect(allocatorText.indexOf('new Uint8Array')).toBeGreaterThan(
      allocatorText.indexOf('budget.chargeHashedBytes'),
    )
    const valuesOnly = namedFunction(sourceAst, 'readAnyValue')
    expect(descendants(valuesOnly).filter(node => (
      ts.isCallExpression(node)
      && /(?:digest|hash|canonical)/i.test(node.expression.getText(sourceAst))
    ))).toHaveLength(0)
    expect(descendants(valuesOnly).filter(node => (
      ts.isNewExpression(node)
      && node.expression.getText(sourceAst) === 'Uint8Array'
    ))).toHaveLength(0)
    const strictReadAny = descendants(sourceAst).find(
      (node): node is ts.MethodDeclaration => (
        ts.isMethodDeclaration(node)
        && node.name.getText(sourceAst) === 'readAny'
        && node.body?.getText(sourceAst).includes('captureFingerprints') === true
      ),
    )
    if (strictReadAny?.body === undefined) throw new Error('missing strict readAny')
    const fingerprintBranch = strictReadAny.body.statements.find(ts.isIfStatement)
    expect(fingerprintBranch?.expression.getText(sourceAst)).toBe('captureFingerprints')
    expect(fingerprintBranch?.elseStatement).toBeUndefined()
    const valuesOnlyCalls = descendants(strictReadAny).filter(node => (
      ts.isCallExpression(node) && node.expression.getText(sourceAst) === 'readAnyValue'
    ))
    expect(valuesOnlyCalls).toHaveLength(1)
    expect(strictReadAny.body.statements.at(-1)?.getText(sourceAst)).toContain('readAnyValue(')

    const strictReadJson = descendants(sourceAst).find(
      (node): node is ts.MethodDeclaration => (
        ts.isMethodDeclaration(node)
        && node.name.getText(sourceAst) === 'readJSON'
        && node.body?.getText(sourceAst).includes('jsonTreeDigest') === true
      ),
    )
    if (strictReadJson?.body === undefined) throw new Error('missing strict readJSON')
    const jsonDigestCalls = descendants(strictReadJson).filter(node => (
      ts.isCallExpression(node) && node.expression.getText(sourceAst) === 'jsonTreeDigest'
    ))
    expect(jsonDigestCalls).toHaveLength(1)
    let jsonDigestParent: ts.Node | undefined = jsonDigestCalls[0]?.parent
    while (jsonDigestParent !== undefined && !ts.isIfStatement(jsonDigestParent)) {
      jsonDigestParent = jsonDigestParent.parent
    }
    expect(jsonDigestParent !== undefined && ts.isIfStatement(jsonDigestParent)).toBe(true)
    if (jsonDigestParent !== undefined && ts.isIfStatement(jsonDigestParent)) {
      expect(jsonDigestParent.expression.getText(sourceAst)).toBe('captureFingerprints')
    }

    const scanString = descendants(jsonAst).find(
      (node): node is ts.MethodDeclaration => (
        ts.isMethodDeclaration(node) && node.name.getText(jsonAst) === 'scanString'
      ),
    )
    if (scanString?.body === undefined) throw new Error('missing scanString')
    const keyDecodeCalls = descendants(scanString).filter(
      (node): node is ts.CallExpression => (
        ts.isCallExpression(node)
        && node.expression.getText(jsonAst) === 'this.decodeKeyAfterCharge'
      ),
    )
    expect(keyDecodeCalls).toHaveLength(1)
    const keyDecodeCall = keyDecodeCalls[0]
    if (keyDecodeCall === undefined) throw new Error('missing key decode call')
    expect(ts.isReturnStatement(keyDecodeCall.parent)).toBe(true)
    if (!ts.isReturnStatement(keyDecodeCall.parent)) {
      throw new Error('key decode is not returned directly')
    }
    const keyDecodeReturn = keyDecodeCall.parent
    expect(keyDecodeReturn.expression).toBe(keyDecodeCall)
    expect(ts.isBlock(keyDecodeReturn.parent)).toBe(true)
    if (!ts.isBlock(keyDecodeReturn.parent)) throw new Error('missing key decode block')
    const keyDecodeBlock = keyDecodeReturn.parent
    const byteCharges = keyDecodeBlock.statements.filter(
      (statement): statement is ts.ExpressionStatement => (
        ts.isExpressionStatement(statement)
        && ts.isCallExpression(statement.expression)
        && statement.expression.expression.getText(jsonAst)
          === 'this.budget.visitDecodedPayloadBytes'
        && statement.expression.arguments.length === 1
        && statement.expression.arguments[0]?.getText(jsonAst) === 'decodedByteLength'
      ),
    )
    const keyObservations = keyDecodeBlock.statements.filter(
      (statement): statement is ts.ExpressionStatement => (
        ts.isExpressionStatement(statement)
        && ts.isCallExpression(statement.expression)
        && statement.expression.expression.getText(jsonAst)
          === 'this.observation?.onKeyMaterialized'
        && statement.expression.arguments.length === 0
      ),
    )
    expect(byteCharges).toHaveLength(1)
    expect(keyObservations).toHaveLength(1)
    const byteChargeIndex = keyDecodeBlock.statements.indexOf(byteCharges[0]!)
    const keyObservationIndex = keyDecodeBlock.statements.indexOf(keyObservations[0]!)
    const keyDecodeIndex = keyDecodeBlock.statements.indexOf(keyDecodeReturn)
    expect(byteChargeIndex).toBeLessThan(keyObservationIndex)
    expect(keyObservationIndex).toBeLessThan(keyDecodeIndex)
    expect(descendants(jsonAst).filter(node => (
      ts.isPropertyAccessExpression(node)
      && node.expression.getText(jsonAst) === 'JSON'
      && node.name.text === 'parse'
    ))).toHaveLength(0)
    const keyDecoder = descendants(jsonAst).find(
      (node): node is ts.MethodDeclaration => (
        ts.isMethodDeclaration(node) && node.name.getText(jsonAst) === 'decodeKeyAfterCharge'
      ),
    )
    if (keyDecoder === undefined) throw new Error('missing key decoder')
    expect(descendants(keyDecoder).filter(node => (
      ts.isCallExpression(node) && /parse/i.test(node.expression.getText(jsonAst))
    ))).toHaveLength(0)
    for (const ast of [sourceAst, jsonAst]) {
      expect(descendants(ast).filter(node => (
        ts.isStringLiteral(node) && node.text === 'TextDecoder'
      ))).toHaveLength(0)
    }
  })
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

  it('charges a lone low surrogate and refuses truncated Unicode before native parse', () => {
    let nativeCalls = 0
    const native = (text: string): unknown => { nativeCalls += 1; return JSON.parse(text) }
    expect(() => parse('"\\uDC00"', { bytes: 2 }, native)).toThrow('bytes')
    expect(() => parse('"\\u00', {}, native)).toThrow(SyntaxError)
    expect(nativeCalls).toBe(0)
    expect(parse('"\\uDC00"', { bytes: 3 }, native))
      .toEqual({ value: '\uDC00', nodes: 1, bytes: 3 })
    expect(nativeCalls).toBe(1)
  })

  it('measures strings before materializing only charged object keys', () => {
    let keyMaterializations = 0
    let nativeCalls = 0
    const parseObserved = (source: string, limit: number): unknown => (
      parseBoundedV1Json(source, {
        visitValueNode: () => undefined,
        visitDecodedPayloadBytes: (length) => {
          if (length > limit) throw new Error('bytes')
        },
        refuseCapacity: () => { throw new Error('depth') },
      }, (text) => {
        nativeCalls += 1
        return JSON.parse(text)
      }, {
        onKeyMaterialized: () => { keyMaterializations += 1 },
      })
    )

    expect(() => parseObserved('"\\u0061\\u0062\\u0063"', 2)).toThrow('bytes')
    expect(keyMaterializations).toBe(0)
    expect(nativeCalls).toBe(0)
    expect(() => parseObserved('{"\\u0061\\u0062\\u0063":0}', 2)).toThrow('bytes')
    expect(keyMaterializations).toBe(0)
    expect(nativeCalls).toBe(0)

    expect(parseObserved('{"\\u0061stral":"💩","lone":"\\uD800"}', 10))
      .toEqual({ astral: '💩', lone: '\uD800' })
    expect(keyMaterializations).toBe(2)
    expect(nativeCalls).toBe(1)
    expect(parse('["a","💩","\\uD800"]').bytes).toBe(8)

    for (const source of [
      '"\\uD83D\uDCA9"',
      '"\uD83D\\uDCA9"',
    ]) {
      const measured = parse(source)
      expect(measured.value).toBe('💩')
      expect(measured.bytes).toBe(4)
    }

    const events: string[] = []
    const observed = parseBoundedV1Json('{"\\u0061":0}', {
      visitValueNode: () => events.push('node'),
      visitDecodedPayloadBytes: length => events.push(`bytes:${length}`),
      refuseCapacity: () => { throw new Error('depth') },
    }, (text) => {
      events.push('native')
      return JSON.parse(text)
    }, {
      onKeyMaterialized: () => events.push('key'),
    })
    expect(observed).toEqual({ a: 0 })
    expect(events).toEqual(['node', 'bytes:1', 'key', 'node', 'native'])
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

  it('pins 4,094 admitted suffix entries and the first forbidden index', () => {
    const empty = Y.encodeStateAsUpdate(new Y.Doc({ gc: false }))
    const admitted = Array.from({ length: 4_094 }, () => empty)
    expect(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint: empty,
      suffix: admitted, candidate: empty,
    }, highPolicy()).kind).toBe('accepted')
    const forbidden = refused(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint: empty,
      suffix: [...admitted, empty], candidate: empty,
    }, highPolicy()), 'capacity-refused', {
      kind: 'input', role: 'suffix', index: 4_094,
    })
    expect(forbidden.usage.decoderPasses).toBe(0)
    expect(forbidden.usage.rawInputBytes).toBe(empty.byteLength)
  })

  it('pins a 262,144-value Any-derived budget boundary', () => {
    const document = new Y.Doc({ gc: false })
    document.getMap<unknown>('frontmatter').set(
      'nodes',
      Array.from({ length: 262_143 }, () => null),
    )
    const checkpoint = Y.encodeStateAsUpdate(document)
    const baseline = accepted(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy(),
    ))
    const exact = baseline.usage.valueNodeVisits
    expect(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint }, highPolicy({ maxValueNodeVisits: exact }),
    ).kind).toBe('accepted')
    expect(validateOrderedLiveUpdateCut(
      { mode: 'registration', checkpoint },
      highPolicy({ maxValueNodeVisits: exact - 1 }),
    )).toMatchObject({ kind: 'refused', reason: 'capacity-refused' })
  }, 15_000)

  it('keeps 100,000 dense nonmergeable client ranges bounded and charged', () => {
    const clientId = 100_000
    const checkpoint = gcUpdate(clientId, 0, 200_000)
    const candidate = oneClientDenseResendUpdate(clientId, 100_000)
    const cut = accepted(validateOrderedLiveUpdateCut({
      mode: 'journal-candidate', checkpoint, suffix: [], candidate,
    }, highPolicy()))
    expect(cut.mode).toBe('journal-candidate')
    if (cut.mode !== 'journal-candidate') return
    expect(cut.candidate.ranges).toHaveLength(100_000)
    expect(cut.usage.structVisits).toBe(400_003)
    expect(cut.usage.indexOperations).toBeGreaterThan(1_000_000)
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
