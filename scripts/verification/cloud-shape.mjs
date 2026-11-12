// Counts include partition zero in the reporting job. Use 2..256 JS workers
// and 1..256 Rust partitions. Update the guarded workflow lists and shape pins
// when tuning these counts. For one Rust partition, also skip rust-tests in
// that shape before matrix expansion; keep its needs edges and partition zero.
export const CLOUD_SHAPES = {
  standard: { js: 20, rust: 20 },
  boat: { js: 4, rust: 2 },
};

export function cloudShape(env = process.env) {
  return CLOUD_SHAPES[env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.DOHC_CLOUD_SHAPE === "boat" ? "boat" : "standard"];
}

// Keep the reader proof on partition one when available, including after tuning.
export const rustReaderShard = shape => Math.min(1, shape.rust - 1);
