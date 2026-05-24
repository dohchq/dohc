// Feature-flag scaffold (Phase 0).
//
// The locked re-foundation principle says every new capability ships
// additive + behind a flag, never a big-bang. This is the one place
// flags are read so future phases don't reinvent the check.
//
// A flag is ON when either:
//   • localStorage 'dohc:<name>' === '1'   (per-browser, no rebuild)
//   • import.meta.env.VITE_DOHC_<NAME> === '1'  (build-time)
// Default OFF ⇒ zero user-facing change until explicitly enabled.

// M1 step 3.8.2.0 — `multiplayer` graduates the prosemirror-sync
// path from dead code to opt-in dev/test availability. Off by
// default; turn on per-browser via:
//   localStorage.setItem('dohc:multiplayer', '1')
// or globally via VITE_DOHC_MULTIPLAYER=1 at build time. Same
// scaffold as inline-atoms. Until codex-clean browser
// verification + a wider rollout, default OFF protects every
// existing single-user editor.
export type FeatureFlag = 'inline-atoms' | 'multiplayer'

export function featureEnabled(name: FeatureFlag): boolean {
  try {
    if (
      typeof localStorage !== 'undefined' &&
      localStorage.getItem(`dohc:${name}`) === '1'
    ) {
      return true
    }
  } catch {
    /* localStorage unavailable (SSR / privacy mode) — fall through */
  }
  const env = (import.meta as unknown as { env?: Record<string, string> }).env
  const key = `VITE_DOHC_${name.toUpperCase().replace(/-/g, '_')}`
  return env?.[key] === '1'
}

// Inline atoms GRADUATED to default-ON at Phase 1 (the wedge depends on
// the user SEEING values as atoms in the populated dashboard). It
// shipped flag-gated in Phase 0 (additive, no regression), was then
// de-risked: parser hardened via subagent+Codex review, 100%
// conformant on the real model across 3 runs, round-trip
// browser-verified. Per the re-foundation principle a flagged
// capability graduates once proven. An explicit kill-switch remains:
// localStorage `dohc:inline-atoms`='0' or VITE_DOHC_INLINE_ATOMS=0.
export const inlineAtomsEnabled = (): boolean => {
  try {
    if (
      typeof localStorage !== 'undefined' &&
      localStorage.getItem('dohc:inline-atoms') === '0'
    ) {
      return false
    }
  } catch {
    /* ignore */
  }
  const env = (import.meta as unknown as { env?: Record<string, string> }).env
  if (env?.VITE_DOHC_INLINE_ATOMS === '0') return false
  return true
}
