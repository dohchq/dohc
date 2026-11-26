// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDatasetCapability } from "@dohc/security-contract/dataset";
import { AppAccessSummary } from "./AppPermissionsCard";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("AppAccessSummary multi-table wording", () => {
  afterEach(() => {
    cleanup();
  });

  it("prefixes operations with table names and keeps Deletes records distinct per table", () => {
    const capability: AppDatasetCapability = {
      kind: "dataset",
      datasetId: id(1),
      name: "Bill Splitter",
      revision: 1,
      revisionSha256: "a".repeat(64),
      operationIds: [id(10), id(11), id(12), id(13)],
      operations: [
        {
          operationId: id(10),
          name: "createMember",
          access: "owner",
          readOnly: false,
          display: { kind: "create", label: "Add member", fields: ["Name"], table: "Members" },
        },
        {
          operationId: id(11),
          name: "deleteMember",
          access: "owner",
          readOnly: false,
          display: { kind: "delete", label: "Delete member", fields: [], table: "Members" },
        },
        {
          operationId: id(12),
          name: "createExpense",
          access: "owner",
          readOnly: false,
          display: {
            kind: "create",
            label: "Add expense",
            fields: ["Title", "Amount"],
            table: "Expenses",
          },
        },
        {
          operationId: id(13),
          name: "deleteExpense",
          access: "owner",
          readOnly: false,
          display: { kind: "delete", label: "Delete expense", fields: [], table: "Expenses" },
        },
      ],
    };

    render(
      <AppAccessSummary
        capabilities={[capability]}
        approved={null}
        failed={false}
        onRetry={vi.fn()}
      />,
    );

    const text = screen.getByTestId("app-access").textContent ?? "";
    expect(text).toContain("Members: Adds recordsName");
    expect(text).toContain("Members: Deletes records");
    expect(text).toContain("Expenses: Adds recordsTitle, Amount");
    expect(text).toContain("Expenses: Deletes records");
  });

  it("preserves the table prefix when highlighting newly added fields against an approved capability", () => {
    const prior: AppDatasetCapability = {
      kind: "dataset",
      datasetId: id(1),
      name: "Bill Splitter",
      revision: 1,
      revisionSha256: "a".repeat(64),
      operationIds: [id(12)],
      operations: [
        {
          operationId: id(12),
          name: "createExpense",
          access: "owner",
          readOnly: false,
          display: { kind: "create", label: "Add expense", fields: ["Title"], table: "Expenses" },
        },
      ],
    };
    const next: AppDatasetCapability = {
      ...prior,
      revision: 2,
      revisionSha256: "b".repeat(64),
      operations: [
        {
          ...prior.operations[0]!,
          display: {
            kind: "create",
            label: "Add expense",
            fields: ["Title", "Currency"],
            table: "Expenses",
          },
        },
      ],
    };

    render(
      <AppAccessSummary
        capabilities={[next]}
        approved={[prior]}
        failed={false}
        onRetry={vi.fn()}
      />,
    );

    const text = screen.getByTestId("app-access").textContent ?? "";
    expect(text).toContain("Expenses: Adds recordsTitle, CurrencyNew");
  });
});
