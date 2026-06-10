import { describe, expect, it } from 'vitest'
import {
  composeRenamedTreePath,
  splitRenamePath,
} from '../components/FileTree'

describe('file tree short-name rename behavior', () => {
  it('shows only the leaf filename when renaming inside a folder', () => {
    expect(splitRenamePath('finance/something.md')).toEqual({
      folderPath: 'finance',
      fileName: 'something.md',
    })
  })

  it('keeps the folder path implied when composing the submitted path', () => {
    expect(
      composeRenamedTreePath('finance/something.md', 'renamed.md'),
    ).toBe('finance/renamed.md')
  })

  it('keeps root-level file renames at the root', () => {
    expect(composeRenamedTreePath('something.md', 'renamed.md')).toBe(
      'renamed.md',
    )
  })
})
