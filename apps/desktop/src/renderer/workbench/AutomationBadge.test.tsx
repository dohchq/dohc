// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationBadge } from "./AutomationBadge";

afterEach(cleanup);

const author = { authorDisplayName: "Stamp the finish date", authorOwnerDisplayName: "Ana", authorUserId: "ana" };
const local = { automationId: "collection:Trip/Tasks#stamp", collectionPath: "Trip/Tasks" };

describe("AutomationBadge", () => {
  it("names the automation and the computer it ran on", () => {
    render(<AutomationBadge testIdPrefix="chats-message" author={author} viewerAuthorId="ice" />);
    const badge = screen.getByTestId("chats-message-automation-badge");
    expect(badge.getAttribute("aria-label")).toBe("automation");
    expect(badge.querySelector(".sr-only")?.textContent).toBe("automation");
    expect(badge.tabIndex).toBe(0);
    fireEvent.focus(badge);
    expect(screen.getByRole("tooltip").textContent).toBe("Stamp the finish dateRan on Ana's computer");
    expect(badge.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
    fireEvent.keyDown(badge, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it.each([
    ["your own automation on another of your computers", { ...author, authorUserId: "ice" }, "Ran on another of your computers"],
    ["an automation on this computer", { ...author, automation: local }, "Ran on your computer"],
    ["an automation without an owner name", { authorDisplayName: "Stamp the finish date" }, "Ran on another computer"],
  ])("says where %s ran", (_name, value, expected) => {
    render(<AutomationBadge testIdPrefix="chats-message" author={value} viewerAuthorId="ice" />);
    fireEvent.mouseEnter(screen.getByTestId("chats-message-automation-badge").parentElement!);
    expect(screen.getByRole("tooltip").textContent).toContain(expected);
  });

  it("opens an automation that ran on this computer from its Collection's automations file", () => {
    const onOpenPath = vi.fn();
    const onOpenPost = vi.fn();
    render(<div onClick={onOpenPost}>
      <AutomationBadge testIdPrefix="chats-message" author={{ ...author, automation: local }} onOpenPath={onOpenPath} />
    </div>);
    const open = screen.getByRole("button", { name: "Open automation" });
    fireEvent.click(open);
    expect(onOpenPath).toHaveBeenCalledWith("Trip/Tasks/automations.yaml");
    expect(onOpenPost).not.toHaveBeenCalled();
  });

  it("offers no way to open an automation from another computer, or where nothing can open files", () => {
    const onOpenPath = vi.fn();
    render(<>
      <AutomationBadge testIdPrefix="remote" author={author} onOpenPath={onOpenPath} />
      <AutomationBadge testIdPrefix="unopenable" author={{ ...author, automation: local }} />
    </>);
    expect(screen.queryByRole("button")).toBeNull();
    const onOpenPost = vi.fn();
    cleanup();
    render(<div onClick={onOpenPost}><AutomationBadge testIdPrefix="remote" author={author} /></div>);
    fireEvent.click(screen.getByTestId("remote-automation-badge"));
    expect(screen.getByRole("tooltip")).not.toBeNull();
    expect(onOpenPost).not.toHaveBeenCalled();
  });
});
