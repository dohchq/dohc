// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { usePhoneAppNotices } from "./usePhoneAppNotices";

afterEach(cleanup);

it("files a row only for a new app or a new reason, and takes back one that cleared", () => {
  const report = vi.fn();
  const clear = vi.fn();
  const { rerender } = renderHook(
    ({ apps }) => usePhoneAppNotices({ workspaceId: "ws", apps, report, clear }),
    { initialProps: { apps: [{ appRoot: "apps/trip", reason: "No index.html." }] } },
  );
  expect(report).toHaveBeenCalledTimes(1);
  expect(report.mock.calls[0]![0]).toMatchObject({
    identity: "phone-app:apps/trip",
    message: "dohc could not send apps/trip to your phones. No index.html.",
  });

  rerender({ apps: [{ appRoot: "apps/trip", reason: "No index.html." }] });
  expect(report).toHaveBeenCalledTimes(1);

  rerender({ apps: [{ appRoot: "apps/trip", reason: "Too large." }] });
  expect(report).toHaveBeenCalledTimes(2);

  rerender({ apps: [] });
  expect(clear).toHaveBeenCalledWith("phone-app:apps/trip");
});
