import { posix } from "node:path";
import { z } from "zod";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import {
  BUILD_OUTPUT_DIRS,
  isSharedWithMePath,
  SITE_DISCOVERY_FILE_NAMES,
} from "@dohc/workspace-core";
import type { createOwnerAppPublicationHandler } from "../ipc/ownerAppPublicationIpc";
import type { CloudCredentials } from "./cloudCredentialStore";
import { prepareOwnerAppPublication, readLocalAppSource } from "./ownerAppPublication";

const SIGNALS = new Set(SITE_DISCOVERY_FILE_NAMES);

export function sendableRoots(paths: readonly string[]): string[] {
  const folders = new Map<string, Set<string>>();
  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    if (slash < 0 || !SIGNALS.has(path.slice(slash + 1))) continue;
    const root = path.slice(0, slash);
    folders.set(root, (folders.get(root) ?? new Set<string>()).add(path.slice(slash + 1)));
  }
  return [...folders].flatMap(([root, names]) =>
    !isSharedWithMePath(root) &&
    !root.split("/").some((part) => part.startsWith(".") || part === "node_modules") &&
    (names.has("app.publish.json") ||
      (names.has("index.html") &&
        names.size === 1 &&
        !BUILD_OUTPUT_DIRS.includes(posix.basename(root))))
      ? [root]
      : [],
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
type Version = Pick<OwnerRow, "publicationId" | "authorityRevision" | "ownerState">;
type Versions = { current?: OwnerRow; pending?: OwnerRow };
type Failure = { revision: string | null; reason: string };
type Watch = {
  timer?: ReturnType<typeof setTimeout>;
  pass?: AbortController;
  queued?: boolean;
  pulled?: boolean;
  parked?: boolean;
  roots: string[];
  inputs: Set<string>;
  failures: Map<string, Failure>;
};
const newest = (versions: Versions | undefined) => versions?.pending ?? versions?.current;
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Publishing = Required<
  Pick<
    Parameters<typeof createOwnerAppPublicationHandler>[0],
    | "withAdapter"
    | "compile"
    | "resolveDatasetRevision"
    | "relayJson"
    | "relayJsonOrUnavailable"
    | "upload"
  >
>;

export interface PhoneAppSenderDependencies<
  Workspace extends { workspaceId: string },
> extends Publishing {
  open(
    workspaceId: string,
    work: (
      workspace: Workspace,
      signal: AbortSignal,
      credentials: CloudCredentials,
    ) => Promise<void>,
  ): Promise<void>;
  admitted(workspace: Workspace): Promise<boolean>;
  sync(workspace: Workspace): Promise<boolean>;
  synced(workspace: Workspace): boolean;
  changed(workspaceId: string): void;
  delayMs?: number;
  timeoutMs?: number;
}

export function createPhoneAppSender<Workspace extends { workspaceId: string }>(
  deps: PhoneAppSenderDependencies<Workspace>,
) {
  const watches = new Map<string, Watch>();
  let sending: boolean | null = null;
  let running = Promise.resolve();
  const watch = (workspaceId: string) => {
    let entry = watches.get(workspaceId);
    if (!entry)
      watches.set(workspaceId, (entry = { roots: [], inputs: new Set(), failures: new Map() }));
    return entry;
  };
  const settle = (workspaceId: string, appRoot: string, failure: Failure | null) => {
    const { failures } = watch(workspaceId);
    const changed = failures.get(appRoot)?.reason !== failure?.reason;
    if (failure) failures.set(appRoot, failure);
    else failures.delete(appRoot);
    if (changed) deps.changed(workspaceId);
  };
  const later = (workspaceId: string) => {
    const entry = watch(workspaceId);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void run(workspaceId);
    }, deps.delayMs ?? 10_000);
    entry.timer.unref();
  };
  const run = (workspaceId: string): Promise<void> => {
    const entry = watch(workspaceId);
    if (entry.queued) return running;
    entry.queued = true;
    running = running.then(async () => {
      entry.queued = false;
      const controller = (entry.pass = new AbortController());
      try {
        await deps.open(workspaceId, (workspace, signal, credentials) =>
          pass(workspace, AbortSignal.any([signal, controller.signal]), credentials, entry),
        );
        settle(workspaceId, "", null);
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError"))
          settle(workspaceId, "", { revision: null, reason: reasonOf(error) });
      } finally {
        if (entry.pass === controller) entry.pass = undefined;
      }
    });
    return running;
  };

  async function pass(
    workspace: Workspace,
    signal: AbortSignal,
    credentials: CloudCredentials,
    entry: Watch,
  ) {
    const { workspaceId } = workspace;
    const base = `/sync/${encodeURIComponent(workspaceId)}/app-publications`;
    const deadline = () =>
      AbortSignal.any([signal, AbortSignal.timeout(deps.timeoutMs ?? 120_000)]);
    const assertCurrent = () => signal.throwIfAborted();
    const admit = async () => {
      signal.throwIfAborted();
      if (!(await deps.admitted(workspace))) entry.pass?.abort();
      signal.throwIfAborted();
    };
    const engine = async <Result>(work: (adapter: VersionedLiveAdapter) => Promise<Result>) => {
      const result = await deps.withAdapter(workspace, work);
      if (result === null) throw new Error("dohc could not read this workspace. Restart dohc.");
      return result;
    };
    const post = async (path: string, value: unknown) => {
      await admit();
      const init = { method: "POST", signal: deadline(), body: JSON.stringify(value) };
      return (await deps.relayJson(credentials, path, init)) as Version;
    };
    const listed = async () => {
      const rows = new Map<string, Versions>();
      let cursor: string | null = null;
      do {
        const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
        const path = `${base}?audience=owner${query}`;
        const answer = await deps.relayJsonOrUnavailable(credentials, path, { signal: deadline() });
        if (answer.kind === "unavailable") return null;
        const page = OwnerPage.parse(answer.body);
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
    const moved = async (appRoot: string, expected: string | null) => {
      signal.throwIfAborted();
      if ((newest((await listed())?.get(appRoot))?.publicationId ?? null) === expected)
        return false;
      later(workspaceId);
      return true;
    };
    const activate = (appRoot: string, row: Version) =>
      post(`${base}/${row.publicationId}/backend/activate`, {
        authorityRevision: row.authorityRevision,
      }).catch(async (error: unknown) => {
        if (!(await moved(appRoot, row.publicationId))) throw error;
      });
    const send = async (appRoot: string, revision: string, expected: string | null) => {
      const { candidate, files } = await engine((adapter) =>
        prepareOwnerAppPublication({ workspaceId, appRoot }, null, {
          adapter,
          signal,
          assertCurrent,
          compile: deps.compile,
          resolveDatasetRevision: (binding) =>
            deps.resolveDatasetRevision(workspace, binding, signal),
          deferredWrites: [],
        }),
      );
      if (candidate.sourceRevision !== revision || !deps.synced(workspace))
        return later(workspaceId);
      await admit();
      for (const file of files)
        await deps.upload(credentials, workspaceId, file.sha256, file.bytes, deadline());
      const request = { audience: "owner", candidate, expectedCurrentPublicationId: expected };
      const row = await post(base, request).catch(async (error: unknown) => {
        if (!(await moved(appRoot, expected))) throw error;
        return null;
      });
      if (row?.ownerState === "pending") await activate(appRoot, row);
    };

    await admit();
    if (!(await deps.sync(workspace))) return void (entry.parked = true);
    const published = await listed();
    if (!published) return;
    if (!(await deps.sync(workspace))) return void (entry.parked = true);
    entry.parked = false;
    const listing = await engine((adapter) =>
      adapter.listTextFileMetadata({ workspaceId, versionId: "main" }),
    );
    const paths = listing.map((file) => file.path);
    const apps = sendableRoots(paths);
    await admit();
    entry.roots = [...apps, ...published.keys()];
    for (const appRoot of entry.failures.keys())
      if (appRoot && !apps.includes(appRoot)) settle(workspaceId, appRoot, null);
    const inputs = new Set<string>();
    const onSelected = (selected: readonly string[]) =>
      selected.forEach((path) => inputs.add(path));
    for (const appRoot of apps) {
      await admit();
      let revision: string | null = null;
      try {
        revision = (
          await engine((adapter) =>
            readLocalAppSource(
              { workspaceId, appRoot, versionId: "main" },
              { adapter, signal, assertCurrent, deferredWrites: [], onSelected },
            ),
          )
        ).sourceRevision;
        const head = newest(published.get(appRoot));
        if (head?.sourceRevision !== revision || head.ownerState === "pending") {
          if (entry.failures.get(appRoot)?.revision === revision) continue;
          if (head?.sourceRevision === revision) await activate(appRoot, head);
          else await send(appRoot, revision, head?.publicationId ?? null);
        }
        settle(workspaceId, appRoot, null);
      } catch (error) {
        signal.throwIfAborted();
        settle(workspaceId, appRoot, { revision, reason: reasonOf(error) });
      }
    }
    entry.inputs = inputs;
    for (const [appRoot, { current, pending }] of published) {
      if (paths.some((path) => path.startsWith(`${appRoot}/`))) continue;
      for (const row of [pending, current])
        if (row)
          await post(`${base}/${row.publicationId}/withdraw`, {
            expectedAuthorityRevision: row.authorityRevision,
          });
    }
  }

  return {
    filesChanged(workspaceId: string, changed: readonly string[]) {
      const { roots, inputs } = watch(workspaceId);
      const touches = (path: string) =>
        /(?:^|\/)(?:index\.html|app\.publish\.json)$/.test(path) ||
        inputs.has(path) ||
        roots.some(
          (root) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`),
        );
      if (changed.some(touches)) later(workspaceId);
    },
    pulled(workspaceId: string, applied: boolean) {
      const entry = watch(workspaceId);
      if (applied || !entry.pulled || entry.parked || entry.failures.has("")) later(workspaceId);
      entry.pulled = true;
    },
    schedule: later,
    versionSwitched(workspaceId: string) {
      watches.get(workspaceId)?.pass?.abort();
      later(workspaceId);
    },
    settingChanged(enabled: boolean) {
      if (enabled === sending) return;
      sending = enabled;
      for (const [workspaceId, entry] of watches) {
        if (enabled && entry.pulled) later(workspaceId);
        if (enabled) continue;
        clearTimeout(entry.timer);
        entry.pass?.abort();
        if (entry.failures.size) deps.changed(workspaceId);
        entry.failures.clear();
      }
    },
    close(workspaceId: string) {
      const entry = watches.get(workspaceId);
      clearTimeout(entry?.timer);
      entry?.pass?.abort();
      watches.delete(workspaceId);
    },
    retry(workspaceId: string, appRoot: string | null) {
      if (!watches.get(workspaceId)?.failures.delete(appRoot ?? "")) return Promise.resolve();
      deps.changed(workspaceId);
      return run(workspaceId);
    },
    notSent(workspaceId: string) {
      return [...(watches.get(workspaceId)?.failures ?? [])].map(([appRoot, { reason }]) => ({
        appRoot: appRoot || null,
        reason,
      }));
    },
    run,
  };
}
