// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ListRelayShareLinksResult,
  type RelayShareDiscussionMessage,
  type RelayShareGrantedRow,
} from "../ipc/bridgeContract";
import { RelayShareDialog, type RelayShareTarget } from "./RelayShareDialog";

const SHARE_CODE = "dohc-share:share-1:http://relay.test";
const LINK_URL = "https://relay.test/share/link-secret";
const LINK_URL_A = "https://relay.test/share/link-secret-a";
const LINK_URL_B = "https://relay.test/share/link-secret-b";
const PATHS_WARNING =
  "Anyone who has the link can read what you selected — no account needed. If files are added to this selection later, the link includes them. The sync relay serves the link, so it can read this content.";
const VERSION_WARNING =
  "Anyone who has the link can read what you selected — no account needed. The link shows this version as it is now. The sync relay serves the link, so it can read this content.";
const END_WARNING =
  "You can end the link at any time. Ending it stops future access, but can't take back copies people already made.";

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
  urlIssuedAtMs: number | null;
  dependents: LinkDependent[];
  selector: { paths: string[]; versionId: string | null };
  access: "view" | "comment";
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
    urlIssuedAtMs: CREATED_MS,
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
    urlIssuedAtMs: CREATED_MS,
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
  createRelayShare: vi.fn(),
  createRelayShareLink: vi.fn(),
  addRelayShareLink: vi.fn(),
  listRelayShareLinks: vi.fn(),
  retuneRelayShareLink: vi.fn(),
  rotateRelayShareLink: vi.fn(),
  revokeRelayShareLink: vi.fn(),
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
  writeClipboardText: vi.fn(),
};

