// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { publishFileComments, useFileComments, type FileComments } from "./fileComments";

afterEach(cleanup);

it("hands the editor the same anchors when a read finds the same comments", () => {
  const seen: Array<FileComments | undefined> = [];
  function Probe() {
    seen.push(useFileComments("workspace-1", "docs/same.md"));
    return null;
  }
  render(<Probe />);
  const read = () => ({
    anchors: [{ threadId: "thread-1", quote: "the plan" }],
    canComment: true,
  });

  act(() => publishFileComments("workspace-1", "docs/same.md", read()));
  const first = seen.at(-1)!;
  const renders = seen.length;
  act(() => publishFileComments("workspace-1", "docs/same.md", read()));
  expect(seen.length).toBe(renders);

  act(() => publishFileComments("workspace-1", "docs/same.md", { ...read(), canComment: false }));
  expect(seen.at(-1)!.canComment).toBe(false);
  expect(seen.at(-1)!.anchors).toBe(first.anchors);

  act(() =>
    publishFileComments("workspace-1", "docs/same.md", {
      anchors: [{ threadId: "thread-2", quote: "the budget" }],
      canComment: false,
    }),
  );
  expect(seen.at(-1)!.anchors).toEqual([{ threadId: "thread-2", quote: "the budget" }]);
});
