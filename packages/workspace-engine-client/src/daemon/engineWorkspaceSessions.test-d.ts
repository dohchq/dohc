// Compile-only contract, enforced by `pnpm typecheck`: session policy methods
// take one physical attachment, never a bare workspace. Vitest does not run
// this file; tsc fails when an `@ts-expect-error` line stops erroring.
import type {
  EngineWorkspace,
  EngineWorkspaceSessions,
} from "./engineWorkspaceSessions";

declare const sessions: EngineWorkspaceSessions;
declare const bare: EngineWorkspace;

// @ts-expect-error Capture policy belongs to one physical attachment.
sessions.rememberCaptureAuthor(bare, null);
// @ts-expect-error Rebuild policy belongs to one physical attachment.
sessions.beginRebuild(bare);
// @ts-expect-error Rebuild policy belongs to one physical attachment.
sessions.endRebuild(bare);
// @ts-expect-error Share policy requires an explicit share-mount descriptor.
sessions.rememberShareMount(bare);
sessions.rememberShareMount({ ...bare, shareMount: true });
