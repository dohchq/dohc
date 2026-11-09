// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatChannelShareGrantRow } from "../../ipc/bridgeContract";
import { ChatMembersDialog } from "./ChatMembersDialog";
import { splitAddresses, suggestPeople } from "./memberPicker";

const member = (email: string, access: "read-write" | "read-only" = "read-write"): ChatChannelShareGrantRow => ({
  shareId: `share-${email}`,
  channelWireId: "wire-team",
  access,
  recipientEmail: email,
  revokedAtMs: null,
});

function dialog(options: {
  members?: ChatChannelShareGrantRow[];
  known?: string[];
  onAdd?: (input: { email: string; viewOnly: boolean }) => Promise<boolean>;
  onClose?: () => void;
} = {}) {
  const onAdd = vi.fn(options.onAdd ?? (async () => true));
  const onClose = vi.fn(options.onClose ?? (() => {}));
  render(
    <ChatMembersDialog
      groupName="team"
      members={options.members ?? []}
      knownPeople={options.known ?? ["ana@example.com", "ben@example.com", "cy@example.org"]}
      readFailure={null}
      blocked={false}
      onAdd={onAdd}
      onRemove={vi.fn()}
      onRetryRead={vi.fn()}
      onClose={onClose}
    />,
  );
  return { onAdd, onClose };
}

const field = () => screen.getByTestId("chats-share-email") as HTMLInputElement;
const chips = () => screen.queryAllByTestId("chats-share-chip").map((chip) => chip.textContent);

