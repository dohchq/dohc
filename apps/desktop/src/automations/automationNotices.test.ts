import { describe, expect, it, vi } from "vitest";
import { RETRY_NO_RUN, retryFromFailureNotice } from "./automationNotices";

describe("Notice retry", () => {
  it("refuses a Notice that is no longer in the current account", async () => {
    const retry = vi.fn();
    const mark = vi.fn();
    await expect(retryFromFailureNotice({ notices: { list: async () => ({ account: "current", notices: [] }), mark }, retry },
      { notice: { store: "account", noticeId: "old-notice" }, account: "old", startOver: false }))
      .resolves.toEqual({ status: "refused", reason: RETRY_NO_RUN });
    expect(retry).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
  });
});
