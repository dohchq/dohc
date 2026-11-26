import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import {
  MEMBER_APP_SOURCE_MAX_BYTES,
  MemberAppInspectResult,
  MemberAppSlug,
  MemberAppsListResult,
} from "@dohc/workspace-contracts/member-apps";
import { createOwnerRelayShareOperation } from "./ownerRelayShareHandler";
import { membersPlace, MEMBERS_UNREACHABLE } from "./workspaceMembersActions";
import { parseAppPublicationDeclaration } from "../workspaces/ownerAppPublication";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { createFile, createFolder } from "../workspaces/workspaceFiles";

type AppsWorkspace = { workspaceId: string; rootPath: string; shareView?: unknown };
type AppsOperation<Workspace> = {
  workspace: Workspace;
  signal: AbortSignal;
  assertCurrent(): void;
};
type Remote<Credentials> = Promise<{ credentials: Credentials; credentialGeneration: number }>;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const PERSONAL_ONLY = "Open a workspace you joined to share or copy Member apps.";
const RATE_LIMITED_TRIES = 8;
const LISTINGS = new Set(["/member-apps", "/member-apps/settings"]);
const MANIFEST = "app.publish.json";

/** The body the relay reads for a Member app: header length, header, then each distinct file once, by digest. */
export function memberAppUpload(
  slug: string,
  candidate: AppPublicationCandidate,
  blobs: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const header = new TextEncoder().encode(JSON.stringify({ slug, candidate }));
  const digests = [
    ...new Set([...candidate.files, ...candidate.inputs].map((file) => file.sha256)),
  ].sort();
  const parts = digests.map((digest) => {
    const blob = blobs.get(digest);
    if (!blob || sha256(blob) !== digest)
      throw new Error("A file in this app changed while dohc read it. Try again.");
    return blob;
  });
  const body = new Uint8Array(4 + header.byteLength + parts.reduce((n, p) => n + p.byteLength, 0));
  new DataView(body.buffer).setUint32(0, header.byteLength);
  body.set(header, 4);
  let offset = 4 + header.byteLength;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return body;
}

type SourceFile = { path: string; bytes: Uint8Array; sha256: string };

/** A Member app's files moved under `appRoot` from the folder that holds its manifest, each checked against its digest. */
function placeAppSource(appRoot: string, files: ReadonlyArray<SourceFile>) {
  const root =
    files
      .filter((file) => `/${file.path}`.endsWith(`/${MANIFEST}`))
      .map((file) => file.path.slice(0, -MANIFEST.length))
      .sort((a, b) => a.length - b.length)[0] ?? `${files[0]?.path.split("/", 1)[0]}/`;
  if (!files.length || files.some((file) => !file.path.startsWith(root)))
    throw new Error("This app's source spans more than one folder, so dohc cannot copy it.");
  return files.map((file) => {
    const rest = file.path.slice(root.length);
    if (!rest || !isShareablePath(`${appRoot}/${rest}`))
      throw new Error(`${file.path} is not a file dohc can copy.`);
    if (sha256(file.bytes) !== file.sha256)
      throw new Error(`${file.path} doesn't match the app the author shared. Try again.`);
    return { path: `${appRoot}/${rest}`, rest, bytes: file.bytes };
  });
}

/**
 * Places a Member app's verified source at a new workspace folder, and refuses before anything is written when the
 * folder can't hold it or its app.publish.json can't be published there.
 */
export function promotedAppFiles(folder: string, files: ReadonlyArray<SourceFile>) {
  if (!isShareablePath(folder))
    throw new Error(`${folder} is not a folder dohc can promote an app into. Choose another.`);
  const placed = placeAppSource(folder, files);
  const manifest = placed.find((file) => file.rest === MANIFEST);
  if (manifest) {
    const declared = parseAppPublicationDeclaration(manifest.bytes, folder, {
      folder: placed.map((file) => file.path),
    });
    if (declared.external?.length)
      throw new Error(
        "This app calls outside services, which official apps can't do yet. Ask its author for a version without them.",
      );
    const outside = declared.inputs.find((path) => !path.startsWith(`${folder}/`));
    if (outside) throw new Error(`This app reads ${outside}, outside its own folder.`);
  }
  return placed.map(({ path, bytes }) => ({ path, bytes }));
}

