import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { selfHostLiveProfile } from '../../../services/sync-relay/src/selfHostLiveProfile.js'
import { getDohcYDocBodyFragment } from './body-fragment.js'
import { markdownToYDoc, yDocToMarkdown } from './import-export.js'
import { validateJournalCutForProjection, validateRegistrationCutForProjection } from './orderedLiveUpdateCut.js'

function bodyText(document: Y.Doc): Y.XmlText {
  const paragraph = getDohcYDocBodyFragment(document).get(0)
  if (!(paragraph instanceof Y.XmlElement)) throw new Error('Expected a paragraph')
  const text = paragraph.get(0)
  if (!(text instanceof Y.XmlText)) throw new Error('Expected paragraph text')
  return text
}

it.each([
  { name: 'one author', authors: 1, backspaceEvery: 0 },
  { name: 'one author with backspaces', authors: 1, backspaceEvery: 10 },
  { name: 'two authors with backspaces', authors: 2, backspaceEvery: 10 },
  { name: 'one author with frequent backspaces', authors: 1, backspaceEvery: 3 },
  { name: 'two authors with frequent backspaces', authors: 2, backspaceEvery: 3 },
])('accepts 4,094 keystrokes before a checkpoint: $name', ({ authors, backspaceEvery }) => {
  const first = markdownToYDoc('Hello')
  const second = new Y.Doc()
  const documents = [first, second]
  let scratch: Y.Doc | undefined
  try {
    const checkpoint = Y.encodeStateAsUpdate(first)
    Y.applyUpdate(second, checkpoint)
    first.clientID = 11
    second.clientID = 12
    const updates: Uint8Array[] = []
    for (let index = 0; index < 4_094; index += 1) {
      const document = documents[index % authors]!
      const emitted: Uint8Array[] = []
      const capture = (update: Uint8Array) => emitted.push(update)
      document.on('update', capture)
      const text = bodyText(document)
      if (backspaceEvery !== 0 && index % backspaceEvery === backspaceEvery - 1) {
        text.delete(text.length - 2, 1)
      } else {
        text.insert(text.length, String.fromCharCode(97 + index % 26))
      }
      document.off('update', capture)
      expect(emitted).toHaveLength(1)
      const update = emitted[0]!
      updates.push(update)
      if (authors === 2) Y.applyUpdate(documents[(index + 1) % authors]!, update)
    }

    // Replay every keystroke as a separate wire update under the deployed limit.
    // One complete cut keeps this regression independent of SQLite throughput.
    const result = validateJournalCutForProjection({
      mode: 'journal-candidate',
      checkpoint,
      suffix: updates.slice(0, -1),
      candidate: updates[updates.length - 1]!,
    }, selfHostLiveProfile().validation)
    expect(result.kind, result.kind === 'refused' ? JSON.stringify(result) : undefined).toBe('accepted')
    if (result.kind !== 'accepted') return
    scratch = result.cut.document
    expect(yDocToMarkdown(scratch)).toBe(yDocToMarkdown(first))
    const finalized = result.cut.finishAfterProjection()
    expect(finalized.kind).toBe('accepted')
    if (finalized.kind !== 'accepted') return
    const revalidated = validateRegistrationCutForProjection({
      mode: 'registration', checkpoint: finalized.stateUpdate,
    }, selfHostLiveProfile().validation)
    expect(revalidated.kind).toBe('accepted')
    if (revalidated.kind === 'accepted') {
      try { expect(revalidated.cut.finishAfterProjection().kind).toBe('accepted') }
      finally { revalidated.cut.document.destroy() }
    }
  } finally {
    scratch?.destroy()
    for (const document of documents) document.destroy()
  }
})
