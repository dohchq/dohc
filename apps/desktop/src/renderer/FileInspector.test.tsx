// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { classifyForView } from "./FileInspector";

describe("classifyForView dispatch", () => {
  const cases: Array<[string, string]> = [
    ["notes/today.md", "markdown"],
    ["readme.markdown", "markdown"],
    ["data/transactions.csv", "csv"],
    ["data/config.json", "json"],
    ["notes/plain.txt", "text"],
    ["uploads/receipt.png", "image"],
    ["uploads/logo.svg", "image"],
    ["uploads/voice.m4a", "audio"],
    ["uploads/contract.pdf", "pdf"],
    ["finance/wallet.sqlite", "database"],
    ["archive/old.db", "database"],
    ["finance/.apps/ledger/app.json", "app-source"],
    ["finance/.apps/ledger/src/App.tsx", "app-source"],
    ["uploads/mystery.bin", "binary"],
  ];

  for (const [path, expected] of cases) {
    it(`classifies ${path} as ${expected}`, () => {
      expect(classifyForView(path)).toBe(expected);
    });
  }

  it("treats an app-source file as app even if it has a data extension", () => {
    // .apps/<name>/app.json is app source, not a standalone JSON document.
    expect(classifyForView("x/.apps/ledger/app.json")).toBe("app-source");
  });
});
