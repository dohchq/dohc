/** Attribution supplied by an agent. The authenticated owner retains all authority. */
export interface ApprovalAgent { kind: "agent"; label: string | null; labelSource: "agent-declared" }
export function parseApprovalAgent(value: unknown): ApprovalAgent | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid approval agent.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["kind", "label", "labelSource"].includes(key)) || row.kind !== "agent" || row.labelSource !== "agent-declared" ||
      (row.label !== null && (typeof row.label !== "string" || !row.label.trim() || row.label.length > 160 || /[\x00-\x1f\x7f]/u.test(row.label)))) throw new Error("Invalid approval agent.");
  return { kind: "agent", label: row.label as string | null, labelSource: "agent-declared" };
}
