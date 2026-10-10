import { isNormalizedRelativePath } from "@dohc/workspace-contracts/collection-values";
export const MAX_CSV_PREVIEW_ROWS = 500;
export interface CsvBoundOffer {
  kind: "csv-bound"; path: string; cap: number; totalRows: number; plainWorkspaceCsv: true;
}
export function detectCsvBound(input: {
  path: string; totalRows: number; source: "workspace-file" | "received-share" | "dataset"; complete: boolean; cap?: number;
}): CsvBoundOffer | null {
  const cap = input.cap ?? MAX_CSV_PREVIEW_ROWS;
  if (input.source !== "workspace-file" || !input.complete || !isNormalizedRelativePath(input.path)
    || input.path.split("/")[0]?.toLowerCase() === "shared-with-me" || !/\.csv$/i.test(input.path)
    || !Number.isSafeInteger(input.totalRows) || !Number.isSafeInteger(cap) || cap < 1 || input.totalRows <= cap) return null;
  return { kind: "csv-bound", path: input.path, cap, totalRows: input.totalRows, plainWorkspaceCsv: true };
}
