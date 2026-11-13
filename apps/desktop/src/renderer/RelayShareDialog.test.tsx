// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { type RelayShareDiscussionMessage, type RelayShareGrantedRow } from "../ipc/bridgeContract";
import { SYNC_UNCONFIRMED_ACCOUNT } from "./cloudSyncWords";
import { RelayShareDialog as ProductionRelayShareDialog, type RelayShareTarget } from "./RelayShareDialog";
import { ShellErrorReporter, type ReportShellFailure } from "./shell/useShellError";
import type { AccessContext, AccessFacts } from "./workbench/accessReason";

function accessContextFor(cloud: AccessFacts["cloud"]): AccessContext {
  return { facts: { cloud, shareView: false }, openSyncSettings: vi.fn(), connect: vi.fn() };
}
const SYNCED: AccessFacts["cloud"] = { connected: true, workspaceSynced: true, workspaceSyncConnected: true };
const CAN_SHARE = accessContextFor(SYNCED);

// The shell's Access context, for a workspace that can share unless a test
// says otherwise.
type DialogProps = ComponentProps<typeof ProductionRelayShareDialog>;
function RelayShareDialog(
  props: Omit<DialogProps, "accessContext" | "server"> & Partial<Pick<DialogProps, "accessContext" | "server">>,
) {
  return <ProductionRelayShareDialog accessContext={CAN_SHARE} server={null} {...props} />;
}

const SHARE_CODE = "dohc-share:share-1:http://relay.test";
const LINK_URL = "https://relay.test/share/link-secret";
const LINK_URL_A = "https://relay.test/share/link-secret-a";
const LINK_URL_B = "https://relay.test/share/link-secret-b";

type LinkResult = {
  shareId: string;
  grantId: string;
  url: string;
};

type LinkDependent = {
  grantId: string;
  recipientUserId: string | null;
  recipientEmail: string | null;
  access: "view" | "comment" | "edit";
  generation: number;
  createdAtMs: number;
};

type ReadableLink = {
  shareId: string;
  grantId: string;
  generation: number;
  status: "active" | "revoked";
  createdAtMs: number;
  revokedAtMs: number | null;
  lastUsedAtMs: number | null;
  url: string | null;
  urlIssuedAtMs: number | null;
  dependents: LinkDependent[];
  selector: { paths: string[]; versionId: string | null };
  access: "view" | "comment" | "edit";
};

type DamagedLink = Omit<ReadableLink, "access" | "selector"> & {
  selector: null;
  access: string;
  damaged: true;
};

type LinkRow = ReadableLink | DamagedLink;

type DiscussionPage = {
  activityRevision: number;
  linkCommentsPaused: boolean;
  messages: RelayShareDiscussionMessage[];
  nextCursor: string | null;
};

type DiscussionActivity = {
  latestRevision: number;
  cursorRevision: number;
  hasMore: boolean;
  messages: RelayShareDiscussionMessage[];
  principals: Array<{ principalId: string; blocked: boolean }>;
  linkCommentsPaused: boolean;
};

type ReadableGrantedRow = Extract<
  RelayShareGrantedRow,
  { selector: { paths: string[]; versionId: string | null } }
>;

const CREATED_MS = Date.UTC(2026, 0, 2, 3, 4);

function dependent(
  grantId: string,
  recipientEmail: string | null,
  recipientUserId: string | null,
  access: LinkDependent["access"] = "view",
): LinkDependent {
  return {
    grantId,
    recipientEmail,
    recipientUserId,
    access,
    generation: 1,
    createdAtMs: CREATED_MS,
  };
}

function readableLink(
  grantId: string,
  overrides: Partial<ReadableLink> = {},
): ReadableLink {
  return {
    shareId: `share-${grantId}`,
    grantId,
    generation: 1,
    status: "active",
    createdAtMs: CREATED_MS,
    revokedAtMs: null,
    lastUsedAtMs: null,
    url: null, urlIssuedAtMs: CREATED_MS,
    dependents: [],
    selector: { paths: ["docs/plan.md"], versionId: null },
    access: "view",
    ...overrides,
  };
}

function damagedLink(
  grantId: string,
  overrides: Partial<DamagedLink> = {},
): DamagedLink {
  return {
    shareId: `share-${grantId}`,
    grantId,
    generation: 1,
    status: "active",
    createdAtMs: CREATED_MS,
    revokedAtMs: null,
    lastUsedAtMs: null,
    url: null, urlIssuedAtMs: CREATED_MS,
    dependents: [],
    selector: null,
    access: "unknown",
    damaged: true,
    ...overrides,
  };
}

function shortDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short" }).format(value);
}

function shortTimestamp(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(value);
}

function linkResult(url: string): LinkResult {
  return { shareId: "share-link-1", grantId: "grant-link-1", url };
}

function namedComment(
  messageId: string,
  body: string,
  displayName = "Owner Name",
): RelayShareDiscussionMessage {
  return {
    messageId,
    createdAtMs: CREATED_MS,
    deleted: false,
    body,
    author: { kind: "named", displayName },
  };
}

function linkComment(
  messageId: string,
  body: string,
  overrides: {
    blocked?: boolean;
    displayName?: string;
    linkGrantId?: string;
    linkPrincipalId?: string;
  } = {},
): RelayShareDiscussionMessage {
  return {
    messageId,
    createdAtMs: CREATED_MS,
    deleted: false,
    body,
    author: {
      kind: "link",
      displayName: overrides.displayName ?? "Link Visitor",
      unverified: true,
    },
    moderation: {
      linkGrantId: overrides.linkGrantId ?? "link-grant-1",
      linkPrincipalId: overrides.linkPrincipalId ?? "principal-1",
      blocked: overrides.blocked ?? false,
    },
  };
}

function discussionPage(
  messages: RelayShareDiscussionMessage[] = [],
  overrides: Partial<DiscussionPage> = {},
): DiscussionPage {
  return {
    activityRevision: 1,
    linkCommentsPaused: false,
    messages,
    nextCursor: null,
    ...overrides,
  };
}

function discussionActivity(
  revision: number,
  overrides: Partial<DiscussionActivity> = {},
): DiscussionActivity {
  return {
    latestRevision: revision,
    cursorRevision: revision,
    hasMore: false,
    messages: [],
    principals: [],
    linkCommentsPaused: false,
    ...overrides,
  };
}

function independentGrant(
  grantId: string,
  overrides: Partial<ReadableGrantedRow> = {},
): ReadableGrantedRow {
  return {
    shareId: "share-1",
    workspaceId: "ws-1",
    recipientUserId: `user-${grantId}`,
    recipientEmail: `${grantId}@example.test`,
    grantId,
    generation: 2,
    createdAtMs: CREATED_MS,
    revokedAtMs: null,
    shareCode: `dohc-share:${grantId}`,
    selector: { paths: ["docs/plan.md"], versionId: null },
    access: "comment",
    ...overrides,
  };
}

const UNDO = { undoId: "undo-1", expiresAtMs: CREATED_MS + 600_000 };

function controllable<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

const bridgeMock = {
  automationShareImpact: vi.fn(),
  createRelayShare: vi.fn(),
  createRelayShareLink: vi.fn(),
  addRelayShareLink: vi.fn(),
  listRelayShareLinks: vi.fn(),
  retuneRelayShareLink: vi.fn(),
  rotateRelayShareLink: vi.fn(),
  revokeRelayShareLink: vi.fn(),
  listRelayShareLinkAgents: vi.fn(),
  disconnectRelayShareLinkAgent: vi.fn(),
  listRelayShares: vi.fn(),
  listRelayShareDiscussion: vi.fn(),
  pollRelayShareDiscussionActivity: vi.fn(),
  cancelRelayShareDiscussionActivity: vi.fn(),
  appendRelayShareDiscussion: vi.fn(),
  deleteRelayShareDiscussionMessage: vi.fn(),
  blockRelayShareDiscussionPrincipal: vi.fn(),
  unblockRelayShareDiscussionPrincipal: vi.fn(),
  pauseRelayShareDiscussion: vi.fn(),
  resumeRelayShareDiscussion: vi.fn(),
  promoteRelayShareGrant: vi.fn(),
  revokeRelayShareGrant: vi.fn(),
};

vi.mock("./bridge", () => ({
  bridge: () => ({
    ...bridgeMock,
    listRelayShareLinks: async (...args: unknown[]) => ({
      supportedLinkAccess: ["view", "comment"],
      independentGrants: [],
      ...(await bridgeMock.listRelayShareLinks(...args)),
    }),
  }),
}));

let writeText: MockInstance<(text: string) => Promise<void>>;

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMock.automationShareImpact.mockResolvedValue({ stops: [] });
  bridgeMock.createRelayShare.mockResolvedValue({
    shareId: "share-1",
    shareCode: SHARE_CODE,
    recipientEmail: "friend@dohc.test",
  });
  bridgeMock.createRelayShareLink.mockResolvedValue(linkResult(LINK_URL));
  bridgeMock.addRelayShareLink.mockResolvedValue(linkResult(LINK_URL));
  bridgeMock.listRelayShareLinks.mockResolvedValue({
    links: [],
    supportedLinkAccess: ["view", "comment"],
    independentGrants: [],
  });
  bridgeMock.retuneRelayShareLink.mockResolvedValue({ outcome: "narrowed" });
  bridgeMock.rotateRelayShareLink.mockResolvedValue({
    outcome: "rotated",
    url: LINK_URL_B,
  });
  bridgeMock.revokeRelayShareLink.mockResolvedValue({ outcome: "ended", undo: UNDO });
  bridgeMock.listRelayShareLinkAgents.mockResolvedValue({ agents: [], nextCursor: null });
  bridgeMock.disconnectRelayShareLinkAgent.mockResolvedValue({ connectionId: "connection-1" });
  bridgeMock.listRelayShares.mockResolvedValue({ granted: [], received: [] });
  bridgeMock.listRelayShareDiscussion.mockResolvedValue(discussionPage());
  bridgeMock.pollRelayShareDiscussionActivity.mockImplementation(
    () => new Promise(() => {}),
  );
  bridgeMock.cancelRelayShareDiscussionActivity.mockResolvedValue(undefined);
  bridgeMock.appendRelayShareDiscussion.mockResolvedValue({
    message: namedComment("appended-1", "Posted comment"),
  });
  bridgeMock.deleteRelayShareDiscussionMessage.mockResolvedValue({
    message: { messageId: "message-1", createdAtMs: CREATED_MS, deleted: true },
  });
  bridgeMock.blockRelayShareDiscussionPrincipal.mockResolvedValue({ blocked: true });
  bridgeMock.unblockRelayShareDiscussionPrincipal.mockResolvedValue({ blocked: false });
  bridgeMock.pauseRelayShareDiscussion.mockResolvedValue({
    linkCommentsPaused: true,
  });
  bridgeMock.resumeRelayShareDiscussion.mockResolvedValue({
    linkCommentsPaused: false,
  });
  bridgeMock.promoteRelayShareGrant.mockResolvedValue({
    grantId: "dependent-1",
    access: "comment",
    generation: 2,
    status: "active",
    revokedAtMs: null,
    parentGrantId: null,
  });
  bridgeMock.revokeRelayShareGrant.mockResolvedValue({
    grantId: "independent-1",
    access: "comment",
    generation: 3,
    status: "revoked",
    revokedAtMs: CREATED_MS + 1,
    parentGrantId: null,
    undo: UNDO,
  });
  // user-event's clipboard stub: every setup() in this file reuses it.
  userEvent.setup();
  writeText = vi.spyOn(navigator.clipboard, "writeText");
});

