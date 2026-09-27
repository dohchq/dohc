// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, expect, it } from "vitest";
import { useFocusReturn, useFocusSurface } from "./focusReturn";
import { SidePanel } from "../workbench/SidePanel";
import { ChatsPanel } from "../workbench/ChatsPanel";

afterEach(cleanup);

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
it.each(["side", "chats"])("returns focus when the %s panel closes", async (kind) => {
  function Panels() {
    const [open, setOpen] = useState(false);
    return <><button data-testid={kind === "side" ? "titlebar-primary-sidebar" : "titlebar-chats-sidebar"} onClick={() => setOpen(true)}>Open panel</button>
      {open && (kind === "side"
        ? <SidePanel width={240} title="Files" onWidthChange={() => {}}><button onClick={() => setOpen(false)}>Close panel</button></SidePanel>
        : <ChatsPanel width={240} tabs={["all"]} tab="all" onTabChange={() => {}} onWidthChange={() => {}} onCollapse={() => setOpen(false)}>Chats</ChatsPanel>)}
    </>;
  }
  render(<Panels />);
  const opener = screen.getByText("Open panel");
  opener.focus();
  fireEvent.click(opener);
  const close = screen.getByRole("button", { name: kind === "side" ? "Close panel" : "Hide chats" });
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
