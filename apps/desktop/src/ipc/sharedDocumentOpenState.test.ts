import { describe, expect, it } from "vitest";
import { otherAccountOpen, sharedOpenNoticed, sharedWaitingLine } from "./sharedDocumentOpenState";

describe("a joined page opened with another account", () => {
  it("says the cause once on the page, in the browser's words, and leaves the toast to the workspace", () => {
    const waiting = otherAccountOpen("lee@dohc.test");
    expect(waiting.state).toBe("other-account");
    expect(sharedWaitingLine(waiting)).toBe(
      "This computer is signed in as lee@dohc.test, not the account the owner invited. You can still read this page.",
    );
    expect(sharedOpenNoticed(waiting)).toBe(false);
  });

  it("names no account it does not know", () => {
    expect(sharedWaitingLine(otherAccountOpen(undefined))).toBe(
      "This computer is signed in to a different account than the one the owner invited. You can still read this page.",
    );
  });
});
