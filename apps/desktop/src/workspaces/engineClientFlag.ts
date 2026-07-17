// Dormant R13b development/test gate for the Rust workspace-engine adapter.
// Nothing in the shipping desktop reads this flag yet; a follow-up R13b PR
// will wire it into main.ts. Production therefore stays on the existing path
// because DOHC_RUST_ENGINE_ADAPTER is never set there.

export function isRustEngineAdapterEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.DOHC_RUST_ENGINE_ADAPTER === "1";
}
