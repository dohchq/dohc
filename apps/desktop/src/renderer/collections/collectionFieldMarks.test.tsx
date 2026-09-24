// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ListCollectionFieldMarksPayload } from "../../ipc/bridgeContract";
import {
  automationFieldMarkLabel,
  CollectionAutomationsRevisionProvider,
  useCollectionFieldMarks,
} from "./collectionFieldMarks";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reads a Collection's marks once, and again only when main's automations change", async () => {
  const listCollectionFieldMarks = vi.fn(async ({ collectionPath }: ListCollectionFieldMarksPayload) => ({
    marks: [{ field: "Finished on", automations: [`Stamp ${collectionPath}`] }],
  }));
  vi.stubGlobal("dohcDesktop", { listCollectionFieldMarks });
  let revision = 0;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <CollectionAutomationsRevisionProvider value={revision}>{children}</CollectionAutomationsRevisionProvider>
  );
  const { result, rerender } = renderHook(() => useCollectionFieldMarks("ws-1", "Tasks"), { wrapper });
  await act(async () => undefined);
  expect([...result.current]).toEqual([["Finished on", ["Stamp Tasks"]]]);
  rerender();
  await act(async () => undefined);
  expect(listCollectionFieldMarks).toHaveBeenCalledTimes(1);

  revision = 1;
  rerender();
  await act(async () => undefined);
  expect(listCollectionFieldMarks).toHaveBeenCalledTimes(2);
});

it("never shows one Collection's marks on another, and asks nothing for a file outside a folder", async () => {
  const answers: Array<() => void> = [];
  const listCollectionFieldMarks = vi.fn(({ collectionPath }: ListCollectionFieldMarksPayload) =>
    new Promise((resolve) => answers.push(() => resolve({ marks: [{ field: "Done", automations: [collectionPath] }] }))));
  vi.stubGlobal("dohcDesktop", { listCollectionFieldMarks });
  const { result, rerender } = renderHook(
    ({ path }: { path: string | null }) => useCollectionFieldMarks("ws-1", path),
    { initialProps: { path: "Tasks" as string | null } },
  );
  rerender({ path: "Trips" });
  // Tasks answers after the page moved on to Trips.
  await act(async () => answers[0]!());
  expect(result.current.size).toBe(0);
  await act(async () => answers[1]!());
  expect([...result.current]).toEqual([["Done", ["Trips"]]]);

  rerender({ path: null });
  expect(result.current.size).toBe(0);
  expect(listCollectionFieldMarks).toHaveBeenCalledTimes(2);
});

it("names one automation or several", () => {
  expect(automationFieldMarkLabel(["Stamp"])).toBe('Set by the automation "Stamp"');
  expect(automationFieldMarkLabel(["Stamp", "Tidy", "Bump"])).toBe('Set by the automations "Stamp", "Tidy", and "Bump"');
});
