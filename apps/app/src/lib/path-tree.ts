// Path-tree utilities. The vault is path-addressed (Obsidian-style),
// but the UI reads as a real recursive tree (Notion-style) — these
// helpers bridge the two.

export type FileRow = {
  _id: string
  path: string
  title?: string | null
  source: string
  // Last-write timestamp (projected by api.atoms.list). Drives the
  // "recent" ordering in the Quick access section. Absent on callers
  // that don't project it.
  updatedAt?: number
  // html-atoms-v1 §5 — 'html' ⇒ tree badges it as a page (no `.html`
  // extension exists). Advisory/additive; absent on legacy rows.
  type?: string | null
  // file-org-v1 §3.1 (Track-4 D4.4a) — lock/star surface for the
  // tree's affordance rendering. Defaults to false on rows that
  // predate Track-4.
  systemLocked?: boolean
  userLocked?: boolean
  starred?: boolean
  // emoji-icons — user-chosen icon emoji (null/absent ⇒ default icon)
  icon?: string | null
  // D4.8e — rename-proof fileId from frontmatter. The editor's
  // formula plugin resolves `{= id.key }` references to the file
  // with this id (read via api.atoms.list projection). null on
  // legacy rows that predate Track-1.
  fileId?: string | null
}

export type TreePage = {
  path: string
  title: string | null
  type?: string | null
  // file-org-v1 D4.4a — passed through to TreeNode so leaf rows
  // can render the lock/star icons. Folder rows carry these via
  // their own folderMetadata join (D4.5).
  systemLocked?: boolean
  userLocked?: boolean
  starred?: boolean
  // emoji-icons — user-chosen icon emoji (null/absent ⇒ default icon)
  icon?: string | null
}

export type TreeNode = {
  segment: string             // last path segment (e.g. "team" or "anna.md")
  fullPath: string            // unique key for state/expand maps
  page: TreePage | null       // the atom that IS this node (leaf, or folder's index.md)
  children: TreeNode[]
  // file-org-v1 §4.3 / D4.5 — folder-row cosmetic state. Only set
  // on folder nodes (page === null). Mirrors the folderMetadata
  // columns from convex/folders.ts:list.
  icon?: string | null
  color?: string | null
  starred?: boolean
}

// file-org-v1 v9 fold (Codex R8-6 DISPOSITIVE) — the input is the
// UNION of legacy strings and rich folder objects. UI consumers
// that already pass `string[]` keep working byte-identically; new
// callers can pass {path, icon?, color?, starred?} to surface
// folder cosmetics. The picker on the FileTree consumes the rich
// shape (`api.folders.list` returns it post-D4.1a).
export type FolderInput = string | {
  path: string
  icon?: string | null
  color?: string | null
  starred?: boolean
}

// Build a tree from atoms + explicit folder rows. Obsidian-style:
// folders are first-class containers (can sit empty), atoms are leaves.
// Each atom is a leaf node at its full path — no folder-as-page
// conflation. `team/index.md` is just a file inside the team folder.
export function buildTree(
  files: FileRow[],
  folders: FolderInput[] = [],
): TreeNode {
  const root: TreeNode = {
    segment: '',
    fullPath: '',
    page: null,
    children: [],
  }

  // Ensure every explicit folder has a node (even if empty). Carry
  // the cosmetic state (icon/color/starred) onto the folder node
  // so the render site can read it without a separate join.
  for (const f of folders) {
    if (typeof f === 'string') {
      ensureFolderNode(root, f)
    } else {
      const node = ensureFolderNode(root, f.path)
      node.icon = f.icon ?? null
      node.color = f.color ?? null
      node.starred = f.starred === true
    }
  }

  for (const f of files) {
    const segments = f.path.split('/')
    let cursor = root
    let acc = ''
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!
      const isLast = i === segments.length - 1
      acc = acc ? `${acc}/${seg}` : seg
      let child = cursor.children.find((c) => c.segment === seg)
      if (!child) {
        child = {
          segment: seg,
          fullPath: acc,
          page: null,
          children: [],
        }
        cursor.children.push(child)
      }
      if (isLast) {
        child.page = {
          path: f.path,
          title: f.title ?? null,
          type: f.type ?? null,
          systemLocked: f.systemLocked,
          userLocked: f.userLocked,
          starred: f.starred,
          icon: f.icon ?? null,
        }
      } else {
        cursor = child
      }
    }
  }
  sortTree(root)
  return root
}

