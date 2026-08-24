import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

function sourceBlock(startMarker: string, endMarker: string): string {
  const start = mainSource.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = mainSource.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return mainSource.slice(start, end);
}

function handlerSource(channel: string): string {
  return sourceBlock(`ipcMain.handle(CHANNELS.${channel}`, "\n  });");
}

describe("ShareViewFiles main-process wiring", () => {
  it("limits received-share ripgrep passes to canonical share files", () => {
    const handler = handlerSource("searchWorkspace");
    const preparedAt = handler.indexOf(
      ").prepareSearch();",
    );
    const mountStartAt = handler.indexOf("await searchRegistry.startSearch(");
    const fallbackStartAt = handler.indexOf(
      "await searchRegistry.startSearch(",
      mountStartAt + 1,
    );
    const mountPredicateAt = handler.indexOf(
      "allowPath: ownedSearchView.allowPath,",
      mountStartAt,
    );
    const ownedPredicateAt = handler.indexOf(
      "allowPath: ownedSearchView.allowPath,",
      fallbackStartAt,
    );

    expect(preparedAt).toBeGreaterThan(-1);
    expect(mountStartAt).toBeGreaterThan(preparedAt);
    expect(fallbackStartAt).toBeGreaterThan(mountStartAt);
    expect(mountPredicateAt).toBeGreaterThan(mountStartAt);
    expect(mountPredicateAt).toBeLessThan(fallbackStartAt);
    expect(ownedPredicateAt).toBeGreaterThan(fallbackStartAt);
  });
});
