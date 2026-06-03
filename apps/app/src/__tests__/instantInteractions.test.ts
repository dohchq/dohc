import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(resolve(__dirname, '../routes/_app.tsx'), 'utf8')
const FILE_TREE = readFileSync(
  resolve(__dirname, '../components/FileTree.tsx'),
  'utf8',
)

describe('instant interaction guards', () => {
  it('opens a newly created atom before waiting for the upsert mutation', () => {
    expect(APP).toMatch(
      /async function createAtom[\s\S]*?openAtom\(path\)[\s\S]*?await upsertAtom/,
    )
  })

  it('updates the open path before file and folder move mutations settle', () => {
    expect(APP).toMatch(
      /if \(activePath === fromPath\) setOptimisticPath\(toPath\)[\s\S]*?await moveAtom/,
    )
    expect(APP).toMatch(
      /const activeTarget = projectTreePath\([\s\S]*?activeTarget !== null && activeTarget !== activePath[\s\S]*?setOptimisticPath\(activeTarget\)[\s\S]*?await moveFolder/,
    )
  })

  it('clears active deleted atoms before remove mutations settle', () => {
    expect(APP).toMatch(
      /if \(activePath === path\) clearOpenAtom\(\{ replace: true \}\)[\s\S]*?await removeAtom/,
    )
    expect(APP).toMatch(
      /if \(activePath && pathInsideFolder\(activePath, path\)\) \{[\s\S]*?clearOpenAtom\(\{ replace: true \}\)[\s\S]*?await removeFolder/,
    )
  })

  it('file tree projects create, rename, delete, and move operations locally', () => {
    expect(FILE_TREE).toContain(
      'applyPendingTreeMoves(files, folders, pendingChanges)',
    )
    expect(FILE_TREE).toContain("kind: 'create-file'")
    expect(FILE_TREE).toContain("kind: 'delete-folder'")
    expect(FILE_TREE).toContain('addPendingChange')
  })
})
