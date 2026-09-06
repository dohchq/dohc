import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveEffectivePolicy } from "@dohc/security-contract/effective-policy";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import {
  VERSIONED_METHOD,
  VersionedLoopbackEngine,
  type EngineTransport,
  type JsonValue,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { scanWorkspaceFilesTolerant } from "@dohc/workspace-fs";
import { readDiskContent } from "../workspaces/workspaceEngineCapture";
import { readWorkspaceEnginePolicy } from "../workspaces/workspaceEnginePolicyFile";

type JsonObject = { [key: string]: JsonValue | undefined };

/**
 * The daemon's disk side, in front of a `VersionedLoopbackEngine`.
 *
 * The desktop capture chain no longer reads or writes the workspace folder on
 * capture: the Rust daemon watches the folder, ingests it on `capture.flush`,
 * and rewrites it after `versions.setActive`, a merge into the active
 * version, and a conflict resolution. The loopback models only the store, so
 * a chain-side test that exercises those operations sees no disk effect at
 * all. This fake adds the disk half the daemon owns, with the same rules the
 * daemon applies:
 *
 * - `capture.flush` and `capture.reconcile` scan the root and ingest every
 *   policy-tracked path into the active version (text, binary, and secret
 *   files by the same classification as `readDiskTextState`), retiring paths
 *   the store tracks that the disk no longer holds. A path under a live
 *   `ydoc.open` lease is left alone, as `ensure_capture_target_not_leased`
 *   does. Bytes the chain itself just wrote (a self-write) are ingested like
 *   any other; the store's content-equality no-op keeps them from becoming a
 *   second moment.
 * - `versions.setActive` ingests the outgoing version first (the fence), then
 *   rewrites the folder to the incoming version's text, binary, and secret
 *   heads and removes paths the incoming version lacks.
 * - `versionedText.merge` and `secrets.apply` into the active version, and
 *   a conflict resolution, rewrite the affected path.
 *
 * Every rewrite is the daemon's own write, so the next ingest of the path
 * sees content equal to the head and records nothing.
 */
export interface FakeDaemonCapture {
  // Answers the methods the daemon's disk side owns; null for every other.
  sendRequest(request: Request): Promise<Response | null>;
  // The paths currently held by a live Y.Doc session, keyed by session id.
  readonly leases: Map<string, string>;
}

// `.env` has no text media type, so the capture's text reader would class it
// as binary. The secret rule is the daemon's: a regular file whose bytes
// round-trip through UTF-8 is secret text.
async function readSecret(
  absolute: string,
): Promise<{ kind: "text"; text: string } | { kind: "absent" } | { kind: "other" }> {
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) return { kind: "other" };
    const bytes = await readFile(absolute);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) return { kind: "other" };
    return { kind: "text", text };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "other" };
  }
}

