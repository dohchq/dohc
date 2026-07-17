// Dormant R13b desktop entry point for the Rust engine's Y.Doc adapter.
// The required engine-side yjs↔yrs replay-parity gate does not exist yet,
// so no live collab/editor path may import this module before R13 composition
// adds that gate and deliberately performs the cutover.

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
