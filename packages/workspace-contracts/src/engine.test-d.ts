// Compile-only contracts, enforced by the package typecheck.
import type { MomentAuthor, VersionedTextStore } from "./engine";

declare const store: VersionedTextStore;
const input = {
  workspaceId: "workspace",
  versionId: "main",
  path: "note.md",
  metadata: { origin: "api" },
} as const;

const agent = { kind: "agent", agentId: "agent" } as const satisfies MomentAuthor;
const automation = {
  kind: "automation",
  automationId: "automation",
  depth: 4,
} as const satisfies MomentAuthor;

for (const author of [agent, automation]) {
  // @ts-expect-error Historical attribution without a principal cannot author a local write.
  store.writeTextFile({ ...input, text: "text", author });
  // @ts-expect-error Binary writes also require the author principal.
  store.writeBinaryFile({ ...input, bytes: new Uint8Array(), author });
  // @ts-expect-error Deletes also require the author principal.
  store.deleteTextFile({ ...input, author });

  const localAuthor = { ...author, onBehalfOf: "local" };
  store.writeTextFile({ ...input, text: "text", author: localAuthor });
  store.writeBinaryFile({ ...input, bytes: new Uint8Array(), author: localAuthor });
  store.deleteTextFile({ ...input, author: localAuthor });
}

for (const author of [
  { kind: "public", principalId: "principal", grantId: "grant" },
  { kind: "named", userId: "user", grantId: "grant", grantGeneration: 1 },
] as const satisfies readonly MomentAuthor[]) {
  // @ts-expect-error Relay attribution cannot author a local write.
  store.writeTextFile({ ...input, text: "text", author });
}
