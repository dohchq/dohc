// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "./DesktopWorkspaceShell";
import { CollectionFieldWriteHost } from "./collections/recordFieldWrites";
import { historyPageFields } from "../testing/historyPageFixture";
import { deferred } from "../testing/deferred";
import { VERSIONS_TAB_PATH } from "./workbench/workbenchState";
import {
  DesktopWorkspaceShell,
  OTHER_WORKSPACE,
  WORKSPACE,
  makeBridge,
  shellBootstrapProps,
  storedStateWithTabs,
} from "./DesktopWorkspaceShell.testHarness";

// What a person sees of the Versions page's read failures, through the real
// shell and Notices: each toast and each row, its words, its buttons, and
// whether it is unread. Every order of events here passed before the page
// moved onto the notice owner, and passes unchanged after it.

type Read = "lastChanges" | "counts" | "conflicts";
type Step = "ok" | "fail" | "hold";

const MAIN = { id: "main", name: "Main", kind: "main" as const, createdAtMs: 0, canMergeIntoMain: false };
const DRAFT = { id: "draft", name: "Draft", kind: "named" as const, createdAtMs: 1, canMergeIntoMain: true, madeFromVersionId: "main" };
const BROKE: Record<Read, string> = {
  lastChanges: "last changes broke",
  counts: "count broke",
  conflicts: "conflicts broke",
};

function versionsShell() {
  const bridge = makeBridge(Promise.resolve(storedStateWithTabs([VERSIONS_TAB_PATH], VERSIONS_TAB_PATH)));
  const plan: Record<Read, Step[]> = { lastChanges: [], counts: [], conflicts: [] };
  const held: Record<Read, Array<ReturnType<typeof deferred<never>>>> = { lastChanges: [], counts: [], conflicts: [] };
  const calls: Record<Read, number> = { lastChanges: 0, counts: 0, conflicts: 0 };
  let moment = 0;
  const answer = <T,>(read: Read, ok: T): Promise<T> => {
    calls[read] += 1;
    const step = plan[read].shift() ?? "ok";
    if (step === "ok") return Promise.resolve(ok);
    if (step === "fail") return Promise.reject(new Error(BROKE[read]));
    const wait = deferred<never>();
    held[read].push(wait);
    return wait.promise;
  };
  Object.assign(bridge, {
    listWorkspaceVersions: vi.fn(async () => ({ versions: [MAIN, DRAFT], activeVersionId: "main", ...historyPageFields })),
    listVersionLastChanges: vi.fn(() => answer("lastChanges", {
      versions: [{ versionId: "main", lastChange: null }, { versionId: "draft", lastChange: null }],
    })),
    countWorkspaceVersionChanges: vi.fn(() => answer("counts", { count: 2 })),
    countWorkspaceVersionConflicts: vi.fn(() => answer("conflicts", { versions: [], more: false })),
    // Each refresh finds a newer moment, so the page reads its history again.
    listEngineMoments: vi.fn(async () => ({
      moments: [], nextCursor: null, latestMomentOrder: (moment += 1), activeVersionId: "main", ...historyPageFields,
    })),
  });
  vi.stubGlobal("dohcDesktop", bridge);
  const view = (workspace: Workspace) => (
    <>
      <CollectionFieldWriteHost />
      <DesktopWorkspaceShell
        key={workspace.workspaceId}
        workspace={workspace}
        workspaces={[WORKSPACE, OTHER_WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
      />
    </>
  );
  const rendered = render(view(WORKSPACE));
  return {
    bridge,
    plan,
    held,
    calls,
    // As DesktopRoot switches: the shell remounts for the other workspace.
    switchTo: (workspace: Workspace) => rendered.rerender(view(workspace)),
  };
}

const READ_WORDS = /dohc could not (read when each version|count the files|read which merges|finish loading Versions)/;

// Each toast for a Versions read: its whole text and its buttons.
function toasts() {
  return screen.queryAllByTestId("workspace-shell-error")
    .filter((toast) => READ_WORDS.test(toast.textContent ?? ""))
    .map((toast) => ({
      text: toast.textContent,
      buttons: within(toast).queryAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent),
    }));
}

// Each Notices row for a Versions read: its text, its buttons, and its unread mark.
async function rows(user: ReturnType<typeof userEvent.setup>) {
  if (screen.queryByTestId("notice-center") === null) await user.click(screen.getByTestId("notice-center-toggle"));
  const panel = await screen.findByTestId("notice-center");
  const found = [...panel.querySelectorAll<HTMLElement>("[data-testid^='notice-shell-error-']")]
    .filter((row) => /^notice-shell-error-\d+$/.test(row.dataset.testid ?? "") && READ_WORDS.test(row.textContent ?? ""))
    .map((row) => ({
      text: row.textContent,
      buttons: within(row).queryAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent),
      unread: within(row).queryByTestId(`${row.dataset.testid}-unread`) !== null,
    }));
  await user.click(screen.getByTestId("notice-center-toggle"));
  await waitFor(() => expect(screen.queryByTestId("notice-center")).toBeNull());
  return found;
}

