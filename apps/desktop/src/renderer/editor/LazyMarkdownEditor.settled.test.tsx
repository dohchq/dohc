// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLiveEditorSettled } from "./LazyMarkdownEditor";

// The editor's code fails to load while the collaboration code never arrives.
vi.mock("./MarkdownEditor", () => Promise.reject(new Error("editor chunk failed to load")));
vi.mock("@tiptap/extension-collaboration", () => new Promise(() => {}));

describe("useLiveEditorSettled", () => {
  it("settles once the editor's code has failed, without waiting for the collaboration code", async () => {
    const { result } = renderHook(() => useLiveEditorSettled(true));
    await waitFor(() => expect(result.current).toBe(true));
  });
});
