// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { modalFocusableElements, switchModalRegion, trapModalTabKey } from "./modalFocus";

afterEach(() => document.body.replaceChildren());

function dialogWith(markup: string): HTMLDivElement {
  const dialog = document.createElement("div");
  dialog.tabIndex = -1;
  dialog.innerHTML = markup;
  document.body.append(dialog);
  return dialog;
}

describe("modal focus with native summaries", () => {
  it("cycles native summaries in a toast and returns to the dialog on F6", () => {
    const dialog = dialogWith('<button>Review change</button>');
    const action = dialog.querySelector("button")!;
    const toasts = document.createElement("div");
    toasts.setAttribute("data-dohc-toasts", "");
    toasts.innerHTML = '<details><summary>Technical details</summary><button>Hidden action</button></details><button>Dismiss</button>';
    document.body.append(toasts);
    const summary = toasts.querySelector("summary")!;
    const dismiss = toasts.querySelectorAll("button")[1]!;
    action.focus();
    expect(switchModalRegion(new KeyboardEvent("keydown", { key: "F6", cancelable: true }), dialog)).toBe(true);
    expect(document.activeElement).toBe(summary);
    trapModalTabKey(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true }), dialog);
    expect(document.activeElement).toBe(dismiss);
    trapModalTabKey(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }), dialog);
    expect(document.activeElement).toBe(summary);
    expect(switchModalRegion(new KeyboardEvent("keydown", { key: "F6", cancelable: true }), dialog)).toBe(true);
    expect(document.activeElement).toBe(action);
  });

  it.each([false, true])("wraps from a programmatically focused excluded boundary (reverse: %s)", (reverse) => {
    const dialog = dialogWith(`
      <button tabindex="-1" data-before>Programmatic start</button>
      <details><summary>4 unchanged fields</summary></details>
      <button>Discard review</button>
      <button tabindex="-1" data-after>Programmatic end</button>
    `);
    const summary = dialog.querySelector("summary")!;
    const action = dialog.querySelector<HTMLElement>('button:not([tabindex])')!;
    const excluded = dialog.querySelector<HTMLElement>(reverse ? '[data-before]' : '[data-after]')!;
    expect(modalFocusableElements(dialog)).toEqual([summary, action]);
    excluded.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: reverse, cancelable: true });
    trapModalTabKey(event, dialog);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(reverse ? action : summary);
  });

  it.each([false, true])("wraps from the first summary to the last enabled action and back (approval enabled: %s)", (approvalEnabled) => {
    const background = document.createElement("button");
    background.textContent = "Delete record";
    document.body.append(background);
    const dialog = dialogWith(`
      <details><summary>4 unchanged fields</summary><p>Saved values</p></details>
      <details><summary>Show migration SQL</summary><pre>SELECT 1</pre></details>
      <input type="checkbox" aria-label="I reviewed this change">
      <button>Review another change</button>
      <button>Discard review</button>
      <button ${approvalEnabled ? "" : "disabled"}>Approve change</button>
    `);
    const [first, second] = dialog.querySelectorAll("summary");
    const checkbox = dialog.querySelector("input")!;
    const [review, discard, approve] = dialog.querySelectorAll("button");
    const last = approvalEnabled ? approve : discard;
    expect(modalFocusableElements(dialog)).toEqual([first, second, checkbox, review, discard, ...(approvalEnabled ? [approve] : [])]);

    // Set the boundary focus explicitly. jsdom does not perform native Tab navigation.
    first!.focus();
    expect(document.activeElement).toBe(first);
    const reverse = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true });
    trapModalTabKey(reverse, dialog);
    expect(reverse.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    const forward = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    trapModalTabKey(forward, dialog);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    second!.focus();
    const interior = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true });
    trapModalTabKey(interior, dialog);
    expect(interior.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(second);
  });

  it("exposes nested binary summaries only while their enclosing details are open", () => {
    const dialog = dialogWith(`
      <details>
        <summary>4 unchanged fields</summary>
        <dl><dd><details><summary>Binary value</summary><pre>AA==</pre></details></dd></dl>
      </details>
      <button>Discard review</button>
    `);
    const outer = dialog.querySelector("details")!;
    const [first, binary] = dialog.querySelectorAll("summary");
    const discard = dialog.querySelector("button")!;
    expect(modalFocusableElements(dialog)).toEqual([first, discard]);
    outer.open = true;
    expect(modalFocusableElements(dialog)).toEqual([first, binary, discard]);
    outer.open = false;
    expect(modalFocusableElements(dialog)).toEqual([first, discard]);
  });

  it("skips summaries excluded by tabindex or hidden ancestors", () => {
    const dialog = dialogWith(`
      <details><summary tabindex="-1">Programmatic focus only</summary></details>
      <details><summary tabindex="-2">Also excluded</summary></details>
      <details><summary hidden>Hidden summary</summary></details>
      <details hidden><summary>Hidden disclosure</summary></details>
      <div aria-hidden="true"><details><summary>Hidden from accessibility</summary></details></div>
      <details><summary tabindex="0">Included summary</summary><summary>Not the disclosure control</summary></details>
      <button>Discard review</button>
    `);
    const included = dialog.querySelector<HTMLElement>('summary[tabindex="0"]')!;
    const hidden = document.createElement("input");
    hidden.type = "hidden";
    dialog.append(hidden);
    const discard = dialog.querySelector("button")!;
    expect(modalFocusableElements(dialog)).toEqual([included, discard]);
    discard.focus();
    const forward = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    trapModalTabKey(forward, dialog);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(included);
  });
});