async function opened() {
  await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
  await screen.findByTestId("versions-page");
}

// Waits for the page to ask for these reads, then for what it was told.
async function settled(shell: ReturnType<typeof versionsShell>, counts: Partial<Record<Read, number>>) {
  await waitFor(() => {
    for (const [read, count] of Object.entries(counts)) expect(shell.calls[read as Read]).toBe(count);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

// History grows, so the page reads when each version last changed and its
// counts again. Merges to decide do not follow history.
async function historyGrows(shell: ReturnType<typeof versionsShell>) {
  const lastChanges = shell.calls.lastChanges + 1;
  act(() => shell.bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId }));
  await settled(shell, { lastChanges });
}

async function look(user: ReturnType<typeof userEvent.setup>) {
  return { toasts: toasts(), rows: await rows(user) };
}

function toast(): HTMLElement {
  const [found] = screen.getAllByTestId("workspace-shell-error").filter((shown) => READ_WORDS.test(shown.textContent ?? ""));
  return found!;
}

async function versionsRow(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  if (screen.queryByTestId("notice-center") === null) await user.click(screen.getByTestId("notice-center-toggle"));
  const panel = await screen.findByTestId("notice-center");
  return [...panel.querySelectorAll<HTMLElement>("[data-testid^='notice-shell-error-']")]
    .find((row) => /^notice-shell-error-\d+$/.test(row.dataset.testid ?? "") && READ_WORDS.test(row.textContent ?? ""))!;
}

describe("the Versions page's read notices, as a person sees them", () => {
  it("fail", async () => {
    const shell = versionsShell();
    shell.plan.lastChanges.push("fail");
    const user = userEvent.setup();
    await opened();
    await settled(shell, { lastChanges: 1, conflicts: 1, counts: 1 });
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [
          {
            "buttons": [
              "Dismiss notice",
              "Try again",
              "Details",
            ],
            "text": "Unreaddohc could not read when each version last changed. last changes brokenowTry againDetails",
            "unread": true,
          },
        ],
        "toasts": [
          {
            "buttons": [
              "Try again",
              "Details",
              "Dismiss workspace error",
            ],
            "text": "dohc could not read when each version last changed. last changes brokeTry againDetails",
          },
        ],
      }
    `);
  });

  it("fail twice with the same cause", async () => {
    const shell = versionsShell();
    shell.plan.lastChanges.push("fail", "fail");
    const user = userEvent.setup();
    await opened();
    await settled(shell, { lastChanges: 1, conflicts: 1, counts: 1 });
    const first = toast();
    await historyGrows(shell);
    expect(toast()).toBe(first);
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [
          {
            "buttons": [
              "Dismiss notice",
              "Try again",
              "Details",
            ],
            "text": "Unreaddohc could not read when each version last changed. last changes brokenowTry againDetails",
            "unread": true,
          },
        ],
        "toasts": [
          {
            "buttons": [
              "Try again",
              "Details",
              "Dismiss workspace error",
            ],
            "text": "dohc could not read when each version last changed. last changes brokeTry againDetails",
          },
        ],
      }
    `);
  });

  it("fail, close the toast, dismiss the row, fail again", async () => {
    const shell = versionsShell();
    shell.plan.lastChanges.push("fail", "fail", "fail");
    const user = userEvent.setup();
    await opened();
    await settled(shell, { lastChanges: 1, conflicts: 1, counts: 1 });
    await user.click(within(toast()).getByRole("button", { name: "Dismiss workspace error" }));
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [
          {
            "buttons": [
              "Dismiss notice",
              "Try again",
              "Details",
            ],
            "text": "Unreaddohc could not read when each version last changed. last changes brokenowTry againDetails",
            "unread": true,
          },
        ],
        "toasts": [],
      }
    `);
    await user.click(within(await versionsRow(user)).getByRole("button", { name: "Dismiss notice" }));
    await user.click(screen.getByTestId("notice-center-toggle"));
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [],
        "toasts": [],
      }
    `);
    // The same read failing again, with nothing new failed, files a new row.
    await historyGrows(shell);
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [
          {
            "buttons": [
              "Dismiss notice",
              "Try again",
              "Details",
            ],
            "text": "Unreaddohc could not read when each version last changed. last changes brokenowTry againDetails",
            "unread": true,
          },
        ],
        "toasts": [
          {
            "buttons": [
              "Try again",
              "Details",
              "Dismiss workspace error",
            ],
            "text": "dohc could not read when each version last changed. last changes brokeTry againDetails",
          },
        ],
      }
    `);
  });

  it("fail, dismiss, then a read that works and one that fails again", async () => {
    const shell = versionsShell();
    shell.plan.lastChanges.push("fail", "ok", "fail");
    const user = userEvent.setup();
    await opened();
    await settled(shell, { lastChanges: 1, conflicts: 1, counts: 1 });
    await user.click(within(await versionsRow(user)).getByRole("button", { name: "Dismiss notice" }));
    await user.click(screen.getByTestId("notice-center-toggle"));
    await historyGrows(shell);
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [],
        "toasts": [],
      }
    `);
    await historyGrows(shell);
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [
          {
            "buttons": [
              "Dismiss notice",
              "Try again",
              "Details",
            ],
            "text": "Unreaddohc could not read when each version last changed. last changes brokenowTry againDetails",
            "unread": true,
          },
        ],
        "toasts": [
          {
            "buttons": [
              "Try again",
              "Details",
              "Dismiss workspace error",
            ],
            "text": "dohc could not read when each version last changed. last changes brokeTry againDetails",
          },
        ],
      }
    `);
  });

  it("fail then succeed", async () => {
    const shell = versionsShell();
    shell.plan.lastChanges.push("fail");
    const user = userEvent.setup();
    await opened();
    await settled(shell, { lastChanges: 1, conflicts: 1, counts: 1 });
    await historyGrows(shell);
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [],
        "toasts": [],
      }
    `);
  });

  it("fail, Try again fails", async () => {
    const shell = versionsShell();
    shell.plan.lastChanges.push("fail", "fail");
    const user = userEvent.setup();
    await opened();
    await settled(shell, { lastChanges: 1, conflicts: 1, counts: 1 });
    await user.click(within(toast()).getByRole("button", { name: "Try again" }));
    await settled(shell, { lastChanges: 2, conflicts: 1 });
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [
          {
            "buttons": [
              "Dismiss notice",
              "Try again",
              "Details",
            ],
            "text": "Unreaddohc could not read when each version last changed. last changes brokenowTry againDetails",
            "unread": true,
          },
        ],
        "toasts": [
          {
            "buttons": [
              "Try again",
              "Details",
              "Dismiss workspace error",
            ],
            "text": "dohc could not read when each version last changed. last changes brokeTry againDetails",
          },
        ],
      }
    `);
  });

  it("fail, Try again succeeds", async () => {
    const shell = versionsShell();
    shell.plan.lastChanges.push("fail");
    const user = userEvent.setup();
    await opened();
    await settled(shell, { lastChanges: 1, conflicts: 1, counts: 1 });
    await user.click(within(toast()).getByRole("button", { name: "Try again" }));
    await settled(shell, { lastChanges: 2, conflicts: 1 });
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [],
        "toasts": [],
      }
    `);
  });

  it("two different causes", async () => {
    const shell = versionsShell();
    shell.plan.lastChanges.push("fail");
    shell.plan.conflicts.push("fail");
    const user = userEvent.setup();
    await opened();
    await settled(shell, { lastChanges: 1, conflicts: 1, counts: 1 });
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [
          {
            "buttons": [
              "Dismiss notice",
              "Try again",
              "Details",
            ],
            "text": "Unreaddohc could not finish loading Versions. last changes brokenowTry againDetails",
            "unread": true,
          },
        ],
        "toasts": [
          {
            "buttons": [
              "Try again",
              "Details",
              "Dismiss workspace error",
            ],
            "text": "dohc could not finish loading Versions. last changes brokeTry againDetails",
          },
        ],
      }
    `);
    // One read works again; the row keeps saying more than one failed.
    await historyGrows(shell);
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [
          {
            "buttons": [
              "Dismiss notice",
              "Try again",
              "Details",
            ],
            "text": "Unreaddohc could not finish loading Versions. last changes brokenowTry againDetails",
            "unread": true,
          },
        ],
        "toasts": [
          {
            "buttons": [
              "Try again",
              "Details",
              "Dismiss workspace error",
            ],
            "text": "dohc could not finish loading Versions. last changes brokeTry againDetails",
          },
        ],
      }
    `);
    await user.click(within(toast()).getByRole("button", { name: "Try again" }));
    await settled(shell, { conflicts: 2 });
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [],
        "toasts": [],
      }
    `);
  });

  it("one count fails alone, then with another read", async () => {
    const shell = versionsShell();
    shell.plan.counts.push("fail", "fail");
    shell.plan.lastChanges.push("ok", "fail");
    const user = userEvent.setup();
    await opened();
    await settled(shell, { lastChanges: 1, conflicts: 1, counts: 1 });
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [
          {
            "buttons": [
              "Dismiss notice",
              "Try again",
              "Details",
            ],
            "text": "Unreaddohc could not count the files that differ from Main. count brokenowTry againDetails",
            "unread": true,
          },
        ],
        "toasts": [
          {
            "buttons": [
              "Try again",
              "Details",
              "Dismiss workspace error",
            ],
            "text": "dohc could not count the files that differ from Main. count brokeTry againDetails",
          },
        ],
      }
    `);
    // A second read fails, and the row changes where it stands.
    await historyGrows(shell);
    await settled(shell, { counts: 2 });
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [
          {
            "buttons": [
              "Dismiss notice",
              "Try again",
              "Details",
            ],
            "text": "Unreaddohc could not finish loading Versions. count brokenowTry againDetails",
            "unread": true,
          },
        ],
        "toasts": [
          {
            "buttons": [
              "Try again",
              "Details",
              "Dismiss workspace error",
            ],
            "text": "dohc could not finish loading Versions. count brokeTry againDetails",
          },
        ],
      }
    `);
    await user.click(within(toast()).getByRole("button", { name: "Try again" }));
    await settled(shell, { lastChanges: 3, counts: 3 });
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [],
        "toasts": [],
      }
    `);
  });

  it("a failure after the view unmounts", async () => {
    const shell = versionsShell();
    shell.plan.lastChanges.push("fail");
    shell.plan.conflicts.push("hold");
    const user = userEvent.setup();
    await opened();
    await settled(shell, { lastChanges: 1, conflicts: 1, counts: 1 });
    // A read still running holds the first row back.
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [],
        "toasts": [],
      }
    `);
    await user.click(within(screen.getByTestId("editor-group-primary")).getByRole("button", { name: "Close Versions" }));
    await waitFor(() => expect(screen.queryByTestId("versions-page")).toBeNull());
    await act(async () => {
      shell.held.conflicts[0]!.reject(new Error(BROKE.conflicts));
      await shell.held.conflicts[0]!.promise.catch(() => undefined);
    });
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [],
        "toasts": [],
      }
    `);
  });

  it("a filed row goes when its view unmounts", async () => {
    const shell = versionsShell();
    shell.plan.lastChanges.push("fail");
    const user = userEvent.setup();
    await opened();
    await settled(shell, { lastChanges: 1, conflicts: 1, counts: 1 });
    await user.click(within(screen.getByTestId("editor-group-primary")).getByRole("button", { name: "Close Versions" }));
    await waitFor(() => expect(screen.queryByTestId("versions-page")).toBeNull());
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [],
        "toasts": [],
      }
    `);
  });

  it("a failure during a workspace switch", async () => {
    const shell = versionsShell();
    shell.plan.lastChanges.push("fail");
    shell.plan.conflicts.push("hold");
    const user = userEvent.setup();
    await opened();
    await settled(shell, { lastChanges: 1, conflicts: 1, counts: 1 });
    shell.plan.lastChanges.push("hold");
    shell.plan.conflicts.push("hold");
    shell.switchTo(OTHER_WORKSPACE);
    await opened();
    await act(async () => {
      shell.held.conflicts[0]!.reject(new Error(BROKE.conflicts));
      await shell.held.conflicts[0]!.promise.catch(() => undefined);
    });
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [],
        "toasts": [],
      }
    `);
  });

  it("mark read fails", async () => {
    const shell = versionsShell();
    // Main would refuse to save a read. A read of this row is this window's own.
    const markNotices = vi.fn(async () => { throw new Error("could not save the read"); });
    Object.assign(shell.bridge, { markNotices });
    shell.plan.lastChanges.push("fail", "fail", "fail");
    const user = userEvent.setup();
    await opened();
    await settled(shell, { lastChanges: 1, conflicts: 1, counts: 1 });
    await user.hover(await versionsRow(user));
    await user.click(screen.getByTestId("notice-center-toggle"));
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [
          {
            "buttons": [
              "Dismiss notice",
              "Try again",
              "Details",
            ],
            "text": "dohc could not read when each version last changed. last changes brokenowTry againDetails",
            "unread": false,
          },
        ],
        "toasts": [],
      }
    `);
    expect(markNotices).not.toHaveBeenCalled();
    // The same failure again keeps the row read; new words make it unread.
    await historyGrows(shell);
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [
          {
            "buttons": [
              "Dismiss notice",
              "Try again",
              "Details",
            ],
            "text": "dohc could not read when each version last changed. last changes brokenowTry againDetails",
            "unread": false,
          },
        ],
        "toasts": [],
      }
    `);
    shell.plan.counts.push("fail");
    await historyGrows(shell);
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [
          {
            "buttons": [
              "Dismiss notice",
              "Try again",
              "Details",
            ],
            "text": "Unreaddohc could not finish loading Versions. last changes brokenowTry againDetails",
            "unread": true,
          },
        ],
        "toasts": [],
      }
    `);
  });

  it("Try again after the row changed reads every failed read", async () => {
    const shell = versionsShell();
    shell.plan.lastChanges.push("fail", "fail");
    const user = userEvent.setup();
    await opened();
    await settled(shell, { lastChanges: 1, conflicts: 1, counts: 1 });
    shell.plan.counts.push("fail");
    await historyGrows(shell);
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [
          {
            "buttons": [
              "Dismiss notice",
              "Try again",
              "Details",
            ],
            "text": "Unreaddohc could not finish loading Versions. last changes brokenowTry againDetails",
            "unread": true,
          },
        ],
        "toasts": [
          {
            "buttons": [
              "Try again",
              "Details",
              "Dismiss workspace error",
            ],
            "text": "dohc could not finish loading Versions. last changes brokeTry againDetails",
          },
        ],
      }
    `);
    await user.click(within(toast()).getByRole("button", { name: "Try again" }));
    await settled(shell, { lastChanges: 3, counts: 3, conflicts: 1 });
    expect(await look(user)).toMatchInlineSnapshot(`
      {
        "rows": [],
        "toasts": [],
      }
    `);
  });
});
