import { z } from "zod";
import {
  APP_PUBLICATION_MAX_BLOB_BYTES,
  APP_PUBLICATION_MAX_REQUEST_BYTES,
  type AppPublicationCandidate,
} from "@dohc/security-contract/app-publication";
import { isSharedWithMePath } from "@dohc/workspace-core";
import type { CloudCredentials } from "./cloudCredentialStore";
import type { SitePackageInfo } from "./sitePackage";

export type SendableSite = Pick<
  SitePackageInfo,
  "root" | "kind" | "entryPath" | "packagePath" | "configPath" | "sourceFiles"
>;

export function sendableApp(site: SendableSite): boolean {
  if (
    site.root === "." ||
    site.root === "" ||
    isSharedWithMePath(site.root) ||
    site.root.split("/").some((part) => part.startsWith("."))
  )
    return false;
  if (site.sourceFiles.includes(`${site.root}/app.publish.json`)) return true;
  return (
    site.kind === "static" &&
    site.packagePath === null &&
    site.configPath === null &&
    site.entryPath === `${site.root}/index.html`
  );
}

const OwnerPage = z.object({
  publications: z.array(
    z.object({
      publicationId: z.string(),
      authorityRevision: z.number().int(),
      active: z.boolean(),
      appRoot: z.string().optional(),
      sourceRevision: z.string().optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
type OwnerRow = z.infer<typeof OwnerPage>["publications"][number];
const Published = z.object({
  publicationId: z.string(),
  authorityRevision: z.number().int(),
  active: z.literal(true),
});

type Failure = { revision: string | null; reason: string };

export const PHONE_APP_REFUSED =
  "Apps that create Collection files or call outside services open on your phone only through a link.";

export interface PhoneAppSenderDependencies<Workspace extends { workspaceId: string }> {
  enabled(): Promise<boolean>;
  atHead(workspaceId: string): boolean;
  withWorkspace(
    workspaceId: string,
    work: (workspace: Workspace, signal: AbortSignal) => Promise<void>,
  ): Promise<void>;
  credentials(workspace: Workspace): Promise<CloudCredentials>;
  apps(workspace: Workspace): Promise<readonly SendableSite[]>;
  sourceRevision(workspace: Workspace, appRoot: string, signal: AbortSignal): Promise<string>;
  prepare(
    workspace: Workspace,
    appRoot: string,
    signal: AbortSignal,
  ): Promise<{
    candidate: AppPublicationCandidate;
    files: readonly { sha256: string; bytes: Uint8Array }[];
  }>;
  relayJson(credentials: CloudCredentials, path: string, init?: RequestInit): Promise<unknown>;
  upload(
    credentials: CloudCredentials,
    workspaceId: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void>;
  changed(workspaceId: string): void;
  delayMs?: number;
}

export function createPhoneAppSender<Workspace extends { workspaceId: string }>(
  deps: PhoneAppSenderDependencies<Workspace>,
) {
  const failures = new Map<string, Map<string, Failure>>();
  const roots = new Map<string, Set<string>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const waiting = new Set<string>();
  const pulled = new Set<string>();
  const queued = new Set<string>();
  let running = Promise.resolve();

  const settle = (workspaceId: string, appRoot: string, failure: Failure | null) => {
    const rows = failures.get(workspaceId) ?? new Map<string, Failure>();
    const before = rows.get(appRoot)?.reason;
    if (failure) rows.set(appRoot, failure);
    else rows.delete(appRoot);
    failures.set(workspaceId, rows);
    if (before !== failure?.reason) deps.changed(workspaceId);
  };
  const clearAll = (workspaceId: string) => {
    if (failures.get(workspaceId)?.size) deps.changed(workspaceId);
    failures.delete(workspaceId);
  };

  const run = (workspaceId: string): Promise<void> => {
    if (queued.has(workspaceId)) return running;
    queued.add(workspaceId);
    running = running
      .then(async () => {
        queued.delete(workspaceId);
        if (!(await deps.enabled())) return clearAll(workspaceId);
        if (!deps.atHead(workspaceId)) return void waiting.add(workspaceId);
        waiting.delete(workspaceId);
        await deps.withWorkspace(workspaceId, (workspace, signal) => pass(workspace, signal));
      })
      .catch((error: unknown) => console.warn("[desktop] send apps to phones:", error));
    return running;
  };
  const later = (workspaceId: string) => {
    clearTimeout(timers.get(workspaceId));
    const timer = setTimeout(() => {
      timers.delete(workspaceId);
      void run(workspaceId);
    }, deps.delayMs ?? 10_000);
    timer.unref();
    timers.set(workspaceId, timer);
  };

  async function pass(workspace: Workspace, signal: AbortSignal) {
    const { workspaceId } = workspace;
    const credentials = await deps.credentials(workspace);
    const base = `/sync/${encodeURIComponent(workspaceId)}/app-publications`;
    const current = async () => {
      const rows = new Map<string, OwnerRow>();
      let cursor: string | null = null;
      do {
        const page = OwnerPage.parse(
          await deps.relayJson(
            credentials,
            `${base}?audience=owner${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            { signal },
          ),
        );
        for (const row of page.publications)
          if (row.active && row.appRoot !== undefined) rows.set(row.appRoot, row);
        cursor = page.nextCursor;
      } while (cursor);
      return rows;
    };
    const published = await current();
    const apps = (await deps.apps(workspace)).filter(sendableApp).map((app) => app.root);
    roots.set(workspaceId, new Set([...apps, ...published.keys()]));
    for (const appRoot of failures.get(workspaceId)?.keys() ?? [])
      if (!apps.includes(appRoot)) settle(workspaceId, appRoot, null);
    for (const [appRoot, row] of published) {
      if (apps.includes(appRoot)) continue;
      await deps
        .relayJson(credentials, `${base}/${row.publicationId}/withdraw`, {
          method: "POST",
          signal,
          body: JSON.stringify({ expectedAuthorityRevision: row.authorityRevision }),
        })
        .catch((error: unknown) => console.warn("[desktop] withdraw phone app:", error));
    }
    const body = (candidate: AppPublicationCandidate, expected: string | null) =>
      JSON.stringify({ audience: "owner", candidate, expectedCurrentPublicationId: expected });
    const publish = async (candidate: AppPublicationCandidate, expected: string | null) =>
      Published.parse(
        await deps.relayJson(credentials, base, {
          method: "POST",
          signal,
          body: body(candidate, expected),
        }),
      );
    const send = async (appRoot: string, revision: string) => {
      const { candidate, files } = await deps.prepare(workspace, appRoot, signal);
      if (
        candidate.external ||
        candidate.capabilities.some((value) => value.kind === "collection-create")
      )
        throw new Error(PHONE_APP_REFUSED);
      const expected = published.get(appRoot)?.publicationId ?? null;
      if (
        Buffer.byteLength(body(candidate, expected)) > APP_PUBLICATION_MAX_REQUEST_BYTES ||
        files.some((file) => file.bytes.byteLength > APP_PUBLICATION_MAX_BLOB_BYTES)
      )
        throw new Error("This app is too large to send to your phones.");
      for (const file of files)
        await deps.upload(credentials, workspaceId, file.sha256, file.bytes, signal);
      let row: z.infer<typeof Published>;
      try {
        row = await publish(candidate, expected);
      } catch (error) {
        signal.throwIfAborted();
        const now = (await current()).get(appRoot);
        if ((now?.publicationId ?? null) === expected) throw error;
        if (now?.sourceRevision === revision) return;
        row = await publish(candidate, now?.publicationId ?? null);
      }
      if (candidate.capabilities.length)
        await deps.relayJson(credentials, `${base}/${row.publicationId}/backend/activate`, {
          method: "POST",
          signal,
          body: JSON.stringify({ authorityRevision: row.authorityRevision }),
        });
    };
    for (const appRoot of apps) {
      if (!(await deps.enabled())) return clearAll(workspaceId);
      signal.throwIfAborted();
      let revision: string | null = null;
      try {
        revision = await deps.sourceRevision(workspace, appRoot, signal);
        if (published.get(appRoot)?.sourceRevision !== revision) {
          if (failures.get(workspaceId)?.get(appRoot)?.revision === revision) continue;
          await send(appRoot, revision);
        }
        settle(workspaceId, appRoot, null);
      } catch (error) {
        signal.throwIfAborted();
        settle(workspaceId, appRoot, {
          revision,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    filesChanged(workspaceId: string, paths: readonly string[]) {
      const known = [...(roots.get(workspaceId) ?? [])];
      if (
        paths.some(
          (path) =>
            /(?:^|\/)(?:index\.html|app\.publish\.json)$/.test(path) ||
            known.some(
              (root) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`),
            ),
        )
      )
        later(workspaceId);
    },
    pulled(workspaceId: string, applied: boolean) {
      if (!applied && !waiting.has(workspaceId) && pulled.has(workspaceId)) return;
      pulled.add(workspaceId);
      later(workspaceId);
    },
    settingChanged(enabled: boolean) {
      if (enabled) for (const workspaceId of pulled) later(workspaceId);
      else for (const workspaceId of [...failures.keys()]) clearAll(workspaceId);
    },
    retry(workspaceId: string, appRoot: string) {
      if (failures.get(workspaceId)?.delete(appRoot)) deps.changed(workspaceId);
      return run(workspaceId);
    },
    notSent(workspaceId: string) {
      return [...(failures.get(workspaceId) ?? [])].map(([appRoot, { reason }]) => ({
        appRoot,
        reason,
      }));
    },
    run,
  };
}
