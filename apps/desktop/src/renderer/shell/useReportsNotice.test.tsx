// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReportKinds } from "../../ipc/bridgeContract";
import type { PrivacySettings } from "../../settings/userSettings";
import { deferred, type Deferred } from "../../testing/deferred";
import { WorkspaceSessionProvider } from "../workspace/workspaceSession";
import { useReportsNotice, useStandaloneReportsNotice } from "./useReportsNotice";

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

it("useStandaloneReportsNotice skips when disabled, drops late answers on unmount or switch-off, and acknowledges only the matching toast", async () => {
  const answers: Deferred<ReportKinds>[] = [];
  const readReportsNotice = vi.fn(() => {
    const answer = deferred<ReportKinds>();
    answers.push(answer);
    return answer.promise;
  });
  const acknowledgeReportsNotice = vi.fn(async () => undefined);
  vi.stubGlobal("dohcDesktop", { readReportsNotice, acknowledgeReportsNotice });
  const show = vi.fn();

  const { rerender, result, unmount } = renderHook(
    ({
      enabled,
      privacy,
      notice,
    }: {
      enabled: boolean;
      privacy: PrivacySettings | null;
      notice: { id: string; reports: ReportKinds } | null;
    }) => useStandaloneReportsNotice({ enabled, privacy, notice, show }),
    {
      initialProps: {
        enabled: false,
        privacy: { usageReports: true, errorReports: true } as PrivacySettings | null,
        notice: null as { id: string; reports: ReportKinds } | null,
      },
    },
  );
  expect(readReportsNotice).not.toHaveBeenCalled();

  rerender({
    enabled: true,
    privacy: { usageReports: true, errorReports: false },
    notice: null,
  });
  expect(readReportsNotice).toHaveBeenCalledTimes(1);

  rerender({
    enabled: true,
    privacy: { usageReports: false, errorReports: false },
    notice: null,
  });
  await act(async () => answers[0]!.resolve({ usage: true, errors: false }));
  expect(show).not.toHaveBeenCalled();

  rerender({
    enabled: true,
    privacy: { usageReports: true, errorReports: true },
    notice: { id: "toast-1", reports: { usage: true, errors: true } },
  });
  expect(readReportsNotice).toHaveBeenCalledTimes(2);
  await act(async () => answers[1]!.resolve({ usage: true, errors: true }));
  expect(show).toHaveBeenCalledExactlyOnceWith({ usage: true, errors: true });

  result.current("other-toast");
  expect(acknowledgeReportsNotice).not.toHaveBeenCalled();
  result.current("toast-1");
  expect(acknowledgeReportsNotice).toHaveBeenCalledExactlyOnceWith({ usage: true, errors: true });

  rerender({
    enabled: true,
    privacy: { usageReports: false, errorReports: true },
    notice: null,
  });
  expect(readReportsNotice).toHaveBeenCalledTimes(3);
  unmount();
  await act(async () => answers[2]!.resolve({ usage: false, errors: true }));
  expect(show).toHaveBeenCalledTimes(1);
});