function ensureFolderNode(root: TreeNode, folderPath: string): TreeNode {
  const segments = folderPath.split('/')
  let cursor = root
  let acc = ''
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg
    let child = cursor.children.find((c) => c.segment === seg)
    if (!child) {
      child = { segment: seg, fullPath: acc, page: null, children: [] }
      cursor.children.push(child)
    }
    cursor = child
  }
  return cursor
}

// file-org-v1 §5.7 / D4.5 — sort order:
//   1. folders before leaves (Obsidian / Notion convention)
//   2. within each tier, STARRED before UNSTARRED
//   3. ties broken by alphabetical (locale-aware)
//
// A folder is "starred" when its folderMetadata row has starred=true
// (carried through `FolderInput.starred` onto the node). A leaf is
// "starred" when its FileRow.starred=true (carried through
// `TreePage.starred`). Empty folders (no children, but present in
// the input folder list) sort as folders. The whole rule reduces to
// a 3-tuple compare; ties broken locale-aware.
function sortTree(node: TreeNode) {
  node.children.sort((a, b) => {
    const aIsFolder = a.page === null
    const bIsFolder = b.page === null
    if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1
    const aStarred = aIsFolder ? a.starred === true : a.page?.starred === true
    const bStarred = bIsFolder ? b.starred === true : b.page?.starred === true
    if (aStarred !== bStarred) return aStarred ? -1 : 1
    return a.segment.localeCompare(b.segment)
  })
  node.children.forEach(sortTree)
}

// Display label for a tree node.
export function nodeLabel(node: TreeNode): string {
  // ai-os-ideas #1 — the Map is the navigable index, not a cryptic
  // `_map` dotfile. Surface it as a friendly first-class artifact.
  if (node.segment === '_map.md') return 'Map · your setup'
  if (node.page?.title) return node.page.title
  // D4.16 — strip the rendering extension (.md OR .html) so a
  // titleless file shows its clean name (e.g. `dashboard`, not
  // `dashboard.html`).
  return node.segment.replace(/\.(md|html)$/i, '')
}

// "Adjacent" pages — for Obsidian-style flat semantics, this returns
// the siblings of the current atom (i.e., other atoms in the same
// folder) so the bottom-of-atom "in this folder" section is useful.
// Returns empty array for root-level atoms (no folder context).
export function findSubpages(
  files: FileRow[],
  currentPath: string,
): FileRow[] {
  const slash = currentPath.lastIndexOf('/')
  if (slash < 0) return []
  const dir = currentPath.slice(0, slash + 1) // includes trailing slash
  return files
    .filter((f) => f.path !== currentPath && f.path.startsWith(dir))
    .filter((f) => !f.path.slice(dir.length).includes('/'))
    .sort((a, b) => a.path.localeCompare(b.path))
}

// Breadcrumb segments for a path. Each segment's target is what should
// open when clicked — intermediate folders open `<folder>/index.md`,
// the final segment is the path itself.
export type Crumb = { label: string; target: string; isCurrent: boolean }

export function pathToBreadcrumbs(path: string): Crumb[] {
  const segs = path.split('/')
  const out: Crumb[] = []
  for (let i = 0; i < segs.length; i++) {
    const isLast = i === segs.length - 1
    const seg = segs[i]!
    if (isLast) {
      out.push({
        label: seg.replace(/\.(md|html)$/i, ''),
        target: segs.slice(0, i + 1).join('/'),
        isCurrent: true,
      })
    } else {
      // Obsidian-style: folders in the breadcrumb are non-clickable
      // (they're not pages).
      out.push({ label: seg, target: '', isCurrent: false })
    }
  }
  return out
}

// All ancestor folder paths of a given atom — used to auto-expand the
// path leading to the active row in the file tree.
export function ancestors(path: string): string[] {
  const segs = path.split('/')
  const out: string[] = []
  for (let i = 1; i < segs.length; i++) {
    out.push(segs.slice(0, i).join('/'))
  }
  return out
}
