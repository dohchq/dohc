import { describe, expect, it, vi } from "vitest";
import type { ToastMessage } from "./Toast";
import { closeToast, doneToast, hideToast, NO_TOASTS, showToast } from "./toastSlots";

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
});