export function createFakeDaemonCapture(input: {
  rootPath: string;
  workspaceId: string;
  loopback: VersionedLoopbackEngine;
  // The Y.Doc transport, when the suite has one. `ydoc.open` takes a lease
  // on its path and `ydoc.close`/`ydoc.evict` release it, so capture skips
  // the path while a session is live, as the daemon's lease registry does.
  ydoc?: Pick<EngineTransport, "sendRequest">;
}): FakeDaemonCapture {
  const { rootPath, workspaceId, loopback, ydoc } = input;
  async function writeDisk(absolutePath: string, bytes: Uint8Array | string): Promise<void> {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
  }
  const leases = new Map<string, string>();
  let nextId = 5_000_000;
  let nextSecretMoment = 1;

  async function call(method: string, params: JsonObject): Promise<JsonValue> {
    const response = await loopback.sendRequest({
      id: nextId++,
      method,
      workspace: workspaceId,
      params: params as JsonValue,
    });
    return response.result;
  }

  async function activeVersionId(): Promise<string> {
    const active = (await call(VERSIONED_METHOD.versionsActive, {})) as {
      id: string;
    } | null;
    if (active) return active.id;
    await call(VERSIONED_METHOD.versionsEnsureMain, {});
    return "main";
  }

  async function listText(versionId: string): Promise<
    Array<{ path: string; contentKind: "text" | "binary"; sha256: string }>
  > {
    const files: Array<{ path: string; contentKind: "text" | "binary"; sha256: string }> = [];
    let afterPath: string | undefined;
    do {
      const page = (await call(VERSIONED_METHOD.textList, {
        versionId,
        limit: 500,
        ...(afterPath === undefined ? {} : { afterPath }),
      })) as {
        files: Array<{ path: string; contentKind: "text" | "binary"; sha256: string }>;
        nextAfterPath: string | null;
      };
      files.push(...page.files);
      afterPath = page.nextAfterPath ?? undefined;
    } while (afterPath !== undefined);
    return files;
  }

  async function listSecrets(versionId: string): Promise<string[]> {
    const page = (await call(VERSIONED_METHOD.secretsList, { versionId, limit: 500 })) as {
      secrets: Array<{ path: string }>;
    };
    return page.secrets.map((secret) => secret.path);
  }

  function leased(path: string): boolean {
    return [...leases.values()].includes(path);
  }

  async function ingestPath(versionId: string, path: string): Promise<void> {
    if (leased(path)) return;
    if (classifyEngineFilePath(path).kind === "secret") {
      const secret = await readSecret(join(rootPath, path));
      if (secret.kind === "text") {
        await call(VERSIONED_METHOD.secretsWrite, {
          workspaceId,
          versionId,
          path,
          text: secret.text,
          origin: "local-file",
          momentId: `fake-secret-${nextSecretMoment++}`,
          summary: `Updated ${path.split("/").at(-1)}`,
        });
        return;
      }
      if (secret.kind === "absent") {
        await call(VERSIONED_METHOD.secretsDelete, {
          workspaceId,
          versionId,
          path,
          origin: "local-file",
          momentId: `fake-secret-${nextSecretMoment++}`,
          summary: `Deleted ${path.split("/").at(-1)}`,
        });
      }
      return;
    }
    const disk = await readDiskContent(join(rootPath, path));
    if (disk.kind === "unreadable" || disk.kind === "untracked-content") return;
    const head = (await call(VERSIONED_METHOD.textRead, { versionId, path })) as {
      contentKind: "text" | "binary";
      sha256: string;
      blobSha256?: string;
    } | null;
    if (disk.kind === "absent") {
      if (head) {
        await call(VERSIONED_METHOD.textDelete, { versionId, path, origin: "local-file" });
      }
      return;
    }
    if (disk.kind === "text") {
      if (head?.contentKind === "text" && head.sha256 === disk.sha256) return;
      await call(VERSIONED_METHOD.textWrite, {
        versionId,
        path,
        text: disk.text,
        origin: "local-file",
      });
      return;
    }
    if (head?.contentKind === "binary" && head.sha256 === disk.sha256) return;
    await call(VERSIONED_METHOD.binaryWrite, {
      versionId,
      path,
      bytesBase64: Buffer.from(disk.bytes).toString("base64"),
      origin: "local-file",
      summary: `Updated ${path.split("/").at(-1)}`,
    });
  }

  // One pass over the folder into `versionId`: the daemon's reconcile.
  async function ingest(versionId: string): Promise<void> {
    const policy = await readWorkspaceEnginePolicy(rootPath);
    const scan = await scanWorkspaceFilesTolerant(rootPath);
    const onDisk = new Set<string>();
    for (const file of scan.files) {
      const classification = classifyEngineFilePath(file.path).kind;
      if (classification === "ignored") continue;
      if (
        classification === "tracked" &&
        !resolveEffectivePolicy({
          path: file.path,
          filesPolicy: policy.filesPolicy,
          visibilityPolicy: policy.visibilityPolicy,
        }).tracked
      ) {
        continue;
      }
      onDisk.add(file.path);
      await ingestPath(versionId, file.path);
    }
    for (const file of await listText(versionId)) {
      if (onDisk.has(file.path)) continue;
      await ingestPath(versionId, file.path);
    }
    for (const path of await listSecrets(versionId)) {
      if (onDisk.has(path)) continue;
      await ingestPath(versionId, path);
    }
  }

  async function writeHead(versionId: string, path: string): Promise<void> {
    const head = (await call(VERSIONED_METHOD.textRead, { versionId, path })) as {
      contentKind: "text" | "binary";
      text: string | null;
      sha256: string;
    } | null;
    if (!head) return;
    const disk = await readDiskContent(join(rootPath, path));
    if (disk.kind === "untracked-content" || disk.kind === "unreadable") return;
    if (head.contentKind === "binary") {
      const blob = (await call(VERSIONED_METHOD.binaryRead, { versionId, path })) as {
        bytesBase64: string | null;
      } | null;
      if (!blob?.bytesBase64) return;
      const bytes = Buffer.from(blob.bytesBase64, "base64");
      if (disk.kind === "binary" && disk.sha256 === head.sha256) return;
      await writeDisk(join(rootPath, path), bytes);
      return;
    }
    let text = head.text;
    if (text === null) {
      text = loopback.textBodyForDigest(workspaceId, head.sha256);
      if (text === null) return;
    }
    if (disk.kind === "text" && disk.sha256 === head.sha256) return;
    await writeDisk(join(rootPath, path), text);
  }

  async function writeSecret(versionId: string, path: string): Promise<void> {
    const materialized = (await call(VERSIONED_METHOD.secretsMaterialize, {
      versionId,
      path,
    })) as { text: string | null } | null;
    if (!materialized?.text) return;
    const disk = await readSecret(join(rootPath, path));
    if (disk.kind === "text" && disk.text === materialized.text) return;
    await writeDisk(join(rootPath, path), materialized.text);
  }

  async function removePath(path: string): Promise<void> {
    try {
      const info = await lstat(join(rootPath, path));
      if (!info.isFile()) return;
    } catch {
      return;
    }
    await rm(join(rootPath, path), { force: true });
  }

  // The switch's disk rewrite: the incoming version's heads land, paths only
  // the outgoing version had are removed.
  async function materializeSwitch(from: string, to: string): Promise<void> {
    const target = await listText(to);
    const targetPaths = new Set(target.map((file) => file.path));
    for (const file of target) {
      if (leased(file.path)) continue;
      await writeHead(to, file.path);
    }
    for (const file of await listText(from)) {
      if (targetPaths.has(file.path)) continue;
      await removePath(file.path);
    }
    const targetSecrets = await listSecrets(to);
    for (const path of targetSecrets) await writeSecret(to, path);
    for (const path of await listSecrets(from)) {
      if (targetSecrets.includes(path)) continue;
      await removePath(path);
    }
  }

  return {
    leases,
    async sendRequest(request) {
      const params = (request.params ?? {}) as JsonObject;
      switch (request.method) {
        case "capture.flush":
        case "capture.reconcile": {
          await ingest(await activeVersionId());
          return { id: request.id, result: { settled: true, running: true, degraded: false } };
        }
        case VERSIONED_METHOD.versionsSetActive: {
          const from = await activeVersionId();
          const to = String(params.versionId);
          if (from === to) return null;
          await ingest(from);
          const response = await loopback.sendRequest(request);
          await materializeSwitch(from, to);
          return response;
        }
        case VERSIONED_METHOD.versionsCreateNamed: {
          await ingest(await activeVersionId());
          return null;
        }
        case VERSIONED_METHOD.versionsMerge: {
          const response = await loopback.sendRequest(request);
          const result = response.result as { status: string; writeKind?: string };
          const target = String(params.targetVersionId);
          if (result.status === "merged" && target === (await activeVersionId())) {
            const path = String(params.path);
            if (result.writeKind === "delete") await removePath(path);
            else await writeHead(target, path);
          }
          return response;
        }
        case VERSIONED_METHOD.secretsApply: {
          const response = await loopback.sendRequest(request);
          const result = response.result as { changed: boolean };
          const target = String(params.targetVersionId);
          if (result.changed && target === (await activeVersionId())) {
            const path = String(params.path);
            const secrets = await listSecrets(target);
            if (secrets.includes(path)) await writeSecret(target, path);
            else await removePath(path);
          }
          return response;
        }
        case "ydoc.open": {
          if (!ydoc) return null;
          const response = await ydoc.sendRequest(request);
          const result = response.result as { sessionId: string; path: string };
          leases.set(result.sessionId, result.path);
          return response;
        }
        case "ydoc.close":
        case "ydoc.evict": {
          if (!ydoc) return null;
          const response = await ydoc.sendRequest(request);
          leases.delete(String(params.sessionId));
          return response;
        }
        default:
          return ydoc && request.method.startsWith("ydoc.")
            ? await ydoc.sendRequest(request)
            : null;
      }
    },
  };
}
