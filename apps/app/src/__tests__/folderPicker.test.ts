import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// file-org-v1 D4.5b — structural assertions on the FolderPicker
// dialog. vitest is node-only (no DOM), so we lock the contract at
// the source level. A Playwright pass will own the behavior (focus
// trap, escape key, click-outside) in a real browser. The
// structural surface lock here catches regressions in:
//   • ARIA dialog wiring (role, modal flag, labelledby)
//   • Iteration over FOLDER_ICONS + FOLDER_COLORS allowlists
//   • Escape-key keydown listener registration
//   • Click-outside (backdrop) → onClose dispatch
//   • Done / Cancel / Clear buttons present and wired

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(
  resolve(__dirname, '../components/FolderPicker.tsx'),
  'utf8',
)
const TREE_SRC = readFileSync(
  resolve(__dirname, '../components/FileTree.tsx'),
  'utf8',
)

describe('FolderPicker — D4.5b structural surface', () => {
  it('renders as a modal dialog with proper ARIA wiring', () => {
    expect(SRC).toMatch(/role="dialog"/)
    expect(SRC).toMatch(/aria-modal="true"/)
    expect(SRC).toMatch(/aria-labelledby="folder-picker-title"/)
    expect(SRC).toMatch(/id="folder-picker-title"/)
  })

  it('folders are color-only: iterate FOLDER_COLORS, no icon picker', () => {
    expect(SRC).toMatch(/FOLDER_COLORS\.map\(/)
    // no folder icon/emoji UI anymore
    expect(SRC).not.toMatch(/EmojiPicker/)
    expect(SRC).not.toMatch(/Choose an icon/)
  })

  it('registers an Escape-key listener that calls onClose', () => {
    expect(SRC).toMatch(
      /window\.addEventListener\(\s*['"]keydown['"][\s\S]*?return\s*\(\s*\)\s*=>\s*window\.removeEventListener\(\s*['"]keydown['"]/,
    )
    expect(SRC).toMatch(/e\.key\s*===\s*['"]Escape['"]/)
  })

  it('backdrop click closes via target-equals-currentTarget guard', () => {
    // The outer overlay onClick distinguishes a click on itself
    // (the backdrop, target === currentTarget) from a click that
    // bubbled up from the card. Card uses stopPropagation.
    expect(SRC).toMatch(/e\.target\s*===\s*e\.currentTarget[\s\S]*?onClose\(\)/)
    expect(SRC).toMatch(/onClick=\{?\(e\)\s*=>\s*e\.stopPropagation\(\)\}?/)
  })

  it('Done button calls onCommit with color + starred (icon always cleared)', () => {
    expect(SRC).toMatch(
      /onCommit\(\{\s*icon:\s*null\s*,\s*color\s*,\s*starred\s*\}\)/,
    )
  })

  it('Clear button calls onCommit with all-null + starred:false', () => {
    expect(SRC).toMatch(
      /onCommit\(\{\s*icon:\s*null,\s*color:\s*null,\s*starred:\s*false\s*\}\)/,
    )
  })

  it('Cancel button calls onClose without committing', () => {
    // Cancel button onClick is onClose (no commit). Match the button
    // text + its onClick wiring.
    expect(SRC).toMatch(/onClick=\{onClose\}[\s\S]{0,400}Cancel/)
  })

  it('Initial focus lands on the first color swatch (ref forwarded)', () => {
    expect(SRC).toMatch(/firstButtonRef[\s\S]*?useRef/)
    expect(SRC).toMatch(/firstButtonRef\.current\?\.focus\(\)/)
    // The ref is on the first color button (ci === 0).
    expect(SRC).toMatch(/ci\s*===\s*0\s*\?\s*firstButtonRef\s*:\s*undefined/)
  })

  // R3 fold (convergent FAIL-A) — focus trap is required when
  // aria-modal="true". Tab at last focusable cycles to first;
  // Shift+Tab at first cycles to last.
  it('traps focus via Tab/Shift+Tab cycle (R3 fold of convergent FAIL-A)', () => {
    expect(SRC).toMatch(/e\.key\s*!==\s*['"]Tab['"]/)
    expect(SRC).toMatch(/e\.shiftKey\s*&&\s*document\.activeElement\s*===\s*first/)
    expect(SRC).toMatch(/!e\.shiftKey\s*&&\s*document\.activeElement\s*===\s*last/)
    // A focusables() helper collects buttons + inputs + tabbable
    // descendants while excluding [tabindex="-1"].
    expect(SRC).toMatch(/tabindex="-1"/)
  })

  it('renders role="alert" error region when onCommit throws (R3 fold of Codex FAIL-5 / indep FAIL-3)', () => {
    expect(SRC).toMatch(/role="alert"/)
    expect(SRC).toMatch(/aria-live="assertive"/)
    expect(SRC).toMatch(/setError\(/)
  })

  // R4 fold of convergent FAIL-1 — outside-focus fallback was
  // broken (focused unfocusable card div). Now focuses first item.
  it('R4 fold — outside-focus fallback refocuses the first item, not the card div', () => {
    expect(SRC).toMatch(
      /!cardRef\.current\.contains\(document\.activeElement\)[\s\S]{0,200}first\.focus\(\)/,
    )
  })

  // R4 fold of Codex FAIL-2 / indep FAIL-3 — all controls disabled
  // while busy; Escape + backdrop refuse to close.
  it('R4 fold — every control disabled when busy=true', () => {
    // Icon buttons, color buttons, checkbox, X (close), Clear,
    // Cancel, Done all carry `disabled={busy}` or check `if (busy)`
    // at handler entry.
    expect(SRC.match(/disabled=\{busy\}/g)?.length ?? 0).toBeGreaterThanOrEqual(5)
    // Escape branch refuses to close when busy.
    expect(SRC).toMatch(/['"]Escape['"][\s\S]{0,300}if\s*\(busy\)/)
    // Backdrop click also gated.
    expect(SRC).toMatch(/if\s*\(busy\)\s*return\s*\n\s*if\s*\(e\.target\s*===\s*e\.currentTarget\)/)
  })

  it('R4 fold + R4b fix — mountedRef guards setState after unmount (Strict Mode safe)', () => {
    // R4b — init with `false`, set to `true` in the effect BODY so
    // every (re-)mount flips it back. Strict Mode dev mounts →
    // cleanup → re-mount the SAME ref; without the body-set, the
    // ref is permanently false after the strict-mode unmount.
    expect(SRC).toMatch(/mountedRef\s*=\s*useRef\(false\)/)
    expect(SRC).toMatch(/mountedRef\.current\s*=\s*true/)
    expect(SRC).toMatch(/mountedRef\.current\s*=\s*false/)
    expect(SRC).toMatch(/if\s*\(!mountedRef\.current\)\s*return/)
  })
})

describe('FileTree — D4.5b picker integration', () => {
  it('renders FolderPicker when pickerFolder is non-null and onSetFolderMeta is wired', () => {
    expect(TREE_SRC).toMatch(/import\s*\{\s*FolderPicker\s*\}\s*from\s*['"]\.\/FolderPicker['"]/)
    expect(TREE_SRC).toMatch(/pickerFolder\s*&&\s*onSetFolderMeta\s*&&/)
    expect(TREE_SRC).toMatch(/<FolderPicker\b/)
  })

  it('folder RowActions gets onCustomize that opens the picker', () => {
    // The folder row wires onCustomize to a setter that captures
    // the current node's cosmetics as the picker's `initial`.
    expect(TREE_SRC).toMatch(/onCustomize=\{[\s\S]*?onOpenPicker/)
    expect(TREE_SRC).toMatch(/setPickerFolder\(\{\s*path:\s*n\.fullPath/)
  })

  it('leaf rows DO get onCustomize — the set-icon emoji picker (emoji-icons)', () => {
    // Leaf (file) rows now expose an onCustomize that opens the
    // EmojiPicker (customizeLabel "set icon"). Slice the leaf-row
    // branch + its RowActions and assert onCustomize is present.
    const leafBranchStart = TREE_SRC.indexOf('if (!isFolder) {')
    expect(leafBranchStart).toBeGreaterThan(0)
    const leafRowActionsIdx = TREE_SRC.indexOf('<RowActions', leafBranchStart)
    expect(leafRowActionsIdx).toBeGreaterThan(0)
    const leafRowActionsEnd = TREE_SRC.indexOf('/>', leafRowActionsIdx)
    const leafSlice = TREE_SRC.slice(leafBranchStart, leafRowActionsEnd + 2)
    expect(leafSlice).toMatch(/onCustomize/)
    expect(leafSlice).toMatch(/customizeLabel="set icon"/)
  })
})

describe('FileTree — D4.4b ARIA-live announcer', () => {
  it('renders a polite live region with role="status"', () => {
    expect(TREE_SRC).toMatch(
      /role="status"[\s\S]{0,200}aria-live="polite"[\s\S]{0,200}aria-atomic="true"/,
    )
  })

  it('L key sets announcement before/after the toggle', () => {
    expect(TREE_SRC).toMatch(/setAnnouncement\(willLock\s*\?\s*['"]locking…['"]/)
    expect(TREE_SRC).toMatch(/setAnnouncement\(willLock\s*\?\s*['"]locked['"]/)
  })

  it('S key on leaf + folder both announce', () => {
    expect(TREE_SRC).toMatch(/setAnnouncement\(willStar\s*\?\s*['"]starring…['"]/)
    expect(TREE_SRC).toMatch(/setAnnouncement\(willStar\s*\?\s*['"]starring folder…['"]/)
  })
})
