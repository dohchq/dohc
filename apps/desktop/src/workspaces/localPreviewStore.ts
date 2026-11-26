import { createHash } from "node:crypto";
import { parseAppPublicationCandidate } from "@dohc/security-contract/app-publication";
import type { ApprovalAgent } from "@dohc/security-contract/approval-provenance";
import { APP_PUBLICATION_LIMITS } from "./ownerAppPublication";
import type { LocalAppKind, LocalAppPrepared, LocalAppRow, LocalAppStore } from "./localAppStore";

export const MAIN_ONLY_SCHEMA_CHANGES =
  "Collection schema and rule changes can only be approved on Main. Merge this version into Main first.";
export const PREVIEW_READ_ONLY =
  "Previews of non-Main versions are read-only. Merge into Main to save changes to this Collection.";

type Held = LocalAppRow & { files: Map<string, Uint8Array> };
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

export function createLocalPreviewStore(assertCurrent: () => void): LocalAppStore {
  const rows = new Map<string, Held>();
  const roots = new Map<string, { revision: number; active: string | null }>();
  const rootOf = (value: Pick<LocalAppRow, "appRoot" | "candidate">) =>
    JSON.stringify([value.appRoot, value.candidate.versionId]);
  const held = (value: LocalAppRow) => {
    const root = roots.get(rootOf(value));
    return (
      value.active &&
      root?.active === value.publicationId &&
      root.revision === value.authorityRevision
    );
  };
  function row(publicationId: string, expected?: number): Held {
    assertCurrent();
    const value = rows.get(publicationId);
    if (!value || !held(value) || (expected !== undefined && expected !== value.authorityRevision))
      throw new Error("This app approval changed. Prepare the app again.");
    return value;
  }
  const advance = (key: string, active: string | null) => {
    const revision = (roots.get(key)?.revision ?? 0) + 1;
    roots.set(key, { revision, active });
    return revision;
  };
  function end(value: Held, revision: number) {
    value.active = false;
    value.authorityRevision = revision;
    value.files.clear();
  }
  function read(publicationId: string) {
    const value = row(publicationId);
    const files = value.candidate.files.map((metadata) => {
      const bytes = value.files.get(metadata.path);
      if (!bytes || hash(bytes) !== metadata.sha256)
        throw new Error("App bundle integrity check failed.");
      return { ...metadata, bytes: Uint8Array.from(bytes) };
    });
    return {
      publicationId,
      authorityRevision: value.authorityRevision,
      appRoot: value.appRoot,
      kind: value.kind,
      resourceId: value.resourceId,
      candidate: value.candidate,
      files,
    };
  }
  const deactivate = (match: (value: Held) => boolean) => {
    assertCurrent();
    for (const value of rows.values())
      if (match(value)) {
        if (held(value)) end(value, advance(rootOf(value), null));
        rows.delete(value.publicationId);
      }
  };
  return {
    row,
    held,
    has: (publicationId: string) => rows.has(publicationId),
    list(appRoot: string) {
      assertCurrent();
      return [...rows.values()].filter((value) => value.appRoot === appRoot);
    },
    heldRow(publicationId: string) {
      const value = rows.get(publicationId);
      return value && held(value) ? value : null;
    },
    activate(
      input: {
        kind: LocalAppKind;
        resourceId: string;
        publicationId: string;
        prepared: LocalAppPrepared;
        agent?: ApprovalAgent | null;
      },
      signal: AbortSignal,
      bind: (
        previous: LocalAppRow | undefined,
        displaced: LocalAppRow | undefined,
        commit: () => void,
      ) => void,
    ) {
      assertCurrent();
      signal.throwIfAborted();
      const candidate = parseAppPublicationCandidate(
        input.prepared.candidate,
        APP_PUBLICATION_LIMITS,
      );
      const files = new Map(
        input.prepared.files.map((file) => [file.path, Uint8Array.from(file.bytes)]),
      );
      if (
        files.size !== candidate.files.length ||
        candidate.files.some((metadata) => {
          const bytes = files.get(metadata.path);
          return (
            !bytes || bytes.byteLength !== metadata.byteLength || hash(bytes) !== metadata.sha256
          );
        })
      )
        throw new Error("App bundle files changed. Prepare the app again.");
      const key = rootOf({ appRoot: candidate.appRoot, candidate });
      const atRoot = [...rows.values()].filter((value) => rootOf(value) === key);
      const previous = atRoot.find((value) => value.kind === input.kind);
      const displaced = atRoot.find((value) => value.kind !== input.kind && held(value));
      if (previous?.publicationId === input.publicationId && held(previous))
        return {
          publicationId: input.publicationId,
          authorityRevision: previous.authorityRevision,
        };
      let authorityRevision = 0;
      bind(previous, displaced, () => {
        signal.throwIfAborted();
        assertCurrent();
        authorityRevision = advance(key, input.publicationId);
        if (displaced) end(rows.get(displaced.publicationId)!, authorityRevision);
        if (previous) rows.delete(previous.publicationId);
        rows.set(input.publicationId, {
          kind: input.kind,
          publicationId: input.publicationId,
          appRoot: candidate.appRoot,
          resourceId: input.resourceId,
          authorityRevision,
          candidate,
          storageBytes: 0,
          active: true,
          files,
        });
      });
      row(input.publicationId, authorityRevision);
      return { publicationId: input.publicationId, authorityRevision };
    },
    withdraw(
      publicationId: string,
      expected: number,
      bind: (row: LocalAppRow, commit: () => void) => void,
    ) {
      const value = rows.get(publicationId);
      if (value && !held(value) && value.authorityRevision === expected)
        return { kind: value.kind, publicationId, authorityRevision: expected };
      const checked = row(publicationId, expected);
      let authorityRevision = 0;
      bind(checked, () => {
        row(publicationId, expected);
        authorityRevision = advance(rootOf(checked), null);
        end(checked, authorityRevision);
      });
      return { kind: checked.kind, publicationId, authorityRevision };
    },
    browserPublication(publicationId: string) {
      const { authorityRevision, appRoot, files } = read(publicationId);
      return { publicationId, authorityRevision, appRoot, files };
    },
    verificationPublication: read,
    deleteResources(kind: LocalAppKind, resourceId: string) {
      deactivate((value) => value.kind === kind && value.resourceId === resourceId);
    },
    deletePublications(kind: LocalAppKind, publicationIds: readonly string[]) {
      deactivate((value) => value.kind === kind && publicationIds.includes(value.publicationId));
    },
  };
}
