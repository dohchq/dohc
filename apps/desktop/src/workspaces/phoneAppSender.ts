import { z } from "zod";
import {
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
      ownerState: z.enum(["pending", "current"]).optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
type OwnerRow = z.infer<typeof OwnerPage>["publications"][number];
type Versions = { current?: OwnerRow; pending?: OwnerRow };
type Version = { publicationId: string; authorityRevision: number };
type Failure = { revision: string | null; reason: string };
const newest = (versions: Versions | undefined) => versions?.pending ?? versions?.current;
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const PHONE_APP_REFUSED =
  "Apps that create Collection files or call outside services open on your phone only through a link.";

export interface PhoneAppSenderDependencies<Workspace extends { workspaceId: string }> {
  withWorkspace(
    workspaceId: string,
    work: (
      workspace: Workspace,
      signal: AbortSignal,
      credentials: CloudCredentials,
    ) => Promise<void>,
  ): Promise<void>;
  admitted(workspace: Workspace): Promise<boolean>;
  sync(workspace: Workspace, signal: AbortSignal): Promise<boolean>;
  apps(workspace: Workspace): Promise<readonly SendableSite[]>;
  exists(workspace: Workspace, appRoot: string): Promise<boolean>;
  readSource(
    workspace: Workspace,
    appRoot: string,
    signal: AbortSignal,
    select: (paths: readonly string[]) => void,
  ): Promise<string>;
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
  const watched = new Map<string, { roots: string[]; inputs: Set<string> }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const passes = new Map<string, AbortController>();
  const waiting = new Set<string>();
  const pulled = new Set<string>();
  const queued = new Set<string>();
  let sending: boolean | null = null;
  let running = Promise.resolve();

  const settle = (workspaceId: string, appRoot: string, failure: Failure | null) => {
    const rows = failures.get(workspaceId) ?? new Map<string, Failure>();
    const before = rows.get(appRoot)?.reason;
    if (failure) rows.set(appRoot, failure);
    else rows.delete(appRoot);
    failures.set(workspaceId, rows);
    if (before !== failure?.reason) deps.changed(workspaceId);
  };
  const run = (workspaceId: string): Promise<void> => {
    if (queued.has(workspaceId)) return running;
    queued.add(workspaceId);
    running = running.then(async () => {
      queued.delete(workspaceId);
      const controller = new AbortController();
      passes.set(workspaceId, controller);
      try {
        await deps.withWorkspace(workspaceId, (workspace, signal, credentials) =>
          pass(workspace, AbortSignal.any([signal, controller.signal]), controller, credentials),
        );
        settle(workspaceId, "", null);
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError"))
          settle(workspaceId, "", { revision: null, reason: reasonOf(error) });
      } finally {
        passes.delete(workspaceId);
      }
    });
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

  async function pass(
    workspace: Workspace,
    signal: AbortSignal,
    controller: AbortController,
    credentials: CloudCredentials,
  ) {
    const { workspaceId } = workspace;
    const base = `/sync/${encodeURIComponent(workspaceId)}/app-publications`;
    const admit = async () => {
      signal.throwIfAborted();
      if (!(await deps.admitted(workspace))) controller.abort();
      signal.throwIfAborted();
    };
    const post = async (path: string, value: unknown) => {
      await admit();
      const body = JSON.stringify(value);
      return (await deps.relayJson(credentials, path, { method: "POST", signal, body })) as Version;
    };
    const activate = (row: Version) =>
      post(`${base}/${row.publicationId}/backend/activate`, {
        authorityRevision: row.authorityRevision,
      });
    const current = async () => {
      const rows = new Map<string, Versions>();
      let cursor: string | null = null;
      do {
        const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
        const page = OwnerPage.parse(
          await deps.relayJson(credentials, `${base}?audience=owner${query}`, { signal }),
        );
        for (const row of page.publications) {
          if (!row.active || row.appRoot === undefined) continue;
          const versions = rows.get(row.appRoot) ?? {};
          versions[row.ownerState === "pending" ? "pending" : "current"] = row;
          rows.set(row.appRoot, versions);
        }
        cursor = page.nextCursor;
      } while (cursor);
      return rows;
    };
    await admit();
    const published = await current();
    if (!(await deps.sync(workspace, signal))) return void waiting.add(workspaceId);
    waiting.delete(workspaceId);
    const apps = (await deps.apps(workspace)).filter(sendableApp).map((app) => app.root);
    await admit();
    const inputs = new Set<string>();
    watched.set(workspaceId, { roots: [...apps, ...published.keys()], inputs });
    for (const appRoot of failures.get(workspaceId)?.keys() ?? [])
      if (appRoot && !apps.includes(appRoot)) settle(workspaceId, appRoot, null);
    const send = async (appRoot: string, revision: string) => {
      const { candidate, files } = await deps.prepare(workspace, appRoot, signal);
      if (candidate.sourceRevision !== revision) return later(workspaceId);
      if (candidate.external || candidate.capabilities.some((c) => c.kind === "collection-create"))
        throw new Error(PHONE_APP_REFUSED);
      const expected = newest(published.get(appRoot))?.publicationId ?? null;
      const request = { audience: "owner", candidate, expectedCurrentPublicationId: expected };
      if (Buffer.byteLength(JSON.stringify(request)) > APP_PUBLICATION_MAX_REQUEST_BYTES)
        throw new Error("This app is too large to send to your phones.");
      await admit();
      for (const file of files)
        await deps.upload(credentials, workspaceId, file.sha256, file.bytes, signal);
      const row = await post(base, request).catch(async (error: unknown) => {
        signal.throwIfAborted();
        if ((newest((await current()).get(appRoot))?.publicationId ?? null) === expected)
          throw error;
        later(workspaceId);
        return null;
      });
      if (row && candidate.capabilities.length) await activate(row);
    };
    for (const appRoot of apps) {
      await admit();
      let revision: string | null = null;
      try {
        revision = await deps.readSource(workspace, appRoot, signal, (paths) => {
          for (const path of paths) inputs.add(path);
        });
        const head = newest(published.get(appRoot));
        if (head?.sourceRevision !== revision || head.ownerState === "pending") {
          if (failures.get(workspaceId)?.get(appRoot)?.revision === revision) continue;
          if (head?.sourceRevision === revision) await activate(head);
          else await send(appRoot, revision);
        }
        settle(workspaceId, appRoot, null);
      } catch (error) {
        signal.throwIfAborted();
        settle(workspaceId, appRoot, { revision, reason: reasonOf(error) });
      }
    }
    for (const [appRoot, versions] of published) {
      const row = versions.current ?? versions.pending;
      if (!row || apps.includes(appRoot) || (await deps.exists(workspace, appRoot))) continue;
      await post(`${base}/${row.publicationId}/withdraw`, {
        expectedAuthorityRevision: row.authorityRevision,
      });
    }
  }

  return {
    filesChanged(workspaceId: string, paths: readonly string[]) {
      const { roots = [], inputs = new Set<string>() } = watched.get(workspaceId) ?? {};
      const touches = (path: string) =>
        /(?:^|\/)(?:index\.html|app\.publish\.json)$/.test(path) ||
        inputs.has(path) ||
        roots.some(
          (root) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`),
        );
      if (paths.some(touches)) later(workspaceId);
    },
    pulled(workspaceId: string, applied: boolean) {
      const failed = failures.get(workspaceId)?.has("");
      if (!applied && !failed && !waiting.has(workspaceId) && pulled.has(workspaceId)) return;
      pulled.add(workspaceId);
      later(workspaceId);
    },
    versionSwitched(workspaceId: string) {
      passes.get(workspaceId)?.abort();
      later(workspaceId);
    },
    settingChanged(enabled: boolean) {
      if (enabled === sending) return;
      sending = enabled;
      if (enabled) for (const workspaceId of pulled) later(workspaceId);
      else {
        for (const controller of passes.values()) controller.abort();
        for (const workspaceId of failures.keys()) deps.changed(workspaceId);
        failures.clear();
      }
    },
    retry(workspaceId: string, appRoot: string | null) {
      if (!failures.get(workspaceId)?.delete(appRoot ?? "")) return Promise.resolve();
      deps.changed(workspaceId);
      return run(workspaceId);
    },
    notSent(workspaceId: string) {
      return [...(failures.get(workspaceId) ?? [])].map(([appRoot, { reason }]) => ({
        appRoot: appRoot || null,
        reason,
      }));
    },
    run,
  };
}
