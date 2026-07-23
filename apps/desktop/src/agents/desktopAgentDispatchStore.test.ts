import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  createLinkedChatStore,
  type LinkedChatStore,
} from "@dohc/workspace-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeTmpdir } from "../workspaces/testTemp";
import {
  createDesktopAgentDispatchStore,
  type DesktopAgentDispatchStoreHandle,
} from "./desktopAgentDispatchStore";
import { APP_QUIT_EXIT_CODE } from "./chatDispatchService";

const WORKSPACE_ID = "workspace-desktop-dispatch-store";
const THREAD_ID = "thread-dispatch";

describe("desktop agent dispatch store", () => {
  let root: string;
  let chats: LinkedChatStore | null;
  let dispatch: DesktopAgentDispatchStoreHandle | null;

  beforeEach(async () => {
    root = await mkdtemp(join(nativeTmpdir(), "dohc-desktop-dispatch-store-"));
    chats = createLinkedChatStore(root);
    await chats.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    dispatch = createDesktopAgentDispatchStore(root);
  });

  afterEach(async () => {
    dispatch?.close();
    dispatch = null;
    await chats?.close();
    chats = null;
    await rm(root, { recursive: true, force: true });
  });

  function requireDispatch(): DesktopAgentDispatchStoreHandle {
    if (!dispatch) throw new Error("Expected the dispatch store to be open.");
    return dispatch;
  }

  it("desktop_claim_mints_one_run_id_and_replaces_every_log_token", () => {
    const handle = requireDispatch();
    const command =
      'claude -p --permission-mode acceptEdits --allowedTools "Bash(dohc chat:*)"';
    const logTemplate = join(root, "run-logs", "{runId}", "{runId}.log");
    handle.store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-command",
      threadId: THREAD_ID,
    });

    const claim = handle.store.claimNextPending(WORKSPACE_ID, {
      command,
      logPath: logTemplate,
    });
    if (!claim) throw new Error("Expected the pending dispatch to be claimed.");

    expect(claim.run.command).toBe(command);
    // MUTATION: replace only the first token -> the basename retains {runId}.
    expect(claim.run.logPath).toBe(
      join(root, "run-logs", claim.run.runId, `${claim.run.runId}.log`),
    );
    expect(basename(claim.run.logPath ?? "")).toBe(`${claim.run.runId}.log`);
    expect(claim.run.logPath).not.toContain("{runId}");

    handle.close();
    dispatch = createDesktopAgentDispatchStore(root);
    expect(dispatch.store.getRunRecord(claim.run.runId)).toMatchObject({
      runId: claim.run.runId,
      command,
      logPath: join(root, "run-logs", claim.run.runId, `${claim.run.runId}.log`),
    });
  });

  it("desktop_claim_persists_the_templated_run_id_in_ledger_and_run", () => {
    requireDispatch().close();
    dispatch = createDesktopAgentDispatchStore(root, {
      createRunId: () => "run_injected_0001",
    });
    dispatch.store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-injected",
      threadId: THREAD_ID,
    });
    const claim = dispatch.store.claimNextPending(WORKSPACE_ID, {
      command: "codex exec",
    });
    if (!claim) throw new Error("Expected the pending dispatch to be claimed.");
    // MUTATION: mint separately for template/claim -> persisted ids diverge.
    expect(claim.run.runId).toBe("run_injected_0001");
    expect(claim.dispatch.runId).toBe("run_injected_0001");
  });

  it("desktop_claim_clears_prepared_id_after_null_and_error", () => {
    requireDispatch().close();
    const ids = ["run_null", "run_error", "run_after"];
    dispatch = createDesktopAgentDispatchStore(root, {
      createRunId: () => ids.shift() ?? "run_exhausted",
    });
    expect(dispatch.store.claimNextPending(WORKSPACE_ID)).toBeNull();
    expect(() =>
      dispatch?.store.claimNextPending(WORKSPACE_ID, { command: "bad\0command" }),
    ).toThrow();
    dispatch.store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-after-clear",
      threadId: THREAD_ID,
    });
    const claim = dispatch.store.claimNextPending(WORKSPACE_ID);
    // MUTATION: omit either finally clear -> a stale prepared id is persisted.
    expect(claim?.run.runId).toBe("run_after");
  });

  it("records and resolves run-message links through the desktop adapter", () => {
    const store = requireDispatch().store;
    store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-link-trigger",
      threadId: THREAD_ID,
    });
    const claim = store.claimNextPending(WORKSPACE_ID, {
      command: "codex exec",
    });
    if (!claim) throw new Error("Expected a run for message linkage.");

    expect(
      store.recordRunMessage({
        workspaceId: WORKSPACE_ID,
        messageId: "message-report-b",
        runId: claim.run.runId,
      }),
    ).toBe(true);
    expect(
      store.recordRunMessage({
        workspaceId: WORKSPACE_ID,
        messageId: "message-report-a",
        runId: claim.run.runId,
      }),
    ).toBe(true);
    expect(
      store.recordRunMessage({
        workspaceId: WORKSPACE_ID,
        messageId: "message-report-a",
        runId: claim.run.runId,
      }),
    ).toBe(false);
    expect(store.listRunMessages(WORKSPACE_ID, claim.run.runId)).toEqual([
      "message-report-a",
      "message-report-b",
    ]);
    expect(store.runIdForMessage(WORKSPACE_ID, "message-report-a")).toBe(
      claim.run.runId,
    );
    expect(store.runIdForMessage(WORKSPACE_ID, "message-unlinked")).toBeNull();
  });

  it("requeues a failed startup run once and refuses a second retry", () => {
    const handle = requireDispatch();
    const { store } = handle;
    store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-restart",
      threadId: THREAD_ID,
    });
    const first = store.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!first) throw new Error("Expected the initial run.");
    store.failRun({
      runId: first.run.runId,
      reason: "app restart during run",
    });

    expect(
      handle.requeueFailedTrigger({
        workspaceId: WORKSPACE_ID,
        triggerMessageId: first.dispatch.triggerMessageId,
        runId: first.run.runId,
      }),
    ).toBe(true);
    expect(
      handle.requeueFailedTrigger({
        workspaceId: WORKSPACE_ID,
        triggerMessageId: first.dispatch.triggerMessageId,
        runId: first.run.runId,
      }),
    ).toBe(false);
    expect(store.listPending(WORKSPACE_ID)).toMatchObject([
      {
        triggerMessageId: first.dispatch.triggerMessageId,
        state: "pending",
        attemptCount: 1,
      },
    ]);

    const retry = store.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!retry) throw new Error("Expected the single startup retry.");
    expect(retry.run.runId).not.toBe(first.run.runId);
    expect(retry.dispatch.attemptCount).toBe(2);
    store.failRun({
      runId: retry.run.runId,
      reason: "app restart during run",
    });

    expect(
      handle.requeueFailedTrigger({
        workspaceId: WORKSPACE_ID,
        triggerMessageId: retry.dispatch.triggerMessageId,
        runId: retry.run.runId,
      }),
    ).toBe(false);
    expect(store.listPending(WORKSPACE_ID)).toEqual([]);
    expect(store.claimNextPending(WORKSPACE_ID)).toBeNull();
  });

  it("lists terminal app-quit runs until their recovery note is consumed", () => {
    const handle = requireDispatch();
    const { store } = handle;
    store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-app-quit",
      threadId: THREAD_ID,
    });
    const claim = store.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!claim) throw new Error("Expected an app-quit run.");
    store.failRun({
      runId: claim.run.runId,
      exitCode: APP_QUIT_EXIT_CODE,
      reason: "app-quit",
    });

    expect(handle.listAppQuitRecoveries(WORKSPACE_ID)).toEqual([
      {
        run: expect.objectContaining({
          runId: claim.run.runId,
          exitCode: APP_QUIT_EXIT_CODE,
          failureNotePosted: false,
        }),
        attemptCount: 1,
      },
    ]);

    store.markFailureNotePosted(claim.run.runId);
    expect(handle.listAppQuitRecoveries(WORKSPACE_ID)).toEqual([]);
  });

  it("never recovers an exit-143 user stop without a note marker", () => {
    const handle = requireDispatch();
    const { store } = handle;
    store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-user-stop",
      threadId: THREAD_ID,
    });
    const claim = store.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!claim) throw new Error("Expected a user-stopped run.");
    const stopped = store.failRun({
      runId: claim.run.runId,
      exitCode: APP_QUIT_EXIT_CODE,
      reason: "user-stop",
    });

    expect(stopped).toMatchObject({
      exitCode: APP_QUIT_EXIT_CODE,
      failureReason: "user-stop",
      failureNotePosted: false,
    });
    expect(handle.listAppQuitRecoveries(WORKSPACE_ID)).toEqual([]);
  });
});
