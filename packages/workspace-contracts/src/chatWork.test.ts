import { describe, expect, it } from "vitest";
import { isChatWorkStatus, isWorkUrl, MAX_WORK_URL_CHARS } from "./chatWork";

describe("a work report's link", () => {
  it("is a web address with no space or control character", () => {
    const longest = `https://example.com/${"a".repeat(MAX_WORK_URL_CHARS - 20)}`;
    expect(longest).toHaveLength(MAX_WORK_URL_CHARS);
    for (const url of ["https://example.com/pull/7", "http://localhost:3773/threads/1", longest]) {
      expect(isWorkUrl(url), url).toBe(true);
    }
    // The engine refuses the same links in `normalize_work_report`.
    for (const url of [
      "ftp://example.com/file",
      "javascript:alert(1)",
      "mailto:ada@example.com",
      "https://",
      "HTTPS://example.com",
      " https://example.com",
      "https://example.com/a b",
      "https://example.com/\u0007",
      "https://example.com/﻿",
      `${longest}a`,
    ]) {
      expect(isWorkUrl(url), url).toBe(false);
    }
  });

  it("knows the statuses an agent can report", () => {
    expect(["working", "waiting", "done", "failed", "stopped"].every(isChatWorkStatus)).toBe(true);
    expect(isChatWorkStatus("paused")).toBe(false);
    expect(isChatWorkStatus(undefined)).toBe(false);
  });
});
