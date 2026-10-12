// Contracts owns the change-author types and the local-author label's brand.
import type {
  ChangeAuthor,
  NonEmptyLocalAuthorLabel,
} from "@dohc/workspace-contracts/engine";

function parseLocalAuthorLabel(label: unknown): NonEmptyLocalAuthorLabel {
  if (typeof label !== "string") {
    throw new Error("Local change author label must be a string.");
  }
  const normalized = label.trim();
  if (!normalized) throw new Error("Local change author label must be non-empty.");
  return normalized as NonEmptyLocalAuthorLabel;
}

export function createLocalChangeAuthor(label: string): Extract<ChangeAuthor, { kind: "local" }> {
  return { kind: "local", label: parseLocalAuthorLabel(label) };
}
