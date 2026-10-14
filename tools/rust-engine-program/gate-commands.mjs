// Cargo arguments shared by the Rust gate and the PR verifier's checks before
// it queues. Identical arguments let the gate's clippy and test steps reuse
// those builds.
export const fmtCheck = ["fmt", "--all", "--check"];
export const clippy = ["clippy", "--locked", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings"];
export const nextest = ["nextest", "run", "--locked", "--workspace"];
