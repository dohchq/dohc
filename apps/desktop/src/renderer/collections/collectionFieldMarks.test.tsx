// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ListCollectionFieldMarksPayload, ListCollectionFieldMarksResult } from "../../ipc/bridgeContract";
import {
  automationFieldMarkLabel,
  CollectionFieldMarksProvider,
  useCollectionFieldMarks,
} from "./collectionFieldMarks";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubBridge(answer: (payload: ListCollectionFieldMarksPayload) => Promise<ListCollectionFieldMarksResult>) {
  const listeners: Array<(event: { workspaceId: string }) => void> = [];
  const listCollectionFieldMarks = vi.fn(answer);
  vi.stubGlobal("dohcDesktop", {
    listCollectionFieldMarks,
    onCollectionAutomationsChanged: (listener: (event: { workspaceId: string }) => void) => {
      listeners.push(listener);
      return () => undefined;
    },
  });
  return { listCollectionFieldMarks, changed: (workspaceId: string) => { for (const listener of listeners) listener({ workspaceId }); } };
}

function wrapperFor(workspace: { id: string }) {
  return ({ children }: { children: ReactNode }) => (
    <CollectionFieldMarksProvider workspaceId={workspace.id}>{children}</CollectionFieldMarksProvider>
  );
}

it("reads a Collection once for every view of it, and again only when main's automations change", async () => {
  let names = ["Stamp"];
  const bridge = stubBridge(async ({ collectionPath }) => ({
    marks: [{ field: "Finished on", automations: names.map((name) => `${name} ${collectionPath}`) }],
  }));
  const wrapper = wrapperFor({ id: "ws-1" });
  const { result } = renderHook(() => [useCollectionFieldMarks("Tasks"), useCollectionFieldMarks("Tasks")] as const, { wrapper });
  await act(async () => undefined);
  const [table, record] = result.current;
  expect([...table]).toEqual([["Finished on", ["Stamp Tasks"]]]);
  expect(record).toBe(table);
  const reads = bridge.listCollectionFieldMarks.mock.calls.length;

  // Another workspace's change reads nothing; this one's reads once, and unchanged marks keep their identity.
  await act(async () => bridge.changed("ws-2"));
  expect(bridge.listCollectionFieldMarks).toHaveBeenCalledTimes(reads);
  await act(async () => bridge.changed("ws-1"));
  expect(bridge.listCollectionFieldMarks).toHaveBeenCalledTimes(reads + 1);
  expect(result.current[0]).toBe(table);

  names = ["Stamp", "Tidy"];
  await act(async () => bridge.changed("ws-1"));
  expect([...result.current[0]]).toEqual([["Finished on", ["Stamp Tasks", "Tidy Tasks"]]]);
});

it("never shows one workspace's marks in another, and asks nothing for null", async () => {
  const answers: Array<() => void> = [];
  const bridge = stubBridge(({ workspaceId }) =>
    new Promise<ListCollectionFieldMarksResult>((resolve) =>
      answers.push(() => resolve({ marks: [{ field: "Done", automations: [workspaceId] }] }))));
  const workspace = { id: "ws-1" };
  const { result, rerender } = renderHook(({ path }: { path: string | null }) => useCollectionFieldMarks(path), {
    initialProps: { path: "Tasks" as string | null },
    wrapper: ({ children }: { children: ReactNode }) => (
      <CollectionFieldMarksProvider workspaceId={workspace.id}>{children}</CollectionFieldMarksProvider>
    ),
  });
  workspace.id = "ws-2";
  rerender({ path: "Tasks" });
  // ws-1 answers after the window moved to ws-2.
  await act(async () => { for (const answer of answers.splice(0)) answer(); });
  expect([...result.current]).toEqual([["Done", ["ws-2"]]]);

  const reads = bridge.listCollectionFieldMarks.mock.calls.length;
  rerender({ path: null });
  expect(result.current.size).toBe(0);
  expect(bridge.listCollectionFieldMarks).toHaveBeenCalledTimes(reads);
});

it("says what is true of the field: which automations set it", () => {
  expect(automationFieldMarkLabel(["Stamp"])).toBe('"Stamp" sets this field');
  expect(automationFieldMarkLabel(["Stamp", "Tidy", "Bump"])).toBe('"Stamp", "Tidy", and "Bump" set this field');
});
