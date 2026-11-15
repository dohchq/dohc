// @vitest-environment jsdom
import { act, cleanup, configure, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessRuleHold } from "../../ipc/bridgeContract";
import { useAccessRuleHoldNotices } from "./useAccessRuleHoldNotices";
import { useShellError } from "./useShellError";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const WIDENED: AccessRuleHold = {
  versionId: "main",
  folder: "team",
  reason: "widened",
  observedSha256: "a".repeat(64),
  recordedAtMs: 1,
};
const REMOVED: AccessRuleHold = {
  versionId: "main",
  folder: "",
  reason: "removed",
  observedSha256: null,
  recordedAtMs: 1,
};

function harness(holds: readonly AccessRuleHold[]) {
  const bridge = { decideAccessRule: vi.fn(async (_input: object) => ({ heldAccessRules: [] })) };
  vi.stubGlobal("dohcDesktop", bridge);
  let errors!: ReturnType<typeof useShellError>;
  function Shell(props: { holds: readonly AccessRuleHold[] }) {
    errors = useShellError("ws-a");
    useAccessRuleHoldNotices({
      workspaceId: "ws-a",
      workspaceName: "Trips",
      holds: props.holds,
      reportShellFailure: errors.reportShellFailure,
      clearIdentity: errors.clearIdentity,
    });
    return null;
  }
  const view = render(<Shell holds={holds} />);
  return {
    bridge,
    errors: () => errors,
    list: (next: readonly AccessRuleHold[]) => view.rerender(<Shell holds={next} />),
  };
}

describe("useAccessRuleHoldNotices", () => {
  it("names the folder, or the workspace for its own rule, and sends the rule the owner saw", async () => {
    const h = harness([WIDENED, REMOVED]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(2));
    const [widened, removed] = h.errors().shellErrors;
    expect(widened).toMatchObject({
      tone: "warning",
      noDismiss: true,
      title: "Access for team was widened outside dohc",
      action: { label: "Allow", additional: [{ label: "Restore rule" }] },
    });
    expect(removed).toMatchObject({
      title: "The access rule for Trips was removed outside dohc",
      action: { label: "Remove access", additional: [{ label: "Restore rule" }] },
    });

    act(() => h.errors().runShellErrorAction(widened!.id));
    act(() => h.errors().runShellErrorAction(removed!.id, 1));
    await waitFor(() => expect(h.bridge.decideAccessRule).toHaveBeenCalledTimes(2));
    expect(h.bridge.decideAccessRule).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-a",
      folder: "team",
      decision: "accept",
      expectedSha256: "a".repeat(64),
    });
    expect(h.bridge.decideAccessRule).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-a",
      folder: "",
      decision: "restore",
      expectedSha256: null,
    });
    // The rows stay until the engine stops listing the holds.
    expect(h.errors().shellErrors).toHaveLength(2);
    h.list([]);
    await waitFor(() => expect(h.errors().shellErrors).toEqual([]));
  });

  it("shows the rule as it is now when it changed since the owner saw it", async () => {
    const h = harness([WIDENED]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(1));
    const first = h.errors().shellErrors[0]!;
    act(() => h.errors().hideShellError(first.id));
    h.bridge.decideAccessRule.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:decide-access-rule': DaemonRefusalError [CONFLICT]: access-rule-changed: team",
      ),
    );
    act(() => h.errors().runShellErrorAction(first.id));
    await waitFor(() => expect(h.bridge.decideAccessRule).toHaveBeenCalledOnce());
    // Main recorded the engine's new judgment, which arrives as the list.
    h.list([{ ...WIDENED, observedSha256: "b".repeat(64), recordedAtMs: 2 }]);
    await waitFor(() => expect(h.errors().shellErrors[0]?.id).not.toBe(first.id));
    expect(h.errors().shellErrors).toHaveLength(1);
    expect(h.errors().shellErrors[0]).toMatchObject({
      title: "Access for team was widened outside dohc",
      seen: false,
    });
    act(() => h.errors().runShellErrorAction(h.errors().shellErrors[0]!.id));
    await waitFor(() =>
      expect(h.bridge.decideAccessRule).toHaveBeenLastCalledWith(
        expect.objectContaining({ expectedSha256: "b".repeat(64) }),
      ),
    );
  });

  it("says when a decision failed for another reason, with Try again", async () => {
    const h = harness([WIDENED]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(1));
    h.bridge.decideAccessRule.mockRejectedValueOnce(new Error("engine stopped"));
    act(() => h.errors().runShellErrorAction(h.errors().shellErrors[0]!.id, 1));
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(2));
    expect(h.errors().shellErrors[1]).toMatchObject({
      title: "dohc could not restore the access rule for team",
      retry: expect.any(Function),
    });
  });
});
