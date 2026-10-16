import type { Page } from "@playwright/test";
import type { DohcDesktopBridge, EngineMomentRecord, HistoryCursor } from "../../src/ipc/bridgeContract";

// Read the complete cursor-fenced History. An unavailable page cannot prove absence.
export async function readHistoryMoments(
  page: Page,
  workspaceId: string,
  path?: string,
): Promise<EngineMomentRecord[] | null> {
  return page.evaluate(async ({ workspaceId, path }) => {
    const api = (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop;
    const moments: EngineMomentRecord[] = [];
    let cursor: HistoryCursor | undefined;
    do {
      const result = await api.listEngineMoments({ workspaceId, limit: 50, cursor });
      if (!("moments" in result)) return null;
      moments.push(...result.moments.filter(moment => path === undefined || moment.path === path));
      cursor = result.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return moments;
  }, { workspaceId, path });
}
