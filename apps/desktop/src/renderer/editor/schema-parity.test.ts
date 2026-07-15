import { describe, expect, it } from 'vitest'
import { getDohcProseMirrorSchema } from './import-export'

// The desktop renders the SAME documents the live hocuspocus server
// materializes over collab, so the ProseMirror schema (the custom dohc nodes +
// StarterKit + TableKit) MUST stay identical on both sides — a mismatch
// silently drops or mangles a construct on one end. This (renderer-safe)
// gate asserts the assembled schema carries the dohc custom nodes; the
// byte-for-byte source-parity guard between editor/extensions.ts and the
// server's dohc-markdown-extensions.ts lives in check-architecture-debt.mjs
// (which is allowed to read across packages — the renderer must stay
// sandboxed and cannot use node:fs).
describe('desktop editor schema parity with hocuspocus', () => {
  it('the assembled schema carries the dohc custom nodes and checklist nodes', () => {
    const schema = getDohcProseMirrorSchema()
    for (const node of [
      'image',
      'escapedPunctuation',
      'wikilink',
      'inlineAtom',
      'callout',
      'mathInline',
      'mathBlock',
      'taskList',
      'taskItem',
    ]) {
      expect(schema.nodes[node]).toBeDefined()
    }
    expect(schema.marks.highlight).toBeDefined()
    expect(schema.nodes.tableRow?.spec.attrs?.height?.default).toBeNull()
  })
})
