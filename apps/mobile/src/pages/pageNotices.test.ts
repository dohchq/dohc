import { describe, expect, it } from "vitest";
import { editAnywayMessage, pageFailureAction, pageNotices, type PageHandlers } from "./pageNotices";

// A strip once offered Try again with nothing behind it. Every action a page offers needs a handler.
describe("a page's actions", () => {
  const handlers: PageHandlers = { retry: () => {}, editAnyway: () => {} };

  it("has a handler for every strip action and the failure's Try again", () => {
    const offered = [...pageNotices({ couldNotOpen: true, lossy: true, large: true }).flatMap(notice => notice.action ? [notice.action] : []), pageFailureAction];
    expect(offered.map(action => action.label)).toEqual(["Try again", "Edit anyway", "Try again"]);
    for (const action of offered) expect(handlers[action.name], action.label).toBeTypeOf("function");
  });

  it("orders the strips as the desktop stacks them", () => {
    expect(pageNotices({ couldNotOpen: true, lossy: true, large: true }).map(notice => notice.key)).toEqual(["couldNotOpen", "lossy", "large"]);
    expect(pageNotices({ couldNotOpen: false, lossy: false, large: false })).toEqual([]);
  });
});

// The sheet names what History said, as the desktop's dialog does, and says nothing about History before it answers.
describe("Edit anyway's message", () => {
  const cost = "Saving rewrites the parts dohc can't show, such as raw HTML or reference links.";
  it("gives each History answer its own line", () => {
    expect(editAnywayMessage("kept")).toBe(`${cost} History keeps the original.`);
    expect(editAnywayMessage("untracked")).toBe(`${cost} History does not track this file, so dohc can't restore the original.`);
    expect(editAnywayMessage("unconfirmed")).toBe(`${cost} dohc could not confirm that History can restore the original.`);
    expect(editAnywayMessage(null)).toBe(cost);
  });
});
