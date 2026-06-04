import { createFileRoute } from '@tanstack/react-router'
import { getAuth } from '@workos/authkit-tanstack-react-start'
import { ConvexHttpClient } from 'convex/browser'
import { JSDOM } from 'jsdom'
import { api } from '../../../convex/_generated/api'
import { sanitizeAtomHtml, htmlAtomResponseHeaders } from '@/lib/htmlSanitize'
import { ATOM_BODY_MAX_BYTES } from '@/lib/inlineAtom'
import {
  harvestFormulaSrcsFromDoc,
  resolveAtomsInDoc,
  formulaValueToText,
} from '@/lib/htmlFormula'
import { HTML_ATOM_HEAD_STYLE } from '@/lib/htmlAtomShell'

// Matches convex MAX_FORMULAS (formulaEval.evalFormulas slices to it
// anyway) — cap srcs HERE so we never build an oversized query.
const MAX_FORMULAS_SENT = 64

// html-atoms-v1 §2-B — the auth-gated, same-origin render route.
// `<iframe src="/r/<atomId>" sandbox="">` (the sandbox + parent
// re-pin are wired in P3/AtomView). PURE SERVER ROUTE (no component
// export) ⇒ this module + its jsdom-backed sanitizer NEVER reach the
// client bundle.
//
// Pipeline: getAuth() (session) → ConvexHttpClient with the WorkOS
// access token → api.htmlAtoms.getRenderable (workspace derived
// SERVER-SIDE from the token via requireWorkspace — the confused-
// deputy defense; the URL atomId is only a lookup key in the
// caller's own workspace) → sanitizeAtomHtml → minimal self-
// contained shell → the EXACT §2-C response headers.
//
// `{= }` server-side resolution (§3), data:-inlined fonts (§2a) and
// the reactivity nonce are P4/P3 — deliberately NOT here. P2b is:
// authenticate, fetch own-workspace html atom, sanitize, headers.

// D4.11c — Vite injects `VITE_*` vars into `import.meta.env`, NOT
// `process.env`. The env file only defines VITE_CONVEX_URL, so the
// old `process.env.*` chain resolved to '' in the dev server → the
// route 500'd ("Server not configured") → the html-atom iframe
// rendered blank. Mirror src/lib/convex-client.ts which already
// falls back to import.meta.env. (Codex /codex review root cause.)
const CONVEX_URL =
  (typeof process !== 'undefined' && process.env?.CONVEX_URL) ||
  import.meta.env?.VITE_CONVEX_URL ||
  ''

// Trusted, fixed shell — author HTML is the ONLY untrusted part and
// it is sanitized before interpolation. §2a typographic baseline +
// IBM Plex Mono data:-inlined via HTML_ATOM_HEAD_STYLE (body uses the
// system sans stack) — zero network, permitted by the header CSP
// (`style-src 'unsafe-inline'; font-src data:`). The §3 walk SKIPs
// STYLE ancestors ⇒ no `{= }` resolves inside this trusted block.
function wrap(bodyHtml: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<title>dohc</title>' +
    '<style>' + HTML_ATOM_HEAD_STYLE + '</style>' +
    '</head><body>' +
    bodyHtml +
    '</body></html>'
  )
}

