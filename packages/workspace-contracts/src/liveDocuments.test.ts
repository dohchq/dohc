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

  it.each(["drawings/plan.excalidraw", "drawings/PLAN.EXCALIDRAW"])(
    "classifies %s as a scene",
    (path) => {
      expect(liveDocumentKindForPath(path)).toBe("scene");
    },
  );

  it.each([
    "notes/today",
    "notes/today.mdx",
    "notes/today.md.bak",
    "notes/markdown",
    "drawings/plan.excalidraw.json",
    "notes/a.constructor",
    "notes/a.__proto__",
  ])("leaves %s outside live document sessions", (path) => {
    expect(liveDocumentKindForPath(path)).toBeNull();
  });

  it("ignores extension names inherited from a poisoned object prototype", () => {
    Object.defineProperty(Object.prototype, "poisonedextension", {
      configurable: true,
      value: "scene",
    });

    try {
      expect(liveDocumentKindForPath("notes/a.poisonedextension")).toBeNull();
    } finally {
      delete (Object.prototype as Record<string, unknown>).poisonedextension;
    }
  });
});
