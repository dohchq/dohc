// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportsSettings } from "./ReportsSettings";

const bridge = {
  readDiagnostics: vi.fn(async () => ({ text: "dohc diagnostics\nUsage reports: on", reports: true })),
  saveDiagnostics: vi.fn(async () => ({ saved: true })),
};

beforeEach(() => {
  bridge.readDiagnostics.mockClear();
  bridge.saveDiagnostics.mockClear();
  window.dohcDesktop = bridge as unknown as typeof window.dohcDesktop;
});

afterEach(() => {
  cleanup();
  delete window.dohcDesktop;
});

describe("report settings", () => {
  it("changes each switch on its own", () => {
    const onChange = vi.fn();
    render(<ReportsSettings privacy={{ usageReports: true, errorReports: true }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch", { name: "Send usage reports" }));
    expect(onChange).toHaveBeenLastCalledWith({ usageReports: false, errorReports: true });
    fireEvent.click(screen.getByRole("switch", { name: "Send error reports" }));
    expect(onChange).toHaveBeenLastCalledWith({ usageReports: true, errorReports: false });
  });

  it("marks a switch that is off as changed, and resets it", () => {
    const onChange = vi.fn();
    render(<ReportsSettings privacy={{ usageReports: false, errorReports: true }} onChange={onChange} />);
    expect(screen.getByRole("switch", { name: "Send usage reports" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onChange).toHaveBeenCalledWith({ usageReports: true, errorReports: true });
  });

  it("shows and saves the diagnostics main builds", async () => {
    render(<ReportsSettings privacy={{ usageReports: true, errorReports: true }} onChange={vi.fn()} />);
    const show = screen.getByTestId("diagnostics-show");
    expect(show.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(show);
    expect(show.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(screen.getByTestId("diagnostics-text").textContent).toContain("Usage reports: on"));
    fireEvent.click(screen.getByTestId("diagnostics-save"));
    await waitFor(() => expect(bridge.saveDiagnostics).toHaveBeenCalledWith({}));
  });

  it("says when this build sends no reports", async () => {
    bridge.readDiagnostics.mockResolvedValueOnce({ text: "dohc diagnostics", reports: false });
    render(<ReportsSettings privacy={{ usageReports: true, errorReports: true }} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText(/This build sends none\./)).toHaveLength(2));
  });

  it("reports a save that failed", async () => {
    bridge.saveDiagnostics.mockRejectedValueOnce(new Error("disk full"));
    const onError = vi.fn();
    render(<ReportsSettings privacy={{ usageReports: true, errorReports: true }} onChange={vi.fn()} onError={onError} />);
    fireEvent.click(screen.getByTestId("diagnostics-save"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("disk full"), expect.any(Error)));
  });
});
