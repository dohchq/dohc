import type { GetCollectionRecordHistoryPayload } from "../../ipc/bridgeContract";
import type { ReadDesktop } from "../desktopOperations";

export async function readRecordHistoryPage(desktop: ReadDesktop, input: GetCollectionRecordHistoryPayload) {
  return { page: await desktop.getCollectionRecordHistory(input), before: input.beforeHistoryId ?? null };
}