afterEach(() => {
  cleanup();
});

async function showLinkPane(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: "Anyone with the link" }));
}

type User = ReturnType<typeof userEvent.setup>;

// With a matching share on screen, a separate share is one step away.
async function openSeparateLink(user: User) {
  await user.click(screen.getByRole("button", { name: "Create separate link" }));
}

async function chooseLinkOption(user: User, row: HTMLElement, name: "Reset link" | "End link") {
  await user.click(within(row).getByRole("button", { name: "Link options" }));
  await user.click(await screen.findByRole("menuitem", { name, hidden: true }));
}

async function chooseLinkAccess(user: User, row: HTMLElement, name: "Can view" | "Can comment" | "Can edit") {
  await user.click(within(row).getByRole("button", { name: /^Can (view|comment|edit)$/ }));
  await user.click(await screen.findByRole("menuitemradio", { name, hidden: true }));
}

async function addLinkWith(user: User, group: HTMLElement, name: "Can view" | "Can comment" | "Can edit") {
  await user.click(within(group).getByRole("button", { name: "Add link" }));
  await user.click(await screen.findByRole("menuitem", { name, hidden: true }));
}

// An active, readable link: its access opens a menu, and its ••• menu offers
// Reset link and End link. Closes the ••• menu again.
async function expectActiveLinkControls(user: User, row: HTMLElement, access: "Can view" | "Can comment" | "Can edit") {
  expect(within(row).getByRole("button", { name: access }).getAttribute("aria-haspopup")).toBe("menu");
  const options = within(row).getByRole("button", { name: "Link options" });
  await user.click(options);
  expect(screen.getAllByRole("menuitem", { hidden: true }).map((item) => item.textContent)).toEqual(["Reset link", "End link"]);
  await user.click(options);
  expect(screen.queryByRole("menu", { hidden: true })).toBeNull();
}

async function openOwnerComments(
  user: ReturnType<typeof userEvent.setup>,
  shareId: string,
) {
  const group = await screen.findByTestId(`share-link-group-${shareId}`);
  await user.click(within(group).getByRole("button", { name: "Comments" }));
  return group;
}

