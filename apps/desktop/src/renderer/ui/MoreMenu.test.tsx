// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoreMenu } from "./MoreMenu";

afterEach(cleanup);

describe("MoreMenu", () => {
  it("moves focus with the arrow keys, picks with Enter, and returns focus to its trigger", async () => {
    const user = userEvent.setup();
    const customize = vi.fn();
    const addApp = vi.fn();
    render(
      <MoreMenu
        label="Sidebar actions"
        items={[
          { label: "Customize…", onSelect: customize },
          { label: "Add an app here…", onSelect: addApp },
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Sidebar actions" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Customize…" }));

    await user.keyboard("{ArrowDown}{Enter}");
    expect(addApp).toHaveBeenCalledOnce();
    expect(customize).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await user.keyboard("{Enter}{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
