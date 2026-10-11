// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useCallback, useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useFocusReturn, useFocusSurface } from "./focusReturn";
import { SidePanel } from "../workbench/SidePanel";
import { AboutRail } from "../workbench/AboutRail";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("returns focus once in the Escape close commit", async () => {
  function Menu() {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    useFocusReturn(open, root);
    return <><button onClick={() => setOpen(true)}>Open menu</button>
      {open && <div ref={root} onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}><button>Menu item</button></div>}
    </>;
  }
  render(<Menu />);
  const opener = screen.getByText("Open menu");
  opener.focus();
  fireEvent.click(opener);
  const item = screen.getByText("Menu item");
  item.focus();
  const focus = vi.spyOn(opener, "focus");
  fireEvent.keyDown(item, { key: "Escape" });
  expect(screen.queryByText("Menu item")).toBeNull();
  expect(document.activeElement).toBe(opener);
  opener.blur();
  await act(async () => {});
  expect(focus).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(document.body);
});

it("cancels StrictMode replay returns before a mounted owner closes", async () => {
  function Menu({ open }: { open: boolean }) {
    const root = useRef<HTMLDivElement>(null);
    useFocusReturn(open, root);
    return open ? <div ref={root}><button autoFocus>Menu item</button></div> : null;
  }
  const view = render(<button>Open menu</button>);
  const opener = screen.getByText("Open menu");
  opener.focus();
  view.rerender(<><button>Open menu</button><StrictMode><Menu open /></StrictMode></>);
  await act(async () => {});
  expect(document.activeElement).toBe(screen.getByText("Menu item"));
  view.rerender(<><button>Open menu</button><StrictMode><Menu open={false} /></StrictMode></>);
  expect(document.activeElement).toBe(opener);
});

function Workspace({ name }: { name: string }) {
  const root = useRef<HTMLDivElement>(null);
  useFocusReturn(true, root, () => document.querySelector('[data-focus-surface="workspace"]'));
  useFocusSurface(root, () => root.current);
  return <div ref={root} tabIndex={-1} data-focus-surface="workspace" data-testid={name}><button>Work in {name}</button></div>;
}
it("lands in the new workspace when the focused workspace is replaced", async () => {
  const view = render(<Workspace key="A" name="A" />);
  screen.getByText("Work in A").focus();
  view.rerender(<Workspace key="B" name="B" />);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("B")));
});
it.each(["side", "about"])("returns focus when the %s panel closes", async (kind) => {
  function Panels() {
    const [open, setOpen] = useState(false);
    const close = <button onClick={() => setOpen(false)}>Close panel</button>;
    return <><button data-testid={kind === "side" ? "titlebar-primary-sidebar" : "titlebar-about-sidebar"} onClick={() => setOpen(true)}>Open panel</button>
      {open && (kind === "side"
        ? <SidePanel width={240} title="Files" onWidthChange={() => {}}>{close}</SidePanel>
        : <AboutRail width={240} onWidthChange={() => {}}>{close}</AboutRail>)}
    </>;
  }
  render(<Panels />);
  const opener = screen.getByText("Open panel");
  opener.focus();
  fireEvent.click(opener);
  const close = screen.getByRole("button", { name: "Close panel" });
  close.focus();
  fireEvent.click(close);
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

it("returns to the surface after its focused editor is replaced", async () => {
  function Editor({ path }: { path: string }) {
    const root = useRef<HTMLElement>(null);
    useFocusSurface(root, () => root.current);
    return <section ref={root} tabIndex={-1} data-testid="editor"><textarea key={path} aria-label={path} /></section>;
  }
  const view = render(<Editor path="first.md" />);
  screen.getByRole("textbox").focus();
  view.rerender(<Editor path="second.md" />);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("editor")));
});
it("does not steal focus when a removed child had already yielded it", async () => {
  function Surface({ show }: { show: boolean }) {
    const root = useRef<HTMLElement>(null);
    useFocusSurface(root, () => root.current);
    return <><section ref={root} tabIndex={-1}>{show && <button>Transient</button>}</section><button>Destination</button></>;
  }
  const view = render(<Surface show />);
  screen.getByText("Transient").focus();
  screen.getByText("Destination").focus();
  view.rerender(<Surface show={false} />);
  await waitFor(() => expect(screen.queryByText("Transient")).toBeNull());
  expect(document.activeElement).toBe(screen.getByText("Destination"));
});

