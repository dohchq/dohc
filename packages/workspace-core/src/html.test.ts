import { describe, expect, it } from "vitest";
import { escapeHtml } from "./html";

describe("escapeHtml", () => {
  it("escapes the five HTML literals", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
    );
  });

  it("double-escapes existing entities", () => {
    expect(escapeHtml("&amp; &lt;script&gt;")).toBe(
      "&amp;amp; &amp;lt;script&amp;gt;",
    );
  });

  it("passes Unicode and line breaks through unchanged", () => {
    expect(escapeHtml("café\nπ ≥ 1")).toBe("café\nπ ≥ 1");
  });
});
