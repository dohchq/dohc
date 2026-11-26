import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import {
  MemberAppInspectResult,
  MemberAppSlug,
  MemberAppsListResult,
} from "@dohc/workspace-contracts/member-apps";
import { createOwnerRelayShareOperation } from "./ownerRelayShareHandler";
import { membersPlace, MEMBERS_UNREACHABLE } from "./workspaceMembersActions";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";

type AppsWorkspace = { workspaceId: string; rootPath: string; shareView?: unknown };
type AppsOperation<Workspace> = {
  workspace: Workspace;
  signal: AbortSignal;
  assertCurrent(): void;
};
type Remote<Credentials> = Promise<{ credentials: Credentials; credentialGeneration: number }>;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const PERSONAL_ONLY = "Open a workspace you joined to share or copy Member apps.";

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

/** Writes a Member app's source into a new folder, refusing a folder that exists or a file that doesn't match its digest. */
export async function writeForkedApp(
  folder: string,
  appRoot: string,
  files: ReadonlyArray<{ path: string; bytes: Uint8Array; sha256: string }>,
): Promise<void> {
  if (!MemberAppSlug.safeParse(appRoot).success)
    throw new Error(
      `Name the copy with lowercase letters, digits, or hyphens. ${appRoot} is not a folder name you can use.`,
    );
  const roots = new Set(files.map((file) => file.path.split("/", 1)[0]));
  if (roots.size !== 1)
    throw new Error("This app's source spans more than one folder, so dohc cannot copy it.");
  const placed = files.map((file) => {
    const rest = file.path.slice(file.path.indexOf("/") + 1);
    if (!file.path.includes("/") || !isShareablePath(`${appRoot}/${rest}`))
      throw new Error(`${file.path} is not a file dohc can copy.`);
    if (sha256(file.bytes) !== file.sha256)
      throw new Error(`${file.path} doesn't match the app the author shared. Try again.`);
    return { target: join(folder, appRoot, ...rest.split("/")), bytes: file.bytes };
  });
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
    relayOperation(operation, async (operation, credentials, session) => {
      const place = membersPlace(operation.workspace);
      if (place === null || place === "joined-unknown")
        throw new Error("Workspace apps are unavailable in this workspace.");
      const base = `/sync/${encodeURIComponent(place.workspaceId)}`;
      const request = async (
        path: string,
        init?: { method: "POST"; body: unknown; type?: string },
      ) => {
        let response: Response;
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
        if (response.ok && !response.headers.get("content-type")?.includes("json")) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          session.assertCurrent();
          return { status: response.status, body: null, bytes: async () => bytes };
        }
        const body: unknown = await response.json().catch(() => null);
        session.assertCurrent();
        if (!response.ok) {
          const said = (body as { error?: unknown; message?: unknown } | null) ?? {};
          const message = typeof said.error === "string" ? said.error : said.message;
          if (response.status === 404 && !path.endsWith("/settings"))
            throw new Error(`dohc could not ${phrase}. This app is no longer shared with you.`);
          if (response.status < 500 && typeof message === "string" && message)
            throw new Error(`dohc could not ${phrase}. ${message}`);
          if (response.status !== 404)
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
    });

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

  return {
    list: (operation: Operation, input: { cursor?: string }) =>
      run(operation, "load workspace apps", async (request) => {
        const page = await request(
          `/member-apps${input.cursor ? `?cursor=${encodeURIComponent(input.cursor)}` : ""}`,
        );
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
        const { review, revision } = await summary(request, input.publicationId, "copy this app");
        const files = [];
        for (const file of review.source) {
          const blob = await request(
            `/app-publications/${input.publicationId}/backend/blobs/${file.sha256}?authorityRevision=${revision}`,
          );
          files.push({ ...file, bytes: await blob.bytes() });
        }
        operation.assertCurrent();
        await writeForkedApp(folder, input.personalApp, files);
        return { personalApp: input.personalApp };
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
