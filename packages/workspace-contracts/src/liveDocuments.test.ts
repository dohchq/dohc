import { describe, expect, it } from "vitest";
import { liveDocumentKindForPath } from "./liveDocuments";

describe("liveDocumentKindForPath", () => {
  it.each([
    "notes/today.md",
    "README.MD",
    "notes/plan.markdown",
    "notes/PLAN.MarkDown",
  ])("classifies %s as a rich document", (path) => {
    expect(liveDocumentKindForPath(path)).toBe("richdoc");
  });

  it.each([
    "notes/today",
    "notes/today.mdx",
    "notes/today.md.bak",
    "notes/markdown",
    "drawings/plan.excalidraw",
    "drawings/plan.excalidraw.json",
  ])("leaves %s outside live document sessions", (path) => {
    expect(liveDocumentKindForPath(path)).toBeNull();
  });
});
