import { describe, expect, it } from "vitest";
import { createLocalChangeAuthor, parseChangeAuthor } from "./changeAuthors";

describe("change authors", () => {
  it("normalizes local author labels and rejects empty labels", () => {
    expect(createLocalChangeAuthor(" Local file edit ")).toEqual({
      kind: "local",
      label: "Local file edit",
    });
    expect(() => createLocalChangeAuthor("  ")).toThrow(/non-empty/i);
  });

  it("parses persisted author values through the same runtime contract", () => {
    expect(parseChangeAuthor({ kind: "user", userId: "user-1" })).toEqual({
      kind: "user",
      userId: "user-1",
    });
    expect(
      parseChangeAuthor({
        kind: "agent",
        agentId: "codex-local",
        onBehalfOf: "user-1",
      }),
    ).toEqual({
      kind: "agent",
      agentId: "codex-local",
      onBehalfOf: "user-1",
    });
    expect(parseChangeAuthor({ kind: "local", label: " Local file edit " })).toEqual({
      kind: "local",
      label: "Local file edit",
    });
    expect(() => parseChangeAuthor({ kind: "local", label: "  " })).toThrow(/non-empty/i);
    expect(() => parseChangeAuthor({ kind: "user", userId: " user-1 " })).toThrow(/canonical/i);
    expect(() =>
      parseChangeAuthor({
        kind: "agent",
        agentId: " codex-local ",
        onBehalfOf: "user-1",
      }),
    ).toThrow(/canonical/i);
    expect(() => parseChangeAuthor({ kind: "agent", agentId: "codex-local" })).toThrow(
      /on-behalf-of/i,
    );
  });

  it("rejects noncanonical identities and normalizes local labels", () => {
    expect(() =>
      parseChangeAuthor({ kind: "user", userId: " user-1 " }),
    ).toThrow(/canonical/i);
    expect(() =>
      parseChangeAuthor({ kind: "agent", agentId: "codex-local", onBehalfOf: " user-1 " }),
    ).toThrow(/canonical/i);
    expect(
      parseChangeAuthor({ kind: "local", label: " Local file edit " }),
    ).toEqual({ kind: "local", label: "Local file edit" });
  });
});
