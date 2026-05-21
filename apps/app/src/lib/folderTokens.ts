// file-org-v1 §2.2 + §4.3 / D4.5 — folder cosmetic catalogs. The
// allowlists MIRROR `convex/atomLocks.ts:FOLDER_COLORS/FOLDER_ICONS`
// (the data-layer source of truth that rejects misspelled writes).
// Co-locating the UI catalog with the data-layer one is the right
// shape for v1 — both are pinned constant arrays; a future picker
// reads from THIS file (the lucide imports + the CSS var resolver
// live here, not in convex/**).
//
// The picker grid in D4.5b will iterate FOLDER_COLORS + FOLDER_ICONS
// in declaration order.

import {
  Folder,
  FolderHeart,
  FolderArchive,
  FolderClock,
  FolderCog,
  FolderLock,
  FolderSearch,
  FolderTree,
  type LucideIcon,
} from 'lucide-react'
// NOTE: there is no `FolderStar` in lucide-react (the star + folder
// is two separate icons in the design); we reuse Folder for that
// slot and project the star as an overlay icon next to the row.
// FolderStar IS in the allowlist (data layer) but the UI here
// maps it to the base Folder icon (the row's star icon already
// signals starred separately — double-encoding would be loud).

export const FOLDER_COLORS = [
  'default',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
] as const

export type FolderColor = (typeof FOLDER_COLORS)[number]

export const FOLDER_ICONS = [
  'folder',
  'folder-heart',
  'folder-star',
  'folder-lock',
  'folder-cog',
  'folder-search',
  'folder-tree',
  'folder-archive',
  'folder-clock',
] as const

export type FolderIcon = (typeof FOLDER_ICONS)[number]

// Lucide component lookup. Unknown ⇒ Folder default (cheap fail-
// soft — a future schema-allowed-but-UI-not-yet icon renders as
// the base folder without crashing).
const ICON_COMPONENT: Record<FolderIcon, LucideIcon> = {
  folder: Folder,
  'folder-heart': FolderHeart,
  // FolderStar isn't exported by lucide-react; reuse base Folder.
  // The row also renders the standalone Star icon separately when
  // starred, so this is not a visual loss.
  'folder-star': Folder,
  'folder-lock': FolderLock,
  'folder-cog': FolderCog,
  'folder-search': FolderSearch,
  'folder-tree': FolderTree,
  'folder-archive': FolderArchive,
  'folder-clock': FolderClock,
}

export function iconComponentFor(name: string | null | undefined): LucideIcon {
  if (!name) return Folder
  return (ICON_COMPONENT as Record<string, LucideIcon>)[name] ?? Folder
}

// CSS custom-property resolver. `default` maps to the existing
// `--ink-dim` shade so legacy folders (no folderMetadata row) render
// unchanged. Other names map to `--color-folder-<name>` declared in
// styles.css (D4.5 wire-up). Returns a CSS value suitable for
// `style={{ color: ... }}`.
export function colorVarFor(name: string | null | undefined): string {
  if (!name || name === 'default') return 'var(--color-ink-dim)'
  return `var(--color-folder-${name}, var(--color-ink-dim))`
}

export function isFolderColor(s: string): s is FolderColor {
  return (FOLDER_COLORS as readonly string[]).includes(s)
}

export function isFolderIcon(s: string): s is FolderIcon {
  return (FOLDER_ICONS as readonly string[]).includes(s)
}
