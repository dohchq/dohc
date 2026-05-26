import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import {
  absolutePositionToRelativePosition,
  initProseMirrorDoc,
  prosemirrorToYXmlFragment,
  relativePositionToAbsolutePosition,
} from 'y-prosemirror'
import * as Y from 'yjs'
import {
  getDohcProseMirrorSchema,
  getDohcYDocBodyFragment,
} from './import-export.js'

export type EncodedSuggestionAnchors = {
  anchorStart: string
  anchorEnd: string
}

export type ApplyAnchoredReplacementInput = EncodedSuggestionAnchors & {
  replacement: string
  expectedText?: string
  expectedPrefix?: string
  expectedSuffix?: string
}

export type ApplyAnchoredReplacementResult =
  | { ok: true }
  | {
      ok: false
      reason: 'unresolved-anchor' | 'invalid-range' | 'stale-intent' | 'needs-review'
      actualText?: string
    }

type TextSpan = {
  textStart: number
  textEnd: number
  pmStart: number
  pmEnd: number
}

export function createAnchorsForText(
  doc: Y.Doc,
  expectedText: string,
): EncodedSuggestionAnchors | null {
  if (!expectedText) return null
  const { body, mapping, pmDoc } = prosemirrorViewOf(doc)
  const plain = plainTextSpans(pmDoc)
  const textStart = plain.text.indexOf(expectedText)
  if (textStart < 0) return null

  const from = pmPosForTextOffset(plain.spans, textStart)
  const to = pmPosForTextOffset(plain.spans, textStart + expectedText.length)
  if (from === null || to === null) return null

  return {
    anchorStart: encodeRelativePosition(
      absolutePositionToRelativePosition(from, body, mapping),
    ),
    anchorEnd: encodeRelativePosition(
      absolutePositionToRelativePosition(to, body, mapping),
    ),
  }
}

export function applyAnchoredReplacement(
  doc: Y.Doc,
  input: ApplyAnchoredReplacementInput,
): ApplyAnchoredReplacementResult {
  const { body, mapping, pmDoc } = prosemirrorViewOf(doc)
  const from = relativePositionToAbsolutePosition(
    doc,
    body,
    decodeRelativePosition(input.anchorStart),
    mapping,
  )
  const to = relativePositionToAbsolutePosition(
    doc,
    body,
    decodeRelativePosition(input.anchorEnd),
    mapping,
  )
  if (from === null || to === null) return { ok: false, reason: 'unresolved-anchor' }
  if (from > to) return { ok: false, reason: 'invalid-range' }

  const actualText = pmDoc.textBetween(from, to, '\n', '')
  if (input.expectedText !== undefined && actualText !== input.expectedText) {
    return {
      ok: false,
      reason: contextStillMatches(pmDoc, from, to, input)
        ? 'needs-review'
        : 'stale-intent',
      actualText,
    }
  }

  const schema = getDohcProseMirrorSchema()
  const replacementSlice = input.replacement
    ? new Slice(Fragment.from(schema.text(input.replacement)), 0, 0)
    : Slice.empty
  const updated = pmDoc.replace(from, to, replacementSlice)
  doc.transact(() => {
    prosemirrorToYXmlFragment(updated, body)
  })
  return { ok: true }
}

function prosemirrorViewOf(doc: Y.Doc): {
  body: Y.XmlFragment
  pmDoc: ProseMirrorNode
  mapping: Map<Y.AbstractType<unknown>, ProseMirrorNode | ProseMirrorNode[]>
} {
  const body = getDohcYDocBodyFragment(doc)
  const { doc: pmDoc, mapping } = initProseMirrorDoc(
    body,
    getDohcProseMirrorSchema(),
  )
  return { body, pmDoc, mapping }
}

function encodeRelativePosition(position: Y.RelativePosition): string {
  return Buffer.from(Y.encodeRelativePosition(position)).toString('base64')
}

function decodeRelativePosition(encoded: string): Y.RelativePosition {
  return Y.decodeRelativePosition(new Uint8Array(Buffer.from(encoded, 'base64')))
}

function plainTextSpans(pmDoc: ProseMirrorNode): {
  text: string
  spans: TextSpan[]
} {
  let text = ''
  const spans: TextSpan[] = []
  pmDoc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const textStart = text.length
    text += node.text
    spans.push({
      textStart,
      textEnd: text.length,
      pmStart: pos,
      pmEnd: pos + node.text.length,
    })
  })
  return { text, spans }
}

function pmPosForTextOffset(spans: TextSpan[], offset: number): number | null {
  for (const span of spans) {
    if (offset >= span.textStart && offset <= span.textEnd) {
      return span.pmStart + (offset - span.textStart)
    }
  }
  return offset === 0 ? 0 : null
}

function textOffsetForPmPos(spans: TextSpan[], pos: number): number | null {
  for (const span of spans) {
    if (pos >= span.pmStart && pos <= span.pmEnd) {
      return span.textStart + (pos - span.pmStart)
    }
  }
  return pos === 0 ? 0 : null
}

function contextStillMatches(
  pmDoc: ProseMirrorNode,
  from: number,
  to: number,
  input: ApplyAnchoredReplacementInput,
): boolean {
  if (!input.expectedPrefix && !input.expectedSuffix) return false
  const { text, spans } = plainTextSpans(pmDoc)
  const textFrom = textOffsetForPmPos(spans, from)
  const textTo = textOffsetForPmPos(spans, to)
  if (textFrom === null || textTo === null) return false

  const prefixMatches =
    input.expectedPrefix === undefined ||
    text.slice(Math.max(0, textFrom - input.expectedPrefix.length), textFrom) ===
      input.expectedPrefix
  const suffixMatches =
    input.expectedSuffix === undefined ||
    text.slice(textTo, textTo + input.expectedSuffix.length) ===
      input.expectedSuffix

  return prefixMatches && suffixMatches
}
