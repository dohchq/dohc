// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PresenceFaces } from "./PresenceIndicators";
import type { PresencePeer } from "./presenceChannel";
afterEach(cleanup);
it("draws faces from disclosed slots, with readable theme classes", () => {
  const peer = (slot: number): PresencePeer => ({ faceToken: String(slot), sessionToken: String(slot), isSelf: false,
    displayName: "Same label", paletteSlot: slot, state: null, updatedAtMs: 0 });
  const { container, rerender } = render(<PresenceFaces others={[peer(0), peer(6)]} />);
  expect(screen.getByRole("status").getAttribute("title")).toBe("Same label, Same label");
  expect(container.querySelectorAll("span")[0]?.className).toContain("text-hue-rust");
  expect(container.querySelectorAll("span")[1]?.className).toContain("text-hue-rose");
  document.documentElement.dataset.theme = "dark";
  rerender(<PresenceFaces others={[peer(0), peer(6)]} />);
  expect(container.querySelectorAll("span")[0]?.getAttribute("style")).toBeNull();
  expect(container.querySelectorAll("span")[0]?.className).toContain("bg-hue-rust/15");
  delete document.documentElement.dataset.theme;
});
