import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AtomEditor } from '@/components/AtomEditor'

// DEV-ONLY, NO-AUTH playground to verify Phase 1b inline atoms in a
// real Tiptap editor (the WorkOS wall blocks the real app; this route
// renders the editor in isolation — no useAuth, no Convex queries).
// It exists to close the deferred Tiptap-serializer round-trip check:
// the <pre> shows EXACTLY what Tiptap emits via markdownUpdated, so we
// can see whether `{billable_this_week}` survives or gets escaped.

export const Route = createFileRoute('/playground')({
  component: Playground,
})

const SAMPLE = [
  '# Inline-atom playground',
  '',
  'Logged {hours: 6} on {client: Acme_Corp} today, rate {rate: 150}.',
  '',
  'Team total: {billable_this_week} — and a flag {billable: true}.',
  '',
  'Due {due: 2026-06-01}. Some _emphasis_ and a code span `{x: 1}`.',
  '',
  'Not an atom: the set \\{1,2,3\\} and {tags: [a,b]}.',
].join('\n')

function Playground() {
  const [mounted, setMounted] = useState(false)
  const [md, setMd] = useState(SAMPLE)

  useEffect(() => {
    // Force the flag on for this page, then mount client-only (Tiptap
    // needs the DOM; never SSR it).
    try {
      localStorage.setItem('dohc:inline-atoms', '1')
    } catch {
      /* ignore */
    }
    setMounted(true)
  }, [])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', height: '100vh', fontFamily: 'system-ui' }}>
      <div style={{ padding: 16, overflow: 'auto', borderRight: '1px solid #ddd' }}>
        <div data-testid="editor">
          {mounted ? (
            <AtomEditor value={SAMPLE} onChange={setMd} autoFocus />
          ) : (
            <p>loading editor…</p>
          )}
        </div>
      </div>
      <div style={{ padding: 16, overflow: 'auto', background: '#0a0a0b', color: '#e8e2d6' }}>
        <p style={{ opacity: 0.6, fontSize: 12 }}>
          Tiptap markdownUpdated output (round-trip evidence — look for stray
          backslashes before _ in billable_this_week / Acme_Corp):
        </p>
        <pre data-testid="roundtrip" style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>
          {md}
        </pre>
      </div>
    </div>
  )
}
