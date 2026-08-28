// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListRelayShareLinksResult } from "../ipc/bridgeContract";
import { RelayShareDialog } from "./RelayShareDialog";

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
  access: "view";
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
  access: "view";
};

type DamagedLink = Omit<ReadableLink, "access" | "selector"> & {
  selector: null;
  access: string;
  damaged: true;
};

type LinkRow = ReadableLink | DamagedLink;

const CREATED_MS = Date.UTC(2026, 0, 2, 3, 4);

function dependent(
  grantId: string,
  recipientEmail: string | null,
  recipientUserId: string | null,
): LinkDependent {
  return {
    grantId,
    recipientEmail,
    recipientUserId,
    access: "view",
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
  listRelayShareLinks: vi.fn(),
  rotateRelayShareLink: vi.fn(),
  revokeRelayShareLink: vi.fn(),
  writeClipboardText: vi.fn(),
};

vi.mock("./bridge", () => ({
  bridge: () => bridgeMock,
}));

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMock.createRelayShare.mockResolvedValue({
    shareId: "share-1",
    shareCode: SHARE_CODE,
    recipientEmail: "friend@dohc.test",
  });
  bridgeMock.createRelayShareLink.mockResolvedValue(linkResult(LINK_URL));
  bridgeMock.listRelayShareLinks.mockResolvedValue({ links: [] });
  bridgeMock.rotateRelayShareLink.mockResolvedValue({
    outcome: "rotated",
    url: LINK_URL_B,
  });
  bridgeMock.revokeRelayShareLink.mockResolvedValue({ outcome: "ended" });
  bridgeMock.writeClipboardText.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

async function showLinkPane(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: "Anyone with the link" }));
}

describe("RelayShareDialog", () => {
  it("defaults the Share with choice to Invite by email", () => {
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
  });

  it("creates a path share and shows the copyable code", async () => {
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

    expect(bridgeMock.createRelayShare).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      recipientEmail: "friend@dohc.test",
      access: "view",
      paths: ["docs/plan.md"],
    });
    const code = await screen.findByTestId("share-code");
    expect(code.textContent).toBe(SHARE_CODE);

    await user.click(screen.getByTestId("share-code-copy"));
    expect(bridgeMock.writeClipboardText).toHaveBeenCalledWith({ text: SHARE_CODE });
  });

  it("creates a version share addressed by version id", async () => {
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "version", versionId: "version-7", versionName: "review" }}
        onClose={() => {}}
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
  });

  it("offers all three levels, states each one, and sends the level it showed", async () => {
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );

    expect(screen.getByTestId("share-access-view").getAttribute("aria-checked")).toBe(
      "true",
    );
    for (const level of ["view", "comment", "edit"] as const) {
      expect(
        screen.getByTestId(`share-access-${level}`).hasAttribute("disabled"),
        `MUTATION: ${level} disabled would refuse a level the relay now grants`,
      ).toBe(false);
    }
    expect(screen.getByTestId("share-access-helper").textContent).toBe(
      "They can read what you selected.",
    );
    expect(screen.queryByTestId("share-access-pending")).toBeNull();

    await user.click(screen.getByTestId("share-access-comment"));
    expect(screen.getByTestId("share-access-comment").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByTestId("share-access-helper").textContent).toBe(
      "They can read what you selected and chat about it.",
    );

    await user.click(screen.getByTestId("share-access-edit"));
    expect(screen.getByTestId("share-access-edit").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      screen.getByTestId("share-access-helper").textContent,
      "MUTATION: promising 'edit what you selected' would name a right Edit does not grant",
    ).toBe("They can read, chat, and send you changes to accept.");

    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect(bridgeMock.createRelayShare).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      recipientEmail: "friend@dohc.test",
      access: "edit",
      paths: ["docs/plan.md"],
    });
  });

  it("keeps the Edit label on the level the relay calls edit", () => {
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: ["docs/plan.md"] }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("share-access-edit").textContent).toBe("Edit");
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

  it("shows the handler's honest error copy (secret refusal), stripped of IPC noise", async () => {
    bridgeMock.createRelayShare.mockRejectedValue(
      new Error(
        "Error invoking remote method 'desktop:create-relay-share': Error: Secret files can't be shared.",
      ),
    );
    const user = userEvent.setup();
    render(
      <RelayShareDialog
        workspaceId="ws-1"
        target={{ kind: "paths", paths: [".env"] }}
        onClose={() => {}}
      />,
    );
    await user.type(screen.getByTestId("share-email"), "friend@dohc.test");
    await user.click(screen.getByTestId("share-create"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Secret files can't be shared.",
    );
  });

  it("shows static View-only access and the exact paths warning", async () => {
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
    expect(screen.getByText("View")).toBeTruthy();
    expect(screen.getByText("Links are view-only for now.")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "View" })).toBeNull();
    expect(screen.queryByText("Comment")).toBeNull();
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

  it("creates a paths link with the physical workspace and no access property", async () => {
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
    });
    expect(bridgeMock.createRelayShareLink.mock.calls[0]?.[0]).not.toHaveProperty(
      "access",
    );
  });

  it("creates a version link with the physical workspace and no access property", async () => {
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
    });
    expect(bridgeMock.createRelayShareLink.mock.calls[0]?.[0]).not.toHaveProperty(
      "access",
    );
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

    const pendingButton = screen.getByRole("button", { name: "Creating link…" });
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
          nextCursor: "tail-page",
        }),
      )
      .mockImplementationOnce(async () =>
        ListRelayShareLinksResult.parse({ links: [tail] }),
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
    expect(screen.getByRole("button", { name: "Creating link…" }).hasAttribute("disabled")).toBe(
      true,
    );
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
    expect(screen.getByRole("button", { name: "Creating link…" }).hasAttribute("disabled")).toBe(
      true,
    );
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
});
