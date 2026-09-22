// @vitest-environment jsdom
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CollectionRecoveryExportDialog } from "./CollectionRecoveryExportDialog";

afterEach(cleanup);
it("explains private contents and keeps cancelled save dialogs reversible", async () => {
  const onExport = vi.fn(async () => null), onClose = vi.fn();
  render(<CollectionRecoveryExportDialog collectionName="Registrations" onExport={onExport} onClose={onClose} onSaved={vi.fn()} onError={vi.fn()} />);
  expect(screen.getByText(/private records, uploads, source, history, and retry credentials/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save recovery file" })); });
  expect(onExport).toHaveBeenCalledOnce(); expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(onClose).toHaveBeenCalledOnce();
});
it("ignores a completed export after its workspace view unmounts", async () => {
  let resolve!: (path: string) => void;
  const onSaved = vi.fn(), onClose = vi.fn(), onError = vi.fn();
  const onExport = vi.fn(() => new Promise<string>(done => { resolve = done; }));
  const view = render(<CollectionRecoveryExportDialog collectionName="Registrations" onExport={onExport} onClose={onClose} onSaved={onSaved} onError={onError} />);
  fireEvent.click(screen.getByRole("button", { name: "Save recovery file" }));
  view.unmount();
  await act(async () => { resolve("C:\\private\\backup.dohc-recovery"); });
  expect(onSaved).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
});
