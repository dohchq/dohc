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

// 3.9.21 — `multiplayer` GRADUATED to default-on (like
// inline-atoms before it). The gate has been removed from
// AtomView; the bootstrap → collab → presence pipeline now
// engages for every markdown atom. If you ever need a
// per-browser kill switch in dev, add it back to this union
// and re-thread to AtomView; for now keeping the type
// minimal.
export type FeatureFlag = 'inline-atoms'

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

// Inline atoms are no longer a feature flag. `{key: value}` captures and
// `{= ...}` formulas are the live-data surface of dohc, so disabling them
// makes ordinary documents lie about what data is live. Keep the function
// as a compatibility shim for older imports/tests; it must always return
// true.
export const inlineAtomsEnabled = (): boolean => true