/** Writes a promoted app into a new workspace folder. It refuses a folder that exists, and never removes what it wrote. */
export async function writePromotedApp(
  rootPath: string,
  folder: string,
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
): Promise<void> {
  const parent = posix.dirname(folder);
  if (parent !== ".") await createFolder(rootPath, parent);
  try {
    await createFolder(rootPath, folder, { exclusive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`The workspace already has ${folder}. Choose another folder.`);
    throw error;
  }
  for (const file of files) await createFile(rootPath, file.path, file.bytes, { exclusive: true });
}

/** Writes a Member app's source into a new folder, refusing a folder that exists or a file that doesn't match its digest. */
export async function writeForkedApp(
  folder: string,
  appRoot: string,
  files: ReadonlyArray<SourceFile>,
): Promise<void> {
  if (!MemberAppSlug.safeParse(appRoot).success)
    throw new Error(
      `Name the copy with lowercase letters, digits, or hyphens. ${appRoot} is not a folder name you can use.`,
    );
  const placed = placeAppSource(appRoot, files).map((file) => ({
    target: join(folder, appRoot, ...file.rest.split("/")),
    bytes: file.bytes,
  }));
  await mkdir(folder, { recursive: true });
  try {
    await mkdir(join(folder, appRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`Your Personal app folder already has ${appRoot}. Choose another name.`);
    throw error;
  }
  try {
    for (const { target, bytes } of placed) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx" });
    }
  } catch (error) {
    await rm(join(folder, appRoot), { recursive: true, force: true });
    throw error;
  }
}

/** The name a Personal app keeps in the workspace when the caller names none: its folder's own name, so two folders never share one. */
export function memberAppSlugOf(appRoot: string): string {
  const parsed = MemberAppSlug.safeParse(appRoot);
  if (!parsed.success)
    throw new Error(
      `Rename the folder ${appRoot} with lowercase letters, digits, or hyphens, or choose a name for the app.`,
    );
  return parsed.data;
}

/**
 * Workspace apps and Member apps, for the app and for agents through the CLI and MCP. Every
 * call asks the relay with the signed-in account, and the relay decides. Nothing here allows
 * a Member app: only a person allows one, in their browser.
 */
export function createMemberAppsActions<
  Workspace extends AppsWorkspace,
  Operation extends AppsOperation<Workspace>,
  Credentials,
>(dependencies: {
  remoteForWorkspace(workspace: Workspace, options?: { allowPaused: boolean }): Remote<Credentials>;
  remoteForJoinedWorkspace(workspace: Workspace): Remote<Credentials>;
  currentCredentialGeneration(): number;
  relayResponse(credentials: Credentials, path: string, init: RequestInit): Promise<Response>;
  serverAnswered(): void;
  /** The member's Personal app folder, or null outside a joined workspace. */
  personalFolder(workspace: Workspace): string | null;
  /** Captures a Personal app as Review does, with its built files' bytes. */
  preparePersonalApp(
    operation: Operation,
    appRoot: string,
  ): Promise<{
    candidate: AppPublicationCandidate;
    files: ReadonlyArray<{ sha256: string; bytes: Uint8Array }>;
  }>;
  /** Runs `work` under the version lock of a workspace this computer may write, with its active version's id. */
  withVersionLock(operation: Operation, work: (versionId: string) => Promise<void>): Promise<void>;
  /** Captures new files into the workspace's History. */
  capture(operation: Operation, paths: readonly string[]): Promise<void>;
}) {
  const relayOperation = createOwnerRelayShareOperation<Workspace, Operation, Credentials>({
    remoteForWorkspace: (workspace, options) =>
      shareViewIsPresent(workspace.shareView)
        ? dependencies.remoteForJoinedWorkspace(workspace)
        : dependencies.remoteForWorkspace(workspace, options),
    credentialGeneration: dependencies.currentCredentialGeneration,
  });

  const run = <Result>(
    operation: Operation,
    phrase: string,
    work: (
      request: (
        path: string,
        init?: { method: "POST"; body: unknown; type?: string },
      ) => Promise<{ status: number; body: unknown; bytes: () => Promise<Uint8Array> }>,
      base: string,
    ) => Promise<Result>,
  ) =>
    relayOperation(
      operation,
      async (operation, credentials, session) => {
        const place = membersPlace(operation.workspace);
        if (place === null || place === "joined-unknown")
          throw new Error("Workspace apps are unavailable in this workspace.");
        const base = `/sync/${encodeURIComponent(place.workspaceId)}`;
        const request = async (
          path: string,
          init?: { method: "POST"; body: unknown; type?: string },
        ) => {
          let response: Response;
          for (let tries = 1; ; tries += 1) {
            try {
              response = await dependencies.relayResponse(credentials, `${base}${path}`, {
                method: init?.method ?? "GET",
                headers: {
                  accept: "application/json",
                  ...(init ? { "content-type": init.type ?? "application/json" } : {}),
                },
                ...(init
                  ? {
                      body: init.type
                        ? (init.body as Uint8Array<ArrayBuffer>)
                        : JSON.stringify(init.body),
                    }
                  : {}),
                signal: AbortSignal.any([operation.signal, AbortSignal.timeout(120_000)]),
              });
            } catch {
              session.assertCurrent();
              throw new Error(MEMBERS_UNREACHABLE);
            }
            dependencies.serverAnswered();
            if (response.status !== 429 || init || tries === RATE_LIMITED_TRIES) break;
            await response.body?.cancel();
            const seconds = Number(response.headers.get("retry-after") ?? 2);
            await wait(Number.isFinite(seconds) ? seconds * 1000 : 2000, undefined, {
              signal: operation.signal,
            });
            session.assertCurrent();
          }
          if (response.ok && !response.headers.get("content-type")?.includes("json")) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            session.assertCurrent();
            return { status: response.status, body: null, bytes: async () => bytes };
          }
          const body: unknown = await response.json().catch(() => null);
          session.assertCurrent();
          if (
            !response.ok &&
            !(response.status === 404 && !init && LISTINGS.has(path.split("?")[0]!))
          ) {
            const said = (body as { error?: unknown; message?: unknown } | null) ?? {};
            const message = typeof said.error === "string" ? said.error : said.message;
            if (response.status === 404)
              throw new Error(`dohc could not ${phrase}. This app is no longer shared with you.`);
            if (response.status < 500 && typeof message === "string" && message)
              throw new Error(`dohc could not ${phrase}. ${message}`);
            throw new Error(
              `dohc could not ${phrase}. The server answered ${response.status}. Try again.`,
            );
          }
          return {
            status: response.status,
            body,
            bytes: async () => {
              throw new Error(`dohc could not ${phrase}. The server sent no file.`);
            },
          };
        };
        return work(request, base);
      },
      undefined,
      { allowPaused: true },
    );

  const unreadable = (phrase: string) =>
    new Error(`dohc could not ${phrase}. The server's answer was unreadable. Try again.`);

  const summary = async (
    request: Parameters<Parameters<typeof run>[2]>[0],
    publicationId: string,
    phrase: string,
  ) => {
    const { body } = await request(`/app-publications/${publicationId}/backend/summary`);
    const value = body as {
      subjectName?: unknown;
      sharerName?: unknown;
      review?: {
        authorityRevision?: unknown;
        consent?: unknown;
        collections?: unknown;
        source?: unknown;
      };
    } | null;
    const parsed = MemberAppInspectResult.safeParse({
      name: value?.subjectName,
      authorName: value?.sharerName ?? null,
      consent: value?.review?.consent,
      collections: value?.review?.collections,
      source: value?.review?.source,
    });
    const revision = value?.review?.authorityRevision;
    if (!parsed.success || typeof revision !== "number") {
      if (value && !value.review)
        throw new Error(`dohc could not ${phrase}. It is not a Member app.`);
      throw unreadable(phrase);
    }
    return { review: parsed.data, revision };
  };
  const blob = async (
    request: Parameters<Parameters<typeof run>[2]>[0],
    publicationId: string,
    file: { sha256: string },
    revision: number,
  ) =>
    (
      await request(
        `/app-publications/${publicationId}/backend/blobs/${file.sha256}?authorityRevision=${revision}`,
      )
    ).bytes();
  const download = async (
    request: Parameters<Parameters<typeof run>[2]>[0],
    publicationId: string,
    phrase: string,
  ) => {
    const { review, revision } = await summary(request, publicationId, phrase);
    const files = [];
    for (const file of review.source)
      files.push({ ...file, bytes: await blob(request, publicationId, file, revision) });
    return files;
  };

  return {
    list: (operation: Operation, input: { cursor?: string }) =>
      run(operation, "load workspace apps", async (request) => {
        const page = await request(
          `/member-apps${input.cursor ? `?cursor=${encodeURIComponent(input.cursor)}` : ""}`,
        );
        if (page.status === 404) return { apps: [], nextCursor: null };
        const settings = input.cursor ? null : await request("/member-apps/settings");
        const value = page.body as { apps?: unknown; nextCursor?: unknown } | null;
        const parsed = MemberAppsListResult.safeParse({
          apps: Array.isArray(value?.apps)
            ? value.apps.map((row: Record<string, unknown>) => ({
                kind: row.kind,
                publicationId: row.publicationId,
                name: row.name,
                authorName: row.authorName,
                createdAtMs: row.createdAtMs,
                reachable: row.reachable,
                consent: row.consent ?? null,
                canWithdraw: row.canWithdraw,
                url: row.url,
              }))
            : value?.apps,
          nextCursor: value?.nextCursor ?? null,
          ...(settings?.status === 200
            ? { membersCanShare: (settings.body as { membersCanShare?: unknown })?.membersCanShare }
            : {}),
        });
        if (!parsed.success) throw unreadable("load workspace apps");
        return parsed.data;
      }),

    inspect: (operation: Operation, input: { publicationId: string }) =>
      run(
        operation,
        "load this app",
        async (request) => (await summary(request, input.publicationId, "load this app")).review,
      ),

    share: async (operation: Operation, input: { personalApp: string; slug?: string }) => {
      const folder = dependencies.personalFolder(operation.workspace);
      if (folder === null) throw new Error(PERSONAL_ONLY);
      const slug = input.slug ?? memberAppSlugOf(input.personalApp);
      const prepared = await dependencies.preparePersonalApp(operation, input.personalApp);
      const blobs = new Map(prepared.files.map((file) => [file.sha256, file.bytes]));
      for (const file of prepared.candidate.inputs)
        if (!blobs.has(file.sha256))
          blobs.set(file.sha256, await readFile(join(folder, ...file.path.split("/"))));
      const body = memberAppUpload(slug, prepared.candidate, blobs);
      return run(operation, "share this app", async (request) => {
        const shared = await request("/member-apps", {
          method: "POST",
          body,
          type: "application/octet-stream",
        });
        const publicationId = (shared.body as { publicationId?: unknown } | null)?.publicationId;
        if (typeof publicationId !== "string") throw unreadable("share this app");
        return { publicationId, slug };
      });
    },

    fork: (operation: Operation, input: { publicationId: string; personalApp: string }) => {
      const folder = dependencies.personalFolder(operation.workspace);
      if (folder === null) throw new Error(PERSONAL_ONLY);
      return run(operation, "copy this app", async (request) => {
        const files = await download(request, input.publicationId, "copy this app");
        operation.assertCurrent();
        await writeForkedApp(folder, input.personalApp, files);
        return { personalApp: input.personalApp };
      });
    },

    source: (operation: Operation, input: { publicationId: string; path: string }) =>
      run(operation, "load this file", async (request) => {
        const { review, revision } = await summary(request, input.publicationId, "load this file");
        const file = review.source.find((entry) => entry.path === input.path);
        if (!file) throw new Error(`dohc could not load ${input.path}. This app has no such file.`);
        const result = { path: file.path, byteLength: file.byteLength, text: null };
        if (file.byteLength > MEMBER_APP_SOURCE_MAX_BYTES) return result;
        const bytes = await blob(request, input.publicationId, file, revision);
        if (sha256(bytes) !== file.sha256)
          throw new Error(`${file.path} doesn't match the app the author shared. Try again.`);
        try {
          return { ...result, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
        } catch {
          return result;
        }
      }),

    promote: async (operation: Operation, input: { publicationId: string; folder: string }) => {
      if (shareViewIsPresent(operation.workspace.shareView))
        throw new Error("Only the workspace's owner can promote a Member app.");
      return run(operation, "promote this app", async (request) => {
        const files = promotedAppFiles(
          input.folder,
          await download(request, input.publicationId, "promote this app"),
        );
        await dependencies.withVersionLock(operation, async (versionId) => {
          if (versionId !== "main") throw new Error("Switch to Main to promote an app.");
          operation.assertCurrent();
          await writePromotedApp(operation.workspace.rootPath, input.folder, files);
          await dependencies.capture(
            operation,
            files.map((file) => file.path),
          );
        });
        return { folder: input.folder };
      });
    },

    withdraw: (operation: Operation, input: { publicationId: string }) =>
      run(operation, "withdraw this app", async (request) => {
        await request(`/member-apps/${input.publicationId}/withdraw`, { method: "POST", body: {} });
        return { publicationId: input.publicationId };
      }),

    sharing: (operation: Operation, input: { membersCanShare: boolean }) =>
      run(operation, "change app sharing", async (request) => {
        const { body } = await request("/member-apps/settings", {
          method: "POST",
          body: { membersCanShare: input.membersCanShare },
        });
        const membersCanShare = (body as { membersCanShare?: unknown } | null)?.membersCanShare;
        if (typeof membersCanShare !== "boolean") throw unreadable("change app sharing");
        return { membersCanShare };
      }),
  };
}
