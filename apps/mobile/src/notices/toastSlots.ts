import { confirmWords } from "@dohc/interface-words/confirmations";
import { noticesWords } from "@dohc/interface-words/notices";
import type { ToastMessage } from "./Toast";

// Which toast the tabs show. One shows at a time. A toast holding the only Undo for a change stays until it's closed
// or another Undo replaces it: any other toast waits behind it and shows once it closes. Every other toast keeps its
// row in Notices, so waiting loses nothing.

export interface ToastSlots {
  readonly shown: ToastMessage | null;
  /** The latest other toast, behind a toast holding an Undo. */
  readonly waiting: ToastMessage | null;
}

export const NO_TOASTS: ToastSlots = { shown: null, waiting: null };

/** The toast after Done on a Notice from the server: its only Undo, which restores it. */
export function doneToast(noticeId: string, restore: () => void): ToastMessage {
  return {
    id: `done:${noticeId}`,
    tone: "success",
    title: noticesWords.markedDone,
    holdsUndo: true,
    action: { label: confirmWords.undo, onPress: restore },
  };
}

export function showToast(slots: ToastSlots, message: ToastMessage): ToastSlots {
  if (message.holdsUndo) {
    // An Undo replaces whatever shows. Another toast it covers waits; an older Undo goes.
    const covered = slots.shown && !slots.shown.holdsUndo ? slots.shown : slots.waiting;
    return { shown: message, waiting: covered };
  }
  if (slots.shown?.holdsUndo) return { shown: slots.shown, waiting: message };
  return { shown: message, waiting: null };
}

/** Takes back the toast with this id, shown or waiting. */
export function hideToast(slots: ToastSlots, id: string): ToastSlots {
  if (slots.shown?.id === id) return { shown: slots.waiting, waiting: null };
  if (slots.waiting?.id === id) return { shown: slots.shown, waiting: null };
  return slots;
}

/** Closes the toast shown; one waiting behind it shows. */
export function closeToast(slots: ToastSlots): ToastSlots {
  return { shown: slots.waiting, waiting: null };
}
