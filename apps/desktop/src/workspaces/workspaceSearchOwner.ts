import type { SearchResult } from "@dohc/workspace-engine-client";
import type { WorkspaceSearchPayload } from "../ipc/bridgeContract";
import {
  CHANNELS,
  parseSearchResultsEvent,
  SEARCH_EVENT_MAX_ENTRIES,
} from "../ipc/channels";
import type { OwnedWorkspaceSearchView } from "./ownedWorkspaceSdkReadPort";
import { usableShareMountRecord } from "./shareMounts";
import { storedShareMounts } from "./shareViewFilesTarget";
import {
  mountScopedIncludeGlob,
  type SearchBatch,
  type SearchRegistry,
} from "./workspaceSearch";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import {
  readWorkspaceEnginePolicy,
  resolveEngineSearchPolicy,
  type WorkspaceEnginePolicySnapshot,
} from "./workspaceEnginePolicyFile";

export interface WorkspaceSearchWorkspace {
  workspaceId: string;
  rootPath: string;
  shareMounts?: unknown;
}

export interface WorkspaceSearchSender {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  once(event: "destroyed", listener: () => void): unknown;
}

export interface WorkspaceSearchEngineInput {
  query: string;
  limit: number;
  isCurrent: () => boolean;
}

export interface WorkspaceSearchAuthority<
  Workspace extends WorkspaceSearchWorkspace,
> {
  workspace: Workspace;
  isCurrent(): boolean;
}

export interface WorkspaceSearchOwnerDependencies<
  Workspace extends WorkspaceSearchWorkspace,
> {
  searchRegistry: Pick<
    SearchRegistry,
    "startSearch" | "cancel" | "disposeOwner" | "killAll"
  >;
  prepareOwnedSearch(
    workspace: Workspace,
  ): Promise<Pick<OwnedWorkspaceSearchView, "allowPath">>;
  engineCaptureFor(
    workspaceId: string,
  ): Pick<WorkspaceEngineCapture, "flush"> | null;
  queryEngine(
    workspace: Workspace,
    input: WorkspaceSearchEngineInput,
  ): Promise<SearchResult[] | null>;
  readEnginePolicy?(
    rootPath: string,
  ): Promise<WorkspaceEnginePolicySnapshot>;
  logError(message: string, error?: unknown): void;
}

interface SearchIdentity {
  searchId: string;
  settled: boolean;
}

function stoppedSearchError(): Error {
  return new Error(
    "Workspace search stopped because it is no longer current.",
  );
}

/** Owns workspace-search policy and every renderer-scoped search lifetime. */
export class WorkspaceSearchOwner<
  Workspace extends WorkspaceSearchWorkspace = WorkspaceSearchWorkspace,
