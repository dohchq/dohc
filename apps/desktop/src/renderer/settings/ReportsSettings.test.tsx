// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportsSettings } from "./ReportsSettings";

const bridge = {
  readDiagnostics: vi.fn(async () => ({
    text: "dohc diagnostics\nUsage reports: on",
    available: { usage: true, errors: true },
  })),
};

beforeEach(() => {
  bridge.readDiagnostics.mockClear();
  window.dohcDesktop = bridge as unknown as typeof window.dohcDesktop;
});

afterEach(() => {
  cleanup();
  delete window.dohcDesktop;
});

describe("report settings", () => {
  it("marks a switch that is off as changed, and resets it", () => {
    const onChange = vi.fn();
    render(
      <ReportsSettings privacy={{ usageReports: false, errorReports: true }} onChange={onChange} />,
    );
    expect(
      screen.getByRole("switch", { name: "Send usage reports" }).getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onChange).toHaveBeenCalledWith({ usageReports: true, errorReports: true });
  });

  it("says which reports this launch cannot send", async () => {
    for (const [usage, errors] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      bridge.readDiagnostics.mockResolvedValueOnce({
        text: "dohc diagnostics",
        available: { usage, errors },
      });
      const onChange = vi.fn();
      const view = render(
        <ReportsSettings
          privacy={{ usageReports: true, errorReports: true }}
          onChange={onChange}
        />,
      );
      await waitFor(() => {
        for (const [kind, available] of [
          ["usage", usage],
          ["error", errors],
        ] as const) {
          const row = screen.getByTestId(`settings-row-${kind}-reports`);
          const control = screen.getByRole("switch", { name: `Send ${kind} reports` });
          const line = screen.queryByText(`This launch sends no ${kind} reports.`);
          expect(row.textContent).not.toContain("Unavailable for this launch.");
          expect(control.hasAttribute("disabled")).toBe(false);
          expect(control.getAttribute("aria-checked")).toBe("true");
          if (available) {
            expect(line).toBeNull();
            expect(control.hasAttribute("aria-describedby")).toBe(false);
          } else {
            expect(line).not.toBeNull();
            expect(row.contains(line)).toBe(true);
            expect(line?.id).toBeTruthy();
            expect(control.getAttribute("aria-describedby")).toBe(line?.id);
          }
        }
      });
      fireEvent.click(screen.getByRole("switch", { name: "Send usage reports" }));
      expect(onChange).toHaveBeenLastCalledWith({ usageReports: false, errorReports: true });
      fireEvent.click(screen.getByRole("switch", { name: "Send error reports" }));
      expect(onChange).toHaveBeenLastCalledWith({ usageReports: true, errorReports: false });
      view.unmount();
    }
  });
});
