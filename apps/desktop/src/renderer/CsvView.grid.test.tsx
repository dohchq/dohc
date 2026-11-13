// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { CsvView } from "./CsvView";
import { documentVersionKey } from "./documentVersionKey";

import { resetOrphanedDrafts } from "./orphanedDrafts";
import {
  acquireSharedLocalDocument,
  resetSharedLocalDocumentsForTests,
} from "./sharedLocalDocument";

const gutterRenders = vi.hoisted(() => [] as Array<number | undefined>);
vi.mock("./ui/DataGrid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui/DataGrid")>();
  return {
    ...actual,
    DataGridGutter: (props: Parameters<typeof actual.DataGridGutter>[0]) => {
      gutterRenders.push(props.number);
      return actual.DataGridGutter(props);
    },
  };
});

const writeWorkspaceText = vi.fn<DohcDesktopBridge["writeWorkspaceText"]>();
const releases: Array<() => void> = [];
const buffers: Array<ReturnType<typeof acquireSharedLocalDocument>["buffer"]> = [];

function csvFile(body: string) {
  const { buffer, release } = acquireSharedLocalDocument(
    documentVersionKey("ws-1", "funnel.csv", undefined),
  );
  releases.push(release);
  buffers.push(buffer);
  const contentReadTicket = buffer.beginRead();
  buffer.initializeRead(body, "hash-1", contentReadTicket);
  return {
    workspaceId: "ws-1",
    path: "funnel.csv",
    body,
    contentHash: "hash-1",
    contentReadTicket,
    contentRequestId: 1,
    latestContentRequestId: 1,
    switchReadPending: false,
    switchUnresyncedRef: { current: false },
    refreshAfterConflict: vi.fn(),
    localBuffer: buffer,
  };
}

const widthText = (column: number) =>
  screen.getByTestId("data-grid-widths").querySelectorAll("td")[column + 1]!.textContent;

describe("CSV view while typing", () => {
  beforeEach(() => {
    writeWorkspaceText.mockResolvedValue({ status: "written", contentHash: "hash-2" });
    vi.stubGlobal("dohcDesktop", {
      platform: "win32",
      writeWorkspaceText,
      onEngineYDocSaveState: () => () => {},
    });
  });

  afterEach(async () => {
    await act(async () => {
      cleanup();
      await Promise.all(buffers.splice(0).map((buffer) => buffer.settled()));
    });
    for (const release of releases.splice(0)) release();
    resetSharedLocalDocumentsForTests();
    resetOrphanedDrafts();
    vi.unstubAllGlobals();
    writeWorkspaceText.mockReset();
  });

  it("keeps a column's width while a cell's text grows, and sets it when the edit ends", async () => {
    const user = userEvent.setup();
    render(<CsvView {...csvFile("stage,count\nVisited,4820\nSigned up,1290")} />);
    expect(widthText(0)).toBe("stageSigned up");

    await user.type(screen.getByLabelText("Row 1 column 1"), " the pricing page");
    expect((screen.getByLabelText("Row 1 column 1") as HTMLInputElement).value).toBe(
      "Visited the pricing page",
    );
    expect(widthText(0)).toBe("stageSigned up");

    await user.type(screen.getByLabelText("Header column 1"), " name");
    expect(widthText(0)).toBe("stageVisited the pricing page");
    await user.tab();
    expect(widthText(0)).toBe("stage nameVisited the pricing page");
    expect(widthText(1)).toBe("count4820");
  });
});
