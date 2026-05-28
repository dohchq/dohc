import { useEffect } from 'react'

const BRAND = 'dohc'
// Mirrors the static favicon the root route renders (routes/__root.tsx).
// The hook hands the icon link back to this when a page has no emoji.
const DEFAULT_FAVICON = '/favicon.svg'

/**
 * Render a page's emoji as an SVG data-URI favicon — the same trick
 * Notion uses for emoji-iconed pages. One centered glyph, no network
 * request. Multi-codepoint emoji (e.g. 👨‍👩‍👧) survive encodeURIComponent.
 */
function emojiFaviconHref(emoji: string): string {
  // baseline at y=78 + text-anchor=middle centers the glyph without
  // relying on `dominant-baseline` (flaky in the favicon render path).
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<text x="50" y="78" font-size="80" text-anchor="middle">${emoji}</text>` +
    `</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/**
 * Reflect the open page in the browser tab — Notion-style.
 *
 * - `title` → document title `"<title> | dohc"`.
 * - `emoji` → the page's icon becomes the favicon.
 *
 * Each value is `string` | `null` | `undefined`:
 *   - a string applies it,
 *   - `null` shows the brand default (title `"dohc"`, drop-lobe favicon),
 *   - `undefined` means "not known yet" — leave the tab untouched so it
 *     never flashes back to the brand while, say, a shared page loads.
 *
 * Imperative on purpose: the open page is derived from live Convex
 * queries in the app shell (see routes/_app.tsx), not from route loader
 * data — so the tab updates the instant a page is renamed or re-iconed.
 * Effects are client-only (no `document` on the server); the SSR markup
 * keeps the root route's "dohc" title + drop-lobe favicon.
 */
export function useDocumentMeta({
  title,
  emoji,
}: {
  title: string | null | undefined
  emoji: string | null | undefined
}) {
  useEffect(() => {
    if (title === undefined) return
    document.title = title ? `${title} | ${BRAND}` : BRAND
  }, [title])

  useEffect(() => {
    if (emoji === undefined) return
    const href = emoji ? emojiFaviconHref(emoji) : DEFAULT_FAVICON
    // Update the EXISTING icon link(s) in place — explicitly, not via a
    // restore-on-cleanup — so navigation never flashes a stale icon.
    // Appending a second <link rel="icon"> is unreliable: Chrome keeps
    // using the first one declared, so the static favicon would never
    // yield. `rel~="icon"` matches `icon`/`shortcut icon` but NOT
    // `apple-touch-icon` (a single, non-matching token).
    let links = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'),
    )
    if (links.length === 0) {
      const created = document.createElement('link')
      created.setAttribute('rel', 'icon')
      document.head.appendChild(created)
      links = [created]
    }
    for (const link of links) {
      link.setAttribute('type', 'image/svg+xml')
      link.setAttribute('href', href)
    }
  }, [emoji])

  // Reset the tab to the brand defaults when the shell unmounts (e.g.
  // sign-out) so it never keeps a stale page title/favicon behind the
  // sign-in screen.
  useEffect(
    () => () => {
      document.title = BRAND
      document
        .querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')
        .forEach((link) => {
          link.setAttribute('type', 'image/svg+xml')
          link.setAttribute('href', DEFAULT_FAVICON)
        })
    },
    [],
  )
}
