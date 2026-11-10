import { describe, expect, it } from "vitest";
import { isNoticeTarget } from "./relay";

describe("a notice's target", () => {
  const agent = `p-${"a".repeat(26)}`;

  it("opens Settings › Agents, at a personal agent's page when it names one", () => {
    expect(isNoticeTarget({ settings: "agents" })).toBe(true);
    expect(isNoticeTarget({ settings: "agents", agent })).toBe(true);
  });

  it("refuses another Settings page", () => {
    expect(isNoticeTarget({ settings: "sync" })).toBe(false);
    expect(isNoticeTarget({ settings: "sync", agent })).toBe(false);
  });

  it("refuses an agent without Settings › Agents", () => {
    expect(isNoticeTarget({ agent })).toBe(false);
    expect(isNoticeTarget({ path: "notes/a.md", agent })).toBe(false);
  });

  it("refuses an agent that isn't a line", () => {
    expect(isNoticeTarget({ settings: "agents", agent: "" })).toBe(false);
    expect(isNoticeTarget({ settings: "agents", agent: ` ${agent}` })).toBe(false);
    expect(isNoticeTarget({ settings: "agents", agent: 7 })).toBe(false);
  });
});
