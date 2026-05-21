import { describe, it, expect } from 'vitest'
import { planDrop, type DragSource } from './file-tree-dnd'

// file-org-v1 D4.7 — drop-planning unit tests. Pure function;
// no DOM, no async. Locks the move semantics.

describe('planDrop — drag-and-drop target computation', () => {
  it('file → folder: moves the file INTO the target folder', () => {
    expect(
      planDrop(
        { path: 'team/anna.md', kind: 'file' },
        { parentDir: 'crew' },
      ),
    ).toEqual({
      kind: 'move-file',
      fromPath: 'team/anna.md',
      toPath: 'crew/anna.md',
    })
  })

  it('file → root: moves the file to the workspace root', () => {
    expect(
      planDrop(
        { path: 'team/anna.md', kind: 'file' },
        { parentDir: '' },
      ),
    ).toEqual({
      kind: 'move-file',
      fromPath: 'team/anna.md',
      toPath: 'anna.md',
    })
  })

  it('root-level file → folder: moves into the folder', () => {
    expect(
      planDrop(
        { path: 'readme.md', kind: 'file' },
        { parentDir: 'docs' },
      ),
    ).toEqual({
      kind: 'move-file',
      fromPath: 'readme.md',
      toPath: 'docs/readme.md',
    })
  })

  it('folder → folder: moves the source folder INTO the target', () => {
    expect(
      planDrop(
        { path: 'team', kind: 'folder' },
        { parentDir: 'org' },
      ),
    ).toEqual({
      kind: 'move-folder',
      fromPath: 'team',
      toPath: 'org/team',
    })
  })

  it('nested folder → root: moves the folder to workspace root', () => {
    expect(
      planDrop(
        { path: 'org/team', kind: 'folder' },
        { parentDir: '' },
      ),
    ).toEqual({
      kind: 'move-folder',
      fromPath: 'org/team',
      toPath: 'team',
    })
  })

  it('NO-OP: dropping into the current parent', () => {
    const r = planDrop(
      { path: 'team/anna.md', kind: 'file' },
      { parentDir: 'team' },
    )
    expect(r.kind).toBe('noop')
  })

  it('NO-OP: folder dropped onto itself', () => {
    const r = planDrop(
      { path: 'team', kind: 'folder' },
      { parentDir: 'team' },
    )
    expect(r.kind).toBe('noop')
    if (r.kind === 'noop') {
      expect(r.reason).toMatch(/itself|target folder/)
    }
  })

  it('NO-OP: folder dropped onto a DESCENDANT (would create unreachable cycle)', () => {
    const r = planDrop(
      { path: 'team', kind: 'folder' },
      { parentDir: 'team/leads' },
    )
    expect(r.kind).toBe('noop')
    if (r.kind === 'noop') {
      expect(r.reason).toMatch(/itself|cycle|self/)
    }
  })

  it('root-level folder → root: no-op (already there)', () => {
    const r = planDrop(
      { path: 'team', kind: 'folder' },
      { parentDir: '' },
    )
    expect(r.kind).toBe('noop')
  })
})
