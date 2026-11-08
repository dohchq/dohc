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

it("draws an agent's mark and a person's initial side by side, then how many more", () => {
  const peer = (id: string, displayName: string, agent = false): PresencePeer => ({ faceToken: id, sessionToken: id, isSelf: false,
    displayName, paletteSlot: 1, state: agent ? { agent: true } : null, updatedAtMs: 0 });
  const { container } = render(<PresenceFaces others={[peer("sam", "Sam Rivera"), peer("nova", "Nova", true), peer("kim", "Kim"), peer("lee", "Lee")]} />);
  const faces = [...container.querySelectorAll(".dohc-presence-faces > span")];
  expect(faces.map((face) => face.textContent)).toEqual(["S", "", "K", "+1"]);
  expect(faces[1]?.getAttribute("title")).toBe("Nova");
  expect(faces[1]?.querySelector("svg")).not.toBeNull();
  expect(faces[1]?.className).not.toContain("rounded-full");
  expect(container.querySelector(".dohc-presence-faces")?.className).toContain("gap-1");
  for (const face of faces) expect(face.className).not.toMatch(/-ml-/u);
  expect(screen.getByRole("status").getAttribute("aria-label")).toBe("4 people here");
});
