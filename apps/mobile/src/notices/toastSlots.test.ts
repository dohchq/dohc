import type { NoticeMark } from "@dohc/workspace-contracts/relay";
import { describe, expect, it, vi } from "vitest";
import type { ToastMessage } from "./Toast";
import {
  clearUndoToast,
  closeToast,
  doneToast,
  hideToast,
  markDone,
  NO_TOASTS,
  showToast,
} from "./toastSlots";

describe("Done on a Notice from the server", () => {
  it("offers its Undo only once the phone keeps the dismissal, and Undo restores after it", async () => {
    const made: NoticeMark[] = [];
    let keep!: (kept: boolean) => void;
    const mark = (_: string, next: NoticeMark) => {
      made.push(next);
      return next === "dismissed"
        ? new Promise<boolean>((done) => (keep = done))
        : Promise.resolve(true);
    };
    const show = vi.fn<(message: ToastMessage) => void>();
    const done = markDone(mark, "n1", show);
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
    keep(true);
    await done;
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Marked done", holdsUndo: true }),
    );
    show.mock.calls[0]?.[0].action?.onPress?.();
    expect(made).toEqual(["dismissed", "restore"]);
  });

  it("shows nothing when the dismissal isn't kept, so the store's report stands alone", async () => {
    const show = vi.fn<(message: ToastMessage) => void>();
    await markDone(async () => false, "n1", show);
    expect(show).not.toHaveBeenCalled();
  });
});

const failure: ToastMessage = {
  id: "notices:marks",
  tone: "failure",
  title: "dohc could not save your changes to notices.",
  body: "dohc could not reach dohc.example.com. Check your connection.",
  action: { label: "Try again" },
};

describe("the tabs' toast", () => {
  it("keeps Done's Undo when a failure comes after it, and shows the failure once Undo closes", () => {
    const restore = vi.fn();
    let slots = showToast(NO_TOASTS, doneToast("n1", restore));
    slots = showToast(slots, failure);
    expect(slots.shown?.title).toBe("Marked done");
    expect(slots.shown?.holdsUndo).toBe(true);
    // The worded action, which VoiceOver reaches on the toast, still restores the Notice.
    expect(slots.shown?.action?.label).toBe("Undo");
    slots.shown?.action?.onPress?.();
    expect(restore).toHaveBeenCalledOnce();
    slots = closeToast(slots);
    expect(slots.shown).toBe(failure);
  });

  it("lets a later Done replace the earlier Undo, keeping the failure behind it", () => {
    let slots = showToast(NO_TOASTS, failure);
    slots = showToast(
      slots,
      doneToast("n1", () => {}),
    );
    slots = showToast(
      slots,
      doneToast("n2", () => {}),
    );
    expect(slots.shown?.id).toBe("done:n2");
    expect(closeToast(slots).shown).toBe(failure);
  });

  it("takes back a waiting failure that a later success ends", () => {
    let slots = showToast(
      showToast(
        NO_TOASTS,
        doneToast("n1", () => {}),
      ),
      failure,
    );
    slots = hideToast(slots, "notices:marks");
    expect(slots.shown?.id).toBe("done:n1");
    expect(closeToast(slots).shown).toBeNull();
  });

  it("replaces one toast with the next when neither holds an Undo", () => {
    const next: ToastMessage = { ...failure, id: "read:w1:files" };
    expect(showToast(showToast(NO_TOASTS, failure), next)).toEqual({ shown: next, waiting: null });
  });

  it("clears workspace-scoped Undo toasts on workspace switch without dropping Notice Done Undo or failures", () => {
    const fileUndo: ToastMessage = {
      id: "deleted:notes/a.md:m1",
      tone: "success",
      title: "Deleted a.md",
      holdsUndo: true,
      workspaceId: "ws-1",
      action: { label: "Undo" },
    };
    const withFileUndo = showToast(showToast(NO_TOASTS, failure), fileUndo);
    expect(clearUndoToast(withFileUndo)).toEqual({ shown: failure, waiting: null });
    const withNoticeUndo = showToast(
      showToast(NO_TOASTS, failure),
      doneToast("n1", () => {}),
    );
    expect(clearUndoToast(withNoticeUndo)).toBe(withNoticeUndo);
    const plain = showToast(NO_TOASTS, failure);
    expect(clearUndoToast(plain)).toBe(plain);
  });
});
