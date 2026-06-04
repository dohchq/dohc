import { slugFromTitle } from './page-urls'

type Threadish = {
  threadId: string
  title?: string | null
  projectPath?: string | null
}

type ThreadPathInput = Threadish & {
  workspaceSlug: string
}

const THREAD_MARKER = '-thread_'

function fallbackTitle(thread: Threadish): string {
  const title = thread.title?.trim()
  if (title) return title
  const projectPath = thread.projectPath?.trim().replace(/^\/+|\/+$/g, '')
  return projectPath ? `${projectPath} chat` : 'Workspace chat'
}

export function agentThreadRef(thread: Threadish): string {
  return `${slugFromTitle(fallbackTitle(thread))}${THREAD_MARKER}${thread.threadId}`
}

export function agentThreadPath(thread: ThreadPathInput): string {
  return `/${encodeURIComponent(thread.workspaceSlug)}/agent/${encodeURIComponent(
    agentThreadRef(thread),
  )}`
}

export function agentThreadIdFromRef(
  ref: string | null | undefined,
): string | null {
  if (!ref) return null
  const clean = decodeURIComponent(ref).replace(/^\/+|\/+$/g, '')
  const marker = clean.lastIndexOf(THREAD_MARKER)
  if (marker <= 0) return null
  const threadId = clean.slice(marker + THREAD_MARKER.length)
  return threadId.length > 0 ? threadId : null
}
