// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReportKinds } from "../../ipc/bridgeContract";
import type { PrivacySettings } from "../../settings/userSettings";
import { deferred, type Deferred } from "../../testing/deferred";
import { WorkspaceSessionProvider } from "../workspace/workspaceSession";
import { useReportsNotice } from "./useReportsNotice";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Session({ children }: { children: ReactNode }) {
  return <WorkspaceSessionProvider workspaceId="ws-1">{children}</WorkspaceSessionProvider>;
}

it("drops a read when both switches turn off, and asks again when one turns back on", async () => {
  const answers: Deferred<ReportKinds>[] = [];
  const readReportsNotice = vi.fn(() => {
    const answer = deferred<ReportKinds>();
    answers.push(answer);
    return answer.promise;
  });
  vi.stubGlobal("dohcDesktop", { readReportsNotice });
  const show = vi.fn();
  const { rerender } = renderHook(
    ({ privacy }: { privacy: PrivacySettings }) =>
      useReportsNotice({ workspaceId: "ws-1", privacy, notice: null, show }),
    { wrapper: Session, initialProps: { privacy: { usageReports: true, errorReports: false } } },
  );
  expect(readReportsNotice).toHaveBeenCalledTimes(1);

  rerender({ privacy: { usageReports: false, errorReports: false } });
  await act(async () => answers[0]!.resolve({ usage: true, errors: false }));
  expect(show).not.toHaveBeenCalled();
  expect(readReportsNotice).toHaveBeenCalledTimes(1);

  rerender({ privacy: { usageReports: false, errorReports: true } });
  expect(readReportsNotice).toHaveBeenCalledTimes(2);
  await act(async () => answers[1]!.resolve({ usage: false, errors: true }));
  expect(show).toHaveBeenCalledTimes(1);
  expect(show).toHaveBeenCalledWith({ usage: false, errors: true });
});