it("restores a surface when only a descendant renders to remove focus", async () => {
  function Child() {
    const [show, setShow] = useState(true);
    return <>{show && <button onClick={() => setShow(false)}>Remove child</button>}</>;
  }
  function Surface() {
    const root = useRef<HTMLElement>(null);
    useFocusSurface(root, () => root.current);
    return <section ref={root} tabIndex={-1} data-testid="surface"><Child /></section>;
  }
  render(<Surface />);
  const child = screen.getByText("Remove child");
  child.focus();
  fireEvent.click(child);
  await act(async () => {});
  expect(document.activeElement).toBe(screen.getByTestId("surface"));
});
it("keeps a deliberate blur when the previously focused child is later removed", async () => {
  function Surface({ show }: { show: boolean }) {
    const root = useRef<HTMLElement>(null);
    useFocusSurface(root, () => root.current);
    return <section ref={root} tabIndex={-1}>{show && <button>Transient</button>}</section>;
  }
  const view = render(<Surface show />);
  const child = screen.getByText("Transient");
  child.focus();
  child.blur();
  // A removal in the same script would be Chromium's blur before a detach.
  await act(async () => {});
  expect(document.activeElement).toBe(document.body);
  view.rerender(<Surface show={false} />);
  await act(async () => {});
  expect(document.activeElement).toBe(document.body);
});

it.each(["click", "Enter"])("recovers when Chromium blurs a child before a %s removes it", async (action) => {
  const user = userEvent.setup();
  function Surface() {
    const root = useRef<HTMLElement>(null);
    const [show, setShow] = useState(true);
    useFocusSurface(root, () => root.current);
    // React detaches the ref before it removes the node, where Chromium blurs it.
    const blurBeforeDetach = useCallback((node: HTMLButtonElement | null) => node ? () => node.blur() : undefined, []);
    return <section ref={root} tabIndex={-1} data-testid="surface">
      {show && <button ref={blurBeforeDetach} onClick={() => setShow(false)}>Remove</button>}
    </section>;
  }
  const blurs: string[] = [];
  const record = (event: FocusEvent) => {
    if (event.target instanceof HTMLButtonElement) blurs.push(`connected ${event.target.isConnected}, body active ${document.activeElement === document.body}`);
  };
  document.addEventListener("focusout", record);
  try {
    render(<Surface />);
    const button = screen.getByText("Remove");
    if (action === "click") await user.click(button);
    else {
      button.focus();
      await user.keyboard("{Enter}");
    }
    expect(blurs).toEqual(["connected true, body active true"]);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("surface")));
  } finally {
    document.removeEventListener("focusout", record);
  }
});

it("keeps a deliberate blur that follows a sibling change in the same script", async () => {
  function Surface() {
    const root = useRef<HTMLElement>(null);
    useFocusSurface(root, () => root.current);
    return <section ref={root} tabIndex={-1}><button>Row</button></section>;
  }
  render(<Surface />);
  const row = screen.getByText("Row");
  row.focus();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  row.parentElement!.append(document.createElement("div"));
  row.blur();
  await act(async () => {});
  expect(document.activeElement).toBe(document.body);
});

it("preserves removal recovery when focusout leaves the same active element", async () => {
  function Surface({ show }: { show: boolean }) {
    const root = useRef<HTMLElement>(null);
    useFocusSurface(root, () => root.current);
    return <section ref={root} tabIndex={-1} data-testid="surface">{show && <button>Transient</button>}</section>;
  }
  const view = render(<Surface show />);
  const child = screen.getByText("Transient");
  child.focus();
  fireEvent.focusOut(child, { relatedTarget: null });
  expect(document.activeElement).toBe(child);
  view.rerender(<Surface show={false} />);
  await act(async () => {});
  expect(document.activeElement).toBe(screen.getByTestId("surface"));
});

it("forgets a blank-area pointer click before the surface content closes later", async () => {
  const user = userEvent.setup();
  function Surface({ show }: { show: boolean }) {
    const root = useRef<HTMLElement>(null);
    useFocusSurface(root, () => root.current?.querySelector("button"));
    return <section ref={root}>
      {show && <div><button>Transient</button></div>}
      <button>Return target</button>
      <div data-testid="blank">Blank area</div>
    </section>;
  }
  const view = render(<Surface show />);
  await user.click(screen.getByText("Transient"));
  await user.click(screen.getByTestId("blank"));
  expect(document.activeElement).toBe(document.body);
  view.rerender(<Surface show={false} />);
  await act(async () => {});
  expect(document.activeElement).toBe(document.body);
});

it("does not restore focus after the window blurs and a focused child is removed", async () => {
  function Surface({ show }: { show: boolean }) {
    const root = useRef<HTMLElement>(null);
    useFocusSurface(root, () => root.current);
    return <section ref={root} tabIndex={-1}>{show && <button>Transient</button>}</section>;
  }
  const view = render(<Surface show />);
  const child = screen.getByText("Transient");
  child.focus();
  fireEvent.pointerDown(child);
  fireEvent.focusOut(child, { relatedTarget: null });
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  fireEvent(window, new Event("blur"));
  expect(document.activeElement).toBe(child);
  view.rerender(<Surface show={false} />);
  await act(async () => {});
  expect(document.activeElement).toBe(document.body);
});