describe("ChatMembersDialog", () => {
  afterEach(cleanup);

  it("opens an empty group on Add people, and a group with members on its list", () => {
    dialog();
    expect(screen.getByTestId("chats-share-panel").dataset.view).toBe("add");
    expect(document.activeElement).toBe(field());
    cleanup();

    dialog({ members: [member("ana@example.com"), member("ben@example.com", "read-only")] });
    expect(screen.getByTestId("chats-share-panel").dataset.view).toBe("members");
    expect(document.activeElement).toBe(screen.getByTestId("chats-share-search"));
    const rows = screen.getAllByTestId("chats-share-member");
    expect(rows.map((row) => row.textContent)).toEqual(["Aana@example.comRemove", "Bben@example.comView onlyRemove"]);
  });

  it("finds members by search", async () => {
    dialog({ members: [member("ana@example.com"), member("ben@example.com")] });
    await userEvent.type(screen.getByTestId("chats-share-search"), "be");
    expect(screen.getAllByTestId("chats-share-member").map((row) => row.textContent)).toEqual(["Bben@example.comRemove"]);
    expect(screen.queryByTestId("chats-share-add-people")).toBeNull();
    await userEvent.type(screen.getByTestId("chats-share-search"), "x");
    expect(screen.getByTestId("chats-share-search-empty").textContent).toBe('No members match "bex".');
  });

  it("suggests people this account knows, marks members, and picks with the keyboard", async () => {
    dialog({ members: [member("ana@example.com")] });
    await userEvent.click(screen.getByTestId("chats-share-add-people"));
    await userEvent.type(field(), "example");
    const options = screen.getAllByTestId("chats-share-suggestion");
    expect(options.map((option) => option.textContent)).toEqual(["Bben@example.com", "Ccy@example.org", "Aana@example.comAlready a member"]);
    expect(options[2]!.getAttribute("aria-disabled")).toBe("true");
    expect(field().getAttribute("aria-activedescendant")).toBe(options[0]!.id);

    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(chips()).toEqual(["Ccy@example.org"]);
    expect(field().value).toBe("");
    expect(screen.queryByTestId("chats-share-suggestions")).toBeNull();

    // A click picks too, and a picked person leaves the suggestions.
    await userEvent.type(field(), "b");
    expect(screen.getAllByTestId("chats-share-suggestion").map((option) => option.textContent)).toEqual(["Bben@example.com"]);
    fireEvent.mouseDown(screen.getByTestId("chats-share-suggestion"));
    expect(chips()).toEqual(["Ccy@example.org", "Bben@example.com"]);

    // Backspace in the empty field takes the last chip back.
    await userEvent.keyboard("{Backspace}");
    expect(chips()).toEqual(["Ccy@example.org"]);
  });

  it("turns a typed or pasted address into a chip, and says why when it cannot", async () => {
    dialog({ members: [member("ana@example.com")] });
    await userEvent.click(screen.getByTestId("chats-share-add-people"));
    await userEvent.type(field(), "dee@example.net,");
    expect(chips()).toEqual(["Ddee@example.net"]);

    await userEvent.click(field());
    await userEvent.paste("Eve Stone <eve@example.net>; fay@example.net");
    expect(chips()).toEqual(["Ddee@example.net", "Eeve@example.net", "Ffay@example.net"]);

    await userEvent.type(field(), "ANA@example.com{Enter}");
    expect(screen.getByTestId("chats-share-error").textContent).toBe("ana@example.com is already a member.");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    await userEvent.clear(field());
    expect(screen.queryByTestId("chats-share-error")).toBeNull();

    await userEvent.type(field(), "gus{Enter}");
    expect(screen.getByTestId("chats-share-error").textContent).toBe("Enter a full email address, like name@example.com.");
  });

  it("adds everyone picked with the chosen access, then shows them on the list", async () => {
    const { onAdd } = dialog({ members: [member("ana@example.com")] });
    await userEvent.click(screen.getByTestId("chats-share-add-people"));
    await userEvent.type(field(), "ben{Enter}");
    await userEvent.type(field(), "new@example.net");
    await userEvent.click(screen.getByTestId("chats-share-readonly"));
    await userEvent.click(screen.getByTestId("chats-share-submit"));
    expect(onAdd.mock.calls.map(([input]) => input)).toEqual([
      { email: "ben@example.com", viewOnly: true },
      { email: "new@example.net", viewOnly: true },
    ]);
    await waitFor(() => expect(screen.getByTestId("chats-share-panel").dataset.view).toBe("members"));
    expect(screen.getAllByTestId("chats-share-member").map((row) => row.textContent)).toEqual([
      "Aana@example.comRemove",
      "Bben@example.comView only",
      "Nnew@example.netView only",
    ]);
  });

  it("treats someone just added as a member before the list reloads", async () => {
    dialog({ members: [member("ana@example.com")] });
    await userEvent.click(screen.getByTestId("chats-share-add-people"));
    await userEvent.type(field(), "ben{Enter}{Enter}");
    await waitFor(() => expect(screen.getByTestId("chats-share-panel").dataset.view).toBe("members"));
    await userEvent.click(screen.getByTestId("chats-share-add-people"));
    await userEvent.type(field(), "ben");
    expect(screen.getAllByTestId("chats-share-suggestion").map((option) => option.textContent)).toEqual([
      "Bben@example.comAlready a member",
    ]);
  });

  it("picks no one from a paste while Add runs", async () => {
    let finish = (_added: boolean) => {};
    dialog({ onAdd: () => new Promise<boolean>((resolve) => { finish = resolve; }) });
    await userEvent.type(field(), "ana{Enter}");
    await userEvent.click(screen.getByTestId("chats-share-submit"));
    expect(screen.getByTestId("chats-share-submit").textContent).toBe("Adding…");
    fireEvent.paste(field(), { clipboardData: { getData: () => "ben@example.com cy@example.org" } });
    expect(chips()).toEqual(["Aana@example.com"]);
    finish(false);
    await waitFor(() => expect(screen.getByTestId("chats-share-submit").textContent).toBe("Add"));
    expect(chips()).toEqual(["Aana@example.com"]);
  });

  it("keeps Back put while Add runs", async () => {
    let finish = (_added: boolean) => {};
    dialog({ members: [member("ana@example.com")], onAdd: () => new Promise<boolean>((resolve) => { finish = resolve; }) });
    await userEvent.click(screen.getByTestId("chats-share-add-people"));
    await userEvent.type(field(), "ben{Enter}{Enter}");
    expect((screen.getByTestId("chats-share-back") as HTMLButtonElement).disabled).toBe(true);
    finish(true);
    await waitFor(() => expect(screen.getByTestId("chats-share-panel").dataset.view).toBe("members"));
    await userEvent.click(screen.getByTestId("chats-share-add-people"));
    expect((screen.getByTestId("chats-share-back") as HTMLButtonElement).disabled).toBe(false);
  });

  it("lets a paste replace the selected text", async () => {
    dialog();
    await userEvent.type(field(), "ana@example.com");
    field().setSelectionRange(0, field().value.length);
    fireEvent.paste(field(), { clipboardData: { getData: () => "ben@example.com, cy@example.org" } });
    expect(chips()).toEqual(["Bben@example.com", "Ccy@example.org"]);
    expect(field().value).toBe("");
  });

  it("puts focus back in the field when Add fails", async () => {
    dialog({ onAdd: async () => false });
    await userEvent.type(field(), "new@example.net");
    await userEvent.click(screen.getByTestId("chats-share-submit"));
    await waitFor(() => expect(chips()).toEqual(["Nnew@example.net"]));
    expect(document.activeElement).toBe(field());
  });

  it("keeps whoever was not added picked when one add fails", async () => {
    const { onAdd } = dialog({ onAdd: async ({ email }) => email !== "ben@example.com" });
    await userEvent.type(field(), "ana{Enter}ben{Enter}cy{Enter}");
    expect(chips()).toEqual(["Aana@example.com", "Bben@example.com", "Ccy@example.org"]);
    await userEvent.keyboard("{Enter}");
    // Ana went in; Ben failed and reported it; Cy waits with him.
    await waitFor(() => expect(chips()).toEqual(["Bben@example.com", "Ccy@example.org"]));
    expect(onAdd.mock.calls.map(([input]) => input.email)).toEqual(["ana@example.com", "ben@example.com"]);
    expect(screen.getByTestId("chats-share-panel").dataset.view).toBe("add");
    expect(document.activeElement).toBe(field());
    await userEvent.click(screen.getByTestId("chats-share-back"));
    expect(screen.getAllByTestId("chats-share-member").map((row) => row.textContent)).toEqual(["Aana@example.com"]);
  });

  it("asks for an address when Add has nothing to add", async () => {
    const { onAdd } = dialog();
    await userEvent.click(screen.getByTestId("chats-share-submit"));
    expect(screen.getByTestId("chats-share-error").textContent).toBe("Enter an email address.");
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("closes the suggestions with Escape before it closes the dialog", async () => {
    const { onClose } = dialog();
    await userEvent.type(field(), "a");
    expect(screen.getByTestId("chats-share-suggestions")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("chats-share-suggestions")).toBeNull();
    expect(field().value).toBe("a");
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("goes back to the list from Add people", async () => {
    dialog({ members: [member("ana@example.com")] });
    await userEvent.click(screen.getByTestId("chats-share-add-people"));
    await userEvent.click(screen.getByTestId("chats-share-back"));
    expect(screen.getByTestId("chats-share-panel").dataset.view).toBe("members");
    await userEvent.click(screen.getByTestId("chats-share-add-people"));
    await userEvent.click(screen.getByTestId("chats-share-cancel"));
    expect(screen.getByTestId("chats-share-panel").dataset.view).toBe("members");
  });
});

describe("memberPicker", () => {
  it("splits pasted addresses and keeps what is not one", () => {
    expect(splitAddresses("a@x.co, b@y.co\nAna Silva <ana@z.co>; nope")).toEqual({
      emails: ["a@x.co", "b@y.co", "ana@z.co"],
      rest: "nope",
    });
    expect(splitAddresses("a@x")).toEqual({ emails: [], rest: "a@x" });
    expect(splitAddresses("Ana <ana@x.co> Ben <ben@y.co>")).toEqual({ emails: ["ana@x.co", "ben@y.co"], rest: "" });
    expect(splitAddresses("a@x.co Ben <ben@y.co>").emails.sort()).toEqual(["a@x.co", "ben@y.co"]);
    expect(splitAddresses('"Doe, Jane" <jane@x.co>, bob@y.co')).toEqual({ emails: ["jane@x.co", "bob@y.co"], rest: "" });
  });

  it("offers a new address only when it is a whole email nobody matches", () => {
    const known = ["ana@example.com"];
    const members = new Set<string>();
    const picked = new Set<string>();
    expect(suggestPeople({ known, members, picked, query: "zed@example" })).toEqual([]);
    expect(suggestPeople({ known, members, picked, query: "zed@example.com" })).toEqual([{ email: "zed@example.com", member: false }]);
    expect(suggestPeople({ known, members, picked, query: "ANA@example.com" })).toEqual([{ email: "ana@example.com", member: false }]);
  });
});
