import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useActiveWorkspaceId } from '../lib/active-workspace'
import { ATOM_BODY_MAX_BYTES } from '../lib/inlineAtom'
import { harvestFormulaSrcsFromDoc } from '../lib/htmlFormula'

// html-atoms-v1 §2 / §2-C / §3 / §5 — the rendered view of a
// `type: html` atom. Crepe is NEVER used for an html body (§5). The
// body is served by the auth-gated §2-B route (/r/<atomId>) which
// sanitizes + sets the real header CSP.
//
// Guarantee A: `sandbox=""` — the EMPTY allow-list (NO allow-* of
// any kind). Script-exec, origin/session, top-nav, popups, forms are
// killed by browser contract regardless of the sanitizer. (Verified
// by the P3 dual-review on all four React-19 paths: SSR-static /
// SSR-string / client-set / hydration all emit `sandbox=""`.) NEVER
// add an allow-* token here.
//
// §2-C belt — HONEST SCOPE (P3 dual-review): a boolean "did we just
// assign src" cannot prove the loaded document IS our pinned route
// (the child is an opaque sandbox origin — the parent cannot read
// its committed URL). So this parent re-pin is BEST-EFFORT for a
// POST-route-load self-nav only. The actual brace for the
// pre-first-load `<meta refresh>` / `<base>` / non-fragment `<a>`
// class is the P2a vetted sanitizer (FORBID_TAGS meta/base/form,
// FORBID http-equiv, non-`#`/non-data: URLs dropped — passed two
// dispositive review rounds, both SHIP) plus `sandbox=""` killing
// every JS self-nav unconditionally. This belt is defense-in-depth
// over that brace, not a substitute — exactly the §2-C model.
//
// §3 reactivity: harvest `{= }` srcs from the body — DOM text nodes
// ONLY (mirrors the §3 server rule; a Markdown parser is WRONG for
// HTML — P3 dual-review FAIL), byte-capped (no per-keystroke freeze)
// — and subscribe to evalFormulas as a CHANGE-SIGNAL; a change bumps
// the `?v=` nonce ⇒ the route re-renders fresh server-side.
// (Server-side `{= }` substitution is P4; P3 wires the trigger.)
//
// §7 acceptance: a reload preserves visual continuity — DOUBLE
// BUFFER. Two filled iframes; the new src loads in the HIDDEN buffer
// (chosen from a ref, never the stale render value — P3 FAIL) and is
// revealed only on its load; the visible buffer is never navigated.

type Buf = 0 | 1

// Byte-cap + client DOMParser guard, then the SHARED §3 walk
// (htmlFormula — the SAME impl + parser the server route uses; one
// notion of "where is a {= }", never two — P3 dual-review FAIL).
export function harvestFormulaSrcs(body: string): string[] {
  if (!body) return []
  // Bound BEFORE parsing (§4 / the codebase ReDoS-cap discipline):
  // over `ATOM_BODY_MAX_BYTES`, harvest nothing (the route still
  // renders; reactivity just won't arm — calm, never a frozen tab).
  if (
    (typeof TextEncoder !== 'undefined'
      ? new TextEncoder().encode(body).length
      : body.length) > ATOM_BODY_MAX_BYTES
  ) {
    return []
  }
  // Client-only: DOMParser is unavailable during SSR. Harvest runs
  // in an effect (below), so this never executes server-side; the
  // guard is belt.
  if (typeof DOMParser === 'undefined') return []
  try {
    return harvestFormulaSrcsFromDoc(
      new DOMParser().parseFromString(body, 'text/html'),
    )
  } catch {
    return []
  }
}

