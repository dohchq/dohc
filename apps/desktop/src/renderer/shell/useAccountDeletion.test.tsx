// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ServerAccountDeletionPreview } from "@dohc/cli/account";
import { deferred } from "../../testing/deferred";
import { useAccountDeletion, type AccountDeletion } from "./useAccountDeletion";

type DeleteResult = { ok: true; finished: boolean; email: string; server: string };

const server = "https://cloud.dohc.test";
const preview: ServerAccountDeletionPreview = {
  email: "me@dohc.test", server, workspaces: [], workspacesElsewhere: 0, storedBytes: 0,
  ownedShareCount: 0, heldGrantCount: 0, previewToken: "token-1",
};
const DELETED = `Deleted me@dohc.test on ${server}. Workspaces on this computer stay.`;

const bridgeMock = {
  previewServerAccountDeletion: vi.fn(async () => preview),
  deleteServerAccount: vi.fn<() => Promise<DeleteResult>>(),
  onCloudSessionChanged: vi.fn(() => () => undefined),
};
vi.mock("../bridge", () => ({ bridge: () => bridgeMock }));

// Which shells have run their first effect.
const started = new Set<string>();

// Orders its effects as the workspace shell does: its notices start empty,
// then it attaches.
function Shell({ name, deletion }: { name: string; deletion: AccountDeletion }) {
  const [notices, setNotices] = useState<string[]>([]);
  useEffect(() => {
    setNotices([]);
    started.add(name);
  }, [name]);
  useEffect(() => {
    const add = (message: string) => setNotices((current) => [...current, message]);
    return deletion.attach({
      cloudStatus: null,
      report: (error) => add(error.message),
      showSuccess: add,
      showWarning: add,
      onEnded: () => undefined,
    });
  }, [deletion]);
  return (
    <section data-testid={`shell-${name}`}>
      {notices.map((notice) => <p key={notice}>{notice}</p>)}
    </section>
  );
}

let switchTo: (name: string) => void = () => undefined;
function Owner() {
  const { deletion, dialog } = useAccountDeletion();
  const [workspace, setWorkspace] = useState("a");
  useEffect(() => {
    switchTo = setWorkspace;
  }, []);
  return (
    <>
      <Shell key={workspace} name={workspace} deletion={deletion} />
      <button onClick={() => deletion.start({ email: "me@dohc.test", server })}>Delete account</button>
      {dialog}
    </>
  );
}

function setActEnvironment(on: boolean) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = on;
}

describe("useAccountDeletion", () => {
  // React runs a commit's effects in a later task than the commit. An answer
  // that arrives in between must wait for the new shell to start its notices.
  it("reports an answer that arrives after a switch commits, before the new shell's effects run", async () => {
    const answer = deferred<DeleteResult>();
    bridgeMock.deleteServerAccount.mockImplementation(() => answer.promise);
    render(<Owner />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    await screen.findByTestId("server-account-delete-scope");
    fireEvent.change(screen.getByTestId("server-account-delete-password"), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByTestId("server-account-delete-confirm"));
    await waitFor(() => expect(bridgeMock.deleteServerAccount).toHaveBeenCalledTimes(1));

    let answeredBeforeEffects: boolean | null = null;
    // Mutation records arrive in a microtask right after the commit.
    const observer = new MutationObserver(() => {
      if (answeredBeforeEffects !== null || !screen.queryByTestId("shell-b")) return;
      answeredBeforeEffects = !started.has("b");
      answer.resolve({ ok: true, finished: true, email: "me@dohc.test", server });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Outside act, so React schedules the switch's effects as it does in the app.
    setActEnvironment(false);
    try {
      switchTo("b");
      await waitFor(() => expect(screen.queryByTestId("server-account-delete")).toBeNull());
    } finally {
      setActEnvironment(true);
      observer.disconnect();
    }

    expect(answeredBeforeEffects).toBe(true);
    expect(await within(screen.getByTestId("shell-b")).findByText(DELETED)).toBeTruthy();
  });
});
