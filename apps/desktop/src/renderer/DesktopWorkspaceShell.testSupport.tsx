import "../testing/legendListMock";

import {
  screen,
  waitFor,
} from "@testing-library/react";

import userEvent from "@testing-library/user-event";

import {
  expect,
  vi,
} from "vitest";

import "./CollectionPage";

// Collection dependencies read these observers during module evaluation.
// Preload them before tests so an unfinished import cannot clean up a later test's globals.
const { ObserverStub } = vi.hoisted(() => {
  class ObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): never[] { return []; }
  }
  Object.assign(globalThis, { ResizeObserver: ObserverStub, IntersectionObserver: ObserverStub });
  return { ObserverStub };
});

import {
  makeBridge,
  renderShell,
  enterMarkdownSource,
  holdHistory,
} from "./DesktopWorkspaceShell.testHarness";

// One share's durable skip record, as the registry holds it.
const SKIPPED_RECORD = {
  ops: [
    {
      originId: "origin-granter",
      originSeq: 7,
      opKind: "moment.append",
      code: "share-boundary-violation",
      detail:
        "replicated moment is outside the share boundary: the share " +
        "granted version main, the relay offered version version-other",
      atMs: 1000,
    },
  ],
  more: 1,
  generation: 3,
};

async function openDirtyMarkdown(
  bridge: ReturnType<typeof makeBridge>,
): Promise<{
  user: ReturnType<typeof userEvent.setup>;
  editor: HTMLElement;
}> {
  const user = userEvent.setup();
  renderShell(holdHistory(bridge));
  const row = (await screen.findAllByTestId("tree-row")).find(
    (candidate) => candidate.dataset.path === "a.md",
  )!;
  await user.click(row);
  await screen.findByTestId("view-markdown");
  const editor = await enterMarkdownSource(user);
  await user.type(editor, "Draft!");
  await waitFor(() =>
    expect(screen.queryAllByTestId("tab-dirty").length).toBeGreaterThan(0),
  );
  return { user, editor };
}

export {
  ObserverStub,
  SKIPPED_RECORD,
  openDirtyMarkdown,
};
