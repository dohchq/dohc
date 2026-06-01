import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { AtomEditor } from '@/components/AtomEditor'
import { PropertiesPanel } from '@/components/PropertiesPanel'
import { SkeletonText } from '@/components/Skeleton'
import { ActiveWorkspaceProvider } from '@/lib/active-workspace'
import {
  applyFrontmatter,
  fmString,
  frontmatterEntries,
  parseFrontmatter,
  setFrontmatterTitle,
} from '@/lib/frontmatter'

export const Route = createFileRoute('/playground')({
  component: Playground,
})

const SAMPLE_DOCUMENT = [
  '---',
  'id: tiptap-playground',
  'title: Tiptap',
  'status: testing',
  '---',
  'This is editable text in the page body.',
  '',
  'Link another page with [[ideas/tiptap-roadmap]].',
  '',
  '```ascii',
  '   +-------------------+',
  '   | dohc page body    |',
  '   | text is the base  |',
  '   +-------------------+',
  '```',
  '',
  'A final paragraph gives slash commands a plain-text place to start.',
].join('\n')

const KNOWN_FILES = [
  { path: 'ideas/tiptap-roadmap.md', title: 'Tiptap roadmap' },
  { path: 'notes/editor-ux.md', title: 'Editor UX' },
  { path: 'projects/dohc.md', title: 'dohc' },
]

function propsFromFrontmatter(body: string): Record<string, string> {
  return Object.fromEntries(frontmatterEntries(body).map((e) => [e.key, e.value]))
}

function replaceMarkdownBody(fullBody: string, nextMarkdown: string): string {
  return applyFrontmatter(nextMarkdown, propsFromFrontmatter(fullBody))
}

function Playground() {
  return (
    <ActiveWorkspaceProvider>
      <PlaygroundEditor />
    </ActiveWorkspaceProvider>
  )
}

function PlaygroundEditor() {
  const [mounted, setMounted] = useState(false)
  const [doc, setDoc] = useState(SAMPLE_DOCUMENT)
  const parsed = useMemo(() => parseFrontmatter(doc), [doc])
  const title = fmString(parsed.meta, 'title', '')

  useEffect(() => {
    try {
      localStorage.setItem('dohc:inline-atoms', '1')
      document.documentElement.setAttribute('data-theme', 'dark')
    } catch {
      /* ignore */
    }
    setMounted(true)
  }, [])

  return (
    <main className="min-h-screen bg-page text-ink">
      <section className="doc doc-editing mx-auto w-full max-w-[760px] px-6 py-10">
        <input
          className="dohc-title-field"
          value={title}
          placeholder="Untitled"
          spellCheck={false}
          aria-label="Page title"
          onChange={(event) =>
            setDoc((current) =>
              setFrontmatterTitle(current, event.currentTarget.value),
            )
          }
        />
        <PropertiesPanel body={doc} onChange={setDoc} />
        {mounted ? (
          <AtomEditor
            value={parsed.body}
            onChange={(next) =>
              setDoc((current) => replaceMarkdownBody(current, next))
            }
            frontmatter={parsed.meta}
            autoFocus
            knownFiles={KNOWN_FILES}
            disableReactiveResolvers
          />
        ) : (
          <SkeletonText lines={5} className="py-8" />
        )}
      </section>
    </main>
  )
}
