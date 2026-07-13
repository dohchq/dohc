// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityBar } from "./ActivityBar";

afterEach(cleanup);

describe("ActivityBar optional utility actions", () => {
  it("renders Cloud and Settings as inert icons when the host omits actions", () => {
    render(
      <ActivityBar
        activeView="explorer"
        sidebarVisible
        hasConflict={false}
        chatsEnabled
        onSelectView={() => undefined}
      />,
    );

    expect(screen.getByTestId("activity-cloud").tagName).toBe("SPAN");
    expect(screen.getByTestId("activity-settings").tagName).toBe("SPAN");
    expect(screen.queryByRole("button", { name: "dohc Cloud" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open settings" })).toBeNull();
  });

  it("keeps the desktop Cloud and Settings actions clickable when supplied", () => {
    const onOpenCloud = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <ActivityBar
        activeView="explorer"
        sidebarVisible
        hasConflict={false}
        onSelectView={() => undefined}
        onOpenCloud={onOpenCloud}
        onOpenSettings={onOpenSettings}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "dohc Cloud" }));
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(onOpenCloud).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});