// Error bodies are FIXED, trusted strings (never author content) and
// still carry the §2-C headers so the iframe shows a calm message,
// not browser error chrome.
function safeResponse(status: number, message: string): Response {
  return new Response(wrap(`<p>${message}</p>`), {
    status,
    headers: {
      ...htmlAtomResponseHeaders(),
      // Route-transport hardening for per-user auth-gated content
      // (distinct from the frozen §2-C content-security trio): keep
      // it out of shared/bfcache, send no referrer.
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

export const Route = createFileRoute('/r/$atomId')({
  server: {
    handlers: {
      GET: async ({
        request,
        params,
      }: {
        request: Request
        params: { atomId: string }
      }) => {
        if (!CONVEX_URL) return safeResponse(500, 'Server not configured.')

        // (a) Authenticate from the session (no client-supplied id).
        let auth: Awaited<ReturnType<typeof getAuth>>
        try {
          auth = await getAuth()
        } catch {
          return safeResponse(401, 'Sign in to view this page.')
        }
        if (!auth.user || !auth.accessToken) {
          return safeResponse(401, 'Sign in to view this page.')
        }

        // org-plan §5: the active workspace is supplied via the URL
        // `?w=<workspaceId>` query param (HtmlAtomFrame appends it; old
        // shared links may omit it, in which case requireWorkspace
        // defaults to the caller's personal workspace via the
        // back-compat path). The route NEVER reads localStorage —
        // server-side runtime has no client state.
        const url = new URL(request.url)
        const wParam = url.searchParams.get('w')
        const activeWorkspaceId =
          wParam && wParam.length > 0 ? wParam : undefined

        // (b) Fetch the atom, workspace-scoped SERVER-SIDE by the
        // token (requireWorkspace in the query). Any negative case
        // (missing / tombstoned / other workspace / not html) → null.
        let result: { html: string; updatedAt: number } | null
        try {
          const client = new ConvexHttpClient(CONVEX_URL)
          client.setAuth(auth.accessToken)
          result = await client.query(api.htmlAtoms.getRenderable, {
            atomId: params.atomId,
            activeWorkspaceId,
          })
        } catch (err) {
          // requireWorkspace throws 'Not authenticated' on an
          // invalid/expired token mid-request → that IS a 401. ANY
          // OTHER throw (bad CONVEX_URL, network, schema/data
          // corruption) is a real outage — surface 500 + log it; do
          // NOT mask it as an auth problem. (P2 dual-review: Codex
          // FAIL-2 / indep M2.) Neither branch fails open — both
          // return a fixed, trusted body.
          const msg = err instanceof Error ? err.message : String(err)
          if (/not authenticated/i.test(msg)) {
            return safeResponse(401, 'Sign in to view this page.')
          }
          // Ultrathink M5 — an authenticated-but-not-authorized caller
          // (e.g. ?w=<org I'm not in>) used to hit the generic 500.
          // Authz failures are 404 (deliberately not 403) to avoid
          // confirming the workspace exists — minor enumeration vector.
          if (
            /not a member of workspace|membership not active/i.test(msg)
          ) {
            return safeResponse(404, 'Not found.')
          }
          console.error('[r/$atomId] render failed:', err)
          return safeResponse(500, 'Could not render this page.')
        }
        if (!result) return safeResponse(404, 'Not found.')

        // (c) Sanitize the author HTML (§2-C defense-in-depth).
        const safe = sanitizeAtomHtml(result.html)

        // (d) §3 — resolve `{= }` SERVER-SIDE on the parsed,
        // sanitized DOM (text nodes ONLY, via the SAME shared walk +
        // FROZEN parser the client harvest uses — one impl §6).
        // Writing the value into a text node + re-serializing makes
        // a value containing markup INERT by construction (the
        // serializer escapes — proven by htmlFormula.test.ts).
        //
        // P4a dual-review folds:
        //  - parse `wrap(safe)` (the EXACT bytes we serve) — NOT the
        //    bare fragment: a leading <style>/metadata tag would be
        //    fostered into <head> and lost if we parsed a fragment
        //    then serialized only <body> (Codex FAIL-2).
        //  - the WHOLE step is one try/catch ⇒ ANY throw (jsdom, a
        //    DOM-global regression, …) fails soft to the literal
        //    `wrap(safe)` (calm §4: the page renders with literal
        //    `{= }`, never a 500/blank — FAIL-1 was an unguarded
        //    throw); only a real auth failure ⇒ 401.
        //  - byte-cap + src-cap before any parse/query (DoS).
        let finalHtml = wrap(safe)
        const overCap =
          new TextEncoder().encode(safe).length > ATOM_BODY_MAX_BYTES
        // D4.10 — entry condition widened from `{=` to `{` so value
        // atoms `{key: value}` get substituted too (the editor
        // renders them as pills showing just the value; the HTML
        // view now matches). Formulas still resolve via the
        // existing evalFormulas query; value atoms substitute from
        // the parser's own `.value` field. liveTotals stay literal
        // (legacy form per the system prompt).
        if (!overCap && safe.indexOf('{') !== -1) {
          try {
            const dom = new JSDOM(finalHtml)
            const doc = dom.window.document
            const srcs = harvestFormulaSrcsFromDoc(doc).slice(
              0,
              MAX_FORMULAS_SENT,
            )
            // Only query evalFormulas when there ARE formulas;
            // value-atom substitution doesn't need the round-trip.
            let map: Map<string, number | string | null> = new Map()
            if (srcs.length > 0) {
              const fc = new ConvexHttpClient(CONVEX_URL)
              fc.setAuth(auth.accessToken)
              const rows = await fc.query(api.formulaEval.evalFormulas, {
                srcs,
                activeWorkspaceId,
              })
              map = new Map(rows.map((r) => [r.src, r.value]))
            }
            // One DOM walk substitutes BOTH kinds in a single pass.
            resolveAtomsInDoc(doc, (s) => formulaValueToText(map.get(s)))
            finalHtml = dom.serialize()
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (/not authenticated/i.test(msg)) {
              return safeResponse(401, 'Sign in to view this page.')
            }
            // Calm §4: keep the literal `wrap(safe)` — page renders,
            // tokens stay literal, no 500/blank, no leaked error.
            console.error('[r/$atomId] atom resolve failed:', err)
            finalHtml = wrap(safe)
          }
        }

        // (e) Serve with the EXACT §2-C browser-enforced headers.
        return new Response(finalHtml, {
          status: 200,
          headers: {
            ...htmlAtomResponseHeaders(),
            'Cache-Control': 'private, no-store',
            'Referrer-Policy': 'no-referrer',
          },
        })
      },
    },
  },
})
