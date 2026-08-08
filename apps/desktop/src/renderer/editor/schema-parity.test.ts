import { describe, expect, it } from 'vitest'
import { getDohcProseMirrorSchema } from './import-export'

// The desktop ProseMirror schema must contain every custom dohc node. A missing
// node silently drops or mangles content. This renderer-safe assertion pins the
// assembled schema without using node:fs.
describe('desktop editor schema parity', () => {
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

  // `paragraph+` (a bare TaskItem) makes an indented list under a checkbox
  // schema-invalid, and the Y.Doc conversion drops the whole task list (#700).
  it('lets a task item hold a nested list', () => {
    expect(getDohcProseMirrorSchema().nodes.taskItem?.spec.content)
      .toBe('paragraph block*')
  })
})