vi.mock("./bridge", () => ({
  bridge: () => ({
    ...bridgeMock,
    listRelayShareLinks: async (...args: unknown[]) => ({
      independentGrants: [],
      ...(await bridgeMock.listRelayShareLinks(...args)),
    }),
  }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMock.createRelayShare.mockResolvedValue({
    shareId: "share-1",
    shareCode: SHARE_CODE,
    recipientEmail: "friend@dohc.test",
  });
  bridgeMock.createRelayShareLink.mockResolvedValue(linkResult(LINK_URL));
  bridgeMock.addRelayShareLink.mockResolvedValue(linkResult(LINK_URL));
  bridgeMock.listRelayShareLinks.mockResolvedValue({
    links: [],
    independentGrants: [],
  });
  bridgeMock.retuneRelayShareLink.mockResolvedValue({ outcome: "narrowed" });
  bridgeMock.rotateRelayShareLink.mockResolvedValue({
    outcome: "rotated",
    url: LINK_URL_B,
  });
  bridgeMock.revokeRelayShareLink.mockResolvedValue({ outcome: "ended" });
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
  });
  bridgeMock.writeClipboardText.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

async function showLinkPane(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: "Anyone with the link" }));
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

  const emailScopeChanges: Array<{
    name: string;
    initial: RelayShareTarget;
    next: RelayShareTarget;
    nextWorkspaceId: string;
  }> = [
    {
      name: "paths",
      initial: { kind: "paths", paths: ["docs/a.md"] },
      next: { kind: "paths", paths: ["docs/b.md"] },
      nextWorkspaceId: "ws-1",
    },
    {
      name: "target kind",
      initial: { kind: "paths", paths: ["docs/a.md"] },
      next: { kind: "version", versionId: "version-a" },
      nextWorkspaceId: "ws-1",
    },
    {
      name: "version",
      initial: { kind: "version", versionId: "version-a" },
      next: { kind: "version", versionId: "version-b" },
      nextWorkspaceId: "ws-1",
    },
    {
      name: "workspace",
      initial: { kind: "paths", paths: ["docs/a.md"] },
      next: { kind: "paths", paths: ["docs/a.md"] },
      nextWorkspaceId: "ws-2",
    },
  ];

  describe.each(emailScopeChanges)("email scope changes by $name", (scope) => {
    it.each(["success", "failure"] as const)(
      "ignores an old create %s while the current share is pending",
      async (outcome) => {
        const oldCreate = controllable<ReturnType<typeof emailResult>>();
        const currentCreate = controllable<ReturnType<typeof emailResult>>();
        bridgeMock.createRelayShare
          .mockReturnValueOnce(oldCreate.promise)
          .mockReturnValueOnce(currentCreate.promise);
        const user = userEvent.setup();
        const onClose = vi.fn();
        const view = render(
          <RelayShareDialog workspaceId="ws-1" target={scope.initial} onClose={onClose} />,
        );
        try {
          await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
          await user.click(screen.getByTestId("share-create"));
          expect(bridgeMock.createRelayShare).toHaveBeenCalledOnce();

          view.rerender(
            <RelayShareDialog
              workspaceId={scope.nextWorkspaceId}
              target={scope.next}
              onClose={onClose}
            />,
          );
          expect((screen.getByTestId("share-email") as HTMLInputElement).value).toBe("");
          await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
          await user.click(screen.getByTestId("share-create"));
          expect(bridgeMock.createRelayShare).toHaveBeenNthCalledWith(2, {
            workspaceId: scope.nextWorkspaceId,
            recipientEmail: "friend@dohc.test",
            access: "view",
            ...(scope.next.kind === "version"
              ? { versionId: scope.next.versionId }
              : { paths: scope.next.paths }),
          });

          await act(async () => {
            if (outcome === "success") oldCreate.resolve(emailResult("old"));
            else oldCreate.reject(new Error("Old share failed."));
          });
          expect(screen.queryByTestId("share-code")).toBeNull();
          expect(screen.queryByTestId("share-error")).toBeNull();
          expect((screen.getByTestId("share-create") as HTMLButtonElement).disabled).toBe(true);
          expect(screen.getByTestId("share-create").textContent).toBe("Creating share…");

          await act(async () => currentCreate.resolve(emailResult("current")));
          expect(screen.getByTestId("share-code").textContent).toBe(emailResult("current").shareCode);
          expect(screen.queryByText(emailResult("old").shareCode)).toBeNull();
          expect(screen.queryByTestId("share-error")).toBeNull();
        } finally {
          view.unmount();
          await act(async () => {
            oldCreate.resolve(emailResult("old"));
            currentCreate.resolve(emailResult("current"));
            await Promise.allSettled([oldCreate.promise, currentCreate.promise]);
          });
        }
      },
    );
  });

  it("does not mark a replacement email code copied when an old copy finishes", async () => {
    const oldCopy = controllable<void>();
    bridgeMock.createRelayShare
      .mockResolvedValueOnce(emailResult("old"))
      .mockResolvedValueOnce(emailResult("current"));
    bridgeMock.writeClipboardText.mockReturnValueOnce(oldCopy.promise);
    const user = userEvent.setup();
    const onClose = vi.fn();
    const view = render(
      <RelayShareDialog workspaceId="ws-1" target={{ kind: "paths", paths: ["docs/a.md"] }} onClose={onClose} />,
    );
    try {
      await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
      await user.click(screen.getByTestId("share-create"));
      await user.click(await screen.findByTestId("share-code-copy"));
      expect(bridgeMock.writeClipboardText).toHaveBeenCalledWith({ text: emailResult("old").shareCode });

      view.rerender(
        <RelayShareDialog workspaceId="ws-1" target={{ kind: "paths", paths: ["docs/b.md"] }} onClose={onClose} />,
      );
      expect(screen.queryByTestId("share-code")).toBeNull();
      await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
      await user.click(screen.getByTestId("share-create"));
      expect((await screen.findByTestId("share-code")).textContent).toBe(emailResult("current").shareCode);
      await act(async () => oldCopy.resolve());
      expect(screen.getByTestId("share-code-copy").textContent).toBe("Copy");
      await user.click(screen.getByTestId("share-code-copy"));
      expect(bridgeMock.writeClipboardText).toHaveBeenLastCalledWith({ text: emailResult("current").shareCode });
      expect(screen.getByTestId("share-code-copy").textContent).toBe("Copied");
    } finally {
      view.unmount();
      await act(async () => {
        oldCopy.resolve();
        await oldCopy.promise;
      });
    }
  });

  it.each<{ name: string; initial: RelayShareTarget; equivalent: RelayShareTarget }>([
    {
      name: "equivalent paths and a new label",
      initial: { kind: "paths", paths: ["docs/a.md", "docs/b.md"], label: "Before" },
      equivalent: { kind: "paths", paths: ["docs\\b.md", "docs/./a.md", "docs/tmp/../a.md"], label: "After" },
    },
    {
      name: "the same version with a new name",
      initial: { kind: "version", versionId: "version-a", versionName: "Before" },
      equivalent: { kind: "version", versionId: "version-a", versionName: "After" },
    },
  ])("keeps email state and pending work across pane switches and $name", async ({ initial, equivalent }) => {
    const create = controllable<ReturnType<typeof emailResult>>();
    const copy = controllable<void>();
    bridgeMock.createRelayShare.mockReturnValueOnce(create.promise);
    bridgeMock.writeClipboardText.mockReturnValueOnce(copy.promise);
    const user = userEvent.setup();
    const onClose = vi.fn();
    const view = render(<RelayShareDialog workspaceId="ws-1" target={initial} onClose={onClose} />);
    try {
      await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
      await user.click(screen.getByTestId("share-access-edit"));
      view.rerender(<RelayShareDialog workspaceId="ws-1" target={equivalent} onClose={onClose} />);
      await showLinkPane(user);
      await user.click(screen.getByRole("radio", { name: "Invite by email" }));
      expect((screen.getByTestId("share-email") as HTMLInputElement).value).toBe("friend@dohc.test");
      expect(screen.getByTestId("share-access-edit").getAttribute("aria-checked")).toBe("true");
      await user.click(screen.getByTestId("share-create"));
      expect(bridgeMock.createRelayShare).toHaveBeenCalledOnce();

      view.rerender(<RelayShareDialog workspaceId="ws-1" target={initial} onClose={onClose} />);
      await showLinkPane(user);
      await act(async () => create.resolve(emailResult("current")));
      await user.click(screen.getByRole("radio", { name: "Invite by email" }));
      expect(screen.getByTestId("share-code").textContent).toBe(emailResult("current").shareCode);
      await user.click(screen.getByTestId("share-code-copy"));
      view.rerender(<RelayShareDialog workspaceId="ws-1" target={equivalent} onClose={onClose} />);
      await showLinkPane(user);
      await act(async () => copy.resolve());
      await user.click(screen.getByRole("radio", { name: "Invite by email" }));
      expect(screen.getByTestId("share-code").textContent).toBe(emailResult("current").shareCode);
      expect(screen.getByTestId("share-code-copy").textContent).toBe("Copied");
      expect(bridgeMock.createRelayShare).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
      await act(async () => {
        create.resolve(emailResult("current"));
        copy.resolve();
        await Promise.allSettled([create.promise, copy.promise]);
      });
    }
  });

  it("defaults to email and hides its controls when switching to links", async () => {
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );

    const choice = screen.getByRole("radiogroup", { name: "Share with" });
    expect(
      within(choice).getByRole("radio", { name: "Invite by email" }).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect(
      within(choice).getByRole("radio", { name: "Anyone with the link" }).getAttribute(
        "aria-checked",
      ),
    ).toBe("false");
    expect(screen.getByTestId("share-email")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create link" })).toBeNull();
    await showLinkPane(user);
    expect(screen.queryByTestId("share-email")).toBeNull();
    expect(screen.getByRole("button", { name: "Create link" })).toBeTruthy();
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

  it("drops the read-only claim from the lead sentence", () => {
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/read-only live view/)).toBeNull();
  });

  it("creates a multi-path site artifact share with a simple label", async () => {
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{
          kind: "paths",
          paths: ["index.html", "assets/logo.png"],
          label: "Workspace Site",
        }}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/Workspace Site/)).toBeTruthy();
    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect(bridgeMock.createRelayShare).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      recipientEmail: "friend@dohc.test",
      access: "view",
      paths: ["index.html", "assets/logo.png"],
    });
  });

  it("shows View and Comment link access with the exact paths warning", async () => {
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );

    await showLinkPane(user);

    expect(screen.getByText("Access")).toBeTruthy();
    const linkAccess = screen.getByRole("radiogroup", { name: "Link access" });
    expect(within(linkAccess).getByRole("radio", { name: "View" })).toBeTruthy();
    expect(within(linkAccess).getByRole("radio", { name: "Comment" })).toBeTruthy();
    expect(screen.queryByText("Edit")).toBeNull();
    expect(screen.getByText(PATHS_WARNING).tagName).toBe("P");
    expect(screen.getByText(END_WARNING).tagName).toBe("P");
    expect(screen.queryByText(/Settings/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Reset|End link/ })).toBeNull();
  });

  it("shows the exact version warning", async () => {
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "version", versionId: "version-7", versionName: "review" }}
        onClose={() => {}}
      />,
    );

    await showLinkPane(user);

    expect(screen.getByText(VERSION_WARNING).tagName).toBe("P");
    expect(screen.getByText(END_WARNING).tagName).toBe("P");
    expect(screen.queryByText(PATHS_WARNING)).toBeNull();
  });

  it("loads links on pane entry, retries a stripped error, and leaves an empty inventory quiet", async () => {
    const firstRead = controllable<{ links: LinkRow[] }>();
    bridgeMock.listRelayShareLinks
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValueOnce({ links: [] });
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );

    expect(bridgeMock.listRelayShareLinks).not.toHaveBeenCalled();
    await showLinkPane(user);

    expect(screen.getByText("Links")).toBeTruthy();
    expect(screen.getByText("Loading links…")).toBeTruthy();
    expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledWith({ workspaceId: "ws-1" });

    await act(async () => {
      firstRead.reject(
        new Error(
          "Error invoking remote method 'desktop:list-relay-share-links': Error: The sync relay is unavailable.",
        ),
      );
    });

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The sync relay is unavailable.",
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Loading links…")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/No links|Nothing here|No active/)).toBeNull();
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
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
  });

  it("publishes inventory only after the last page arrives", async () => {
    const lastPage = controllable<{ links: LinkRow[] }>();
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce({
        links: [readableLink("first-page-visible")],
        nextCursor: "last-page",
      })
      .mockReturnValueOnce(lastPage.promise);
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );

    await showLinkPane(user);
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByTestId("share-link-row-first-page-visible")).toBeNull();
    expect(screen.getByText("Loading links…")).toBeTruthy();

    await act(async () => {
      lastPage.resolve({ links: [] });
    });
    expect(await screen.findByTestId("share-link-row-first-page-visible")).toBeTruthy();
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
          urlIssuedAtMs: resetAt,
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

    expect(within(rows[0]!).getByText("Not used yet")).toBeTruthy();
    expect(
      within(rows[0]!).getByText(
        `Created ${shortDate(CREATED_MS)} · Link reset ${shortDate(resetAt)}`,
      ),
    ).toBeTruthy();
    expect(
      within(rows[1]!).getByText(`Used as recently as ${shortTimestamp(usedAt)}`),
    ).toBeTruthy();
    expect(within(rows[1]!).getByText(`Created ${shortDate(CREATED_MS)}`)).toBeTruthy();
    expect(
      within(rows[2]!).getByText(
        `Created ${shortDate(CREATED_MS)} · Ended ${shortDate(endedAt)}`,
      ),
    ).toBeTruthy();
    expect(
      within(rows[2]!).getByText(`Used as recently as ${shortTimestamp(usedAt)}`),
    ).toBeTruthy();
    expect(
      within(rows[3]!).getByText(
        "Unreadable link — dohc can't read what this link shares",
      ),
    ).toBeTruthy();
    expect(within(rows[3]!).queryByRole("button", { name: "Reset link" })).toBeNull();
    expect(within(rows[3]!).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "End link",
    ]);
    expect(screen.queryByTestId("share-link-row-subset")).toBeNull();
    expect(screen.queryByTestId("share-link-row-overlap")).toBeNull();
    expect(screen.queryByTestId("share-link-row-unrelated")).toBeNull();
    expect(screen.queryByTestId("share-link-row-version-row")).toBeNull();
    expect(screen.queryByTestId("share-link-row-damaged-ended")).toBeNull();
  });

  it("matches version links only by the exact version id", async () => {
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [
        readableLink("right-version", {
          selector: { paths: [], versionId: "version-7" },
        }),
        readableLink("wrong-version", {
          selector: { paths: [], versionId: "version-8" },
        }),
        readableLink("same-paths-no-version", {
          selector: { paths: ["version-7"], versionId: null },
        }),
      ],
    });
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "version", versionId: "version-7" }}
        onClose={() => {}}
      />,
    );

    await showLinkPane(user);
    expect(await screen.findByTestId("share-link-row-right-version")).toBeTruthy();
    expect(screen.queryByTestId("share-link-row-wrong-version")).toBeNull();
    expect(screen.queryByTestId("share-link-row-same-paths-no-version")).toBeNull();
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
    await user.click(screen.getByRole("button", { name: "Create link" }));

    expect(bridgeMock.createRelayShareLink).toHaveBeenCalledWith({
      workspaceId: "physical-ws-1",
      paths: ["docs/plan.md", "assets/map.png"],
      access: "view",
    });
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
    await user.click(screen.getByRole("button", { name: "Create link" }));

    expect(bridgeMock.createRelayShareLink).toHaveBeenCalledWith({
      workspaceId: "physical-ws-1",
      versionId: "version-7",
      access: "view",
    });
  });

  it("disables Create link while pending and strips a current error", async () => {
    const request = controllable<LinkResult>();
    bridgeMock.createRelayShareLink.mockReturnValueOnce(request.promise);
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    await user.click(screen.getByRole("button", { name: "Create link" }));

    const pendingButton = screen.getByRole("button", { name: "Create link" });
    expect(pendingButton.textContent).toBe("Creating link…");
    expect(pendingButton.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      request.reject(
        new Error(
          "Error invoking remote method 'desktop:create-relay-share-link': Error: The sync relay refused this selection.",
        ),
      );
    });

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The sync relay refused this selection.",
    );
    expect(screen.getByRole("button", { name: "Create link" }).hasAttribute("disabled")).toBe(
      false,
    );
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
    expect(bridgeMock.writeClipboardText).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Create link" }));

    const url = await screen.findByTestId("share-link-url");
    expect(url.tagName).toBe("CODE");
    expect(url.textContent).toBe(LINK_URL);
    expect(screen.getByText("Copy the link now — dohc doesn't keep a copy.")).toBeTruthy();
    expect(screen.getByText("If you lose the link, reset it to get a new one.")).toBeTruthy();
    expect(
      screen.getByText(
        "To reset or end this link later, open Share on this selection again.",
      ),
    ).toBeTruthy();
    expect(bridgeMock.writeClipboardText).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(bridgeMock.writeClipboardText).toHaveBeenCalledTimes(1);
    expect(bridgeMock.writeClipboardText).toHaveBeenCalledWith({ text: LINK_URL });
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();

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

  it("shows every dependent identity and cancel never mutates a link", async () => {
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [
        readableLink("grant-link-1", {
          dependents: [
            dependent("dependent-z", "avery.long.address@example.test", "user-a"),
            dependent("dependent-a", null, "server-user-id-0000000002"),
          ],
        }),
      ],
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
    await user.click(within(row).getByRole("button", { name: "Reset link" }));
    let confirmation = screen.getByTestId("share-link-confirmation");
    expect(confirmation.querySelector("p")?.textContent).toBe(
      "Reset this link? The current link stops working right away, and dohc shows the new link once. People who joined through it keep access: avery.long.address@example.test, server-user-id-0000000002. To remove them, end the link instead.",
    );
    expect(
      within(confirmation).getByText("server-user-id-0000000002").tagName,
    ).toBe("CODE");
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));

    expect(bridgeMock.rotateRelayShareLink).not.toHaveBeenCalled();
    await user.click(within(row).getByRole("button", { name: "End link" }));
    confirmation = screen.getByTestId("share-link-confirmation");
    expect(confirmation.querySelector("p")?.textContent).toBe(
      "End this link? It stops working right away, and these people lose access through it: avery.long.address@example.test, server-user-id-0000000002. Copies they already made stay with them.",
    );
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));

    expect(bridgeMock.revokeRelayShareLink).not.toHaveBeenCalled();
  });

  it("loads and ends an active link after 1,000 mixed inventory rows", async () => {
    const firstRows = Array.from({ length: 1_000 }, (_, index) =>
      index % 2 === 0
        ? readableLink(`older-${String(index).padStart(4, "0")}`, {
            selector: { paths: [`archive/${index}.md`], versionId: null },
            status: index % 4 === 0 ? "active" : "revoked",
            revokedAtMs: index % 4 === 0 ? null : CREATED_MS + index,
          })
        : damagedLink(`damaged-${String(index).padStart(4, "0")}`, {
            status: "revoked",
            revokedAtMs: CREATED_MS + index,
          }),
    );
    const tail = readableLink("active-tail", { shareId: "share-active-tail" });
    bridgeMock.listRelayShareLinks
      .mockImplementationOnce(async () =>
        ListRelayShareLinksResult.parse({
          links: firstRows,
          independentGrants: [],
          nextCursor: "tail-page",
        }),
      )
      .mockImplementationOnce(async () =>
        ListRelayShareLinksResult.parse({
          links: [tail],
          independentGrants: [],
        }),
      )
      .mockResolvedValue({ links: [tail] });
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );

    await showLinkPane(user);
    const tailRow = await screen.findByTestId("share-link-row-active-tail");
    await user.click(within(tailRow).getByRole("button", { name: "End link" }));
    await user.click(
      within(screen.getByTestId("share-link-confirmation")).getByRole("button", {
        name: "End link",
      }),
    );

    expect(bridgeMock.revokeRelayShareLink).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      shareId: "share-active-tail",
      grantId: "active-tail",
      expectedDependentGrantIds: [],
    });
    expect(bridgeMock.listRelayShareLinks).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      cursor: "tail-page",
    });
  });

  it("bounds the independent grants carried by a link inventory page", () => {
    expect(
      ListRelayShareLinksResult.safeParse({
        links: [],
        independentGrants: Array.from({ length: 1_001 }, (_, index) => ({
          shareId: "share-1",
          grantId: `grant-${index}`,
          recipientUserId: `user-${index}`,
          recipientEmail: null,
        })),
      }).success,
    ).toBe(false);
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
    await user.click(screen.getByRole("button", { name: "Create link" }));
    expect((await screen.findByTestId("share-link-url")).textContent).toBe(LINK_URL);
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });

    const linkRow = screen.getByTestId("share-link-row-grant-link-1");
    await user.click(within(linkRow).getByRole("button", { name: "Reset link" }));
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

  it("ends with no dependents, clears its minted URL, and refreshes", async () => {
    const row = readableLink("grant-link-1", { shareId: "share-link-1" });
    bridgeMock.listRelayShareLinks.mockResolvedValue({ links: [row] });
    const end = controllable<{ outcome: "ended" }>();
    bridgeMock.revokeRelayShareLink.mockReturnValueOnce(end.promise);
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
    await user.click(screen.getByRole("button", { name: "Create link" }));
    expect((await screen.findByTestId("share-link-url")).textContent).toBe(LINK_URL);
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });

    const linkRow = screen.getByTestId("share-link-row-grant-link-1");
    await user.click(within(linkRow).getByRole("button", { name: "End link" }));
    const confirmation = screen.getByTestId("share-link-confirmation");
    expect(confirmation.querySelector("p")?.textContent).toBe(
      "End this link? It stops working right away. Copies people already made stay with them.",
    );
    await user.click(within(confirmation).getByRole("button", { name: "End link" }));

    expect(within(confirmation).getByRole("button", { name: "Ending…" })).toBeTruthy();
    expect(bridgeMock.revokeRelayShareLink).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      shareId: "share-link-1",
      grantId: "grant-link-1",
      expectedDependentGrantIds: [],
    });
    await act(async () => {
      end.resolve({ outcome: "ended" });
    });

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
      .mockResolvedValueOnce({ outcome: "ended" });
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
    await user.click(within(row).getByRole("button", { name: "End link" }));
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

    await user.click(
      within(screen.getByTestId("share-link-row-grant-link-1")).getByRole("button", {
        name: "End link",
      }),
    );
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
    await user.click(screen.getByRole("button", { name: "Create link" }));
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });
    await user.click(within(linkRow).getByRole("button", { name: "Reset link" }));
    expect(screen.getByTestId("share-link-confirmation")).toBeTruthy();

    await act(async () => {
      refresh.resolve({ links: [] });
    });

    expect(screen.queryByTestId("share-link-confirmation")).toBeNull();
    expect(screen.getByRole("button", { name: "Create link" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("ignores a stale inventory page without clearing the current loading state", async () => {
    const readAFirst = controllable<{ links: LinkRow[]; nextCursor: string }>();
    const readASecond = controllable<{ links: LinkRow[] }>();
    const readB = controllable<{ links: LinkRow[] }>();
    bridgeMock.listRelayShareLinks
      .mockReturnValueOnce(readAFirst.promise)
      .mockReturnValueOnce(readASecond.promise)
      .mockReturnValueOnce(readB.promise);
    const user = userEvent.setup();
    const view = render(
      <RelayShareDialog
        workspaceId="ws-a"
        target={{ kind: "paths", paths: ["docs/a.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);

    await act(async () => {
      readAFirst.resolve({ links: [], nextCursor: "ws-a-page-2" });
    });
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });
    expect(bridgeMock.listRelayShareLinks).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-a",
      cursor: "ws-a-page-2",
    });

    view.rerender(
      <RelayShareDialog
        workspaceId="ws-b"
        target={{ kind: "paths", paths: ["docs/b.md"] }}
        onClose={() => {}}
      />,
    );
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(3);
    });
    await act(async () => {
      readASecond.resolve({
        links: [
          readableLink("stale-a", {
            selector: { paths: ["docs/a.md"], versionId: null },
          }),
        ],
      });
    });

    expect(screen.queryByTestId("share-link-row-stale-a")).toBeNull();
    expect(screen.getByText("Loading links…")).toBeTruthy();

    await act(async () => {
      readB.resolve({
        links: [
          readableLink("current-b", {
            selector: { paths: ["docs/b.md"], versionId: null },
          }),
        ],
      });
    });
    expect(await screen.findByTestId("share-link-row-current-b")).toBeTruthy();
  });

  it("keeps B busy when a lifecycle success from A arrives late", async () => {
    const resetA = controllable<{ outcome: "rotated"; url: string }>();
    const endB = controllable<{ outcome: "ended" }>();
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
    await user.click(within(row).getByRole("button", { name: "Reset link" }));
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
    await user.click(within(row).getByRole("button", { name: "End link" }));
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
      endB.resolve({ outcome: "ended" });
    });
    expect(screen.queryByTestId("share-link-confirmation")).toBeNull();
  });

  it("ignores a lifecycle conflict after a target change and an error after unmount", async () => {
    const conflictA = controllable<{
      outcome: "dependents-changed";
      dependents: LinkDependent[];
    }>();
    const errorB = controllable<{ outcome: "ended" }>();
    bridgeMock.rotateRelayShareLink.mockReturnValueOnce(conflictA.promise);
    bridgeMock.revokeRelayShareLink.mockReturnValueOnce(errorB.promise);
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [
        readableLink("path-grant", {
          selector: { paths: ["docs/a.md"], versionId: null },
        }),
        readableLink("version-grant", {
          selector: { paths: [], versionId: "version-b" },
        }),
      ],
    });
    const user = userEvent.setup();
    const view = render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/a.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    let row = await screen.findByTestId("share-link-row-path-grant");
    await user.click(within(row).getByRole("button", { name: "Reset link" }));
    await user.click(
      within(screen.getByTestId("share-link-confirmation")).getByRole("button", {
        name: "Reset link",
      }),
    );

    view.rerender(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "version", versionId: "version-b" }}
        onClose={() => {}}
      />,
    );
    await act(async () => {
      conflictA.resolve({
        outcome: "dependents-changed",
        dependents: [dependent("stale-dependent", "stale@example.test", "stale-user")],
      });
    });

    expect(screen.queryByText(/Who has access through this link changed/)).toBeNull();
    expect(screen.queryByText(/stale@example\.test/)).toBeNull();
    row = await screen.findByTestId("share-link-row-version-grant");
    await user.click(within(row).getByRole("button", { name: "End link" }));
    await user.click(
      within(screen.getByTestId("share-link-confirmation")).getByRole("button", {
        name: "End link",
      }),
    );
    view.unmount();
    await act(async () => {
      errorB.reject(new Error("The late lifecycle request failed."));
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/The late lifecycle request failed/)).toBeNull();
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
    await user.click(screen.getByRole("button", { name: "Create link" }));

    view.rerender(
      <RelayShareDialog
        workspaceId="ws-b"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Create link" }));

    await act(async () => {
      requestA.resolve(linkResult(LINK_URL_A));
    });

    expect(screen.queryByText(LINK_URL_A)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    const pendingCreate = screen.getByRole("button", { name: "Create link" });
    expect(pendingCreate.textContent).toBe("Creating link…");
    expect(pendingCreate.hasAttribute("disabled")).toBe(true);
    expect(bridgeMock.writeClipboardText).not.toHaveBeenCalled();

    await act(async () => {
      requestB.resolve(linkResult(LINK_URL_B));
    });
    expect(screen.getByText(LINK_URL_B)).toBeTruthy();
  });

  it("ignores a stale error after the target changes without clearing B busy", async () => {
    const requestA = controllable<LinkResult>();
    const requestB = controllable<LinkResult>();
    bridgeMock.createRelayShareLink
      .mockReturnValueOnce(requestA.promise)
      .mockReturnValueOnce(requestB.promise);
    const user = userEvent.setup();
    const view = render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/a.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    await user.click(screen.getByRole("button", { name: "Create link" }));

    view.rerender(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "version", versionId: "version-b" }}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Create link" }));

    await act(async () => {
      requestA.reject(new Error("A failed after the target changed."));
    });

    expect(screen.queryByRole("alert")).toBeNull();
    const pendingCreate = screen.getByRole("button", { name: "Create link" });
    expect(pendingCreate.textContent).toBe("Creating link…");
    expect(pendingCreate.hasAttribute("disabled")).toBe(true);
    expect(bridgeMock.writeClipboardText).not.toHaveBeenCalled();

    await act(async () => {
      requestB.resolve(linkResult(LINK_URL_B));
    });
    expect(screen.getByText(LINK_URL_B)).toBeTruthy();
  });

  it("does not accept success or error after unmount", async () => {
    const success = controllable<LinkResult>();
    const failure = controllable<LinkResult>();
    bridgeMock.createRelayShareLink
      .mockReturnValueOnce(success.promise)
      .mockReturnValueOnce(failure.promise);
    const user = userEvent.setup();

    const first = render(
      <RelayShareDialog
        workspaceId="ws-a"
        target={{ kind: "paths", paths: ["docs/a.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    await user.click(screen.getByRole("button", { name: "Create link" }));
    first.unmount();
    await act(async () => {
      success.resolve(linkResult(LINK_URL_A));
    });

    const second = render(
      <RelayShareDialog
        workspaceId="ws-b"
        target={{ kind: "version", versionId: "version-b" }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    await user.click(screen.getByRole("button", { name: "Create link" }));
    second.unmount();
    await act(async () => {
      failure.reject(new Error("A failed after unmount."));
    });

    expect(screen.queryByText(LINK_URL_A)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(bridgeMock.writeClipboardText).not.toHaveBeenCalled();
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
    await user.click(screen.getByRole("button", { name: "Create link" }));
    await act(async () => {
      create.reject(new Error("The Create link response was lost."));
    });

    expect(await screen.findByText("The Create link response was lost.")).toBeTruthy();
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });
    const committedRow = await screen.findByTestId("share-link-row-committed-create");
    expect(within(committedRow).getByText("Comment")).toBeTruthy();
    for (const name of ["Turn off comments", "Reset link", "End link"]) {
      expect(within(committedRow).getByRole("button", { name })).toBeTruthy();
    }
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
    expect(
      within(firstGroup).getByText(
        "Another link to the same share. Same files, same comments.",
      ),
    ).toBeTruthy();

    await user.click(within(firstGroup).getByRole("radio", { name: "Comment" }));
    await user.click(within(firstGroup).getByRole("button", { name: "Add link" }));
    await vi.waitFor(() => {
      expect(bridgeMock.addRelayShareLink).toHaveBeenCalledTimes(1);
    });
    expect(bridgeMock.addRelayShareLink).toHaveBeenNthCalledWith(1, {
      workspaceId: "physical-ws-1",
      shareId: "share-one",
      access: "comment",
    });

    await user.click(within(secondGroup).getByRole("button", { name: "Add link" }));
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

  it("recovers a committed Add link after its response is lost", async () => {
    const add = controllable<LinkResult>();
    const existing = readableLink("existing-link", { shareId: "share-existing" });
    const committed = readableLink("committed-link", {
      shareId: "share-existing",
      access: "comment",
    });
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce({ links: [existing] })
      .mockResolvedValueOnce({ links: [existing, committed] });
    bridgeMock.addRelayShareLink.mockReturnValueOnce(add.promise);
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);

    const group = await screen.findByTestId("share-link-group-share-existing");
    await user.click(within(group).getByRole("radio", { name: "Comment" }));
    await user.click(within(group).getByRole("button", { name: "Add link" }));
    await act(async () => {
      add.reject(new Error("The Add link response was lost."));
    });

    expect(await screen.findByText("The Add link response was lost.")).toBeTruthy();
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });
    const committedRow = await screen.findByTestId("share-link-row-committed-link");
    expect(within(committedRow).getByText("Comment")).toBeTruthy();
    for (const name of ["Turn off comments", "Reset link", "End link"]) {
      expect(within(committedRow).getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.queryByTestId("share-link-url")).toBeNull();
    expect(bridgeMock.addRelayShareLink).toHaveBeenCalledTimes(1);
  });

  it("admits Add link only when the matching share still has an active grant", async () => {
    const revokedAtMs = CREATED_MS + 1;
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [
        readableLink("ended-link", {
          shareId: "share-ended",
          status: "revoked",
          revokedAtMs,
        }),
        readableLink("named-link", {
          shareId: "share-named",
          status: "revoked",
          revokedAtMs,
        }),
        readableLink("pending-link", {
          shareId: "share-pending",
          status: "revoked",
          revokedAtMs,
        }),
        readableLink("other-share-link", {
          shareId: "share-other-evidence",
          status: "revoked",
          revokedAtMs,
        }),
        readableLink("damaged-history", {
          shareId: "share-damaged",
          status: "revoked",
          revokedAtMs,
        }),
        damagedLink("damaged-active", { shareId: "share-damaged" }),
      ],
      independentGrants: [
        independentGrant("named-root", { shareId: "share-named" }),
        independentGrant("pending-root", {
          shareId: "share-pending",
          recipientUserId: null,
          recipientEmail: "pending@example.test",
        }),
        independentGrant("other-root", { shareId: "share-unrelated" }),
      ],
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

    const ended = await screen.findByTestId("share-link-group-share-ended");
    const named = screen.getByTestId("share-link-group-share-named");
    const pending = screen.getByTestId("share-link-group-share-pending");
    const otherEvidence = screen.getByTestId(
      "share-link-group-share-other-evidence",
    );
    const damaged = screen.getByTestId("share-link-group-share-damaged");

    for (const group of [ended, otherEvidence]) {
      expect(within(group).queryByRole("button", { name: "Add link" })).toBeNull();
      expect(
        within(group).queryByRole("radiogroup", { name: "Access for another link" }),
      ).toBeNull();
      expect(within(group).queryByRole("button", { name: "Comments" })).toBeNull();
    }
    for (const group of [named, pending, damaged]) {
      expect(within(group).getByRole("button", { name: "Add link" })).toBeTruthy();
      expect(within(group).getByRole("button", { name: "Comments" })).toBeTruthy();
    }

    const create = screen.getByRole("button", { name: "Create link" });
    expect(create.textContent).toBe("Create separate link");

    await user.click(within(named).getByRole("button", { name: "Comments" }));
    const namedGrant = await within(named).findByTestId(
      "share-independent-named-root",
    );
    expect(
      within(namedGrant).getByRole("button", { name: "End access" }),
    ).toBeTruthy();
    expect(within(pending).queryByTestId("share-independent-pending-root")).toBeNull();
    expect(bridgeMock.listRelayShares).not.toHaveBeenCalled();
  });

  it("builds independent access from bounded link pages without account inventory", async () => {
    const repeatedGrant = independentGrant("named-root", {
      shareId: "share-paged",
    });
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce({
        links: [readableLink("link-first", { shareId: "share-paged" })],
        independentGrants: [repeatedGrant],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        links: [readableLink("link-second", { shareId: "share-paged" })],
        independentGrants: [repeatedGrant],
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
    const group = await openOwnerComments(user, "share-paged");

    expect(bridgeMock.listRelayShareLinks).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-1",
    });
    expect(bridgeMock.listRelayShareLinks).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      cursor: "page-2",
    });
    expect(bridgeMock.listRelayShares).not.toHaveBeenCalled();
    expect(
      await within(group).findByTestId("share-independent-named-root"),
    ).toBeTruthy();
    expect(
      within(group).getAllByTestId("share-independent-named-root"),
    ).toHaveLength(1);
  });

  it("drains independent-grant pages before publishing a link page", async () => {
    const firstLink = readableLink("link-first", { shareId: "share-first" });
    const secondLink = readableLink("link-second", { shareId: "share-second" });
    const independentPage = controllable<{
      links: LinkRow[];
      independentGrants: ReadableGrantedRow[];
      nextCursor: string;
    }>();
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce({
        links: [firstLink],
        independentGrants: [
          independentGrant("independent-first", { shareId: "share-first" }),
        ],
        nextIndependentGrantCursor: "independent-page-2",
        nextCursor: "link-page-2",
      })
      .mockReturnValueOnce(independentPage.promise)
      .mockResolvedValueOnce({
        links: [secondLink],
        independentGrants: [
          independentGrant("independent-second", { shareId: "share-second" }),
        ],
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
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });
    expect(bridgeMock.listRelayShareLinks).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      independentGrantCursor: "independent-page-2",
    });
    expect(screen.queryByTestId("share-link-group-share-first")).toBeNull();

    await act(async () => {
      independentPage.resolve({
        links: [firstLink],
        independentGrants: [
          independentGrant("independent-first-tail", {
            shareId: "share-first",
          }),
        ],
        nextCursor: "link-page-2",
      });
    });

    expect(
      await screen.findByTestId("share-link-group-share-first"),
    ).toBeTruthy();
    expect(
      await screen.findByTestId("share-link-group-share-second"),
    ).toBeTruthy();
    expect(bridgeMock.listRelayShareLinks).toHaveBeenNthCalledWith(3, {
      workspaceId: "ws-1",
      cursor: "link-page-2",
    });
    const firstGroup = await openOwnerComments(user, "share-first");
    expect(
      within(firstGroup).getByTestId("share-independent-independent-first"),
    ).toBeTruthy();
    expect(
      within(firstGroup).getByTestId(
        "share-independent-independent-first-tail",
      ),
    ).toBeTruthy();
    expect(bridgeMock.listRelayShares).not.toHaveBeenCalled();
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
      within(inventoryError.parentElement!).getByRole("button", { name: "Retry" }),
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

  it("keeps equal selectors as separate shares and creates a separate Comment link", async () => {
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [
        readableLink("first", { shareId: "share-first" }),
        readableLink("second", { shareId: "share-second" }),
      ],
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

    expect(await screen.findByTestId("share-link-group-share-first")).toBeTruthy();
    expect(screen.getByTestId("share-link-group-share-second")).toBeTruthy();
    const create = screen.getByRole("button", { name: "Create link" });
    expect(create.textContent).toBe("Create separate link");
    expect(
      screen.getByText("A separate share of this selection, with its own comments."),
    ).toBeTruthy();
    const createAccess = screen.getByRole("radiogroup", { name: "Link access" });
    expect(within(createAccess).queryByRole("radio", { name: "Edit" })).toBeNull();
    await user.click(within(createAccess).getByRole("radio", { name: "Comment" }));
    await user.click(create);

    expect(bridgeMock.createRelayShareLink).toHaveBeenCalledWith({
      workspaceId: "physical-ws-1",
      paths: ["docs/plan.md"],
      access: "comment",
    });
  });

  it("keeps Create link when no share matches and honors a changed access choice", async () => {
    bridgeMock.listRelayShareLinks.mockResolvedValue({ links: [] });
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="physical-ws-1"
        target={{ kind: "version", versionId: "version-7" }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(1);
    });

    const create = screen.getByRole("button", { name: "Create link" });
    expect(create.textContent).toBe("Create link");
    expect(
      screen.queryByText("A separate share of this selection, with its own comments."),
    ).toBeNull();
    const createAccess = screen.getByRole("radiogroup", { name: "Link access" });
    expect(
      within(createAccess).getByRole("radio", { name: "View" }).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    await user.click(within(createAccess).getByRole("radio", { name: "Comment" }));
    await user.click(create);

    expect(bridgeMock.createRelayShareLink).toHaveBeenCalledWith({
      workspaceId: "physical-ws-1",
      versionId: "version-7",
      access: "comment",
    });
  });

  it("shows the settled retune warnings and cancel never retunes", async () => {
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [
        readableLink("view-link", {
          shareId: "share-view",
          access: "view",
          dependents: [
            dependent("view-person", "view@example.test", "view-user"),
            dependent(
              "comment-person",
              "comment@example.test",
              "comment-user",
              "comment",
            ),
          ],
        }),
        readableLink("comment-link", {
          shareId: "share-comment",
          access: "comment",
          dependents: [
            dependent("stays-view", "stays@example.test", "stays-user"),
            dependent(
              "drops-comment",
              "drops@example.test",
              "drops-user",
              "comment",
            ),
            dependent("drops-edit", "editor@example.test", "editor-user", "edit"),
          ],
        }),
      ],
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

    const viewRow = await screen.findByTestId("share-link-row-view-link");
    expect(within(viewRow).getByText("View")).toBeTruthy();
    await user.click(
      within(viewRow).getByRole("button", { name: "Turn on comments" }),
    );
    let confirmation = screen.getByTestId("share-link-confirmation");
    expect(confirmation.querySelector("p")?.textContent).toBe(
      "Turn on comments for this link? The current link stops working right away, and dohc shows the new link once. People who joined through it keep access and stay at their current level: view@example.test, comment@example.test.",
    );
    expect(
      within(confirmation).getByRole("button", { name: "Turn on comments" }),
    ).toBeTruthy();
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));

    const commentRow = screen.getByTestId("share-link-row-comment-link");
    expect(within(commentRow).getByText("Comment")).toBeTruthy();
    await user.click(
      within(commentRow).getByRole("button", { name: "Turn off comments" }),
    );
    confirmation = screen.getByTestId("share-link-confirmation");
    expect(confirmation.querySelector("p")?.textContent).toBe(
      "Turn off comments for this link? The same link keeps working, for viewing only. These people drop to view too: drops@example.test, editor@example.test.",
    );
    expect(
      within(confirmation).getByRole("button", { name: "Turn off comments" }),
    ).toBeTruthy();
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));

    expect(bridgeMock.retuneRelayShareLink).not.toHaveBeenCalled();
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
    await user.click(screen.getByRole("button", { name: "Create link" }));
    expect((await screen.findByTestId("share-link-url")).textContent).toBe(LINK_URL_A);
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });

    let row = screen.getByTestId("share-link-row-retune-link");
    await user.click(within(row).getByRole("button", { name: "Turn on comments" }));
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
    await user.click(within(row).getByRole("button", { name: "Turn off comments" }));
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
    await user.click(screen.getByRole("button", { name: "Create link" }));
    expect((await screen.findByTestId("share-link-url")).textContent).toBe(LINK_URL_A);
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });
    await user.click(within(row).getByRole("button", { name: "Turn on comments" }));
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
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(3);
    });
    expect(screen.queryByTestId("share-link-confirmation")).toBeNull();
    row = screen.getByTestId("share-link-row-stale-retune");
    expect(within(row).getByText("Comment")).toBeTruthy();
    expect(
      within(row).getByRole("button", { name: "Turn off comments" }),
    ).toBeTruthy();
    expect(bridgeMock.retuneRelayShareLink).toHaveBeenCalledTimes(1);
  });

  it("updates retune conflicts without retrying and requires fresh confirmation", async () => {
    const oldRow = readableLink("retune-conflict", {
      shareId: "share-retune",
      access: "comment",
      dependents: [
        dependent("old-comment", "old@example.test", "old-user", "comment"),
      ],
    });
    const freshDependents = [
      dependent("new-comment", "new@example.test", "new-user", "comment"),
    ];
    const freshRow = readableLink("retune-conflict", {
      shareId: "share-retune",
      access: "comment",
      dependents: freshDependents,
    });
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce({ links: [oldRow] })
      .mockResolvedValue({ links: [freshRow] });
    bridgeMock.retuneRelayShareLink.mockResolvedValueOnce({
      outcome: "dependents-changed",
      dependents: freshDependents,
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

    let row = await screen.findByTestId("share-link-row-retune-conflict");
    await user.click(within(row).getByRole("button", { name: "Turn off comments" }));
    let confirmation = screen.getByTestId("share-link-confirmation");
    expect(confirmation.textContent).toContain("old@example.test");
    await user.click(
      within(confirmation).getByRole("button", { name: "Turn off comments" }),
    );

    expect(
      await screen.findByText(
        "Who has access through this link changed. Check the updated names and confirm again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("share-link-confirmation")).toBeNull();
    expect(bridgeMock.retuneRelayShareLink).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });
    expect(bridgeMock.retuneRelayShareLink).toHaveBeenCalledTimes(1);

    row = screen.getByTestId("share-link-row-retune-conflict");
    await user.click(within(row).getByRole("button", { name: "Turn off comments" }));
    confirmation = screen.getByTestId("share-link-confirmation");
    expect(confirmation.textContent).toContain("new@example.test");
    expect(confirmation.textContent).not.toContain("old@example.test");
  });

  it("keeps grouped lifecycle actions keyboard operable and disables pending peers", async () => {
    const add = controllable<LinkResult>();
    bridgeMock.addRelayShareLink.mockReturnValueOnce(add.promise);
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
    const row = within(group).getByTestId("share-link-row-keyboard-link");
    const retune = within(row).getByRole("button", { name: "Turn on comments" });
    retune.focus();
    expect(document.activeElement).toBe(retune);
    await user.keyboard("{Enter}");
    const confirmation = screen.getByTestId("share-link-confirmation");
    const cancel = within(confirmation).getByRole("button", { name: "Cancel" });
    cancel.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("share-link-confirmation")).toBeNull();
    expect(bridgeMock.retuneRelayShareLink).not.toHaveBeenCalled();

    const addButton = within(group).getByRole("button", { name: "Add link" });
    addButton.focus();
    expect(document.activeElement).toBe(addButton);
    await user.keyboard("{Enter}");
    expect(
      within(group).getByRole("button", { name: "Adding link…" }).hasAttribute(
        "disabled",
      ),
    ).toBe(true);
    for (const name of ["Turn on comments", "Reset link", "End link"]) {
      expect(within(row).getByRole("button", { name }).hasAttribute("disabled")).toBe(
        true,
      );
    }
    expect(
      screen.getByRole("button", { name: "Create link" }).hasAttribute("disabled"),
    ).toBe(true);

    await act(async () => {
      add.resolve({ shareId: "share-keyboard", grantId: "added", url: LINK_URL });
    });
  });

  it("keeps a newer add busy when a stale add failure arrives", async () => {
    const addA = controllable<LinkResult>();
    const addB = controllable<LinkResult>();
    bridgeMock.addRelayShareLink
      .mockReturnValueOnce(addA.promise)
      .mockReturnValueOnce(addB.promise);
    bridgeMock.listRelayShareLinks.mockImplementation(
      async ({ workspaceId }: { workspaceId: string }) => ({
        links: [
          readableLink(`grant-${workspaceId}`, {
            shareId: `share-${workspaceId}`,
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
    let group = await screen.findByTestId("share-link-group-share-ws-a");
    await user.click(within(group).getByRole("button", { name: "Add link" }));

    view.rerender(
      <RelayShareDialog
        workspaceId="ws-b"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    group = await screen.findByTestId("share-link-group-share-ws-b");
    await user.click(within(group).getByRole("button", { name: "Add link" }));
    await act(async () => {
      addA.reject(new Error("The stale add failed."));
    });

    expect(screen.queryByText("The stale add failed.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Adding link…" }).hasAttribute("disabled"),
    ).toBe(true);

    await act(async () => {
      addB.resolve({ shareId: "share-ws-b", grantId: "added-b", url: LINK_URL_B });
    });
    expect((await screen.findByTestId("share-link-url")).textContent).toBe(LINK_URL_B);
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
    await user.click(within(row).getByRole("button", { name: "Turn on comments" }));
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
    await user.click(within(row).getByRole("button", { name: "Turn off comments" }));
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

  it("keeps the named result separate when returning from a minted link", async () => {
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );

    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect((await screen.findByTestId("share-code")).textContent).toBe(SHARE_CODE);

    await showLinkPane(user);
    await user.click(screen.getByRole("button", { name: "Create link" }));
    expect((await screen.findByTestId("share-link-url")).textContent).toBe(LINK_URL);

    await user.click(screen.getByRole("radio", { name: "Invite by email" }));
    expect(screen.queryByText(LINK_URL)).toBeNull();
    expect(screen.getByTestId("share-code").textContent).toBe(SHARE_CODE);
    expect(screen.getByText("friend@dohc.test")).toBeTruthy();
    expect(bridgeMock.createRelayShare).toHaveBeenCalledTimes(1);
    expect(bridgeMock.createRelayShare).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      recipientEmail: "friend@dohc.test",
      access: "view",
      paths: ["docs/plan.md"],
    });
    expect(bridgeMock.writeClipboardText).not.toHaveBeenCalled();
  });

  it("keeps one collapsed Comments section per eligible real share", async () => {
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [
        readableLink("link-a", { shareId: "share-a" }),
        readableLink("link-b", { shareId: "share-b" }),
        damagedLink("damaged-only", { shareId: "share-damaged" }),
      ],
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

    const groupA = await screen.findByTestId("share-link-group-share-a");
    const groupB = screen.getByTestId("share-link-group-share-b");
    const damaged = screen.getByTestId("share-link-group-share-damaged");
    expect(within(groupA).getByRole("button", { name: "Comments" }).textContent).toBe(
      "Comments",
    );
    expect(within(groupB).getByRole("button", { name: "Comments" }).textContent).toBe(
      "Comments",
    );
    expect(within(damaged).queryByRole("button", { name: "Comments" })).toBeNull();
    expect(bridgeMock.listRelayShareDiscussion).not.toHaveBeenCalled();

    await user.click(within(groupA).getByRole("button", { name: "Comments" }));
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      shareId: "share-a",
      direction: "newest-first",
    });
    expect(await within(groupA).findByText("No comments yet.")).toBeTruthy();
    expect(within(groupB).queryByText("No comments yet.")).toBeNull();
  });

  it("promotes a named dependent under a damaged sibling in an eligible group", async () => {
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [
        readableLink("readable-parent", { shareId: "share-mixed" }),
        damagedLink("damaged-parent", {
          shareId: "share-mixed",
          generation: 9,
          dependents: [
            dependent(
              "damaged-dependent",
              "damaged@example.test",
              "damaged-user",
              "comment",
            ),
          ],
        }),
      ],
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
    const group = await openOwnerComments(user, "share-mixed");

    const dependentRow = await within(group).findByTestId(
      "share-dependent-damaged-dependent",
    );
    await user.click(
      within(dependentRow).getByRole("button", { name: "Make independent" }),
    );
    await user.click(
      within(within(group).getByTestId("owner-comments-confirmation")).getByRole(
        "button",
        { name: "Make independent" },
      ),
    );

    expect(bridgeMock.promoteRelayShareGrant).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      shareId: "share-mixed",
      grantId: "damaged-dependent",
      expectedParentGrantId: "damaged-parent",
      expectedParentGeneration: 9,
    });
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

  it("orders equal-timestamp comments by the relay message id across pages", async () => {
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion
      .mockResolvedValueOnce(
        discussionPage([namedComment("a", "Lowercase a")], {
          nextCursor: "cursor-1",
        }),
      )
      .mockResolvedValueOnce(discussionPage([namedComment("Z", "Uppercase Z")]));
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

    expect(await within(group).findByText("Lowercase a")).toBeTruthy();
    await user.click(
      within(group).getByRole("button", { name: "Show more comments" }),
    );
    expect(await within(group).findByText("Uppercase Z")).toBeTruthy();
    expect(
      Array.from(
        group.querySelectorAll<HTMLElement>("[data-comment-message-id]"),
        (node) => node.dataset.commentMessageId,
      ),
    ).toEqual(["Z", "a"]);
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
    expect(await within(group).findByText("Couldn't post comment.")).toBeTruthy();
    expect((field as HTMLTextAreaElement).value).toBe("Keep this draft");
    await user.click(within(group).getByRole("button", { name: "Retry" }));
    expect(bridgeMock.appendRelayShareDiscussion).toHaveBeenCalledTimes(2);
    expect(bridgeMock.appendRelayShareDiscussion.mock.calls[1]?.[0]).toEqual(
      firstPayload,
    );
    expect(await within(group).findByText("Couldn't post comment.")).toBeTruthy();

    await user.type(field, "!");
    expect(within(group).queryByRole("button", { name: "Retry" })).toBeNull();
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

  it("keeps the last good owner comment and revision when activity reuses its id", async () => {
    const conflict = controllable<DiscussionActivity>();
    const original = namedComment("message-1", "Original");
    const forged = namedComment("message-1", "Forged");
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion.mockResolvedValue(
      discussionPage([original], { activityRevision: 1 }),
    );
    bridgeMock.pollRelayShareDiscussionActivity
      .mockReturnValueOnce(conflict.promise)
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

    expect(await within(group).findByText("Original")).toBeTruthy();
    await vi.waitFor(() => {
      expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      conflict.resolve(
        discussionActivity(2, {
          messages: [forged],
        }),
      );
    });

    await vi.waitFor(() => {
      expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(2);
    });
    expect(within(group).getByText("Original")).toBeTruthy();
    expect(within(group).queryByText("Forged")).toBeNull();
    expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ since: 1 }),
    );
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

  it("keeps the last good window when a full read conflicts on an existing id", async () => {
    const original = namedComment("message-1", "Original");
    const forged = namedComment("message-1", "Forged");
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion
      .mockResolvedValueOnce(
        discussionPage([original], { activityRevision: 1 }),
      )
      .mockResolvedValueOnce(
        discussionPage([forged], { activityRevision: 2 }),
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
    expect(await within(group).findByText("Original")).toBeTruthy();

    await user.click(within(group).getByRole("button", { name: "Comments" }));
    await user.click(within(group).getByRole("button", { name: "Comments" }));

    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledTimes(2);
    });
    expect(within(group).queryByText("Couldn't load comments.") !== null).toBe(
      true,
    );
    expect(within(group).queryByText("Original") !== null).toBe(true);
    expect(within(group).queryByText("Forged")).toBeNull();
  });

  it.each([
    {
      label: "more than 2,000 normalized code points",
      body: "a".repeat(2_001),
    },
    {
      label: "more than 8,000 raw bytes despite a short NFC form",
      body: "\u1100\u1161\u11a8".repeat(889),
    },
  ])("keeps an owner draft with $label local and editable", async ({ body }) => {
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
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
    const field = within(group).getByRole("textbox", { name: "Add a comment" });

    fireEvent.change(field, { target: { value: body } });

    const alert = within(group).queryByRole("alert");
    expect(alert).not.toBeNull();
    if (alert === null) return;
    expect(alert.textContent).toBe(
      "This comment is too long. Shorten it before posting.",
    );
    expect(alert.id).not.toBe("");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(alert.id);
    expect((field as HTMLTextAreaElement).disabled).toBe(false);
    expect(within(group).getByRole("button", { name: "Post" }).hasAttribute("disabled"))
      .toBe(true);
    expect(within(group).queryByRole("button", { name: "Retry" })).toBeNull();
    expect(bridgeMock.appendRelayShareDiscussion).not.toHaveBeenCalled();
  });

  it.each([
    ["leading", "\u0000hello", "hello"],
    ["interior", "hello\u0000world", "helloworld"],
  ] as const)(
    "removes a %s NUL before an owner draft can post",
    async (_case, draft, visible) => {
      bridgeMock.listRelayShareLinks.mockResolvedValue({
        links: [readableLink("link-1", { shareId: "share-1" })],
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
      const field = within(group).getByRole("textbox", { name: "Add a comment" });

      fireEvent.change(field, { target: { value: draft } });

      expect((field as HTMLTextAreaElement).value).toBe(visible);
      expect(
        within(group).queryByText(
          "This comment is too long. Shorten it before posting.",
        ),
      ).toBeNull();
      const post = within(group).getByRole("button", { name: "Post" });
      expect(post.hasAttribute("disabled")).toBe(false);
      await user.click(post);

      expect(bridgeMock.appendRelayShareDiscussion).toHaveBeenCalledTimes(1);
      const payload = bridgeMock.appendRelayShareDiscussion.mock.calls[0]?.[0];
      expect(payload).toMatchObject({
        workspaceId: "ws-1",
        shareId: "share-1",
        body: visible,
      });
      expect(payload?.body).not.toContain("\u0000");
    },
  );

  it("posts an owner draft at the exact body boundary", async () => {
    const body = "😀".repeat(2_000);
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
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
    const field = within(group).getByRole("textbox", { name: "Add a comment" });

    fireEvent.change(field, { target: { value: body } });

    expect(field.hasAttribute("aria-invalid")).toBe(false);
    expect(field.hasAttribute("aria-describedby")).toBe(false);
    expect(within(group).queryByText("This comment is too long.")).toBeNull();
    const post = within(group).getByRole("button", { name: "Post" });
    expect(post.hasAttribute("disabled")).toBe(false);
    await user.click(post);
    expect(bridgeMock.appendRelayShareDiscussion).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      shareId: "share-1",
      body,
      idempotencyKey: expect.stringMatching(/^[\x20-\x7e]{1,64}$/u),
    });
  });

  it("retries a failed discussion load without changing the draft", async () => {
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion
      .mockRejectedValueOnce(new Error("private relay detail"))
      .mockResolvedValueOnce(discussionPage([namedComment("message-1", "Loaded")]));
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
    expect(await within(group).findByText("Couldn't load comments.")).toBeTruthy();
    const field = within(group).getByRole("textbox", { name: "Add a comment" });
    await user.type(field, "Draft survives");
    await user.click(within(group).getByRole("button", { name: "Retry" }));
    expect(await within(group).findByText("Loaded")).toBeTruthy();
    expect(within(group).queryByText("Couldn't load comments.")).toBeNull();
    expect((field as HTMLTextAreaElement).value).toBe("Draft survives");
  });

  it("retries a failed authoritative refresh without the stale page cursor", async () => {
    const live = namedComment("message-1", "Delete this body");
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
      .mockResolvedValueOnce(
        discussionPage([live], { nextCursor: "stale-page-cursor" }),
      )
      .mockRejectedValueOnce(new Error("authoritative refresh failed"))
      .mockResolvedValueOnce(discussionPage([tombstone]));
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
    const message = await within(group).findByTestId("share-comment-message-1");
    await user.click(
      within(message).getByRole("button", { name: "Delete comment" }),
    );
    await user.click(
      within(within(group).getByTestId("owner-comments-confirmation")).getByRole(
        "button",
        { name: "Delete comment" },
      ),
    );

    expect(await within(group).findByText("Couldn't load comments.")).toBeTruthy();
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      shareId: "share-1",
      direction: "newest-first",
    });
    await user.click(within(group).getByRole("button", { name: "Retry" }));
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenNthCalledWith(3, {
      workspaceId: "ws-1",
      shareId: "share-1",
      direction: "newest-first",
    });
    expect(
      await within(group).findByText("Comment deleted by the owner"),
    ).toBeTruthy();
    expect(within(group).queryByText("Delete this body")).toBeNull();
  });

  it("retries a failed page with the same opaque cursor and keeps earlier rows", async () => {
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion
      .mockResolvedValueOnce(
        discussionPage([namedComment("message-1", "First page")], {
          nextCursor: "opaque-page-cursor",
        }),
      )
      .mockRejectedValueOnce(new Error("page failed"))
      .mockResolvedValueOnce(
        discussionPage([namedComment("message-2", "Second page")]),
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
    expect(await within(group).findByText("First page")).toBeTruthy();
    await user.click(
      within(group).getByRole("button", { name: "Show more comments" }),
    );

    expect(await within(group).findByText("Couldn't load comments.")).toBeTruthy();
    expect(within(group).getByText("First page")).toBeTruthy();
    await user.click(within(group).getByRole("button", { name: "Retry" }));
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenNthCalledWith(3, {
      workspaceId: "ws-1",
      shareId: "share-1",
      direction: "newest-first",
      cursor: "opaque-page-cursor",
    });
    expect(await within(group).findByText("Second page")).toBeTruthy();
    expect(within(group).getByText("First page")).toBeTruthy();
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
    expect(within(group).queryByText("Couldn't complete that change.")).toBeNull();
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
    expect(within(group).queryByText("Couldn't complete that change.")).not.toBeNull();
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
    expect(within(group).queryByText("Couldn't complete that change.")).toBeNull();
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

  it("keeps an authoritative reconciliation ahead of a blocked history-page request", async () => {
    const available = linkComment("message-1", "Moderate after commit");
    const blocked = linkComment("message-1", "Moderate after commit", {
      blocked: true,
    });
    const reconciliation = controllable<DiscussionPage>();
    const mutation = controllable<unknown>();
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion
      .mockResolvedValueOnce(
        discussionPage([available], {
          activityRevision: 81,
          nextCursor: "older-page",
        }),
      )
      .mockReturnValueOnce(reconciliation.promise);
    bridgeMock.blockRelayShareDiscussionPrincipal.mockReturnValueOnce(
      mutation.promise,
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
    const showMore = within(group).getByRole("button", {
      name: "Show more comments",
    });

    await user.click(within(row).getByRole("button", { name: "Block" }));
    await user.click(
      within(within(group).getByTestId("owner-comments-confirmation")).getByRole(
        "button",
        { name: "Block" },
      ),
    );

    await act(async () => {
      mutation.reject(new Error("block response lost after commit"));
      await Promise.resolve();
      fireEvent.click(showMore);
    });
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledTimes(2);
    });
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      shareId: "share-1",
      direction: "newest-first",
    });
    expect(within(group).queryByText("Couldn't complete that change.")).not.toBeNull();
    expect(
      within(group)
        .getByRole("button", { name: "Show more comments" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledTimes(2);
    expect(within(group).queryByText("Couldn't complete that change.")).not.toBeNull();

    await act(async () => {
      reconciliation.resolve(
        discussionPage([blocked], {
          activityRevision: 82,
          nextCursor: "older-page",
        }),
      );
    });

    const refreshedRow = within(group).getByTestId("share-comment-message-1");
    expect(
      within(refreshedRow).queryByRole("button", { name: "Unblock" }),
    ).not.toBeNull();
    expect(within(group).queryByText("Couldn't complete that change.")).toBeNull();
    expect(bridgeMock.cancelRelayShareDiscussionActivity).toHaveBeenCalledWith({
      pollId: oldPoll.pollId,
    });
    await vi.waitFor(() => {
      expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(2);
    });
    expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceId: "ws-1",
        shareId: "share-1",
        since: 82,
      }),
    );
  });

  it("keeps reconciliation priority through a failed full read and retry", async () => {
    const available = linkComment("message-1", "Moderate through retry");
    const blocked = linkComment("message-1", "Moderate through retry", {
      blocked: true,
    });
    const retry = controllable<DiscussionPage>();
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion
      .mockResolvedValueOnce(
        discussionPage([available], {
          activityRevision: 91,
          nextCursor: "older-page",
        }),
      )
      .mockRejectedValueOnce(new Error("reconciliation read failed"))
      .mockImplementationOnce(({ cursor }: { cursor?: string }) =>
        cursor === undefined
          ? retry.promise
          : Promise.resolve(
              discussionPage([available], {
                activityRevision: 91,
                nextCursor: null,
              }),
            ),
      );
    bridgeMock.blockRelayShareDiscussionPrincipal.mockRejectedValueOnce(
      new Error("block response lost after commit"),
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

    await user.click(within(row).getByRole("button", { name: "Block" }));
    await user.click(
      within(within(group).getByTestId("owner-comments-confirmation")).getByRole(
        "button",
        { name: "Block" },
      ),
    );

    expect(await within(group).findByText("Couldn't load comments.")).toBeTruthy();
    expect(within(group).queryByText("Couldn't complete that change.")).not.toBeNull();
    expect(within(group).getByText("Moderate through retry")).toBeTruthy();
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledTimes(2);
    const showMore = within(group).getByRole("button", {
      name: "Show more comments",
    });
    expect(showMore.hasAttribute("disabled")).toBe(true);
    await user.click(showMore);
    expect(within(group).queryByText("Couldn't load comments.")).not.toBeNull();
    expect(within(group).queryByText("Couldn't complete that change.")).not.toBeNull();
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledTimes(2);

    await user.click(within(group).getByRole("button", { name: "Retry" }));
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenNthCalledWith(3, {
      workspaceId: "ws-1",
      shareId: "share-1",
      direction: "newest-first",
    });
    expect(within(group).queryByText("Couldn't load comments.")).not.toBeNull();
    expect(within(group).queryByText("Couldn't complete that change.")).not.toBeNull();
    expect(within(group).getByText("Moderate through retry")).toBeTruthy();
    const retryShowMore = within(group).getByRole("button", {
      name: "Show more comments",
    });
    expect(retryShowMore.hasAttribute("disabled")).toBe(true);
    await user.click(retryShowMore);
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledTimes(3);

    await act(async () => {
      retry.resolve(
        discussionPage([blocked], {
          activityRevision: 92,
          nextCursor: "older-page",
        }),
      );
    });

    const refreshedRow = within(group).getByTestId("share-comment-message-1");
    expect(
      within(refreshedRow).queryByRole("button", { name: "Unblock" }),
    ).not.toBeNull();
    expect(within(group).queryByText("Couldn't load comments.")).toBeNull();
    expect(within(group).queryByText("Couldn't complete that change.")).toBeNull();
    expect(bridgeMock.cancelRelayShareDiscussionActivity).toHaveBeenCalledWith({
      pollId: oldPoll.pollId,
    });
    await vi.waitFor(() => {
      expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(2);
    });
    expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceId: "ws-1",
        shareId: "share-1",
        since: 92,
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

  it("reconciles lost block and unblock responses without reading either inventory", async () => {
    const available = linkComment("message-1", "Moderate after commit");
    const blocked = linkComment("message-1", "Moderate after commit", {
      blocked: true,
    });
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion
      .mockResolvedValueOnce(discussionPage([available], { activityRevision: 31 }))
      .mockResolvedValueOnce(discussionPage([blocked], { activityRevision: 32 }))
      .mockResolvedValueOnce(discussionPage([available], { activityRevision: 33 }));
    bridgeMock.blockRelayShareDiscussionPrincipal.mockRejectedValueOnce(
      new Error("block response lost after commit"),
    );
    bridgeMock.unblockRelayShareDiscussionPrincipal.mockRejectedValueOnce(
      new Error("unblock response lost after commit"),
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
    let row = await within(group).findByTestId("share-comment-message-1");
    const linkInventoryCalls = bridgeMock.listRelayShareLinks.mock.calls.length;
    const grantInventoryCalls = bridgeMock.listRelayShares.mock.calls.length;

    await user.click(within(row).getByRole("button", { name: "Block" }));
    await user.click(
      within(within(group).getByTestId("owner-comments-confirmation")).getByRole(
        "button",
        { name: "Block" },
      ),
    );
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledTimes(2);
    });
    row = await within(group).findByTestId("share-comment-message-1");
    expect(await within(row).findByRole("button", { name: "Unblock" })).toBeTruthy();

    await user.click(within(row).getByRole("button", { name: "Unblock" }));
    row = await within(group).findByTestId("share-comment-message-1");
    expect(await within(row).findByRole("button", { name: "Block" })).toBeTruthy();
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      shareId: "share-1",
      direction: "newest-first",
    });
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenNthCalledWith(3, {
      workspaceId: "ws-1",
      shareId: "share-1",
      direction: "newest-first",
    });
    expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(linkInventoryCalls);
    expect(bridgeMock.listRelayShares).toHaveBeenCalledTimes(grantInventoryCalls);
    await vi.waitFor(() => {
      expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(3);
    });
    expect(
      bridgeMock.pollRelayShareDiscussionActivity.mock.calls.map(
        ([payload]) => payload.since,
      ),
    ).toEqual([31, 32, 33]);
  });

  it("reconciles lost pause and resume responses without reading either inventory", async () => {
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion
      .mockResolvedValueOnce(discussionPage([], { activityRevision: 41 }))
      .mockResolvedValueOnce(
        discussionPage([], {
          activityRevision: 42,
          linkCommentsPaused: true,
        }),
      )
      .mockResolvedValueOnce(discussionPage([], { activityRevision: 43 }));
    bridgeMock.pauseRelayShareDiscussion.mockRejectedValueOnce(
      new Error("pause response lost after commit"),
    );
    bridgeMock.resumeRelayShareDiscussion.mockRejectedValueOnce(
      new Error("resume response lost after commit"),
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
    expect(
      await within(group).findByRole("button", { name: "Pause link comments" }),
    ).toBeTruthy();
    const linkInventoryCalls = bridgeMock.listRelayShareLinks.mock.calls.length;
    const grantInventoryCalls = bridgeMock.listRelayShares.mock.calls.length;

    await user.click(
      within(group).getByRole("button", { name: "Pause link comments" }),
    );
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledTimes(2);
    });
    expect(
      await within(group).findByText(
        "Link comments are paused. People with links can still read everything.",
      ),
    ).toBeTruthy();
    expect(
      within(group).getByRole("button", { name: "Resume link comments" }),
    ).toBeTruthy();

    await user.click(
      within(group).getByRole("button", { name: "Resume link comments" }),
    );
    expect(
      await within(group).findByRole("button", { name: "Pause link comments" }),
    ).toBeTruthy();
    expect(
      within(group).queryByText(
        "Link comments are paused. People with links can still read everything.",
      ),
    ).toBeNull();
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      shareId: "share-1",
      direction: "newest-first",
    });
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenNthCalledWith(3, {
      workspaceId: "ws-1",
      shareId: "share-1",
      direction: "newest-first",
    });
    expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(linkInventoryCalls);
    expect(bridgeMock.listRelayShares).toHaveBeenCalledTimes(grantInventoryCalls);
    await vi.waitFor(() => {
      expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(3);
    });
    expect(
      bridgeMock.pollRelayShareDiscussionActivity.mock.calls.map(
        ([payload]) => payload.since,
      ),
    ).toEqual([41, 42, 43]);
  });

  it("keeps the loaded discussion and both errors until reconciliation retry succeeds", async () => {
    const live = namedComment("message-1", "Still loaded after read failure");
    const tombstone: RelayShareDiscussionMessage = {
      messageId: "message-1",
      createdAtMs: CREATED_MS,
      deleted: true,
      author: { kind: "named", displayName: "Owner Name" },
    };
    const retry = controllable<DiscussionPage>();
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion
      .mockResolvedValueOnce(discussionPage([live], { activityRevision: 51 }))
      .mockRejectedValueOnce(new Error("reconciliation read failed"))
      .mockReturnValueOnce(retry.promise);
    bridgeMock.deleteRelayShareDiscussionMessage.mockRejectedValueOnce(
      new Error("delete response lost after commit"),
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
    expect(await within(group).findByText("Couldn't load comments.")).toBeTruthy();
    expect(
      within(group).queryByText("Couldn't complete that change."),
    ).not.toBeNull();
    expect(within(group).getByText("Still loaded after read failure")).toBeTruthy();
    expect(bridgeMock.cancelRelayShareDiscussionActivity).toHaveBeenCalledWith({
      pollId: oldPoll.pollId,
    });
    expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(1);

    await user.click(within(group).getByRole("button", { name: "Retry" }));
    expect(
      within(group).queryByText("Couldn't complete that change."),
    ).not.toBeNull();
    expect(within(group).getByText("Still loaded after read failure")).toBeTruthy();
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenNthCalledWith(3, {
      workspaceId: "ws-1",
      shareId: "share-1",
      direction: "newest-first",
    });
    await act(async () => {
      retry.resolve(discussionPage([tombstone], { activityRevision: 52 }));
    });

    expect(
      await within(group).findByText("Comment deleted by the owner"),
    ).toBeTruthy();
    expect(within(group).queryByText("Couldn't load comments.")).toBeNull();
    expect(within(group).queryByText("Couldn't complete that change.")).toBeNull();
    expect(within(group).queryByText("Still loaded after read failure")).toBeNull();
    await vi.waitFor(() => {
      expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(2);
    });
    expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        shareId: "share-1",
        since: 52,
      }),
    );
  });

  it("does not reconcile a rejected mutation from a replaced target", async () => {
    const pause = controllable<{ linkCommentsPaused: true }>();
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
        discussionPage([namedComment("message-a", "Old target state")], {
          activityRevision: 61,
        }),
      )
      .mockResolvedValueOnce(
        discussionPage([namedComment("message-b", "Current target state")], {
          activityRevision: 71,
        }),
      )
      .mockResolvedValueOnce(
        discussionPage([], {
          activityRevision: 62,
          linkCommentsPaused: true,
        }),
      );
    bridgeMock.pauseRelayShareDiscussion.mockReturnValueOnce(pause.promise);
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
    expect(await within(groupA).findByText("Old target state")).toBeTruthy();
    await user.click(
      within(groupA).getByRole("button", { name: "Pause link comments" }),
    );

    view.rerender(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "version", versionId: "version-b" }}
        onClose={() => {}}
      />,
    );
    const groupB = await openOwnerComments(user, "share-shared");
    expect(await within(groupB).findByText("Current target state")).toBeTruthy();
    const discussionCallsBeforeRejection =
      bridgeMock.listRelayShareDiscussion.mock.calls.length;

    await act(async () => {
      pause.reject(new Error("old target response lost after commit"));
    });

    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledTimes(
      discussionCallsBeforeRejection,
    );
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      shareId: "share-shared",
      direction: "newest-first",
    });
    expect(screen.queryByText("Old target state")).toBeNull();
    expect(screen.queryByText("Couldn't complete that change.")).toBeNull();
    expect(
      screen.queryByText(
        "Link comments are paused. People with links can still read everything.",
      ),
    ).toBeNull();
    expect(within(groupB).getByText("Current target state")).toBeTruthy();
  });

  it("keeps a confirmation-action error visible through its pending retry", async () => {
    const retry = controllable<{
      message: { messageId: string; createdAtMs: number; deleted: true };
    }>();
    const reconciliation = controllable<DiscussionPage>();
    const live = namedComment("message-1", "Retry deletion");
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
      .mockResolvedValueOnce(discussionPage([live]))
      .mockReturnValueOnce(reconciliation.promise)
      .mockResolvedValueOnce(discussionPage([tombstone]));
    bridgeMock.deleteRelayShareDiscussionMessage
      .mockRejectedValueOnce(new Error("delete failed"))
      .mockReturnValueOnce(retry.promise);
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
    await user.click(within(row).getByRole("button", { name: "Delete comment" }));
    await user.click(
      within(within(group).getByTestId("owner-comments-confirmation")).getByRole(
        "button",
        { name: "Delete comment" },
      ),
    );
    expect(await within(group).findByText("Couldn't complete that change.")).toBeTruthy();

    await user.click(within(row).getByRole("button", { name: "Delete comment" }));
    expect(within(group).getByText("Couldn't complete that change.")).toBeTruthy();
    await user.click(
      within(within(group).getByTestId("owner-comments-confirmation")).getByRole(
        "button",
        { name: "Delete comment" },
      ),
    );
    expect(bridgeMock.deleteRelayShareDiscussionMessage).toHaveBeenCalledTimes(2);
    expect(within(group).getByText("Couldn't complete that change.")).toBeTruthy();

    await act(async () => {
      retry.resolve({
        message: {
          messageId: "message-1",
          createdAtMs: CREATED_MS,
          deleted: true,
        },
      });
    });
    expect(
      await within(group).findByText("Comment deleted by the owner"),
    ).toBeTruthy();
    expect(within(group).queryByText("Couldn't complete that change.")).toBeNull();
  });

  it("keeps a direct pause error visible through its pending retry", async () => {
    const retry = controllable<{ linkCommentsPaused: true }>();
    const reconciliation = controllable<DiscussionPage>();
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion
      .mockResolvedValueOnce(discussionPage())
      .mockReturnValueOnce(reconciliation.promise)
      .mockResolvedValueOnce(discussionPage([], { linkCommentsPaused: true }));
    bridgeMock.pauseRelayShareDiscussion
      .mockRejectedValueOnce(new Error("pause failed"))
      .mockReturnValueOnce(retry.promise);
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
    await user.click(
      within(group).getByRole("button", { name: "Pause link comments" }),
    );
    expect(await within(group).findByText("Couldn't complete that change.")).toBeTruthy();

    await user.click(
      within(group).getByRole("button", { name: "Pause link comments" }),
    );
    expect(bridgeMock.pauseRelayShareDiscussion).toHaveBeenCalledTimes(2);
    expect(within(group).getByText("Couldn't complete that change.")).toBeTruthy();
    await act(async () => {
      retry.resolve({ linkCommentsPaused: true });
    });
    expect(
      await within(group).findByText(
        "Link comments are paused. People with links can still read everything.",
      ),
    ).toBeTruthy();
    expect(within(group).queryByText("Couldn't complete that change.")).toBeNull();
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
        independentGrants: [],
      })
      .mockResolvedValueOnce({
        links: [parentWithoutDependent],
        independentGrants: [
          independentGrant("dependent-1", { shareId: "share-1" }),
        ],
      })
      .mockResolvedValueOnce({
        links: [parentWithoutDependent],
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

  it("refreshes stale owner inventories after promotion fails and keeps recovery reachable", async () => {
    const retry = controllable<{
      grantId: string;
      access: "comment";
      generation: number;
      status: "active";
      revokedAtMs: null;
      parentGrantId: null;
    }>();
    const staleParent = readableLink("parent-link", {
      shareId: "share-1",
      generation: 7,
      dependents: [
        dependent("dependent-1", "friend@example.test", "friend-user", "comment"),
      ],
    });
    const currentParent = { ...staleParent, generation: 8 };
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce({
        links: [staleParent],
        independentGrants: [independentGrant("stale-independent")],
      })
      .mockResolvedValueOnce({
        links: [currentParent],
        independentGrants: [independentGrant("current-independent")],
      });
    bridgeMock.promoteRelayShareGrant
      .mockRejectedValueOnce(new Error("stale parent generation"))
      .mockReturnValueOnce(retry.promise);
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
    expect(
      await within(group).findByTestId("share-independent-stale-independent"),
    ).toBeTruthy();
    await user.click(
      within(await within(group).findByTestId("share-dependent-dependent-1"))
        .getByRole("button", { name: "Make independent" }),
    );
    await user.click(
      within(within(group).getByTestId("owner-comments-confirmation")).getByRole(
        "button",
        { name: "Make independent" },
      ),
    );

    expect(await within(group).findByText("Couldn't complete that change.")).toBeTruthy();
    expect(
      await within(group).findByTestId("share-independent-current-independent"),
    ).toBeTruthy();
    expect(
      within(group).queryByTestId("share-independent-stale-independent"),
    ).toBeNull();
    expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    expect(bridgeMock.listRelayShares).not.toHaveBeenCalled();
    expect(within(group).getByText("Couldn't complete that change.")).toBeTruthy();

    await user.click(
      within(within(group).getByTestId("share-dependent-dependent-1")).getByRole(
        "button",
        { name: "Make independent" },
      ),
    );
    expect(within(group).getByText("Couldn't complete that change.")).toBeTruthy();
    await user.click(
      within(within(group).getByTestId("owner-comments-confirmation")).getByRole(
        "button",
        { name: "Make independent" },
      ),
    );
    expect(bridgeMock.promoteRelayShareGrant).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      shareId: "share-1",
      grantId: "dependent-1",
      expectedParentGrantId: "parent-link",
      expectedParentGeneration: 8,
    });
    expect(within(group).getByText("Couldn't complete that change.")).toBeTruthy();
  });

  it("retries an initial bounded inventory failure without account inventory", async () => {
    bridgeMock.listRelayShareLinks
      .mockRejectedValueOnce(new Error("private inventory failure"))
      .mockResolvedValueOnce({
        links: [readableLink("link-1", { shareId: "share-1" })],
        independentGrants: [independentGrant("independent-1")],
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
    const error = await screen.findByText("private inventory failure");

    await user.click(
      within(error.parentElement!).getByRole("button", { name: "Retry" }),
    );
    expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    const group = await openOwnerComments(user, "share-1");
    expect(
      await within(group).findByTestId("share-independent-independent-1"),
    ).toBeTruthy();
    expect(screen.queryByText("private inventory failure")).toBeNull();
    expect(within(group).getByRole("button", { name: "End access" })).toBeTruthy();
    expect(bridgeMock.listRelayShares).not.toHaveBeenCalled();
  });

  it("keeps promotion recovery reachable when its bounded refresh fails", async () => {
    const parentWithDependent = readableLink("parent-link", {
      shareId: "share-1",
      generation: 7,
      dependents: [
        dependent("dependent-1", "friend@example.test", "friend-user", "comment"),
      ],
    });
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce({
        links: [parentWithDependent],
        independentGrants: [
          independentGrant("existing-1", { shareId: "share-1" }),
        ],
      })
      .mockRejectedValueOnce(new Error("bounded refresh failure"))
      .mockResolvedValueOnce({
        links: [{ ...parentWithDependent, dependents: [] }],
        independentGrants: [
          independentGrant("existing-1", { shareId: "share-1" }),
          independentGrant("dependent-1", { shareId: "share-1" }),
        ],
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
    await user.click(
      within(await within(group).findByTestId("share-dependent-dependent-1"))
        .getByRole("button", { name: "Make independent" }),
    );
    await user.click(
      within(within(group).getByTestId("owner-comments-confirmation")).getByRole(
        "button",
        { name: "Make independent" },
      ),
    );

    const error = await screen.findByText("bounded refresh failure");
    expect(within(group).getByTestId("share-dependent-dependent-1")).toBeTruthy();
    expect(
      within(group).queryByTestId("share-independent-dependent-1"),
    ).toBeNull();
    expect(within(group).queryByTestId("share-independent-existing-1")).toBeNull();
    expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    await user.click(
      within(error.parentElement!).getByRole("button", { name: "Retry" }),
    );
    expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(3);
    const independent = await within(group).findByTestId(
      "share-independent-dependent-1",
    );
    expect(within(independent).getByRole("button", { name: "End access" })).toBeTruthy();
    expect(within(group).queryByTestId("share-dependent-dependent-1")).toBeNull();
    expect(bridgeMock.listRelayShares).not.toHaveBeenCalled();
  });

  it("ignores a bounded inventory failure from an old target", async () => {
    const stale = controllable<{
      links: LinkRow[];
      independentGrants: ReadableGrantedRow[];
    }>();
    bridgeMock.listRelayShareLinks
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({
        links: [readableLink("version-link", {
          shareId: "share-version",
          selector: { paths: [], versionId: "version-2" },
        })],
        independentGrants: [],
      });
    const user = userEvent.setup();
    const view = render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(1);
    });
    view.rerender(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "version", versionId: "version-2" }}
        onClose={() => {}}
      />,
    );
    const group = await openOwnerComments(user, "share-version");
    await act(async () => {
      stale.reject(new Error("stale inventory failure"));
    });
    expect(screen.queryByText("stale inventory failure")).toBeNull();
    expect(within(group).getByRole("button", { name: "Comments" })).toBeTruthy();
    expect(bridgeMock.listRelayShares).not.toHaveBeenCalled();
  });

  it("ignores an older bounded refresh failure after a replacement target request", async () => {
    const stale = controllable<{
      links: LinkRow[];
      independentGrants: ReadableGrantedRow[];
    }>();
    const parent = readableLink("parent-link", {
      shareId: "share-1",
      dependents: [
        dependent("dependent-1", "friend@example.test", "friend-user", "comment"),
      ],
    });
    const versionLink = readableLink("version-link", {
      shareId: "share-version",
      selector: { paths: [], versionId: "version-2" },
    });
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce({ links: [parent], independentGrants: [] })
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({
        links: [versionLink],
        independentGrants: [
          independentGrant("version-root", { shareId: "share-version" }),
        ],
      });
    const user = userEvent.setup();
    const view = render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    const group = await openOwnerComments(user, "share-1");
    await user.click(
      within(await within(group).findByTestId("share-dependent-dependent-1"))
        .getByRole("button", { name: "Make independent" }),
    );
    await user.click(
      within(within(group).getByTestId("owner-comments-confirmation")).getByRole(
        "button",
        { name: "Make independent" },
      ),
    );
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(2);
    });
    view.rerender(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "version", versionId: "version-2" }}
        onClose={() => {}}
      />,
    );
    const versionGroup = await openOwnerComments(user, "share-version");
    expect(
      await within(versionGroup).findByTestId("share-independent-version-root"),
    ).toBeTruthy();
    await act(async () => {
      stale.reject(new Error("replaced inventory failure"));
    });
    expect(screen.queryByText("replaced inventory failure")).toBeNull();
    expect(within(versionGroup).getByTestId("share-independent-version-root")).toBeTruthy();
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
    expect(group.querySelector("a, img, script, svg, [href]")).toBeNull();
  });

  it("lets a newer read win and refuses an append after Close", async () => {
    const firstRead = controllable<DiscussionPage>();
    const secondRead = controllable<DiscussionPage>();
    const append = controllable<{ message: RelayShareDiscussionMessage }>();
    const onClose = vi.fn();
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise);
    bridgeMock.appendRelayShareDiscussion.mockReturnValueOnce(append.promise);
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={onClose}
      />,
    );
    await showLinkPane(user);
    const group = await openOwnerComments(user, "share-1");
    await user.click(within(group).getByRole("button", { name: "Comments" }));
    await user.click(within(group).getByRole("button", { name: "Comments" }));
    await act(async () => {
      secondRead.resolve(discussionPage([namedComment("current", "Current page")]));
    });
    expect(await within(group).findByText("Current page")).toBeTruthy();
    const activityPollId =
      bridgeMock.pollRelayShareDiscussionActivity.mock.calls[0]![0].pollId;
    await act(async () => {
      firstRead.resolve(discussionPage([namedComment("stale", "Stale page")]));
    });
    expect(within(group).queryByText("Stale page")).toBeNull();

    const field = within(group).getByRole("textbox", { name: "Add a comment" });
    await user.type(field, "Late append");
    await user.click(within(group).getByRole("button", { name: "Post" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(bridgeMock.cancelRelayShareDiscussionActivity).toHaveBeenCalledWith({
      pollId: activityPollId,
    });
    await act(async () => {
      append.resolve({ message: namedComment("late", "Late append") });
    });
    expect(within(group).queryByTestId("share-comment-late")).toBeNull();
  });

  it("settles concurrent discussion reads for different shares independently", async () => {
    const readA = controllable<DiscussionPage>();
    const readB = controllable<DiscussionPage>();
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [
        readableLink("link-a", { shareId: "share-a" }),
        readableLink("link-b", { shareId: "share-b" }),
      ],
    });
    bridgeMock.listRelayShareDiscussion
      .mockReturnValueOnce(readA.promise)
      .mockReturnValueOnce(readB.promise);
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    const groupA = await openOwnerComments(user, "share-a");
    const groupB = await openOwnerComments(user, "share-b");

    await act(async () => {
      readB.resolve(discussionPage([namedComment("message-b", "From B")]));
    });
    expect(await within(groupB).findByText("From B")).toBeTruthy();
    await act(async () => {
      readA.resolve(discussionPage([namedComment("message-a", "From A")]));
    });
    expect(await within(groupA).findByText("From A")).toBeTruthy();
    expect(within(groupB).getByText("From B")).toBeTruthy();
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

  it("applies current principal activity states to an older page captured before the delta", async () => {
    const olderPage = controllable<DiscussionPage>();
    const firstActivity = controllable<DiscussionActivity>();
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion.mockImplementation(
      ({ cursor }: { cursor?: string }) =>
        cursor === undefined
          ? Promise.resolve(
              discussionPage([], {
                activityRevision: 10,
                nextCursor: "older",
              }),
            )
          : olderPage.promise,
    );
    bridgeMock.pollRelayShareDiscussionActivity.mockReturnValueOnce(
      firstActivity.promise,
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
    await user.click(
      within(group).getByRole("button", { name: "Show more comments" }),
    );
    expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      shareId: "share-1",
      direction: "newest-first",
      cursor: "older",
    });

    await act(async () => {
      firstActivity.resolve(
        discussionActivity(11, {
          principals: [
            { principalId: "principal-blocked", blocked: true },
            { principalId: "principal-unblocked", blocked: false },
          ],
        }),
      );
    });
    await vi.waitFor(() => {
      expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      olderPage.resolve(
        discussionPage([
          linkComment("stale-blocked", "Stale blocked state", {
            linkPrincipalId: "principal-blocked",
            blocked: false,
          }),
          linkComment("stale-unblocked", "Stale unblocked state", {
            linkPrincipalId: "principal-unblocked",
            blocked: true,
          }),
        ]),
      );
    });

    expect(
      within(await screen.findByTestId("share-comment-stale-blocked")).getByRole(
        "button",
        { name: "Unblock" },
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("share-comment-stale-unblocked")).getByRole(
        "button",
        { name: "Block" },
      ),
    ).toBeTruthy();
  });

  it("keeps the last activity page visible while retrying only an expanded share", async () => {
    const retry = controllable<DiscussionActivity>();
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [readableLink("link-1", { shareId: "share-1" })],
    });
    bridgeMock.listRelayShareDiscussion.mockResolvedValue(
      discussionPage([namedComment("kept", "Kept through retry")], {
        activityRevision: 9,
      }),
    );
    bridgeMock.pollRelayShareDiscussionActivity
      .mockRejectedValueOnce(new Error("transient activity failure"))
      .mockReturnValueOnce(retry.promise);

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
    expect(await within(group).findByText("Kept through retry")).toBeTruthy();
    await vi.waitFor(() => {
      expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(2);
    });
    const retryPayload =
      bridgeMock.pollRelayShareDiscussionActivity.mock.calls[1]![0];
    expect(retryPayload).toMatchObject({
      workspaceId: "ws-1",
      shareId: "share-1",
      since: 9,
      hold: 30_000,
      limit: 100,
    });
    expect(within(group).getByText("Kept through retry")).toBeTruthy();

    await user.click(within(group).getByRole("button", { name: "Comments" }));
    expect(bridgeMock.cancelRelayShareDiscussionActivity).toHaveBeenCalledWith({
      pollId: retryPayload.pollId,
    });
    expect(bridgeMock.pollRelayShareDiscussionActivity).toHaveBeenCalledTimes(2);
  });

  it("keeps a mutation refresh current while another share is read", async () => {
    const refreshA = controllable<DiscussionPage>();
    const readB = controllable<DiscussionPage>();
    bridgeMock.listRelayShareLinks.mockResolvedValue({
      links: [
        readableLink("link-a", { shareId: "share-a" }),
        readableLink("link-b", { shareId: "share-b" }),
      ],
    });
    bridgeMock.listRelayShareDiscussion
      .mockResolvedValueOnce(
        discussionPage([namedComment("message-a-old", "A before refresh")]),
      )
      .mockReturnValueOnce(refreshA.promise)
      .mockReturnValueOnce(readB.promise);
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    const groupA = await openOwnerComments(user, "share-a");
    expect(await within(groupA).findByText("A before refresh")).toBeTruthy();
    await user.click(
      within(groupA).getByRole("button", { name: "Pause link comments" }),
    );
    await vi.waitFor(() => {
      expect(bridgeMock.listRelayShareDiscussion).toHaveBeenCalledTimes(2);
    });

    const groupB = await openOwnerComments(user, "share-b");
    await act(async () => {
      readB.resolve(discussionPage([namedComment("message-b", "B current")]));
    });
    expect(await within(groupB).findByText("B current")).toBeTruthy();
    await act(async () => {
      refreshA.resolve(
        discussionPage([namedComment("message-a-new", "A after refresh")], {
          linkCommentsPaused: true,
        }),
      );
    });
    expect(await within(groupA).findByText("A after refresh")).toBeTruthy();
    expect(
      within(groupA).getByText(
        "Link comments are paused. People with links can still read everything.",
      ),
    ).toBeTruthy();
  });

  it("ignores moderation after a target change", async () => {
    const pause = controllable<{ linkCommentsPaused: true }>();
    bridgeMock.listRelayShareLinks
      .mockResolvedValueOnce({
        links: [readableLink("link-a", { shareId: "share-a" })],
      })
      .mockResolvedValueOnce({
        links: [
          readableLink("link-b", {
            shareId: "share-b",
            selector: { paths: [], versionId: "version-b" },
          }),
        ],
      });
    bridgeMock.pauseRelayShareDiscussion.mockReturnValueOnce(pause.promise);
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
    await user.click(
      within(groupA).getByRole("button", { name: "Pause link comments" }),
    );
    view.rerender(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "version", versionId: "version-b" }}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByTestId("share-link-group-share-b")).toBeTruthy();
    await act(async () => {
      pause.resolve({ linkCommentsPaused: true });
    });
    expect(
      screen.queryByText(
        "Link comments are paused. People with links can still read everything.",
      ),
    ).toBeNull();
  });

  it("ignores promotion after a workspace change and revoke after unmount", async () => {
    const promotion = controllable<{
      grantId: string;
      access: "comment";
      generation: number;
      status: "active";
      revokedAtMs: null;
      parentGrantId: null;
    }>();
    const revoke = controllable<{
      grantId: string;
      access: "comment";
      generation: number;
      status: "revoked";
      revokedAtMs: number;
      parentGrantId: null;
    }>();
    bridgeMock.listRelayShareLinks.mockImplementation(
      async ({ workspaceId }: { workspaceId: string }) => ({
        links:
          workspaceId === "ws-a"
            ? [
                readableLink("parent-a", {
                  shareId: "share-a",
                  dependents: [
                    dependent("dependent-a", "a@example.test", "user-a", "comment"),
                  ],
                }),
              ]
            : [readableLink("parent-b", { shareId: "share-b" })],
        independentGrants:
          workspaceId === "ws-a"
            ? []
            : [
                independentGrant("independent-b", {
                  workspaceId: "ws-b",
                  shareId: "share-b",
                  recipientEmail: "b@example.test",
                }),
              ],
      }),
    );
    bridgeMock.promoteRelayShareGrant.mockReturnValueOnce(promotion.promise);
    bridgeMock.revokeRelayShareGrant.mockReturnValueOnce(revoke.promise);
    const user = userEvent.setup();
    const view = render(
      <RelayShareDialog
        workspaceId="ws-a"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    await showLinkPane(user);
    const groupA = await openOwnerComments(user, "share-a");
    await user.click(
      within(await within(groupA).findByTestId("share-dependent-dependent-a"))
        .getByRole("button", { name: "Make independent" }),
    );
    await user.click(
      within(within(groupA).getByTestId("owner-comments-confirmation")).getByRole(
        "button",
        { name: "Make independent" },
      ),
    );
    expect(bridgeMock.promoteRelayShareGrant).toHaveBeenCalledTimes(1);

    view.rerender(
      <RelayShareDialog
        workspaceId="ws-b"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    const groupB = await openOwnerComments(user, "share-b");
    const callsBeforePromotionSettles =
      bridgeMock.listRelayShareLinks.mock.calls.length;
    await act(async () => {
      promotion.resolve({
        grantId: "dependent-a",
        access: "comment",
        generation: 2,
        status: "active",
        revokedAtMs: null,
        parentGrantId: null,
      });
    });
    expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(
      callsBeforePromotionSettles,
    );

    const independent = await within(groupB).findByTestId(
      "share-independent-independent-b",
    );
    await user.click(
      within(independent).getByRole("button", { name: "End access" }),
    );
    await user.click(
      within(within(groupB).getByTestId("owner-comments-confirmation")).getByRole(
        "button",
        { name: "End access" },
      ),
    );
    const callsBeforeUnmount = bridgeMock.listRelayShareLinks.mock.calls.length;
    view.unmount();
    await act(async () => {
      revoke.resolve({
        grantId: "independent-b",
        access: "comment",
        generation: 3,
        status: "revoked",
        revokedAtMs: CREATED_MS + 1,
        parentGrantId: null,
      });
    });
    expect(bridgeMock.listRelayShareLinks).toHaveBeenCalledTimes(callsBeforeUnmount);
    expect(bridgeMock.listRelayShares).not.toHaveBeenCalled();
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
      "Turn on comments",
      "Reset link",
      "End link",
      "Pause link comments",
      "Post",
    ]) {
      expect(within(group).getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Create link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });
});
