import { afterEach, describe, expect, it, vi } from "vitest";
import { bridge } from "./bridge";
import { activateReadOnlyLinkHref, openLink } from "./linkActivation";
import { installWorkLinkOpener } from "./workLinkOpener";

vi.mock("./bridge", () => ({ bridge: vi.fn() }));

const WORK_LINK = `https://dohc.example/l/${"a".repeat(43)}`;

let uninstall: (() => void) | null = null;

afterEach(() => {
  uninstall?.();
  uninstall = null;
  vi.mocked(bridge).mockReset();
});

function mockBridge(): { openExternalUrl: ReturnType<typeof vi.fn> } {
  const openExternalUrl = vi.fn().mockResolvedValue(undefined);
  vi.mocked(bridge).mockReturnValue({
    openExternalUrl,
  } as unknown as ReturnType<typeof bridge>);
  return { openExternalUrl };
}

function install(answer: boolean | Error): ReturnType<typeof vi.fn> {
  const open = vi.fn(async (_url: string) => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  uninstall = installWorkLinkOpener(open);
  return open;
}

describe("openLink", () => {
  it("opens a work link in dohc when a workspace holds its message", async () => {
    const { openExternalUrl } = mockBridge();
    const open = install(true);

    await openLink(WORK_LINK);

    expect(open).toHaveBeenCalledWith(WORK_LINK);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("sends a work link no workspace holds to the browser", async () => {
    const { openExternalUrl } = mockBridge();
    install(false);

    await openLink(WORK_LINK);

    expect(openExternalUrl).toHaveBeenCalledWith({ url: WORK_LINK });
  });

  it("sends a work link to the browser when finding its message fails", async () => {
    const { openExternalUrl } = mockBridge();
    install(new Error("engine stopped"));

    await openLink(WORK_LINK);

    expect(openExternalUrl).toHaveBeenCalledWith({ url: WORK_LINK });
  });

  it("sends a work link to the browser when no workspace is open", async () => {
    const { openExternalUrl } = mockBridge();

    await openLink(WORK_LINK);

    expect(openExternalUrl).toHaveBeenCalledWith({ url: WORK_LINK });
  });

  it("never asks dohc about a link that is not a work link", async () => {
    const { openExternalUrl } = mockBridge();
    const open = install(true);

    await openLink("https://dohc.example/l/short");
    await openLink(`https://dohc.example/s/${"a".repeat(43)}`);

    expect(open).not.toHaveBeenCalled();
    expect(openExternalUrl).toHaveBeenCalledTimes(2);
  });

  it("a removed opener no longer answers", async () => {
    const { openExternalUrl } = mockBridge();
    const open = install(true);
    uninstall?.();
    uninstall = null;

    await openLink(WORK_LINK);

    expect(open).not.toHaveBeenCalled();
    expect(openExternalUrl).toHaveBeenCalledWith({ url: WORK_LINK });
  });

  it("a click on a work link in a chat routes through dohc", async () => {
    const { openExternalUrl } = mockBridge();
    let opened!: () => void;
    const answered = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const open = vi.fn(async (_url: string) => {
      opened();
      return true;
    });
    uninstall = installWorkLinkOpener(open);

    activateReadOnlyLinkHref(WORK_LINK, { detail: 1, preventDefault: () => {} });
    await answered;

    expect(open).toHaveBeenCalledWith(WORK_LINK);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
});
