// Temporary R13b migration gate for the Rust workspace-engine adapter.
// Production stays on the existing path unless explicitly opted in.

export function isRustEngineAdapterEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.DOHC_RUST_ENGINE_ADAPTER === "1";
}