describe("RelayShareDialog", () => {
  function emailResult(shareId: string) {
    return {
      shareId,
      shareCode: `dohc-share:${shareId}:http://relay.test`,
      recipientEmail: "friend@dohc.test",
    };
  }

  it("does not mark a replacement email code copied when an old copy finishes", async () => {
    const oldCopy = controllable<void>();
    bridgeMock.createRelayShare
      .mockResolvedValueOnce(emailResult("old"))
      .mockResolvedValueOnce(emailResult("current"));
    writeText.mockReturnValueOnce(oldCopy.promise);
    const user = userEvent.setup();
    const onClose = vi.fn();
    const view = render(
      <RelayShareDialog workspaceId="ws-1" target={{ kind: "paths", paths: ["docs/a.md"] }} onClose={onClose} />,
    );
    try {
      await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
      await user.click(screen.getByTestId("share-create"));
      await user.click(await screen.findByTestId("share-code-copy"));
      expect(writeText).toHaveBeenCalledWith(emailResult("old").shareCode);

      view.rerender(
        <RelayShareDialog workspaceId="ws-1" target={{ kind: "paths", paths: ["docs/b.md"] }} onClose={onClose} />,
      );
      expect(screen.queryByTestId("share-code")).toBeNull();
      await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
      await user.click(screen.getByTestId("share-create"));
      expect((await screen.findByTestId("share-code")).textContent).toBe(emailResult("current").shareCode);
      await act(async () => oldCopy.resolve());
      expect(screen.getByTestId("share-code-copy").getAttribute("aria-label")).toBe("Copy");
      await user.click(screen.getByTestId("share-code-copy"));
      expect(writeText).toHaveBeenLastCalledWith(emailResult("current").shareCode);
      await waitFor(() => expect(screen.getByTestId("share-code-copy").getAttribute("aria-label")).toBe("Copied"));
    } finally {
      view.unmount();
      await act(async () => {
        oldCopy.resolve();
        await oldCopy.promise;
      });
    }
  });

  it("creates a version share addressed by version id and closes on Done", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "version", versionId: "version-7", versionName: "review" }}
        onClose={onClose}
      />,
    );
    expect(screen.getByText(/version “review”/)).toBeTruthy();

    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect(bridgeMock.createRelayShare).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      recipientEmail: "friend@dohc.test",
      access: "view",
      versionId: "version-7",
    });
    await user.click(await screen.findByTestId("share-done"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stops a repeated inventory cursor and offers Retry", async () => {
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce({ links: [], nextCursor: "repeated-page" })
      .mockResolvedValueOnce({ links: [], nextCursor: "repeated-page" });
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );

    await showLinkPane(user);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "dohc could not load all links.",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
  });

  it("shows only exact selector matches in lifecycle order and appends active damaged rows", async () => {
    const resetAt = CREATED_MS + 86_400_000;
    const usedAt = CREATED_MS + 172_800_000;
    const endedAt = CREATED_MS + 259_200_000;
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [
        readableLink("ended", {
          status: "revoked",
          revokedAtMs: endedAt,
          lastUsedAtMs: usedAt,
          selector: {
            paths: ["assets/map.png", "docs/plan.md"],
            versionId: null,
          },
        }),
        readableLink("active-reset", {
          url: null, urlIssuedAtMs: resetAt,
          selector: {
            paths: ["./docs/plan.md", "assets\\map.png"],
            versionId: null,
          },
        }),
        readableLink("active-used", {
          lastUsedAtMs: usedAt,
          selector: {
            paths: ["assets/map.png", "docs/plan.md"],
            versionId: null,
          },
        }),
        readableLink("subset", {
          selector: { paths: ["docs/plan.md"], versionId: null },
        }),
        readableLink("overlap", {
          selector: {
            paths: ["docs/plan.md", "notes/other.md"],
            versionId: null,
          },
        }),
        readableLink("unrelated", {
          selector: { paths: ["notes/other.md"], versionId: null },
        }),
        readableLink("version-row", {
          selector: { paths: [], versionId: "version-7" },
        }),
        damagedLink("damaged-active"),
        damagedLink("damaged-ended", {
          status: "revoked",
          revokedAtMs: endedAt,
        }),
      ],
    });
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{
          kind: "paths",
          paths: ["docs/plan.md", "assets/map.png"],
        }}
        onClose={() => {}}
      />,
    );

    await showLinkPane(user);
    const rows = await screen.findAllByTestId(/^share-link-row-/);
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "share-link-row-active-reset",
      "share-link-row-active-used",
      "share-link-row-ended",
      "share-link-row-damaged-active",
    ]);

    expect(
      within(rows[0]!).getByText(
        `Not used yet · Created ${shortDate(CREATED_MS)} · Link reset ${shortDate(resetAt)}`,
      ),
    ).toBeTruthy();
    expect(
      within(rows[1]!).getByText(
        `Used ${shortTimestamp(usedAt)} · Created ${shortDate(CREATED_MS)}`,
      ),
    ).toBeTruthy();
    expect(within(rows[2]!).getByText(`Ended ${shortDate(endedAt)}`)).toBeTruthy();
    // An ended link has nothing left to change.
    expect(within(rows[2]!).queryByRole("button", { name: "Link options" })).toBeNull();
    expect(
      within(rows[3]!).getByText(
        "Unreadable link. dohc can't read what this link shares.",
      ),
    ).toBeTruthy();
    expect(within(rows[3]!).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Link options",
    ]);
    await user.click(within(rows[3]!).getByRole("button", { name: "Link options" }));
    expect(screen.getAllByRole("menuitem", { hidden: true }).map((item) => item.textContent)).toEqual([
      "End link",
    ]);
    expect(screen.queryByTestId("share-link-row-subset")).toBeNull();
    expect(screen.queryByTestId("share-link-row-overlap")).toBeNull();
    expect(screen.queryByTestId("share-link-row-unrelated")).toBeNull();
    expect(screen.queryByTestId("share-link-row-version-row")).toBeNull();
    expect(screen.queryByTestId("share-link-row-damaged-ended")).toBeNull();
  });


  it("creates a paths link with the physical workspace and explicit View access", async () => {
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="physical-ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md", "assets/map.png"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    await user.click(screen.getByTestId("share-link-create"));

    expect(bridgeMock.createRelayShareLink).toHaveBeenCalledWith({
      workspaceId: "physical-ws-1",
      paths: ["docs/plan.md", "assets/map.png"],
      access: "view",
    });
  });

  it("warns before an Edit link that would stop automations, naming anyone who opens it, and makes it on the second Create", async () => {
    bridgeMock.listRelayShareLinks.mockResolvedValue({ links: [], supportedLinkAccess: ["view", "comment", "edit"] });
    bridgeMock.automationShareImpact.mockResolvedValue({
      stops: [{ automationId: "collection:Trip#spend", automationName: "Spend", collectionPath: "Trip", target: "Budget", action: "change" }],
    });
    const user = userEvent.setup();
    render(<RelayShareDialog workspaceId="physical-ws-1" target={{ kind: "paths", paths: ["Trip"] }} onClose={() => {}} />);
    await showLinkPane(user);
    const access = screen.getByRole("radiogroup", { name: "Link access" });
    await user.click(await within(access).findByRole("radio", { name: "Edit" }));
    const create = screen.getByTestId("share-link-create");
    await user.click(create);

    expect(bridgeMock.automationShareImpact).toHaveBeenCalledWith({
      workspaceId: "physical-ws-1", recipientEmail: null, paths: ["Trip"], access: "edit",
    });
    expect(bridgeMock.createRelayShareLink).not.toHaveBeenCalled();
    expect((await screen.findByTestId("share-automation-warning")).textContent).toBe(
      'This share stops the automation "Spend" in Trip, because anyone who opens this link cannot edit Budget.',
    );
    expect(create.textContent).toBe("Create link anyway");
    await user.click(create);
    expect(bridgeMock.createRelayShareLink).toHaveBeenCalledWith({ workspaceId: "physical-ws-1", paths: ["Trip"], access: "edit" });
    expect(bridgeMock.automationShareImpact).toHaveBeenCalledTimes(1);
  });


  it("creates a version link with the physical workspace and explicit View access", async () => {
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="physical-ws-1"
        target={{ kind: "version", versionId: "version-7", versionName: "review" }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    await user.click(screen.getByTestId("share-link-create"));

    expect(bridgeMock.createRelayShareLink).toHaveBeenCalledWith({
      workspaceId: "physical-ws-1",
      versionId: "version-7",
      access: "view",
    });
  });

  it("keeps the complete URL volatile and copies it only after an explicit click", async () => {
    const user = userEvent.setup();
    const first = render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);

    expect(screen.queryByText(LINK_URL)).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("share-link-create"));

    const url = await screen.findByTestId("share-link-url");
    expect(url.tagName).toBe("CODE");
    expect(url.textContent).toBe(LINK_URL);
    expect(writeText).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(LINK_URL);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();

    first.unmount();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    expect(screen.queryByText(LINK_URL)).toBeNull();
  });

  it("copies the address an agent signs in with beside the link, and never shows it", async () => {
    const secret = "A".repeat(43);
    const shareLink = `https://share.dohc.test/s/#${secret}`;
    const agentAddress = `https://share.dohc.test/mcp/s/${secret}`;
    bridgeMock.createRelayShareLink.mockResolvedValue(linkResult(shareLink));
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    expect(screen.queryByTestId("share-link-agent-copy")).toBeNull();
    await user.click(screen.getByTestId("share-link-create"));

    const copy = await screen.findByTestId("share-link-agent-copy");
    expect(copy.textContent).toBe("Copy for an agent");
    expect(document.body.textContent).not.toContain(agentAddress);
    expect(writeText).not.toHaveBeenCalled();
    await user.click(copy);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(agentAddress);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    // The same address as the commands one named agent takes, still never shown.
    await user.click(screen.getByTestId("share-link-agent-apps"));
    await user.click(screen.getByTestId("share-link-agent-apps-codex"));
    expect(writeText).toHaveBeenLastCalledWith(`codex mcp add dohc-share --url ${agentAddress}
codex mcp login dohc-share`);
    expect(document.body.textContent).not.toContain(agentAddress);
  });

  it("lists a link's agents in its row, and Disconnect takes one off", async () => {
    bridgeMock.listRelayShareLinks.mockResolvedValue({ links: [readableLink("grant-link-1")] });
    bridgeMock.listRelayShareLinkAgents.mockResolvedValue({
      agents: [
        { connectionId: "connection-1", reportedName: "Claude Code", connectedAtMs: CREATED_MS, lastActionAtMs: CREATED_MS + 60_000 },
        { connectionId: "connection-2", reportedName: null, connectedAtMs: CREATED_MS, lastActionAtMs: null },
      ],
      nextCursor: null,
    });
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);

    const row = await screen.findByTestId("share-link-row-grant-link-1");
    const agents = await within(row).findByRole("region", { name: "Agents" });
    expect(bridgeMock.listRelayShareLinkAgents).toHaveBeenCalledWith({ workspaceId: "ws-1", shareId: "share-grant-link-1", grantId: "grant-link-1" });
    const named = within(agents).getByTestId("share-link-agent-connection-1");
    expect(named.textContent).toContain("Claude Code");
    expect(named.textContent).toContain("Name reported by the agent");
    expect(named.textContent).toContain(`Last action ${shortTimestamp(CREATED_MS + 60_000)}`);
    const unnamed = within(agents).getByTestId("share-link-agent-connection-2");
    expect(unnamed.textContent).toContain("Agent");
    expect(unnamed.textContent).toContain("The agent reported no name");
    expect(unnamed.textContent).toContain(`Signed in ${shortTimestamp(CREATED_MS)}`);

    await user.click(within(named).getByRole("button", { name: "Disconnect Claude Code" }));
    expect(bridgeMock.disconnectRelayShareLinkAgent).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-1",
      shareId: "share-grant-link-1",
      grantId: "grant-link-1",
      connectionId: "connection-1",
    });
    await waitFor(() => expect(within(agents).queryByTestId("share-link-agent-connection-1")).toBeNull());
    expect(within(agents).getByTestId("share-link-agent-connection-2")).toBeTruthy();
    expect(bridgeMock.revokeRelayShareLink).not.toHaveBeenCalled();
  });

  // The shell owns the notice and its Undo, so the pane hands over the
  // receipt and the words. A link and a person's access are two removals.
  it("reports an ended link and an ended named grant with their undo receipts", async () => {
    const link = readableLink("link-1", {
      shareId: "share-1",
      selector: { paths: ["docs/plan.md"], versionId: null },
    });
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [link],
      supportedLinkAccess: ["view", "comment"],
      independentGrants: [independentGrant("named-1", { recipientEmail: "friend@example.test" })],
    });
    const shareRemovals = { removed: vi.fn(), failed: vi.fn(), agentDisconnected: vi.fn() };
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
        shareRemovals={shareRemovals}
      />,
    );
    await showLinkPane(user);

    const group = await openOwnerComments(user, "share-1");
    const named = await within(group).findByTestId("share-independent-named-1");
    expect(named.textContent).toContain("Can comment");
    await user.click(within(named).getByRole("button", { name: "End access" }));
    await user.click(
      within(within(group).getByTestId("owner-comments-confirmation")).getByRole("button", {
        name: "End access",
      }),
    );
    await vi.waitFor(() => expect(shareRemovals.removed).toHaveBeenCalledTimes(1));
    expect(shareRemovals.removed.mock.calls[0]![0]).toMatchObject({
      workspaceId: "ws-1",
      shareId: "share-1",
      undo: UNDO,
      message: "Ended friend@example.test's access to docs/plan.md.",
      restoredMessage: "Restored friend@example.test's access to docs/plan.md.",
    });

    const row = await screen.findByTestId("share-link-row-link-1");
    await chooseLinkOption(user, row, "End link");
    await user.click(
      within(screen.getByTestId("share-link-confirmation")).getByRole("button", {
        name: "End link",
      }),
    );
    await vi.waitFor(() => expect(shareRemovals.removed).toHaveBeenCalledTimes(2));
    expect(shareRemovals.removed.mock.calls[1]![0]).toMatchObject({
      workspaceId: "ws-1",
      shareId: "share-1",
      undo: UNDO,
      message: "Ended the link to docs/plan.md.",
      restoredMessage: "Restored the link to docs/plan.md.",
    });

    // Restoring reads the inventory again while the dialog is open.
    const reads = bridgeMock.listRelayShareLinks.mock.calls.length;
    await act(async () => shareRemovals.removed.mock.calls[1]![0].restored());
    await vi.waitFor(() =>
      expect(bridgeMock.listRelayShareLinks.mock.calls.length).toBeGreaterThan(reads),
    );
    expect(shareRemovals.failed).not.toHaveBeenCalled();
  });

  // A refused removal goes where the removal's own notice would have gone:
  // the shell, with Try again. No second copy of it inside the dialog.

  // The link is a credential: after Reset link, Try again from a failed copy
  // of the old link must not put the old link on the clipboard.
  it("never copies a link that Reset link retired when Try again comes later", async () => {
    const row = readableLink("grant-link-1", { shareId: "share-link-1", dependents: [] });
    bridgeMock.listRelayShareLinks.mockResolvedValue({ links: [row] });
    bridgeMock.rotateRelayShareLink.mockResolvedValueOnce({ outcome: "rotated", url: LINK_URL_B });
    const report = vi.fn<ReportShellFailure>();
    const user = userEvent.setup();
    writeText.mockRejectedValueOnce(new Error("Document is not focused."));
    render(
      <ShellErrorReporter.Provider value={report}>
        <RelayShareDialog workspaceId="ws-1" target={{ kind: "paths", paths: ["docs/plan.md"] }} onClose={() => {}} />
      </ShellErrorReporter.Provider>,
    );
    await showLinkPane(user);
    await screen.findByTestId("share-link-row-grant-link-1");
    await openSeparateLink(user);
    await user.click(screen.getByTestId("share-link-create"));
    expect((await screen.findByTestId("share-link-url")).textContent).toBe(LINK_URL);
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await vi.waitFor(() =>
      expect(report).toHaveBeenCalledWith({
        message: "dohc could not copy the share link. Document is not focused.",
        cause: expect.anything(),
        retry: expect.any(Function),
      }),
    );
    const retry = report.mock.calls[0]![0].retry!;

    const linkRow = screen.getByTestId("share-link-row-grant-link-1");
    await chooseLinkOption(user, linkRow, "Reset link");
    await user.click(within(screen.getByTestId("share-link-confirmation")).getByRole("button", { name: "Reset link" }));
    expect((await screen.findByTestId("share-link-url")).textContent).toBe(LINK_URL_B);

    writeText.mockClear();
    await act(async () => retry());
    expect(writeText).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith({
      message: "dohc could not copy the share link. Document is not focused. Open Share to copy it again.",
      cause: expect.anything(),
      retry: null,
    });
  });

  it("resets with the sorted current dependent ids, replaces the URL, and refreshes", async () => {
    const row = readableLink("grant-link-1", {
      shareId: "share-link-1",
      dependents: [
        dependent("dependent-z", "z@example.test", "user-z"),
        dependent("dependent-a", "a@example.test", "user-a"),
      ],
    });
    bridgeMock.listRelayShareLinks.mockResolvedValue({ links: [row] });
    const reset = controllable<{ outcome: "rotated"; url: string }>();
    bridgeMock.rotateRelayShareLink.mockReturnValueOnce(reset.promise);
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    await screen.findByTestId("share-link-row-grant-link-1");
    await openSeparateLink(user);
    await user.click(screen.getByTestId("share-link-create"));
    expect((await screen.findByTestId("share-link-url")).textContent).toBe(LINK_URL);
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });

    const linkRow = screen.getByTestId("share-link-row-grant-link-1");
    await chooseLinkOption(user, linkRow, "Reset link");
    const confirmation = screen.getByTestId("share-link-confirmation");
    await user.click(within(confirmation).getByRole("button", { name: "Reset link" }));

    expect(within(confirmation).getByRole("button", { name: "Resetting…" })).toBeTruthy();
    expect(bridgeMock.rotateRelayShareLink).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      shareId: "share-link-1",
      grantId: "grant-link-1",
      expectedDependentGrantIds: ["dependent-a", "dependent-z"],
    });

    await act(async () => {
      reset.resolve({ outcome: "rotated", url: LINK_URL_B });
    });

    expect((await screen.findByTestId("share-link-url")).textContent).toBe(LINK_URL_B);
    expect(screen.queryByText(LINK_URL)).toBeNull();
    expect(screen.queryByTestId("share-link-confirmation")).toBeNull();
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(3);
    });
  });

  it("shows changed dependents, does not retry, and requires fresh confirmation", async () => {
    const oldRow = readableLink("grant-link-1", {
      shareId: "share-link-1",
      dependents: [dependent("dependent-old", "old@example.test", "user-old")],
    });
    const freshDependents = [
      dependent("dependent-new-z", "new@example.test", "user-new"),
      dependent("dependent-new-a", null, "server-user-new"),
    ];
    const freshRow = readableLink("grant-link-1", {
      shareId: "share-link-1",
      dependents: freshDependents,
    });
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce({ links: [oldRow] })
      .mockResolvedValue({ links: [freshRow] });
    bridgeMock.revokeRelayShareLink
      .mockResolvedValueOnce({
        outcome: "dependents-changed",
        dependents: freshDependents,
      })
      .mockResolvedValueOnce({ outcome: "ended", undo: UNDO });
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);

    const row = await screen.findByTestId("share-link-row-grant-link-1");
    await chooseLinkOption(user, row, "End link");
    let confirmation = screen.getByTestId("share-link-confirmation");
    expect(confirmation.textContent).toContain("old@example.test");
    await user.click(within(confirmation).getByRole("button", { name: "End link" }));

    expect(
      await screen.findByText(
        "Who has access through this link changed. Check the updated names and confirm again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("share-link-confirmation")).toBeNull();
    expect(bridgeMock.revokeRelayShareLink).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });
    expect(bridgeMock.revokeRelayShareLink).toHaveBeenCalledTimes(1);

    await chooseLinkOption(user, screen.getByTestId("share-link-row-grant-link-1"), "End link");
    confirmation = screen.getByTestId("share-link-confirmation");
    expect(confirmation.textContent).toContain("new@example.test, server-user-new");
    expect(confirmation.textContent).not.toContain("old@example.test");
    await user.click(within(confirmation).getByRole("button", { name: "End link" }));

    expect(bridgeMock.revokeRelayShareLink).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      shareId: "share-link-1",
      grantId: "grant-link-1",
      expectedDependentGrantIds: ["dependent-new-a", "dependent-new-z"],
    });
  });



  it("clears an open confirmation when an accepted post-create refresh removes its link", async () => {
    const row = readableLink("grant-link-1", { shareId: "share-link-1" });
    const refresh = controllable<{ links: LinkRow[] }>();
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce({ links: [row] })
      .mockReturnValueOnce(refresh.promise);
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);

    const linkRow = await screen.findByTestId("share-link-row-grant-link-1");
    await openSeparateLink(user);
    await user.click(screen.getByTestId("share-link-create"));
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });
    await chooseLinkOption(user, linkRow, "Reset link");
    expect(screen.getByTestId("share-link-confirmation")).toBeTruthy();

    await act(async () => {
      refresh.resolve({ links: [] });
    });

    expect(screen.queryByTestId("share-link-confirmation")).toBeNull();
    expect(screen.getByTestId("share-link-create").hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("keeps B busy when a lifecycle success from A arrives late", async () => {
    const resetA = controllable<{ outcome: "rotated"; url: string }>();
    const endB = controllable<{ outcome: "ended"; undo: typeof UNDO }>();
    bridgeMock.rotateRelayShareLink.mockReturnValueOnce(resetA.promise);
    bridgeMock.revokeRelayShareLink.mockReturnValueOnce(endB.promise);
    bridgeMock.listRelayShareLinks.mockImplementation(
      async ({ workspaceId }: { workspaceId: string }) => ({
        links:
          workspaceId === "ws-a"
            ? [readableLink("grant-a", { shareId: "share-a" })]
            : [readableLink("grant-b", { shareId: "share-b" })],
      }),
    );
    const user = userEvent.setup();
    const view = render(
      <RelayShareDialog
        workspaceId="ws-a"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    let row = await screen.findByTestId("share-link-row-grant-a");
    await chooseLinkOption(user, row, "Reset link");
    await user.click(
      within(screen.getByTestId("share-link-confirmation")).getByRole("button", {
        name: "Reset link",
      }),
    );

    view.rerender(
      <RelayShareDialog
        workspaceId="ws-b"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    row = await screen.findByTestId("share-link-row-grant-b");
    await chooseLinkOption(user, row, "End link");
    await user.click(
      within(screen.getByTestId("share-link-confirmation")).getByRole("button", {
        name: "End link",
      }),
    );

    await act(async () => {
      resetA.resolve({ outcome: "rotated", url: LINK_URL_A });
    });

    expect(screen.queryByText(LINK_URL_A)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Ending…" }).hasAttribute("disabled")).toBe(
      true,
    );

    await act(async () => {
      endB.resolve({ outcome: "ended", undo: UNDO });
    });
    expect(screen.queryByTestId("share-link-confirmation")).toBeNull();
  });

  it("ignores a stale success after the workspace changes without clearing B busy", async () => {
    const requestA = controllable<LinkResult>();
    const requestB = controllable<LinkResult>();
    bridgeMock.createRelayShareLink
      .mockReturnValueOnce(requestA.promise)
      .mockReturnValueOnce(requestB.promise);
    const user = userEvent.setup();
    const view = render(
      <RelayShareDialog
        workspaceId="ws-a"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    await user.click(screen.getByTestId("share-link-create"));

    view.rerender(
      <RelayShareDialog
        workspaceId="ws-b"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByTestId("share-link-create"));

    await act(async () => {
      requestA.resolve(linkResult(LINK_URL_A));
    });

    expect(screen.queryByText(LINK_URL_A)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    const pendingCreate = screen.getByTestId("share-link-create");
    expect(pendingCreate.textContent).toBe("Creating link…");
    expect(pendingCreate.hasAttribute("disabled")).toBe(true);
    expect(writeText).not.toHaveBeenCalled();

    await act(async () => {
      requestB.resolve(linkResult(LINK_URL_B));
    });
    expect(screen.getByText(LINK_URL_B)).toBeTruthy();
  });

  it("recovers a committed Create link after its response is lost", async () => {
    const create = controllable<LinkResult>();
    const committed = readableLink("committed-create", {
      shareId: "share-created",
      access: "comment",
    });
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce({ links: [] })
      .mockResolvedValueOnce({ links: [committed] });
    bridgeMock.createRelayShareLink.mockReturnValueOnce(create.promise);
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);

    await user.click(screen.getByRole("radio", { name: "Comment" }));
    await user.click(screen.getByTestId("share-link-create"));
    await act(async () => {
      create.reject(new Error("The Create link response was lost."));
    });

    expect(await screen.findByText("The Create link response was lost.")).toBeTruthy();
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });
    const committedRow = await screen.findByTestId("share-link-row-committed-create");
    await expectActiveLinkControls(user, committedRow, "Can comment");
    expect(screen.queryByTestId("share-link-url")).toBeNull();
    expect(bridgeMock.createRelayShareLink).toHaveBeenCalledTimes(1);
  });

  it("groups links by real share id and adds only to the chosen share", async () => {
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [
        readableLink("one-view", { shareId: "share-one", access: "view" }),
        readableLink("one-comment", {
          shareId: "share-one",
          access: "comment",
        }),
        readableLink("two-view", { shareId: "share-two", access: "view" }),
      ],
    });
    bridgeMock.addRelayShareLink
      .mockResolvedValueOnce({
        shareId: "share-one",
        grantId: "one-added",
        url: LINK_URL_A,
      })
      .mockResolvedValueOnce({
        shareId: "share-two",
        grantId: "two-added",
        url: LINK_URL_B,
      });
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="physical-ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);

    const firstGroup = await screen.findByTestId("share-link-group-share-one");
    const secondGroup = screen.getByTestId("share-link-group-share-two");
    expect(within(firstGroup).getAllByTestId(/^share-link-row-/u)).toHaveLength(2);
    expect(within(secondGroup).getAllByTestId(/^share-link-row-/u)).toHaveLength(1);
    expect(screen.getAllByTestId(/^share-link-group-/u)).toHaveLength(2);
    expect(within(firstGroup).queryByText(/Another link to the same share/)).toBeNull();

    await addLinkWith(user, firstGroup, "Can comment");
    await vi.waitFor(() => {
      expect(bridgeMock.addRelayShareLink).toHaveBeenCalledTimes(1);
    });
    expect(bridgeMock.addRelayShareLink).toHaveBeenNthCalledWith(1, {
      workspaceId: "physical-ws-1",
      shareId: "share-one",
      access: "comment",
    });

    await addLinkWith(user, secondGroup, "Can view");
    await vi.waitFor(() => {
      expect(bridgeMock.addRelayShareLink).toHaveBeenCalledTimes(2);
    });
    expect(bridgeMock.addRelayShareLink).toHaveBeenNthCalledWith(2, {
      workspaceId: "physical-ws-1",
      shareId: "share-two",
      access: "view",
    });
    for (const [payload] of bridgeMock.addRelayShareLink.mock.calls) {
      expect(payload).not.toHaveProperty("paths");
      expect(payload).not.toHaveProperty("versionId");
      expect(payload.access).not.toBe("edit");
    }
  });

  it("does not use stale root-grant eligibility after its inventory refresh fails", async () => {
    const inventory = {
      links: [
        readableLink("ended-link", {
          shareId: "share-1",
          status: "revoked",
          revokedAtMs: CREATED_MS + 1,
        }),
      ],
      supportedLinkAccess: ["view", "comment"],
      independentGrants: [independentGrant("named-root")],
    };
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce(inventory)
      .mockRejectedValueOnce(new Error("independent inventory unavailable"))
      .mockResolvedValueOnce(inventory);
    bridgeMock.revokeRelayShareGrant.mockRejectedValueOnce(
      new Error("revoke unavailable"),
    );
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);

    const group = await screen.findByTestId("share-link-group-share-1");
    await user.click(within(group).getByRole("button", { name: "Comments" }));
    const namedGrant = await within(group).findByTestId(
      "share-independent-named-root",
    );
    await user.click(within(namedGrant).getByRole("button", { name: "End access" }));
    await user.click(
      within(within(group).getByTestId("owner-comments-confirmation")).getByRole(
        "button",
        { name: "End access" },
      ),
    );

    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
      expect(within(group).queryByRole("button", { name: "Add link" })).toBeNull();
    });
    expect(within(group).queryByRole("button", { name: "Comments" })).toBeNull();
    expect(within(group).queryByTestId("share-independent-named-root")).toBeNull();

    const inventoryError = await screen.findByText(
      "independent inventory unavailable",
    );
    await user.click(
      within(inventoryError.parentElement!).getByRole("button", { name: "Try again" }),
    );

    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(3);
      expect(within(group).getByRole("button", { name: "Add link" })).toBeTruthy();
      expect(within(group).getByRole("button", { name: "Comments" })).toBeTruthy();
    });
    expect(screen.queryByText("independent inventory unavailable")).toBeNull();
    await user.click(within(group).getByRole("button", { name: "Comments" }));
    expect(
      await within(group).findByTestId("share-independent-named-root"),
    ).toBeTruthy();
    expect(bridgeMock.listRelayShares).not.toHaveBeenCalled();
  });

  it("replaces the URL on widening and preserves it on narrowing", async () => {
    const viewRow = readableLink("retune-link", {
      shareId: "share-retune",
      access: "view",
    });
    const commentRow = readableLink("retune-link", {
      shareId: "share-retune",
      access: "comment",
    });
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce({ links: [viewRow] })
      .mockResolvedValueOnce({ links: [viewRow] })
      .mockResolvedValueOnce({ links: [commentRow] })
      .mockResolvedValue({ links: [viewRow] });
    bridgeMock.createRelayShareLink.mockResolvedValueOnce(linkResult(LINK_URL_A));
    bridgeMock.retuneRelayShareLink
      .mockResolvedValueOnce({ outcome: "widened", url: LINK_URL_B })
      .mockResolvedValueOnce({ outcome: "narrowed" });
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    await screen.findByTestId("share-link-row-retune-link");
    await openSeparateLink(user);
    await user.click(screen.getByTestId("share-link-create"));
    expect((await screen.findByTestId("share-link-url")).textContent).toBe(LINK_URL_A);
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });

    let row = screen.getByTestId("share-link-row-retune-link");
    await chooseLinkAccess(user, row, "Can comment");
    let confirmation = screen.getByTestId("share-link-confirmation");
    await user.click(
      within(confirmation).getByRole("button", { name: "Turn on comments" }),
    );
    expect((await screen.findByTestId("share-link-url")).textContent).toBe(LINK_URL_B);
    expect(screen.queryByText(LINK_URL_A)).toBeNull();
    expect(bridgeMock.retuneRelayShareLink).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-1",
      shareId: "share-retune",
      grantId: "retune-link",
      access: "comment",
      expectedDependentGrantIds: [],
    });
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(3);
    });

    row = screen.getByTestId("share-link-row-retune-link");
    await chooseLinkAccess(user, row, "Can view");
    confirmation = screen.getByTestId("share-link-confirmation");
    await user.click(
      within(confirmation).getByRole("button", { name: "Turn off comments" }),
    );
    await vi.waitFor(() => {
      expect(bridgeMock.retuneRelayShareLink).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByTestId("share-link-url").textContent).toBe(LINK_URL_B);
    expect(bridgeMock.retuneRelayShareLink).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      shareId: "share-retune",
      grantId: "retune-link",
      access: "view",
      expectedDependentGrantIds: [],
    });
  });

  it("retires the displayed URL before refreshing after a lost widening response", async () => {
    const retune = controllable<{ outcome: "widened"; url: string }>();
    const viewRow = readableLink("stale-retune", {
      shareId: "share-stale-retune",
      access: "view",
    });
    const commentRow = readableLink("stale-retune", {
      shareId: "share-stale-retune",
      access: "comment",
    });
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce({ links: [viewRow] })
      .mockResolvedValueOnce({ links: [viewRow] })
      .mockResolvedValueOnce({ links: [commentRow] });
    bridgeMock.createRelayShareLink.mockResolvedValueOnce({
      shareId: viewRow.shareId,
      grantId: viewRow.grantId,
      url: LINK_URL_A,
    });
    bridgeMock.retuneRelayShareLink.mockReturnValueOnce(retune.promise);
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);

    let row = await screen.findByTestId("share-link-row-stale-retune");
    await openSeparateLink(user);
    await user.click(screen.getByTestId("share-link-create"));
    expect((await screen.findByTestId("share-link-url")).textContent).toBe(LINK_URL_A);
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });
    await chooseLinkAccess(user, row, "Can comment");
    await user.click(
      within(screen.getByTestId("share-link-confirmation")).getByRole("button", {
        name: "Turn on comments",
      }),
    );
    expect(bridgeMock.retuneRelayShareLink).toHaveBeenCalledTimes(1);

    await act(async () => {
      retune.reject(new Error("The link changed on another device."));
    });

    expect(
      await screen.findByText("The link changed on another device."),
    ).toBeTruthy();
    expect(screen.queryByTestId("share-link-url")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(3);
    });
    expect(screen.queryByTestId("share-link-confirmation")).toBeNull();
    row = screen.getByTestId("share-link-row-stale-retune");
    await expectActiveLinkControls(user, row, "Can comment");
    expect(bridgeMock.retuneRelayShareLink).toHaveBeenCalledTimes(1);
  });


  it("keeps a newer retune busy when a stale widening arrives", async () => {
    const widenA = controllable<{ outcome: "widened"; url: string }>();
    const narrowB = controllable<{ outcome: "narrowed" }>();
    bridgeMock.retuneRelayShareLink
      .mockReturnValueOnce(widenA.promise)
      .mockReturnValueOnce(narrowB.promise);
    bridgeMock.listRelayShareLinks.mockImplementation(
      async ({ workspaceId }: { workspaceId: string }) => ({
        links: [
          readableLink(`grant-${workspaceId}`, {
            shareId: `share-${workspaceId}`,
            access: workspaceId === "ws-a" ? "view" : "comment",
          }),
        ],
      }),
    );
    const user = userEvent.setup();
    const view = render(
      <RelayShareDialog
        workspaceId="ws-a"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    let row = await screen.findByTestId("share-link-row-grant-ws-a");
    await chooseLinkAccess(user, row, "Can comment");
    await user.click(
      within(screen.getByTestId("share-link-confirmation")).getByRole("button", {
        name: "Turn on comments",
      }),
    );

    view.rerender(
      <RelayShareDialog
        workspaceId="ws-b"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    row = await screen.findByTestId("share-link-row-grant-ws-b");
    await chooseLinkAccess(user, row, "Can view");
    await user.click(
      within(screen.getByTestId("share-link-confirmation")).getByRole("button", {
        name: "Turn off comments",
      }),
    );

    await act(async () => {
      widenA.resolve({ outcome: "widened", url: LINK_URL_A });
    });
    expect(screen.queryByText(LINK_URL_A)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Turning off comments…" }).hasAttribute(
        "disabled",
      ),
    ).toBe(true);

    await act(async () => {
      narrowB.resolve({ outcome: "narrowed" });
    });
    expect(screen.queryByText(LINK_URL_A)).toBeNull();
    expect(screen.queryByTestId("share-link-confirmation")).toBeNull();
  });

  it("appends ordered pages without duplicates and renders owner tombstones", async () => {
    const first = namedComment("message-1", "First");
    const second = linkComment("message-2", "Second");
    const deleted: RelayShareDiscussionMessage = {
      messageId: "message-3",
      createdAtMs: CREATED_MS + 2,
      deleted: true,
      author: { kind: "named", displayName: "Deleted Author" },
    };
    const fourth = namedComment("message-4", "Fourth");
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion
      .mockResolvedValueOnce(
        discussionPage([first, second, deleted], { nextCursor: "cursor-1" }),
      )
      .mockResolvedValueOnce(discussionPage([second, fourth]));
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    const group = await openOwnerComments(user, "share-1");

    expect(await within(group).findByText("First")).toBeTruthy();
    expect(within(group).getByText("Second")).toBeTruthy();
    expect(within(group).getByText("Unverified")).toBeTruthy();
    expect(within(group).getByText("Comment deleted by the owner")).toBeTruthy();
    expect(within(group).queryByText("Deleted body must not render")).toBeNull();
    await user.click(
      within(group).getByRole("button", { name: "Show more comments" }),
    );
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      shareId: "share-1",
      direction: "newest-first",
      cursor: "cursor-1",
    });
    expect(await within(group).findByText("Fourth")).toBeTruthy();
    const messageIds = Array.from(
      group.querySelectorAll<HTMLElement>("[data-comment-message-id]"),
      (node) => node.dataset.commentMessageId,
    );
    expect(messageIds).toEqual([
      "message-1",
      "message-2",
      "message-4",
      "message-3",
    ]);
  });

  it("retries one append intent, changes its key after an edit, and never adds early", async () => {
    const first = controllable<{ message: RelayShareDiscussionMessage }>();
    const third = controllable<{ message: RelayShareDiscussionMessage }>();
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.appendRelayShareDiscussion
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new Error("Retry failed."))
      .mockReturnValueOnce(third.promise);
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    const group = await openOwnerComments(user, "share-1");
    const field = within(group).getByRole("textbox", { name: "Add a comment" });
    await user.type(field, "Keep this draft");
    const post = within(group).getByRole("button", { name: "Post" });
    await user.dblClick(post);
    expect(bridgeMock.appendRelayShareDiscussion).toHaveBeenCalledTimes(1);
    const firstPayload = bridgeMock.appendRelayShareDiscussion.mock.calls[0]?.[0];
    expect(firstPayload).toEqual({
      workspaceId: "ws-1",
      shareId: "share-1",
      body: "Keep this draft",
      idempotencyKey: expect.stringMatching(/^[\x20-\x7e]{1,64}$/u),
    });
    expect(
      Array.from(group.querySelectorAll("[data-comment-message-id]")).some(
        (row) => row.textContent?.includes("Keep this draft"),
      ),
    ).toBe(false);

    await act(async () => {
      first.reject(new Error("Post failed."));
    });
    expect(await within(group).findByText("dohc could not post the comment.")).toBeTruthy();
    expect((field as HTMLTextAreaElement).value).toBe("Keep this draft");
    await user.click(within(group).getByRole("button", { name: "Try again" }));
    expect(bridgeMock.appendRelayShareDiscussion).toHaveBeenCalledTimes(2);
    expect(bridgeMock.appendRelayShareDiscussion.mock.calls[1]?.[0]).toEqual(
      firstPayload,
    );
    expect(await within(group).findByText("dohc could not post the comment.")).toBeTruthy();

    await user.type(field, "!");
    expect(within(group).queryByRole("button", { name: "Try again" })).toBeNull();
    await user.click(within(group).getByRole("button", { name: "Post" }));
    const editedPayload = bridgeMock.appendRelayShareDiscussion.mock.calls[2]?.[0];
    expect(editedPayload).toMatchObject({
      workspaceId: "ws-1",
      shareId: "share-1",
      body: "Keep this draft!",
    });
    expect(editedPayload.idempotencyKey).not.toBe(firstPayload.idempotencyKey);
    expect(
      Array.from(group.querySelectorAll("[data-comment-message-id]")).some(
        (row) => row.textContent?.includes("Keep this draft!"),
      ),
    ).toBe(false);
    await act(async () => {
      third.resolve({
        message: namedComment("settled-message", "Keep this draft!"),
      });
    });
    expect((field as HTMLTextAreaElement).value).toBe("");
    expect(within(group).getAllByText("Keep this draft!")).toHaveLength(1);
  });

  it("keeps an activity tombstone when a stale owner post settles later", async () => {
    const append = controllable<{ message: RelayShareDiscussionMessage }>();
    const activity = controllable<DiscussionActivity>();
    const staleBody = "Stale posted body";
    const staleLive = namedComment("message-1", staleBody);
    const tombstone: RelayShareDiscussionMessage = {
      messageId: "message-1",
      createdAtMs: CREATED_MS,
      deleted: true,
      author: { kind: "named", displayName: "Owner Name" },
    };
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.appendRelayShareDiscussion.mockReturnValueOnce(append.promise);
    bridgeMock.pollRelayShareDiscussionActivity.mockReturnValueOnce(
      activity.promise,
    );
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    const group = await openOwnerComments(user, "share-1");
    const field = within(group).getByRole("textbox", { name: "Add a comment" });
    await user.type(field, staleBody);
    await user.click(within(group).getByRole("button", { name: "Post" }));
    await vi.waitFor(() => {
      expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(1);
      expect(bridgeMock.appendRelayShareDiscussion).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      activity.resolve(
        discussionActivity(2, {
          messages: [tombstone],
        }),
      );
    });
    const row = await within(group).findByTestId("share-comment-message-1");
    expect(within(row).getByText("Comment deleted by the owner")).toBeTruthy();
    expect(within(row).queryByText(staleBody)).toBeNull();

    await act(async () => {
      append.resolve({ message: staleLive });
    });
    expect(within(row).getByText("Comment deleted by the owner")).toBeTruthy();
    expect(within(row).queryByText(staleBody)).toBeNull();
  });

  it("does not apply principal state from a rejected activity page", async () => {
    const conflict = controllable<DiscussionActivity>();
    const retry = controllable<DiscussionActivity>();
    const original = linkComment("message-1", "Original", {
      linkPrincipalId: "principal-1",
    });
    const forged = linkComment("message-1", "Forged", {
      linkPrincipalId: "principal-1",
    });
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion.mockResolvedValue(
      discussionPage([original], { activityRevision: 1 }),
    );
    bridgeMock.pollRelayShareDiscussionActivity
      .mockReturnValueOnce(conflict.promise)
      .mockReturnValueOnce(retry.promise)
      .mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    const group = await openOwnerComments(user, "share-1");
    const row = await within(group).findByTestId("share-comment-message-1");
    expect(within(row).queryByRole("button", { name: "Block" }) !== null).toBe(
      true,
    );

    await act(async () => {
      conflict.resolve(
        discussionActivity(2, {
          messages: [forged],
          principals: [{ principalId: "principal-1", blocked: true }],
        }),
      );
    });
    await vi.waitFor(() => {
      expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(2);
    });
    expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ since: 1 }),
    );
    await act(async () => {
      retry.resolve(discussionActivity(2));
    });
    await vi.waitFor(() => {
      expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(3);
    });

    expect(within(row).queryByRole("button", { name: "Block" }) !== null).toBe(
      true,
    );
    expect(within(row).queryByRole("button", { name: "Unblock" })).toBeNull();
  });

  it("reloads delete, principal block, and share pause changes from authority", async () => {
    const named = namedComment("message-1", "Remove me");
    const link = linkComment("message-2", "Moderate me");
    const tombstone: RelayShareDiscussionMessage = {
      messageId: "message-1",
      createdAtMs: CREATED_MS,
      deleted: true,
      author: { kind: "named", displayName: "Owner Name" },
    };
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion
      .mockResolvedValueOnce(discussionPage([named, link]))
      .mockResolvedValueOnce(discussionPage([tombstone, link]))
      .mockResolvedValueOnce(
        discussionPage([tombstone, linkComment("message-2", "Moderate me", { blocked: true })]),
      )
      .mockResolvedValueOnce(discussionPage([tombstone, link]))
      .mockResolvedValueOnce(
        discussionPage([tombstone, link], { linkCommentsPaused: true }),
      )
      .mockResolvedValueOnce(discussionPage([tombstone, link]));
    bridgeMock.pauseRelayShareDiscussion.mockRejectedValueOnce(
      new Error("private failure"),
    );
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    const group = await openOwnerComments(user, "share-1");
    const namedRow = await within(group).findByTestId("share-comment-message-1");
    await user.click(
      within(namedRow).getByRole("button", { name: "Delete comment" }),
    );
    let confirmation = within(group).getByTestId("owner-comments-confirmation");
    expect(confirmation.querySelector("p")?.textContent).toBe(
      "Delete this comment? Its text is removed for everyone right away and can't be brought back. Readers see that a comment was deleted.",
    );
    await user.click(
      within(confirmation).getByRole("button", { name: "Delete comment" }),
    );
    expect(bridgeMock.deleteRelayShareDiscussionMessage).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      shareId: "share-1",
      messageId: "message-1",
    });
    expect(await within(group).findByText("Comment deleted by the owner")).toBeTruthy();

    let linkRow = within(group).getByTestId("share-comment-message-2");
    await user.click(within(linkRow).getByRole("button", { name: "Block" }));
    confirmation = within(group).getByTestId("owner-comments-confirmation");
    expect(confirmation.querySelector("p")?.textContent).toBe(
      "Block Link Visitor? They can't comment through this link from this browser until you unblock them. They can still comment from another browser or another link. To stop everyone with this link, reset it.",
    );
    await user.click(within(confirmation).getByRole("button", { name: "Block" }));
    expect(bridgeMock.blockRelayShareDiscussionPrincipal).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      shareId: "share-1",
      principalId: "principal-1",
    });
    linkRow = await within(group).findByTestId("share-comment-message-2");
    await user.click(within(linkRow).getByRole("button", { name: "Unblock" }));
    expect(bridgeMock.unblockRelayShareDiscussionPrincipal).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      shareId: "share-1",
      principalId: "principal-1",
    });
    expect(
      await within(group).findByRole("button", { name: "Block" }),
    ).toBeTruthy();

    await user.click(within(group).getByRole("button", { name: "Pause link comments" }));
    expect(bridgeMock.pauseRelayShareDiscussion).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      shareId: "share-1",
    });
    expect(
      await within(group).findByText(
        "Link comments are paused. People with links can still read everything.",
      ),
    ).toBeTruthy();
    expect(within(group).queryByText("dohc could not complete that change.")).toBeNull();
    await user.click(within(group).getByRole("button", { name: "Resume link comments" }));
    expect(bridgeMock.resumeRelayShareDiscussion).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      shareId: "share-1",
    });
    expect(
      await within(group).findByRole("button", { name: "Pause link comments" }),
    ).toBeTruthy();
  });

  it("reconciles a lost delete response from the authoritative tombstone and refreshed activity revision", async () => {
    const live = namedComment("message-1", "Delete after commit");
    const tombstone: RelayShareDiscussionMessage = {
      messageId: "message-1",
      createdAtMs: CREATED_MS,
      deleted: true,
      author: { kind: "named", displayName: "Owner Name" },
    };
    const reconciliation = controllable<DiscussionPage>();
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion
      .mockResolvedValueOnce(discussionPage([live], { activityRevision: 11 }))
      .mockReturnValueOnce(reconciliation.promise);
    bridgeMock.deleteRelayShareDiscussionMessage.mockRejectedValueOnce(
      new Error("response lost after commit"),
    );
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    const group = await openOwnerComments(user, "share-1");
    const row = await within(group).findByTestId("share-comment-message-1");
    await vi.waitFor(() => {
      expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(1);
    });
    const oldPoll = bridgeMock.pollRelayShareDiscussionActivity.mock.calls[0]![0];

    await user.click(within(row).getByRole("button", { name: "Delete comment" }));
    await user.click(
      within(within(group).getByTestId("owner-comments-confirmation")).getByRole(
        "button",
        { name: "Delete comment" },
      ),
    );

    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledTimes(2);
    });
    expect(within(group).queryByText("dohc could not complete that change.")).not.toBeNull();
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      shareId: "share-1",
      direction: "newest-first",
    });
    expect(bridgeMock.cancelRelayShareDiscussionActivity).toHaveBeenCalledWith({
      pollId: oldPoll.pollId,
    });
    expect(within(group).getByText("Delete after commit")).toBeTruthy();

    await act(async () => {
      reconciliation.resolve(
        discussionPage([tombstone], { activityRevision: 27 }),
      );
    });
    expect(
      await within(group).findByText("Comment deleted by the owner"),
    ).toBeTruthy();
    expect(within(group).queryByText("Delete after commit")).toBeNull();
    expect(within(group).queryByText("dohc could not complete that change.")).toBeNull();
    await vi.waitFor(() => {
      expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(2);
    });
    expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceId: "ws-1",
        shareId: "share-1",
        since: 27,
      }),
    );
  });

  it("keeps successor comments current while an old scope read settles", async () => {
    const scopeAFull = controllable<DiscussionPage>();
    const scopeBFull = controllable<DiscussionPage>();
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce({
        links: [readableLink("link-a", { shareId: "share-shared" })],
      })
      .mockResolvedValueOnce({
        links: [
          readableLink("link-b", {
            shareId: "share-shared",
            selector: { paths: [], versionId: "version-b" },
          }),
        ],
      });
    bridgeMock.listRelayShareDiscussion
      .mockResolvedValueOnce(
        discussionPage([linkComment("message-a", "Scope A state")], {
          activityRevision: 101,
          nextCursor: "older-a",
        }),
      )
      .mockReturnValueOnce(scopeAFull.promise)
      .mockResolvedValueOnce(
        discussionPage([linkComment("message-b", "Scope B state")], {
          activityRevision: 111,
          nextCursor: "older-b",
        }),
      )
      .mockReturnValueOnce(scopeBFull.promise);
    bridgeMock.blockRelayShareDiscussionPrincipal.mockRejectedValueOnce(
      new Error("scope A response lost after commit"),
    );
    const user = userEvent.setup();
    const view = render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    const groupA = await openOwnerComments(user, "share-shared");
    const rowA = await within(groupA).findByTestId("share-comment-message-a");
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-1",
      shareId: "share-shared",
      direction: "newest-first",
    });
    await vi.waitFor(() => {
      expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(1);
    });
    const pollA = bridgeMock.pollRelayShareDiscussionActivity.mock.calls[0]![0];
    expect(pollA).toMatchObject({
      workspaceId: "ws-1",
      shareId: "share-shared",
      since: 101,
    });
    await user.click(within(rowA).getByRole("button", { name: "Block" }));
    await user.click(
      within(within(groupA).getByTestId("owner-comments-confirmation")).getByRole(
        "button",
        { name: "Block" },
      ),
    );
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledTimes(2);
    });
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      shareId: "share-shared",
      direction: "newest-first",
    });
    expect(bridgeMock.cancelRelayShareDiscussionActivity).toHaveBeenCalledWith({
      pollId: pollA.pollId,
    });

    view.rerender(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "version", versionId: "version-b" }}
        onClose={() => {}}
      />,
    );
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });
    const groupB = await screen.findByTestId("share-link-group-share-shared");

    await user.click(within(groupB).getByRole("button", { name: "Comments" }));
    const seedB = await within(groupB).findByTestId("share-comment-message-b");
    expect(within(seedB).getByText("Scope B state")).toBeTruthy();
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenNthCalledWith(3, {
      workspaceId: "ws-1",
      shareId: "share-shared",
      direction: "newest-first",
    });
    await vi.waitFor(() => {
      expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(2);
    });
    const pollB = bridgeMock.pollRelayShareDiscussionActivity.mock.calls[1]![0];
    expect(pollB).toMatchObject({
      workspaceId: "ws-1",
      shareId: "share-shared",
      since: 111,
    });
    await user.click(within(seedB).getByRole("button", { name: "Block" }));
    await user.click(
      within(within(groupB).getByTestId("owner-comments-confirmation")).getByRole(
        "button",
        { name: "Block" },
      ),
    );
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledTimes(4);
    });
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenNthCalledWith(4, {
      workspaceId: "ws-1",
      shareId: "share-shared",
      direction: "newest-first",
    });
    expect(bridgeMock.cancelRelayShareDiscussionActivity).toHaveBeenCalledWith({
      pollId: pollB.pollId,
    });

    await act(async () => {
      scopeAFull.resolve(
        discussionPage([namedComment("message-a-late", "Late Scope A state")], {
          activityRevision: 102,
        }),
      );
    });
    expect(within(groupB).queryByText("Late Scope A state")).toBeNull();
    expect(within(groupB).queryByText("Scope A state")).toBeNull();
    expect(within(groupB).getByText("Scope B state")).toBeTruthy();
    const scopeBCursor = within(groupB).getByRole("button", {
      name: "Show more comments",
    });
    expect(scopeBCursor.hasAttribute("disabled")).toBe(true);
    await user.click(scopeBCursor);
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledTimes(4);
    expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(2);

    await act(async () => {
      scopeBFull.resolve(
        discussionPage([linkComment("message-b", "Scope B state", {
          blocked: true,
        })], {
          activityRevision: 112,
          nextCursor: "older-b",
        }),
      );
    });
    expect(within(groupB).queryByText("Late Scope A state")).toBeNull();
    const rowB = within(groupB).getByTestId("share-comment-message-b");
    expect(within(rowB).getByRole("button", { name: "Unblock" })).toBeTruthy();
    expect(
      within(groupB)
        .getByRole("button", { name: "Show more comments" })
        .hasAttribute("disabled"),
    ).toBe(false);
    await vi.waitFor(() => {
      expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(3);
    });
    expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        workspaceId: "ws-1",
        shareId: "share-shared",
        since: 112,
      }),
    );
  });

  it("promotes under the displayed parent and keeps direct End access reachable", async () => {
    const parentWithDependent = readableLink("parent-link", {
      shareId: "share-1",
      generation: 7,
      dependents: [
        dependent("dependent-1", "friend@example.test", "friend-user", "comment"),
      ],
    });
    const parentWithoutDependent = { ...parentWithDependent, dependents: [] };
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce({
        links: [parentWithDependent],
        supportedLinkAccess: ["view", "comment"],
        independentGrants: [],
      })
      .mockResolvedValueOnce({
        links: [parentWithoutDependent],
        supportedLinkAccess: ["view", "comment"],
        independentGrants: [
          independentGrant("dependent-1", { shareId: "share-1" }),
        ],
      })
      .mockResolvedValueOnce({
        links: [parentWithoutDependent],
        supportedLinkAccess: ["view", "comment"],
        independentGrants: [],
      });
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    const group = await openOwnerComments(user, "share-1");
    const dependentRow = await within(group).findByTestId(
      "share-dependent-dependent-1",
    );
    // Each person shows what they can do, not only how they joined.
    expect(dependentRow.textContent).toContain("Can comment · Joined through a link");
    await user.click(
      within(dependentRow).getByRole("button", { name: "Make independent" }),
    );
    let confirmation = within(group).getByTestId("owner-comments-confirmation");
    expect(confirmation.querySelector("p")?.textContent).toBe(
      "Make friend@example.test's access independent of this link? This is permanent. Resetting or ending the link no longer affects their access. You can end their access here at any time.",
    );
    await user.click(
      within(confirmation).getByRole("button", { name: "Make independent" }),
    );
    expect(bridgeMock.promoteRelayShareGrant).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      shareId: "share-1",
      grantId: "dependent-1",
      expectedParentGrantId: "parent-link",
      expectedParentGeneration: 7,
    });

    const independentRow = await within(group).findByTestId(
      "share-independent-dependent-1",
    );
    await user.click(
      within(independentRow).getByRole("button", { name: "End access" }),
    );
    confirmation = within(group).getByTestId("owner-comments-confirmation");
    expect(confirmation.querySelector("p")?.textContent).toBe(
      "End dependent-1@example.test's access? They lose access right away. Copies they already made stay with them.",
    );
    await user.click(
      within(confirmation).getByRole("button", { name: "End access" }),
    );
    expect(bridgeMock.revokeRelayShareGrant).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      shareId: "share-1",
      grantId: "dependent-1",
    });
    await act(async () => {});
    expect(within(group).queryByTestId("share-independent-dependent-1")).toBeNull();
    expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(3);
    expect(bridgeMock.listRelayShares).not.toHaveBeenCalled();
  });

  it("keeps hostile author names and comment bodies inert", async () => {
    const hostileName = `<img src=x onerror=alert(1)> javascript: data: \u202e%3C`;
    const hostileBody = `<script>bad()</script> [open](javascript:alert(1)) data:text/html,%3Csvg%3E`;
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion.mockResolvedValue(
      discussionPage([
        namedComment("hostile-named", hostileBody, hostileName),
        linkComment("hostile-link", "**literal Markdown**", {
          displayName: `Link ${hostileName}`,
        }),
      ]),
    );
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    const group = await openOwnerComments(user, "share-1");

    expect(await within(group).findByText(hostileBody)).toBeTruthy();
    expect(within(group).getByText(hostileName)).toBeTruthy();
    expect(within(group).getByText("**literal Markdown**")).toBeTruthy();
    // The card carries its own icons; the comments carry no markup at all.
    const comments = group.querySelectorAll("[data-comment-message-id]");
    expect(comments).toHaveLength(2);
    for (const comment of comments) {
      expect(comment.querySelector("a, img, script, svg, [href]")).toBeNull();
    }
  });

  it("keeps two live owner discussions isolated through deltas, history, cancellation, and a workspace switch", async () => {
    const activityCalls: Array<{
      payload: {
        workspaceId: string;
        shareId: string;
        since: number;
        hold: number;
        limit: number;
        pollId: string;
      };
      deferred: ReturnType<typeof controllable<DiscussionActivity>>;
    }> = [];
    bridgeMock.pollRelayShareDiscussionActivity.mockImplementation((payload) => {
      const deferred = controllable<DiscussionActivity>();
      activityCalls.push({ payload, deferred });
      return deferred.promise;
    });
    const activityCall = async (shareId: string, index: number) => {
      await vi.waitFor(() => {
        expect(
          activityCalls.filter((call) => call.payload.shareId === shareId).length,
        ).toBeGreaterThan(index);
      });
      return activityCalls.filter((call) => call.payload.shareId === shareId)[
        index
      ]!;
    };

    const aOlder = {
      ...namedComment("a-older", "A older"),
      createdAtMs: CREATED_MS + 10,
    };
    const aNewest = {
      ...namedComment("a-newest", "A newest"),
      createdAtMs: CREATED_MS + 20,
    };
    const bOnly = {
      ...namedComment("b-only", "B only"),
      createdAtMs: CREATED_MS + 15,
    };
    const external = {
      messageId: "a-external",
      createdAtMs: CREATED_MS + 30,
      deleted: false as const,
      body: "A external",
      author: {
        kind: "link" as const,
        displayName: "Link Visitor",
        unverified: true as const,
      },
      moderation: {
        linkGrantId: "link-grant-1",
        linkPrincipalId: "principal-a",
        blocked: false,
      },
    } satisfies RelayShareDiscussionMessage;
    const externalTombstone: RelayShareDiscussionMessage = {
      messageId: external.messageId,
      createdAtMs: external.createdAtMs,
      deleted: true,
      author: external.author,
      moderation: external.moderation,
    };
    const ancient = {
      ...namedComment("a-ancient", "A ancient"),
      createdAtMs: CREATED_MS,
    };
    const reopened = {
      ...namedComment("a-reopened", "A reopened"),
      createdAtMs: CREATED_MS + 40,
    };
    let initialReadsForA = 0;

    bridgeMock.listRelayShareLinks.mockImplementation(
      async ({ workspaceId }: { workspaceId: string }) => ({
        links:
          workspaceId === "ws-1"
            ? [
                readableLink("link-a", { shareId: "share-a" }),
                readableLink("link-b", { shareId: "share-b" }),
              ]
            : [readableLink("link-c", { shareId: "share-c" })],
      }),
    );
    bridgeMock.listRelayShareDiscussion.mockImplementation(
      async ({
        workspaceId,
        shareId,
        cursor,
      }: {
        workspaceId: string;
        shareId: string;
        cursor?: string;
      }) => {
        if (workspaceId === "ws-1" && shareId === "share-a" && cursor) {
          expect(cursor).toBe("older-a");
          return discussionPage([external, aOlder, ancient], {
            activityRevision: 12,
            linkCommentsPaused: true,
          });
        }
        if (workspaceId === "ws-1" && shareId === "share-a") {
          initialReadsForA += 1;
          return initialReadsForA === 1
            ? discussionPage([aNewest, aOlder], {
                activityRevision: 10,
                nextCursor: "older-a",
              })
            : discussionPage([reopened], { activityRevision: 30 });
        }
        if (workspaceId === "ws-1" && shareId === "share-b") {
          return discussionPage([bOnly], { activityRevision: 20 });
        }
        return discussionPage([], { activityRevision: 40 });
      },
    );

    const user = userEvent.setup();
    const view = render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    const groupA = await openOwnerComments(user, "share-a");
    const groupB = await openOwnerComments(user, "share-b");

    expect(await within(groupA).findByText("A older")).toBeTruthy();
    expect(within(groupA).getByText("A newest")).toBeTruthy();
    expect(await within(groupB).findByText("B only")).toBeTruthy();
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      shareId: "share-a",
      direction: "newest-first",
    });
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      shareId: "share-b",
      direction: "newest-first",
    });

    const a0 = await activityCall("share-a", 0);
    const b0 = await activityCall("share-b", 0);
    expect(a0.payload).toMatchObject({
      workspaceId: "ws-1",
      shareId: "share-a",
      since: 10,
      hold: 30_000,
      limit: 100,
    });
    expect(b0.payload).toMatchObject({
      workspaceId: "ws-1",
      shareId: "share-b",
      since: 20,
      hold: 30_000,
      limit: 100,
    });
    expect(a0.payload.pollId).not.toBe(b0.payload.pollId);

    await act(async () => {
      a0.deferred.resolve(
        discussionActivity(12, {
          cursorRevision: 11,
          hasMore: true,
          messages: [external],
        }),
      );
    });
    expect(within(groupA).queryByText("A external")).not.toBeNull();
    expect(within(groupB).queryByText("A external")).toBeNull();

    const a1 = await activityCall("share-a", 1);
    expect(a1.payload).toMatchObject({ since: 11, hold: 0, limit: 100 });
    await act(async () => {
      a1.deferred.resolve(
        discussionActivity(12, { messages: [externalTombstone] }),
      );
    });
    expect(
      await within(groupA).findByText("Comment deleted by the owner"),
    ).toBeTruthy();
    expect(within(groupA).queryByText("A external")).toBeNull();

    const a2 = await activityCall("share-a", 2);
    expect(a2.payload).toMatchObject({ since: 12, hold: 30_000, limit: 100 });
    await act(async () => {
      a2.deferred.resolve(
        discussionActivity(13, {
          principals: [{ principalId: "principal-a", blocked: true }],
          linkCommentsPaused: true,
        }),
      );
    });
    expect(
      await within(groupA).findByText(
        "Link comments are paused. People with links can still read everything.",
      ),
    ).toBeTruthy();
    expect(within(groupA).getByRole("button", { name: "Unblock" })).toBeTruthy();
    expect(within(groupB).queryByRole("button", { name: "Unblock" })).toBeNull();

    const a3 = await activityCall("share-a", 3);
    await act(async () => {
      a3.deferred.resolve(
        discussionActivity(14, {
          principals: [{ principalId: "principal-a", blocked: false }],
          linkCommentsPaused: false,
        }),
      );
    });
    await vi.waitFor(() => {
      expect(
        within(groupA).queryByText(
          "Link comments are paused. People with links can still read everything.",
        ),
      ).toBeNull();
    });
    expect(within(groupA).getByRole("button", { name: "Block" })).toBeTruthy();
    expect(within(groupB).getByText("B only")).toBeTruthy();

    await user.click(
      within(groupA).getByRole("button", { name: "Show more comments" }),
    );
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      shareId: "share-a",
      direction: "newest-first",
      cursor: "older-a",
    });
    expect(await within(groupA).findByText("A ancient")).toBeTruthy();
    expect(within(groupA).queryByText("A external")).toBeNull();
    expect(
      within(groupA).queryByText(
        "Link comments are paused. People with links can still read everything.",
      ),
    ).toBeNull();
    expect(
      Array.from(
        groupA.querySelectorAll<HTMLElement>("[data-comment-message-id]"),
        (node) => node.dataset.commentMessageId,
      ),
    ).toEqual(["a-ancient", "a-older", "a-newest", "a-external"]);

    const a4 = await activityCall("share-a", 4);
    await user.click(within(groupA).getByRole("button", { name: "Comments" }));
    expect(bridgeMock.cancelRelayShareDiscussionActivity).toHaveBeenCalledWith({
      pollId: a4.payload.pollId,
    });
    await user.click(within(groupA).getByRole("button", { name: "Comments" }));
    expect(await within(groupA).findByText("A reopened")).toBeTruthy();
    const a5 = await activityCall("share-a", 5);

    await act(async () => {
      a4.deferred.resolve(
        discussionActivity(15, {
          messages: [namedComment("late-after-collapse", "Late after collapse")],
        }),
      );
    });
    expect(within(groupA).queryByText("Late after collapse")).toBeNull();
    expect(within(groupA).getByText("A reopened")).toBeTruthy();

    view.rerender(
      <RelayShareDialog
        workspaceId="ws-2"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByTestId("share-link-group-share-c")).toBeTruthy();
    expect(bridgeMock.cancelRelayShareDiscussionActivity).toHaveBeenCalledWith({
      pollId: a5.payload.pollId,
    });
    expect(bridgeMock.cancelRelayShareDiscussionActivity).toHaveBeenCalledWith({
      pollId: b0.payload.pollId,
    });

    await act(async () => {
      a5.deferred.resolve(
        discussionActivity(31, {
          messages: [namedComment("late-a", "Late old workspace A")],
        }),
      );
      b0.deferred.resolve(
        discussionActivity(21, {
          messages: [namedComment("late-b", "Late old workspace B")],
        }),
      );
    });
    expect(screen.queryByText("Late old workspace A")).toBeNull();
    expect(screen.queryByText("Late old workspace B")).toBeNull();
  });

  it("keeps owner controls and existing link controls keyboard operable", async () => {
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("keyboard-link", { shareId: "share-keyboard" })],
    });
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    const group = await screen.findByTestId("share-link-group-share-keyboard");
    const comments = within(group).getByRole("button", { name: "Comments" });
    comments.focus();
    await user.keyboard("{Enter}");
    expect(
      await within(group).findByRole("textbox", { name: "Add a comment" }),
    ).toBeTruthy();
    for (const name of [
      "Can view",
      "Link options",
      "Add link",
      "Pause link comments",
      "Post",
    ]) {
      expect(within(group).getByRole("button", { name })).toBeTruthy();
    }
    // The row's ••• menu opens from the keyboard and moves with the arrows.
    const options = within(group).getByRole("button", { name: "Link options" });
    options.focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Reset link", hidden: true }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "End link", hidden: true }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { hidden: true })).toBeNull();
    expect(document.activeElement).toBe(options);
    expect(screen.getByRole("button", { name: "Create separate link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });
});

describe("advertised public Edit release", () => {
  it("does not offer Edit for a pinned version even when advertised", async () => {
    bridgeMock.listRelayShareLinks.mockResolvedValue({links: [], independentGrants: [], supportedLinkAccess: ["view", "comment", "edit"]});
    const user = userEvent.setup();
    render(<RelayShareDialog workspaceId="ws-1" target={{kind: "version", versionId: "version-7", versionName: "review"}} onClose={() => {}} />);
    await showLinkPane(user);
    expect(within(screen.getByRole("radiogroup", {name: "Link access"})).queryByRole("radio", {name: "Edit"})).toBeNull();
  });
});

// Sharing that cannot work yet says why before anyone fills in a share, with
// the one action that changes it, and holds the forms. The cause is About's
// rule for the workspace's own shares.
describe("sharing that cannot work yet", () => {
  const PLAN: RelayShareTarget = { kind: "paths", paths: ["docs/plan.md"] };
  // The controls a person would fill in, the share-with choice included.
  const formControls = () => [
    screen.getByRole("radio", { name: "Anyone with the link", hidden: true }),
    screen.getByTestId("share-access-edit"),
    screen.getByTestId("share-email"),
    screen.getByTestId("share-create"),
  ];

  it.each([
    {
      reason: "not-synced",
      cloud: { connected: true, workspaceSynced: false, workspaceSyncConnected: false },
      words: ["Sharing needs sync."],
      action: "Set up sync",
      runs: "openSyncSettings",
    },
    {
      reason: "signed-out",
      cloud: { connected: false, workspaceSynced: true, workspaceSyncConnected: false },
      words: ["Not connected to sync.example.org", "Others may have access."],
      action: "Connect server",
      runs: "connect",
    },
    {
      reason: "other-account",
      cloud: { connected: true, workspaceSynced: true, workspaceSyncConnected: false },
      words: [`${SYNC_UNCONFIRMED_ACCOUNT} Resume sync to share.`],
      action: "Sync and sharing",
      runs: "openSyncSettings",
    },
  ] as const)("$reason: says why, holds the forms, and offers $action", async (held) => {
    const context = accessContextFor(held.cloud);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <RelayShareDialog workspaceId="ws-1" target={PLAN} onClose={onClose}
        accessContext={context} server="https://sync.example.org" />,
    );

    const setup = screen.getByTestId("share-setup");
    expect(setup.dataset.reason).toBe(held.reason);
    expect([...setup.querySelectorAll("p")].map((line) => line.textContent)).toEqual(held.words);
    expect(setup.closest("[inert]")).toBeNull();
    for (const control of formControls()) expect(control.closest("[inert]")).not.toBeNull();

    // The dialog gives way to the place the action opens.
    await user.click(within(setup).getByRole("button", { name: held.action }));
    expect(context[held.runs]).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(bridgeMock.createRelayShare).not.toHaveBeenCalled();
    expect(bridgeMock.listRelayShareLinks).not.toHaveBeenCalled();
  });

  it("holds the forms, unexplained, until the server connection is read", () => {
    const view = render(
      <RelayShareDialog workspaceId="ws-1" target={PLAN} onClose={() => {}} accessContext={accessContextFor("checking")} />,
    );
    expect(screen.queryByTestId("share-setup")).toBeNull();
    for (const control of formControls()) expect(control.closest("[inert]")).not.toBeNull();

    view.rerender(<RelayShareDialog workspaceId="ws-1" target={PLAN} onClose={() => {}} accessContext={CAN_SHARE} />);
    expect(screen.queryByTestId("share-setup")).toBeNull();
    for (const control of formControls()) expect(control.closest("[inert]")).toBeNull();
  });

});
