import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// file-org-v1 D4.4a — structural assertions on the FileTree's L/S
// keyboard surface + lock/star icon render. The vitest harness is
// node-only (no DOM), so we lock the contract at the source level —
// equivalent to the prepareStep / skillTurnGate pattern used by
// Track-3 (structural-presence + unit-locked pure logic = behavioral
// confidence without a renderer).

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(
  resolve(__dirname, '../components/FileTree.tsx'),
  'utf8',
)

describe('FileTree D4.4a — Track-4 affordances surface', () => {
  it('imports the lucide Lock + Star icons (single source for the iconography)', () => {
    // Icons are imported as named members from lucide-react.
    expect(SRC).toMatch(/import\s*\{[^}]*\bLock\b[^}]*\bStar\b[^}]*\}\s*from\s*['"]lucide-react['"]/s)
  })

  it('renders Lock icon on a leaf row when systemLocked or userLocked is true', () => {
    // The leaf-row branch renders the Lock icon inside a
    // (systemLocked || userLocked) conditional with an aria-label
    // distinguishing the two owners.
    expect(SRC).toMatch(/node\.page!\.systemLocked\s*\|\|\s*node\.page!\.userLocked/)
    expect(SRC).toMatch(/<Lock\b[^>]*aria-label=\{?[\s\S]*?system-locked/)
  })

  it('renders Star icon on a leaf row when starred is true', () => {
    expect(SRC).toMatch(/node\.page!\.starred\s*&&\s*\(/)
    expect(SRC).toMatch(/<Star\b[^>]*aria-label="starred"/)
  })

  it('renders a Share2 indicator only for files the owner has shared', () => {
    expect(SRC).toMatch(/sharedByMeFileIds\?: string\[\]/)
    expect(SRC).toMatch(
      /const\s+sharedByMeIds\s*=\s*useMemo\(\s*\(\)\s*=>\s*new\s+Set\(sharedByMeFileIds\s*\?\?\s*\[\]\)/,
    )
    expect(SRC).toMatch(/sharedByMeIds\.has\(node\.page!\.fileId\s*\?\?\s*['"]['"]\)/)
    expect(SRC).toMatch(/<Share2\b[^>]*aria-label="shared"/)
  })

  it('renders special icons for the .context folder and canonical context files', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*\bBrain\b[^}]*\bUser\b[^}]*\bTarget\b[^}]*\bBuilding2\b[^}]*\}\s*from\s*['"]lucide-react['"]/s)
    expect(SRC).toMatch(/node\.fullPath\s*===\s*['"]\.context['"]/)
    expect(SRC).toMatch(/path\s*===\s*['"]\.context\/me\.md['"]/)
    expect(SRC).toMatch(/path\s*===\s*['"]\.context\/intent\.md['"]/)
    expect(SRC).toMatch(/path\s*===\s*['"]\.context\/company\.md['"]/)
  })

  it('does not render a Quick access sidebar section', () => {
    expect(SRC).not.toMatch(/Quick access/)
    expect(SRC).not.toMatch(/filetree-quick/)
    expect(SRC).not.toMatch(/selectQuickAccess/)
  })

  it('does not render a Context sidebar section', () => {
    expect(SRC).not.toMatch(/label="Context"/)
    expect(SRC).not.toMatch(/filetree-context/)
    expect(SRC).not.toMatch(/ContextList/)
    expect(SRC).not.toMatch(/partitionTree/)
  })

  it('Shift+L (lower OR upper) toggles lock (R3 fold — bare L reserved for future typeahead)', () => {
    // R3 fold of convergent FAIL-B — APG tree pattern reserves
    // printable letters for typeahead. Lock/star moved to Shift+.
    expect(SRC).toMatch(
      /\(e\.key\s*===\s*['"]l['"]\s*\|\|\s*e\.key\s*===\s*['"]L['"]\)\s*&&\s*e\.shiftKey/,
    )
    // R4 fold (Codex FAIL-3 second-pass) — handler reads
    // currentlyLocked from optimistic state, then calls
    // onToggleLock with that value.
    expect(SRC).toMatch(
      /onToggleLock\(\s*pathSnapshot\s*,\s*currentlyLocked\s*\)/,
    )
  })

  it('Shift+S toggles star (R3 fold)', () => {
    expect(SRC).toMatch(
      /\(e\.key\s*===\s*['"]s['"]\s*\|\|\s*e\.key\s*===\s*['"]S['"]\)\s*&&\s*e\.shiftKey/,
    )
    // The keyboard handler delegates to the shared toggleFileStar
    // (also used by the row's star button), which reads the optimistic
    // state then calls onToggleStar with the current value.
    expect(SRC).toMatch(/toggleFileStar\(\s*pathSnapshot\s*\)/)
    expect(SRC).toMatch(/onToggleStar\(\s*path\s*,\s*current\s*\)/)
  })

  it('pending* Maps drive optimistic lock/star/folder-star (R4 fold of Codex FAIL-3 second-pass)', () => {
    // R4 fold: pendingPaths Set ⇒ three pending Maps with the
    // intended NEW state. Reads use the optimistic value first,
    // falling back to the row prop. Cleared by a useEffect that
    // matches the projection against the intent.
    expect(SRC).toMatch(/pendingLocks\s*=\s*useRef\(\s*new\s+Map<string,\s*boolean>\(\)\s*\)/)
    expect(SRC).toMatch(/pendingStars\s*=\s*useRef\(\s*new\s+Map<string,\s*boolean>\(\)\s*\)/)
    expect(SRC).toMatch(/pendingFolderStars\s*=\s*useRef\(\s*new\s+Map<string,\s*boolean>\(\)\s*\)/)
    expect(SRC).toMatch(/pendingLocks\.current\.get\(focusedPath\)/)
    expect(SRC).toMatch(/pendingLocks\.current\.set\(focusedPath,\s*willLock\)/)
  })

  it('reconcile useEffect drops pending entries when projection catches up (R4 fold)', () => {
    // Walks pendingLocks / pendingStars / pendingFolderStars and
    // deletes any entry where the live row's flag matches the
    // optimistic intent.
    expect(SRC).toMatch(/for\s*\(const\s+\[path,\s*intended\]\s+of\s+pendingLocks\.current\)/)
    expect(SRC).toMatch(/\(row\.userLocked\s*===\s*true\)\s*===\s*intended/)
  })

  it('focusedPath re-anchors when stale (R3 fold of Codex FAIL-4)', () => {
    // The bootstrap useEffect must trip when focusedPath !== null
    // BUT is not in visible flatRows (e.g., stale activePath
    // pointing at a deleted file).
    expect(SRC).toMatch(
      /focusedPath\s*===\s*null\s*\|\|\s*!visible\.has\(focusedPath\)/,
    )
  })

  it('threads the lock + star projection through FileRow / TreeNode types', () => {
    const pathTreeSrc = readFileSync(
      resolve(__dirname, '../lib/path-tree.ts'),
      'utf8',
    )
    expect(pathTreeSrc).toMatch(/systemLocked\?: boolean/)
    expect(pathTreeSrc).toMatch(/userLocked\?: boolean/)
    expect(pathTreeSrc).toMatch(/starred\?: boolean/)
    // The leaf-row's TreePage carries them too so the renderer
    // can read off the node without re-querying.
    expect(pathTreeSrc).toMatch(/type TreePage[\s\S]*?systemLocked\?: boolean/)
  })

  // file-org-v1 D4.5 — folder-level affordances on the tree.
  // R3 fold: path captured as `pathSnapshot` so the .finally
  // resolves against a stable id (defends against focusedPath
  // changing while the mutation is in flight).
  it('S key on a folder row delegates to the shared toggleFolderStar', () => {
    // Mirrors the file path: the handler calls toggleFolderStar, which
    // reads the optimistic state then calls onToggleFolderStar(path, current).
    expect(SRC).toMatch(/toggleFolderStar\(\s*pathSnapshot\s*\)/)
    expect(SRC).toMatch(/onToggleFolderStar\(\s*path\s*,\s*current\s*\)/)
  })

  it('Folder row renders the folder shape colored via colorVarFor (no icon — color only)', () => {
    expect(SRC).toMatch(/colorVarFor\(node\.color\)/)
    // folders are color-only now — no emoji/icon overlay
    expect(SRC).not.toMatch(/emojiForFolderIcon/)
  })

  it('Folder row renders the Star icon when node.starred is true', () => {
    expect(SRC).toMatch(/node\.starred\s*&&\s*\(/)
    expect(SRC).toMatch(/<Star\b[^>]*aria-label="starred folder"/)
  })

  // D4.6 — VSCode-style "create where you're standing".
  it('D4.6 — targetDir derives from focused row (folder ⇒ self; leaf ⇒ parent)', () => {
    // The useMemo branches: row.isFolder ⇒ fullPath; else parentPath.
    expect(SRC).toMatch(/if\s*\(row\.isFolder\)\s*return\s+row\.fullPath/)
    expect(SRC).toMatch(/return\s+row\.parentPath\s*\?\?\s*['"]['"]/)
  })

  it('D4.6 — commitPending prepends targetDir to the typed name (escape-hatch when input contains slash)', () => {
    expect(SRC).toMatch(
      /const\s+path\s*=\s*name\.includes\(['"]\/['"]\)\s*\|\|\s*targetDir\s*===\s*['"]['"][\s\S]*?\$\{targetDir\}\/\$\{name\}/,
    )
  })

  it('D4.6 — beginPending auto-expands the target folder so the new row is visible', () => {
    expect(SRC).toMatch(/function\s+beginPending/)
    expect(SRC).toMatch(/!expanded\.has\(targetDir\)/)
    expect(SRC).toMatch(/setExpanded\(\(prev\)\s*=>\s*new\s+Set\(prev\)\.add\(targetDir\)\)/)
  })

  // D4.7 — HTML5 drag-and-drop.
  it('D4.7 — leaf rows are draggable; carry the file path + kind via dataTransfer', () => {
    expect(SRC).toMatch(/draggable\b/)
    // Leaf branch sets the source as kind:'file'.
    expect(SRC).toMatch(/\{\s*path:\s*filePath,\s*kind:\s*['"]file['"]\s*\}\s*satisfies\s*DragSource/)
  })

  it('D4.7 — folder rows are draggable; carry path + kind:folder', () => {
    expect(SRC).toMatch(
      /\{[\s\S]*?path:\s*node\.fullPath,[\s\S]*?kind:\s*['"]folder['"][\s\S]*?\}\s*satisfies\s*DragSource/,
    )
  })

  it('D4.7 — leaf drop drops into the LEAF\'S PARENT folder', () => {
    // leafParent is computed from filePath, then passed to
    // handleDrop in the leaf row's onDrop.
    expect(SRC).toMatch(/const\s+leafParent\s*=/)
    expect(SRC).toMatch(/handleDrop\(e,\s*leafParent\)/)
  })

  it('D4.7 — folder drop drops INTO the target folder', () => {
    expect(SRC).toMatch(/handleDrop\(e,\s*node\.fullPath\)/)
  })

  it('D4.7 — root drop zone on the tree container drops to ""', () => {
    expect(SRC).toMatch(/handleDrop\(e,\s*['"]['"]\)/)
  })

  it('D4.7 — dragOverPath highlight applies bg-accent-2-soft + ring on the target row', () => {
    expect(SRC).toMatch(/bg-accent-2-soft\s+ring-1\s+ring-accent-2/)
  })

  it('D4.7 — uses a custom mime "application/dohc-tree-row" (avoids cross-origin DnD leak)', () => {
    expect(SRC).toMatch(/application\/dohc-tree-row/)
    // Always 4 occurrences: dragStart×2 (leaf+folder) + dragOver×3 (leaf,folder,root) + drop×3 (read in handleDrop).
    const occurrences = SRC.match(/application\/dohc-tree-row/g) ?? []
    expect(occurrences.length).toBeGreaterThanOrEqual(6)
  })
})