> {
  readonly #dependencies: WorkspaceSearchOwnerDependencies<Workspace>;
  readonly #latest = new Map<number, SearchIdentity>();
  readonly #cleanupHooked = new WeakSet<object>();
  #disposed = false;

  constructor(dependencies: WorkspaceSearchOwnerDependencies<Workspace>) {
    this.#dependencies = dependencies;
  }

  async start(
    sender: WorkspaceSearchSender,
    authority: WorkspaceSearchAuthority<Workspace>,
    input: WorkspaceSearchPayload,
  ): Promise<void> {
    if (this.#disposed) throw stoppedSearchError();

    const { workspace } = authority;

    const identity = {
      searchId: input.searchId,
      settled: false,
    };
    const previous = this.#latest.get(sender.id);
    this.#latest.set(sender.id, identity);
    if (previous) {
      this.#dependencies.searchRegistry.cancel(sender.id, previous.searchId);
    }
    this.#hookDestroyed(sender);

    const ownsSearch = () =>
      !this.#disposed && this.#latest.get(sender.id) === identity;
    const isCurrent = () =>
      ownsSearch() && !sender.isDestroyed() && authority.isCurrent();
    const assertCurrent = () => {
      if (!isCurrent()) throw stoppedSearchError();
    };

    const ownedSearchView =
      await this.#dependencies.prepareOwnedSearch(workspace);
    assertCurrent();

    const registeredMounts = storedShareMounts(workspace);
    const hasUsableMount = registeredMounts.some((mount) =>
      usableShareMountRecord(registeredMounts, mount),
    );
    const capture = this.#dependencies.engineCaptureFor(workspace.workspaceId);
    if (!capture) {
      await this.#startRipgrep({
        sender,
        workspace,
        input,
        includeGlob: input.includeGlob,
        allowPath: ownedSearchView.allowPath,
        identity,
        ownsSearch,
        isCurrent,
        assertCurrent,
      });
      return;
    }

    await capture.flush();
    assertCurrent();

    const policy = resolveEngineSearchPolicy(
      await (this.#dependencies.readEnginePolicy ?? readWorkspaceEnginePolicy)(
        workspace.rootPath,
      ),
    );
    assertCurrent();
    if (policy.kind === "blocked") {
      this.#dependencies.logError(
        `Workspace search blocked by policy validation for ${workspace.rootPath}.`,
        policy.message,
      );
      this.#sendRequired(
        sender,
        {
          searchId: input.searchId,
          entries: [],
          done: true,
          limitHit: false,
          notice: (
            "Search is paused because dohc could not apply the workspace policy. " +
            `Fix the policy file, then search again. ${policy.message}`
          ).slice(0, 500),
        },
        isCurrent,
        "policy result",
      );
      return;
    }

    const results = await this.#dependencies.queryEngine(workspace, {
      query: input.query,
      limit: SEARCH_EVENT_MAX_ENTRIES,
      isCurrent,
    });
    if (results === null) throw stoppedSearchError();
    assertCurrent();

    this.#sendRequired(
      sender,
      {
        searchId: input.searchId,
        entries: results.map((result) => ({
          path: result.path,
          line: result.line,
          column: result.matchStart + 1,
          preview: result.preview,
          matchStart: result.matchStart,
          matchEnd: result.matchEnd,
          surface: result.surface,
          // File groups already display their path. Omitting the duplicate
          // title also keeps a valid long path from exceeding the separate
          // human-title bound at the renderer seam.
          ...(result.surface === "chat" ? { title: result.title } : {}),
          ...(result.threadId ? { threadId: result.threadId } : {}),
          ...(result.objectId ? { objectId: result.objectId } : {}),
        })),
        done: !hasUsableMount,
        limitHit: false,
      },
      isCurrent,
      "engine result",
    );
    if (!hasUsableMount || !isCurrent()) return;

    const mountGlob = mountScopedIncludeGlob(input.includeGlob);
    if (mountGlob === null) {
      this.#sendRequired(
        sender,
        {
          searchId: input.searchId,
          entries: [],
          done: true,
          limitHit: false,
        },
        isCurrent,
        "mount completion",
      );
      return;
    }

    await this.#startRipgrep({
      sender,
      workspace,
      input,
      includeGlob: mountGlob,
      allowPath: ownedSearchView.allowPath,
      identity,
      ownsSearch,
      isCurrent,
      assertCurrent,
    });
  }

  cancel(senderId: number, searchId: string): void {
    const latest = this.#latest.get(senderId);
    if (latest?.searchId === searchId) this.#latest.delete(senderId);
    this.#dependencies.searchRegistry.cancel(senderId, searchId);
  }

  disposeSender(senderId: number): void {
    this.#latest.delete(senderId);
    this.#dependencies.searchRegistry.disposeOwner(senderId);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#latest.clear();
    this.#dependencies.searchRegistry.killAll();
  }

  #hookDestroyed(sender: WorkspaceSearchSender): void {
    if (this.#cleanupHooked.has(sender)) return;
    this.#cleanupHooked.add(sender);
    sender.once("destroyed", () => this.disposeSender(sender.id));
  }

  async #startRipgrep(input: {
    sender: WorkspaceSearchSender;
    workspace: Workspace;
    input: WorkspaceSearchPayload;
    includeGlob: string | undefined;
    allowPath: (path: string) => boolean;
    identity: SearchIdentity;
    ownsSearch: () => boolean;
    isCurrent: () => boolean;
    assertCurrent: () => void;
  }): Promise<void> {
    input.assertCurrent();
    await this.#dependencies.searchRegistry.startSearch(
      input.sender.id,
      input.workspace.rootPath,
      input.input.searchId,
      {
        query: input.input.query,
        caseSensitive: input.input.caseSensitive,
        wholeWord: input.input.wholeWord,
        regex: input.input.regex,
        includeGlob: input.includeGlob,
        excludeGlob: input.input.excludeGlob,
      },
      (batch) =>
        this.#sendRipgrepBatch(
          input.sender,
          batch,
          input.identity,
          input.ownsSearch,
          input.isCurrent,
        ),
      {
        isCurrent: input.isCurrent,
        allowPath: input.allowPath,
      },
    );
    if (!input.isCurrent()) {
      // This invocation is still pending, so its rejection settles the
      // renderer. Mark it first so cancellation cannot also emit a terminal
      // batch through a synchronous or late child callback.
      input.identity.settled = true;
      // Root validation can finish after this workspace loses authority. Kill
      // only this invocation's handle. A superseding search owns a different
      // identity and has already replaced or cancelled this handle.
      if (input.ownsSearch()) {
        this.#dependencies.searchRegistry.cancel(
          input.sender.id,
          input.input.searchId,
        );
      }
      throw stoppedSearchError();
    }
  }

  #sendRipgrepBatch(
    sender: WorkspaceSearchSender,
    batch: SearchBatch,
    identity: SearchIdentity,
    ownsSearch: () => boolean,
    isCurrent: () => boolean,
  ): void {
    if (identity.settled) return;
    if (!isCurrent()) {
      this.#settleStaleRipgrep(sender, identity, ownsSearch);
      return;
    }
    const matchesIdentity = batch.searchId === identity.searchId;
    if (!matchesIdentity) {
      this.#dependencies.logError(
        "Workspace search dropped a ripgrep batch with the wrong request identity.",
      );
    }
    const sent =
      matchesIdentity &&
      this.#send(sender, batch, isCurrent, "ripgrep batch");
    if (!batch.done) return;
    if (sent) {
      identity.settled = true;
      return;
    }
    if (!isCurrent()) {
      this.#settleStaleRipgrep(sender, identity, ownsSearch);
      return;
    }

    // A malformed terminal batch cannot be allowed to disappear: the invoke
    // already resolved when ripgrep started, so only an event can settle the
    // renderer now. The empty completion is closed and independently parsed.
    const fallbackSent = this.#send(
      sender,
      {
        searchId: identity.searchId,
        entries: [],
        done: true,
        limitHit: false,
      },
      isCurrent,
      "ripgrep fallback completion",
    );
    if (fallbackSent) {
      identity.settled = true;
      return;
    }
    if (!isCurrent()) {
      this.#settleStaleRipgrep(sender, identity, ownsSearch);
    }
  }

  #settleStaleRipgrep(
    sender: WorkspaceSearchSender,
    identity: SearchIdentity,
    ownsSearch: () => boolean,
  ): void {
    // The normal current check failed. Only the exact request identity and a
    // live sender authorize an empty terminal event, never result data.
    if (identity.settled || !ownsSearch() || sender.isDestroyed()) return;
    identity.settled = true;
    this.#dependencies.searchRegistry.cancel(sender.id, identity.searchId);
    this.#send(
      sender,
      {
        searchId: identity.searchId,
        entries: [],
        done: true,
        limitHit: false,
      },
      () => ownsSearch() && !sender.isDestroyed(),
      "stale ripgrep completion",
    );
  }

  #send(
    sender: WorkspaceSearchSender,
    event: unknown,
    isCurrent: () => boolean,
    source: string,
  ): boolean {
    if (!isCurrent()) return false;
    const parsed = parseSearchResultsEvent(event);
    if (!parsed) {
      this.#dependencies.logError(
        `Workspace search dropped an invalid ${source}.`,
        new Error("Search result event failed the preload boundary parser."),
      );
      return false;
    }
    if (!isCurrent()) return false;
    try {
      sender.send(CHANNELS.searchResults, parsed);
      return true;
    } catch (error) {
      this.#dependencies.logError(
        `Workspace search could not send a ${source}.`,
        error,
      );
      return false;
    }
  }

  #sendRequired(
    sender: WorkspaceSearchSender,
    event: unknown,
    isCurrent: () => boolean,
    source: string,
  ): void {
    if (this.#send(sender, event, isCurrent, source)) return;
    if (!isCurrent()) throw stoppedSearchError();
    throw new Error(`Workspace search could not deliver ${source}.`);
  }
}
