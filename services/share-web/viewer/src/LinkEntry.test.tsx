// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect, it, vi} from "vitest";
import {LinkAbout, LinkAgent} from "./LinkEntry";
it("names the authorized link target with its access, without inventing a sharer", async () => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  const node = document.createElement("div"), root = createRoot(node);
  try {
    await act(async () => root.render(<LinkAbout meta={{subjectName: "Trip", access: "view", effectiveSelector: {paths: ["trip"], versionId: null, access: "view"}, lastSettledAtMs: null, lastSettledKnown: false}} fileCount={2} updated=""/>));
    expect(node.textContent).toContain("Trip"); expect(node.textContent).toContain("Anyone with this link can view"); expect(node.textContent).toContain("2 files in trip");
    expect(node.textContent).not.toContain("dohc user");
  } finally {await act(async () => root.unmount());}
});

it("shows the MCP address format and copies exactly that address", async () => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText}});
  const node = document.createElement("div"), root = createRoot(node);
  try {
    await act(async () => root.render(<LinkAgent/>));
    const section = node.querySelector('section[aria-labelledby="link-agent-title"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain(`${location.origin}/mcp/s/<secret>`);
    expect(section?.textContent).toContain("Replace <secret> with the text after # in the original share link.");
    expect(section?.textContent).toContain("It cannot access work outside this link or change its permissions.");
    expect(section?.textContent).not.toContain("Included paths");
    const button = section?.querySelector('button[aria-label="Copy MCP address"]') as HTMLButtonElement;
    await act(async () => button.click());
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/mcp/s/<secret>`);
    expect(button.title).toBe("Copied");
    writeText.mockRejectedValueOnce(new Error("Clipboard refused"));
    await act(async () => button.click());
    expect(button.title).toBe("Could not copy");
    expect(section?.querySelector("code")?.textContent).toBe(`${location.origin}/mcp/s/<secret>`);
  } finally {await act(async () => root.unmount());}
});
