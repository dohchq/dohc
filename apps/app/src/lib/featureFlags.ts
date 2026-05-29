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

// No generic feature flags are active right now. Keep this type as the
// single place a future flag name would be added.
export type FeatureFlag = never

export function featureEnabled(name: FeatureFlag): boolean {
  const flagName = name as string
  try {
    if (
      typeof localStorage !== 'undefined' &&
      localStorage.getItem(`dohc:${flagName}`) === '1'
    ) {
      return true
    }
  } catch {
    /* localStorage unavailable (SSR / privacy mode) — fall through */
  }
  const env = (import.meta as unknown as { env?: Record<string, string> }).env
  const key = `VITE_DOHC_${flagName.toUpperCase().replace(/-/g, '_')}`
  return env?.[key] === '1'
}

// Inline atoms are no longer a feature flag. `{key: value}` captures and
// `{= ...}` formulas are the live-data surface of dohc, so disabling them
// makes ordinary documents lie about what data is live. Keep the function
// as a compatibility shim for older imports/tests; it must always return
// true.
export const inlineAtomsEnabled = (): boolean => true