it("keeps focus on a row reinserted during a reorder", async () => {
  function Surface({ rows }: { rows: string[] }) {
    const root = useRef<HTMLElement>(null);
    useFocusSurface(root, () => root.current);
    return <section ref={root} tabIndex={-1}>
      {rows.map((row) => <button key={row}>{row}</button>)}
    </section>;
  }
  render(<Surface rows={["First", "Second"]} />);
  const row = screen.getByText("First");
  row.focus();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const focus = vi.spyOn(row, "focus");
  // Reinsert the keyed node without React's commit-time focus restoration.
  row.parentElement!.append(row);
  expect(screen.getByText("First")).toBe(row);
  expect(row.isConnected).toBe(true);
  expect(document.activeElement).toBe(document.body);
  await act(async () => {});
  expect(document.activeElement).toBe(row);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
});

it("keeps a pointer blur when sibling content changes during the press", async () => {
  function Surface() {
    const root = useRef<HTMLElement>(null);
    useFocusSurface(root, () => root.current);
    return <section ref={root} tabIndex={-1}><button>Row</button><div>Blank area</div></section>;
  }
  render(<Surface />);
  const row = screen.getByText("Row");
  row.focus();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  fireEvent.pointerDown(screen.getByText("Blank area"));
  row.blur();
  row.parentElement!.append(document.createElement("div"));
  await act(async () => {});
  expect(document.activeElement).toBe(document.body);
});

it("shares removal tracking and ignores contenteditable typing and sibling tree updates", async () => {
  const callbacks = vi.fn();
  const NativeObserver = MutationObserver;
  const observers = vi.fn(function (callback: MutationCallback) {
    return new NativeObserver((records, observer) => {
      callbacks();
      callback(records, observer);
    });
  });
  vi.stubGlobal("MutationObserver", observers);
  const listeners = vi.spyOn(document, "addEventListener");
  const user = userEvent.setup();
  function Editor() {
    const root = useRef<HTMLElement>(null);
    useFocusSurface(root, () => root.current);
    return <section ref={root} tabIndex={-1} data-testid="editor">
      <div data-testid="editor-content"><div role="textbox" contentEditable suppressContentEditableWarning /></div>
    </section>;
  }
  function Shell({ label }: { label: string }) {
    const root = useRef<HTMLDivElement>(null);
    useFocusSurface(root, () => root.current);
    return <div ref={root} tabIndex={-1} data-focus-surface="workspace">
      <Editor /><aside data-testid="tree" />{label}
    </div>;
  }
  const view = render(<Shell label="first" />);
  const focusListenerCount = () => listeners.mock.calls.filter(([type]) => type === "focusin" || type === "focusout").length;
  expect(focusListenerCount()).toBe(2);
  expect(observers).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("textbox"));
  view.rerender(<Shell label="second" />);
  expect(focusListenerCount()).toBe(2);
  await act(async () => {});
  callbacks.mockClear();
  await user.keyboard("Writing in the editor");
  screen.getByRole("textbox").append(document.createElement("p"));
  screen.getByTestId("tree").append(document.createElement("div"));
  await act(async () => {});
  expect(screen.getByRole("textbox").textContent).toBe("Writing in the editor");
  expect(callbacks).not.toHaveBeenCalled();

  screen.getByTestId("editor-content").remove();
  await act(async () => {});
  expect(callbacks).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(screen.getByTestId("editor"));

  screen.getByTestId("editor").blur();
  screen.getByTestId("editor").append(document.createElement("div"));
  await act(async () => {});
  expect(callbacks).toHaveBeenCalledTimes(1);
});

it("registers a surface whose container mounts after its owner", async () => {
  function Surface({ open }: { open: boolean }) {
    const root = useRef<HTMLElement>(null);
    useFocusSurface(root, () => root.current);
    return open ? <section ref={root} tabIndex={-1} data-testid="surface"><button>Transient</button></section> : null;
  }
  const view = render(<Surface open={false} />);
  view.rerender(<Surface open />);
  const child = screen.getByText("Transient");
  child.focus();
  child.remove();
  await act(async () => {});
  expect(document.activeElement).toBe(screen.getByTestId("surface"));
});

it("keeps removal memory when a new surface registers in the same commit", async () => {
  function ChildSurface() {
    const root = useRef<HTMLElement>(null);
    useFocusSurface(root, () => root.current);
    return <section ref={root} />;
  }
  function Surface({ show }: { show: boolean }) {
    const root = useRef<HTMLElement>(null);
    useFocusSurface(root, () => root.current);
    return <section ref={root} tabIndex={-1} data-testid="surface">
      {show ? <button>Transient</button> : <ChildSurface />}
    </section>;
  }
  const view = render(<Surface show />);
  screen.getByText("Transient").focus();
  view.rerender(<Surface show={false} />);
  await act(async () => {});
  expect(document.activeElement).toBe(screen.getByTestId("surface"));
});
