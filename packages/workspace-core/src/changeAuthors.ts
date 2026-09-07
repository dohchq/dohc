import { isRecord } from "./records";
// Contracts owns the change-author types and the local-author label's brand.
import type {
  ChangeAuthor,
  NonEmptyLocalAuthorLabel,
} from "@dohc/workspace-contracts/engine";

function parseCanonicalNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  if (!value || value.trim() !== value) {
    throw new Error(`${label} must be canonical and non-empty.`);
  }
  return value;
}

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

export function parseChangeAuthor(value: unknown): ChangeAuthor {
  if (!isRecord(value)) {
    throw new Error("Change author is invalid.");
  }
  if (value.kind === "user") {
    return {
      kind: "user",
      userId: parseCanonicalNonEmptyString(value.userId, "Change author user id"),
    };
  }
  if (value.kind === "agent") {
    return {
      kind: "agent",
      agentId: parseCanonicalNonEmptyString(value.agentId, "Change author agent id"),
      onBehalfOf: parseCanonicalNonEmptyString(
        value.onBehalfOf,
        "Change author on-behalf-of id",
      ),
    };
  }
  if (value.kind === "local") {
    if (typeof value.label !== "string") {
      throw new Error("Local change author label must be a string.");
    }
    return createLocalChangeAuthor(value.label);
  }
  throw new Error("Change author kind is invalid.");
}
