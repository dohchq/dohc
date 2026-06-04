type Pageish = {
  _id: string
  title?: string | null
  path?: string | null
}

type PagePathInput = Pageish & {
  workspaceSlug: string
}

const RESERVED_PAGE_REFS = new Set([
  'agent',
  'api',
  'files',
  'graph',
  'r',
  'shared',
  'signed-out',
  'v',
  'views',
  'w',
])

function pathLeaf(path: string | null | undefined): string {
  const leaf = (path ?? '').split('/').filter(Boolean).pop() ?? ''
  return leaf.replace(/\.[a-z0-9]+$/i, '')
}

export function slugFromTitle(input: string | null | undefined): string {
  const slug = (input ?? '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'page'
}

export function pageRef(page: Pageish): string {
  const slug = slugFromTitle(page.title?.trim() || pathLeaf(page.path))
  return `${slug}-${page._id}`
}

export function pagePath(page: PagePathInput): string {
  return `/${encodeURIComponent(page.workspaceSlug)}/${encodeURIComponent(
    pageRef(page),
  )}`
}

export function pageIdFromRef(ref: string | null | undefined): string | null {
  if (!ref) return null
  const clean = decodeURIComponent(ref).replace(/^\/+|\/+$/g, '')
  if (RESERVED_PAGE_REFS.has(clean)) return null
  const dash = clean.lastIndexOf('-')
  if (dash <= 0 || dash === clean.length - 1) return null
  return clean.slice(dash + 1)
}
