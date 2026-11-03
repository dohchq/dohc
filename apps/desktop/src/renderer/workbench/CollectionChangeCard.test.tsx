// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessageRecord } from "../../ipc/bridgeContract";
import { DATASET_SERVER_NOT_FOUND, ipcWireError } from "../../ipc/errorWords";
import { ask, proposalPath, world, type World } from "../collections/collectionChangeFlow.testHarness";
import { formatClock } from "../time";
import { CollectionChangeCard } from "./CollectionChangeCard";

const message: ChatMessageRecord = { id: "message-1", threadId: "thread-1", presentation: { group: "agent", hue: null, self: false },
  authorKind: "agent", authorDisplayName: "Claude Code", body: "Here's the due date you asked for.", createdAtMs: 3_000 };
const onReply = vi.fn(async (_input: { body: string; resolves: boolean }) => undefined);
const onError = vi.fn();
let place: World;

beforeEach(() => {
  place = world();
  vi.stubGlobal("dohcDesktop", place.api);
  localStorage.clear();
  onReply.mockClear();
  onError.mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const card = () => render(<CollectionChangeCard workspaceId="w" message={message} path={proposalPath} locked={false}
  onReply={onReply} onError={onError} testIdPrefix="lane" />);
const row = (text: string) => screen.getByText(text).closest("li")!;

it("shows a collaborator's unapplied edit as its own row with its author", async () => {
  ask(place); card();
  await screen.findByTestId("lane-change-card");
  expect(within(row("Makes Email unique")).getByText(`Ice · ${formatClock(1_000)}`)).toBeTruthy();
  // Rows the message's author made name nobody.
  expect(within(row("Adds the field Due date")).queryByText(/Claude Code/u)).toBeNull();
  expect(screen.getByText("History can't undo this change.")).toBeTruthy();
});

it("applies the rows it showed and answers the message as the person who clicked", async () => {
  const proposal = ask(place); card();
  const apply = await screen.findByTestId("lane-change-apply");
  expect(apply.textContent).toBe("Apply and delete 12 values");
  // Someone with write access hides the deletion in the attached file after the card loaded.
  place.files[proposalPath] = JSON.stringify({ ...proposal, rows: proposal.rows.filter(entry => entry.kind !== "field-removed") });
  fireEvent.click(apply);
  await waitFor(() => expect(onReply).toHaveBeenCalledWith({ body: "Applied the change to Volunteers.", resolves: true }));
  expect(place.head().revisionSha256).toBe(proposal.revisionSha256);
  expect(onError).not.toHaveBeenCalled();
});

it("names the server when it refuses the change, with no Try again", async () => {
  ask(place);
  const refused = Object.assign(new Error("That share isn't available anymore."), { code: DATASET_SERVER_NOT_FOUND });
  place.control.refuse = new Error(`Error invoking remote method 'desktop:dataset': ${String(ipcWireError(refused))}`);
  card();
  fireEvent.click(await screen.findByTestId("lane-change-apply"));
  const failed = await screen.findByTestId("lane-change-failed");
  expect(failed.textContent).toBe("The server that keeps Volunteers refused this change. Nothing changed. Ask its owner to apply it.");
  expect(screen.queryByTestId("lane-change-apply")).toBeNull();
  expect(screen.getByTestId("lane-change-not-now-button")).toBeTruthy();
  expect(screen.getByTestId("lane-change-review")).toBeTruthy();
  expect(onReply).not.toHaveBeenCalled();
});

it("reviews the change the files make now and applies that preparation", async () => {
  ask(place); card();
  fireEvent.click(await screen.findByTestId("lane-change-review"));
  const dialog = await screen.findByTestId("lane-change-review-dialog");
  await waitFor(() => expect(within(dialog).getAllByTestId("lane-change-review-row")).toHaveLength(4));
  expect(within(dialog).getByText("Change to Volunteers · 2 files")).toBeTruthy();
  fireEvent.click(within(within(dialog).getByText("Runs a migration on the 12 existing records").closest("li")!).getByRole("button"));
  expect(within(dialog).getByTestId("lane-change-review-diff").textContent).toContain("ALTER TABLE volunteers ADD COLUMN due TEXT;");
  fireEvent.click(within(dialog).getByTestId("lane-change-review-apply"));
  await waitFor(() => expect(screen.queryByTestId("lane-change-review-dialog")).toBeNull());
  expect(onReply).toHaveBeenCalledWith({ body: "Applied the change to Volunteers.", resolves: true });
  expect(place.actions().filter(action => action !== "describe" && action !== "historyRevision"))
    .toEqual(["prepareMigration", "approveMigration"]);
});

it("discards the review's preparation when Not now closes it, and folds the card on this device", async () => {
  ask(place); card();
  fireEvent.click(await screen.findByTestId("lane-change-review"));
  const dialog = await screen.findByTestId("lane-change-review-dialog");
  await waitFor(() => expect(within(dialog).getAllByTestId("lane-change-review-row")).toHaveLength(4));
  fireEvent.click(within(dialog).getByTestId("lane-change-review-not-now"));
  await waitFor(() => expect(place.actions()).toContain("discardMigration"));
  expect(screen.getByTestId("lane-change-not-now").textContent).toBe("Waiting· Change to Volunteers");
  expect(onReply).not.toHaveBeenCalled();
});
