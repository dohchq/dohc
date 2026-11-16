import { describe, expect, it } from "vitest";
import { createNavigationRule, externalLink } from "./appNavigation";

const BOOTSTRAP = `https://${"a".repeat(48)}.apps.example.net/bootstrap`;
const SERVER = "https://dohc.example.com";

describe("an app's navigation rule", () => {
  it("loads the exact bootstrap once at the top, then only about:srcdoc and about:blank in frames", () => {
    const allows = createNavigationRule(BOOTSTRAP);
    const table: [string, boolean, boolean][] = [
      // Before the bootstrap, nothing else loads, a frame's about:srcdoc included.
      ["about:srcdoc", false, false],
      [`${BOOTSTRAP}?x=1`, true, false],
      [BOOTSTRAP, false, false],
      [BOOTSTRAP, true, true],
      // Once only, at the top or reported as a frame.
      [BOOTSTRAP, true, false],
      [BOOTSTRAP, false, false],
      ["about:srcdoc", false, true],
      ["about:blank", false, true],
      ["about:srcdoc", true, false],
      ["about:blank", true, false],
      // Everything else, in a frame or at the top: the launch host, other HTTPS, dohc's own scheme and the rest.
      [`https://${"a".repeat(48)}.apps.example.net/status`, false, false],
      ["https://example.org/", false, false],
      ["https://example.org/", true, false],
      [`${SERVER}/sync/ws/ops/apps`, true, false],
      ["dohc://page?path=a.md", false, false],
      ["dohc://app-run", true, false],
      ["tel:+15555550100", false, false],
      ["sms:+15555550100", true, false],
      ["file:///etc/hosts", false, false],
      ["data:text/html,<p>x</p>", false, false],
      ["javascript:alert(1)", true, false],
      ["blob:https://example.org/1", false, false],
    ];
    for (const [url, isTopFrame, allowed] of table)
      expect(allows({ url, isTopFrame }), `${url} top=${isTopFrame}`).toBe(allowed);
  });

  it("starts again with each launch's own rule", () => {
    const first = createNavigationRule(BOOTSTRAP);
    expect(first({ url: BOOTSTRAP, isTopFrame: true })).toBe(true);
    const second = createNavigationRule(BOOTSTRAP);
    expect(second({ url: BOOTSTRAP, isTopFrame: true })).toBe(true);
    expect(first({ url: BOOTSTRAP, isTopFrame: true })).toBe(false);
  });
});

describe("a link the person taps in an app", () => {
  it("opens outside only over HTTPS, never on the dohc server or the app domain", () => {
    const table: [string, string | null][] = [
      ["https://example.org/trip?day=2", "https://example.org/trip?day=2"],
      ["https://maps.example.org/", "https://maps.example.org/"],
      ["http://example.org/", null],
      ["https://user:pass@example.org/", null],
      [SERVER, null],
      [`${SERVER}/sync/ws/ops/apps`, null],
      ["https://share.dohc.example.com/s/x", null],
      ["https://apps.example.net/", null],
      ["https://dohc.example.com./", null],
      ["https://x.apps.example.net./", null],
      [`https://${"b".repeat(48)}.apps.example.net/bootstrap`, null],
      ["dohc://page?path=a.md", null],
      ["tel:+15555550100", null],
      ["mailto:someone@example.org", null],
      ["file:///etc/hosts", null],
      ["data:text/html,<p>x</p>", null],
      ["javascript:alert(1)", null],
      ["not a url", null],
    ];
    for (const [url, opened] of table)
      expect(externalLink(url, BOOTSTRAP, SERVER), url).toBe(opened);
  });
});