export function HtmlAtomFrame({
  atomId,
  body,
}: {
  atomId: string | null
  body: string
}) {
  // Harvest in an effect (client-only ⇒ SSR-safe; no SSR/hydration
  // memo divergence — srcs feed a subscription, not rendered markup).
  const [srcs, setSrcs] = useState<string[]>([])
  useEffect(() => {
    setSrcs(harvestFormulaSrcs(body))
  }, [body])

  // org-plan §5 non-defaultable: pass the active workspace so the
  // formulas resolve in the workspace the user is *viewing*.
  const activeWorkspaceId = useActiveWorkspaceId()
  const resolved = useQuery(
    api.formulaEval.evalFormulas,
    srcs.length ? { srcs, activeWorkspaceId } : 'skip',
  )
  const sig = useMemo(() => JSON.stringify(resolved ?? []), [resolved])

  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    setNonce((n) => n + 1)
  }, [sig, atomId])

  // The iframe also routes through the server-side /r/<atomId> route
  // which itself calls getRenderable + evalFormulas. Forward the active
  // workspace via `?w=` so the route can pass it through (default-
  // personal at the route layer for old shared links with no `?w=`).
  const wParam =
    activeWorkspaceId ? `&w=${encodeURIComponent(activeWorkspaceId)}` : ''
  const src = atomId
    ? `/r/${encodeURIComponent(atomId)}?v=${nonce}${wParam}`
    : null

  // ── double buffer + best-effort re-pin ───────────────────────────
  const refs = [
    useRef<HTMLIFrameElement | null>(null),
    useRef<HTMLIFrameElement | null>(null),
  ] as const
  const [active, setActive] = useState<Buf>(0)
  // activeRef MIRRORS active and is updated SYNCHRONOUSLY before
  // setActive so the drive effect never picks a stale back buffer
  // (P3 dual-review FAIL: a load that flipped `active` before the
  // effect ran could otherwise navigate the VISIBLE buffer).
  const activeRef = useRef<Buf>(0)
  const pinned = useRef<[string | null, string | null]>([null, null])
  const expecting = useRef<[boolean, boolean]>([false, false])
  // Per-buffer generation: bumped on every src WE assign + stamped on
  // the element (dataset). An onLoad whose stamp is stale (a newer
  // assignment superseded it) is discarded — the newer load arrives.
  // A self-nav does NOT bump gen, so it is NOT discarded → it falls
  // through to the re-pin classifier below.
  const gen = useRef<[number, number]>([0, 0])

  function drive(buf: Buf, to: string) {
    const el = refs[buf].current
    if (!el) return
    const g = (gen.current[buf] += 1)
    el.dataset.gen = String(g)
    pinned.current[buf] = to
    expecting.current[buf] = true
    el.src = to
  }

  useEffect(() => {
    if (!src) return
    const back: Buf = activeRef.current === 0 ? 1 : 0
    if (pinned.current[back] === src) return // already (re)loading it
    drive(back, src)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  function onLoad(buf: Buf) {
    const el = refs[buf].current
    if (!el) return
    if (Number(el.dataset.gen ?? '0') !== gen.current[buf]) {
      // Our own stale load (a newer assignment superseded it). The
      // newer src's load will arrive — ignore this one.
      return
    }
    if (expecting.current[buf]) {
      // Our pinned route document loaded — reveal this buffer.
      // (Best-effort: see the §2-C HONEST SCOPE note above.)
      expecting.current[buf] = false
      activeRef.current = buf
      setActive(buf)
      return
    }
    // A load we did not initiate, AFTER our route load = a POST-load
    // frame self-nav. Force it back to the pinned route src (the
    // belt; bounds a post-load self-nav to ≤1 script-free paint).
    const pin = pinned.current[buf]
    if (pin) drive(buf, pin)
  }

  if (!atomId) {
    // Fail-soft (§4): an html atom should always carry a Track-1
    // `id:`; if absent, render nothing dangerous + calm recourse.
    return (
      <div className="px-1 py-8 text-[13px] text-ink-dim">
        Couldn’t render this page — it has no address yet. Open{' '}
        <span className="text-ink-strong">⟨⟩ source</span> and add an{' '}
        <code className="text-[11px]">id:</code>.
      </div>
    )
  }

  return (
    <div className="relative w-full min-h-[70vh] rounded-md overflow-hidden border border-rule bg-page">
      {([0, 1] as const).map((buf) => (
        <iframe
          key={buf}
          ref={refs[buf]}
          title="Rendered HTML page"
          // SECURITY: empty allow-list. Do NOT add allow-* tokens.
          sandbox=""
          referrerPolicy="no-referrer"
          onLoad={() => onLoad(buf)}
          className="absolute inset-0 h-full w-full border-0 transition-opacity duration-150"
          style={{
            opacity: active === buf ? 1 : 0,
            pointerEvents: active === buf ? 'auto' : 'none',
          }}
        />
      ))}
    </div>
  )
}
