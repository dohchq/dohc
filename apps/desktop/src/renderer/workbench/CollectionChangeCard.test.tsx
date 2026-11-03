// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessageRecord } from "../../ipc/bridgeContract";
import { DATASET_SERVER_NOT_FOUND, ipcWireError } from "../../ipc/errorWords";
import { COLLECTION_CHANGE_FILE } from "../collections/collectionChangeFlow";
import { ask, proposalPath, volunteers, world, type World } from "../collections/collectionChangeFlow.testHarness";
import { formatClock } from "../time";
import { CollectionChangeCard } from "./CollectionChangeCard";

const posted: ChatMessageRecord = { id: "message-1", threadId: "thread-1", presentation: { group: "agent", hue: null, self: false },
  authorKind: "agent", authorDisplayName: "Claude Code", body: "Here's the due date you asked for.", createdAtMs: 3_000 };
const onReply = vi.fn(async (_input: { body: string; resolves: boolean; attach?: string }) => undefined);
const onError = vi.fn();
let place: World;
// Cards remember what they showed for the session, so each test posts its own message.
let message = posted, posts = 0;

beforeEach(() => {
  place = world();
  message = { ...posted, id: `message-${++posts}` };
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

it("draws its frame and heading from the attached file, with one quiet line until the rows arrive", async () => {
  ask(place);
  let open!: () => void;
  const history = new Promise<void>(resolve => { open = resolve; });
  const list = place.api.listFileChats;
  vi.spyOn(place.api, "listFileChats").mockImplementation(async input => { await history; return list(input); });
  card();
  const loading = await screen.findByTestId("lane-change-loading");
  expect(loading.textContent).toContain("Change to Volunteers");
  expect(within(loading).getByRole("status").textContent).toBe("Loading the change to Volunteers");
  expect(within(loading).queryByRole("button", { name: "Try again" })).toBeNull();
  open();
  await screen.findByTestId("lane-change-card");
  expect(screen.queryByTestId("lane-change-loading")).toBeNull();
  expect(screen.getAllByRole("listitem")).toHaveLength(4);
});

it("keeps its frame when the Collection can't be read, and offers Try again there", async () => {
  ask(place);
  vi.mocked(place.api.dataset).mockRejectedValueOnce(new Error("dohc couldn't open Volunteers."));
  card();
  const failed = await screen.findByTestId("lane-change-load-failed");
  expect(screen.getByTestId("lane-change-loading").textContent).toContain("Change to Volunteers");
  expect(failed.textContent).toContain("dohc couldn't open Volunteers.");
  fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
  await screen.findByTestId("lane-change-card");
});

it("draws in full at once when the chat list shows it again", async () => {
  ask(place);
  const first = card();
  await screen.findByTestId("lane-change-card");
  first.unmount();
  card();
  expect(screen.getByTestId("lane-change-card")).toBeTruthy();
  expect(screen.queryByTestId("lane-change-loading")).toBeNull();
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

it("applies the change after records came, and its reply attaches the change as it applied it", async () => {
  ask(place); card();
  const apply = await screen.findByTestId("lane-change-apply");
  // A volunteer signed up without a note.
  place.recount(13, 12);
  fireEvent.click(apply);
  await waitFor(() => expect(onReply).toHaveBeenCalledWith({ body: "Applied the change to Volunteers.", resolves: true, attach: expect.stringMatching(COLLECTION_CHANGE_FILE) }));
  const { attach } = onReply.mock.calls[0]![0] as { attach: string };
  expect(attach).not.toBe(proposalPath);
  expect(JSON.parse(place.files[attach]!).rows).toContainEqual(expect.objectContaining({ kind: "migration", records: 13 }));
  expect(onError).not.toHaveBeenCalled();
});

it("applies nothing when records changed so that the change deletes more, and points to the review", async () => {
  const proposal = ask(place); card();
  const apply = await screen.findByTestId("lane-change-apply");
  place.recount(13);
  fireEvent.click(apply);
  const failed = await screen.findByTestId("lane-change-failed");
  expect(failed.textContent).toBe("Records changed after it was sent, and it now deletes more. Review the change to apply it.");
  expect(screen.queryByTestId("lane-change-apply")).toBeNull();
  expect(screen.getByTestId("lane-change-review")).toBeTruthy();
  expect(place.head().revisionSha256).not.toBe(proposal.revisionSha256);
  expect(onReply).not.toHaveBeenCalled();
});

it("offers Try again for an Applied reply that didn't post, which posts it", async () => {
  ask(place); card();
  onReply.mockRejectedValueOnce(new Error("dohc couldn't send that message."));
  fireEvent.click(await screen.findByTestId("lane-change-apply"));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("dohc couldn't send that message.", expect.any(Error), expect.any(Function)));
  (onError.mock.calls[0]![2] as () => void)();
  await waitFor(() => expect(onReply).toHaveBeenCalledTimes(2));
  expect(onReply).toHaveBeenLastCalledWith({ body: "Applied the change to Volunteers.", resolves: true });
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

it("lists a changed file that other rows stand for, with who changed it and its changes", async () => {
  ask(place);
  // Ada edits the schema after the message. On the card, the field rows stand for that file.
  const schemaSql = "CREATE TABLE volunteers (id TEXT PRIMARY KEY, due TEXT);";
  place.files[volunteers.schemaPath] = schemaSql;
  place.moments.push(place.moment(5, volunteers.schemaPath, 4_000, { personAuthorName: "Ada" }, schemaSql));
  card();
  fireEvent.click(await screen.findByTestId("lane-change-review-button"));
  const dialog = await screen.findByTestId("lane-change-review-dialog");
  const schema = (await within(dialog).findByText("Changes the schema")).closest("li")!;
  expect(within(schema).getByText("Ada")).toBeTruthy();
  fireEvent.click(within(schema).getByRole("button"));
  expect(within(schema).getByTestId("lane-change-review-diff").textContent).toContain("due TEXT");
});

it("prepares the change again after a failed Apply, so Try again applies the review it shows", async () => {
  ask(place); card();
  fireEvent.click(await screen.findByTestId("lane-change-review"));
  const dialog = await screen.findByTestId("lane-change-review-dialog");
  await waitFor(() => expect(within(dialog).getAllByTestId("lane-change-review-row")).toHaveLength(4));
  place.control.refuse = new Error("dohc lost its connection to the engine.");
  fireEvent.click(within(dialog).getByTestId("lane-change-review-apply"));
  expect((await within(dialog).findByTestId("lane-change-review-failed")).textContent).toContain("dohc lost its connection to the engine.");
  await waitFor(() => expect(place.actions().filter(action => action === "prepareMigration")).toHaveLength(2));
  const retry = within(dialog).getByTestId("lane-change-review-apply");
  await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
  expect(retry.textContent).toBe("Try again");
  fireEvent.click(retry);
  await waitFor(() => expect(screen.queryByTestId("lane-change-review-dialog")).toBeNull());
  expect(onReply).toHaveBeenCalledWith({ body: "Applied the change to Volunteers.", resolves: true });
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
