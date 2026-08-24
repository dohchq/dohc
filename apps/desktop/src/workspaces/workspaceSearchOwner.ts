import type { SearchResult } from "@dohc/workspace-engine-client";
import {
  SearchResultsEventSchema,
  type WorkspaceSearchPayload,
} from "../ipc/bridgeContract";
import { CHANNELS, SEARCH_EVENT_MAX_ENTRIES } from "../ipc/channels";
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
  logError(message: string, error?: unknown): void;
}

interface SearchIdentity {
  generation: number;
  searchId: string;
}

/** Owns workspace-search policy and every renderer-scoped search lifetime. */
export class WorkspaceSearchOwner<
  Workspace extends WorkspaceSearchWorkspace = WorkspaceSearchWorkspace,
> {
  readonly #dependencies: WorkspaceSearchOwnerDependencies<Workspace>;
  readonly #generations = new Map<number, number>();
  readonly #latest = new Map<number, SearchIdentity>();
  readonly #cleanupHooked = new WeakSet<object>();
  #disposed = false;

  constructor(dependencies: WorkspaceSearchOwnerDependencies<Workspace>) {
    this.#dependencies = dependencies;
  }

  async start(
    sender: WorkspaceSearchSender,
    workspace: Workspace,
    input: WorkspaceSearchPayload,
  ): Promise<void> {
    if (this.#disposed) return;

    const identity = {
      generation: this.#generation(sender.id),
      searchId: input.searchId,
    };
    const previous = this.#latest.get(sender.id);
    this.#latest.set(sender.id, identity);
    if (previous) {
      this.#dependencies.searchRegistry.cancel(sender.id, previous.searchId);
    }
    this.#hookDestroyed(sender);

    const isCurrent = () =>
      !this.#disposed &&
      !sender.isDestroyed() &&
      this.#generation(sender.id) === identity.generation &&
      this.#latest.get(sender.id) === identity;

    const ownedSearchView =
      await this.#dependencies.prepareOwnedSearch(workspace);
    if (!isCurrent()) return;

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
        isCurrent,
      });
      return;
    }

    await capture.flush();
    if (!isCurrent()) return;

    const policy = resolveEngineSearchPolicy(
      await readWorkspaceEnginePolicy(workspace.rootPath),
    );
    if (!isCurrent()) return;
    if (policy.kind === "blocked") {
      this.#dependencies.logError(
        `Workspace search blocked by policy validation for ${workspace.rootPath}.`,
        policy.message,
      );
      this.#send(
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
    if (results === null || !isCurrent()) return;

    this.#send(
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
          title: result.title,
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
      this.#send(
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
      isCurrent,
    });
  }

  cancel(senderId: number, searchId: string): void {
    const latest = this.#latest.get(senderId);
    if (latest?.searchId === searchId) this.#latest.delete(senderId);
    this.#dependencies.searchRegistry.cancel(senderId, searchId);
  }

  disposeSender(senderId: number): void {
    this.#generations.set(senderId, this.#generation(senderId) + 1);
    this.#latest.delete(senderId);
    this.#dependencies.searchRegistry.disposeOwner(senderId);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#latest.clear();
    this.#dependencies.searchRegistry.killAll();
  }

  #generation(senderId: number): number {
    return this.#generations.get(senderId) ?? 0;
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
    isCurrent: () => boolean;
  }): Promise<void> {
    if (!input.isCurrent()) return;
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
      (batch) => this.#sendRipgrepBatch(input.sender, batch, input.isCurrent),
      {
        isCurrent: input.isCurrent,
        allowPath: input.allowPath,
      },
    );
  }

  #sendRipgrepBatch(
    sender: WorkspaceSearchSender,
    batch: SearchBatch,
    isCurrent: () => boolean,
  ): void {
    this.#send(sender, batch, isCurrent, "ripgrep batch");
  }

  #send(
    sender: WorkspaceSearchSender,
    event: unknown,
    isCurrent: () => boolean,
    source: string,
  ): void {
    if (!isCurrent()) return;
    const parsed = SearchResultsEventSchema.safeParse(event);
    if (!parsed.success) {
      this.#dependencies.logError(
        `Workspace search dropped an invalid ${source}.`,
        parsed.error,
      );
      return;
    }
    if (!isCurrent()) return;
    try {
      sender.send(CHANNELS.searchResults, parsed.data);
    } catch (error) {
      this.#dependencies.logError(
        `Workspace search could not send a ${source}.`,
        error,
      );
    }
  }
}
