// Dormant R13b desktop entry point for the Rust engine's Y.Doc adapter.
// The engine replay-parity gate now proves that real yjs update streams,
// including concurrent and causally scrambled delivery, converge through the
// daemon yrs path on the same normalized plaintext, maps, richdoc XML
// structure, attributes, and marks. This shard deliberately does not wire a
// live importer; R13 composition owns the cutover.

import {
  openEngineYdocProviderSession,
  type EngineYdocProviderSession,
  type EngineYdocProviderSessionOptions,
} from "@dohc/workspace-engine-client";

export type EngineYdocProviderSessionRust = EngineYdocProviderSession;
export type EngineYdocProviderSessionRustOptions =
  EngineYdocProviderSessionOptions;

export function openEngineYdocProviderSessionRust(
  options: EngineYdocProviderSessionRustOptions,
): Promise<EngineYdocProviderSessionRust> {
  return openEngineYdocProviderSession(options);
}
