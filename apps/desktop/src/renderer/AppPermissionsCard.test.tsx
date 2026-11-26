// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAppExternalDeclaration } from "@dohc/security-contract/app-external";
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

  it("keeps reads apart when a field name contains a comma", () => {
    const read = (n: number, fields: string[]) => ({
      operationId: id(n),
      name: `list${n}`,
      access: "owner" as const,
      readOnly: true,
      display: { kind: "read" as const, label: "List", fields },
    });
    const capability: AppDatasetCapability = {
      kind: "dataset",
      datasetId: id(1),
      name: "Guests",
      revision: 1,
      revisionSha256: "a".repeat(64),
      operationIds: [id(20), id(21)],
      operations: [read(20, ["Record ID", "Last,First"]), read(21, ["Record ID", "Last", "First"])],
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
    expect(text).toContain("Reads recordsRecord ID, Last,First");
    expect(text).toContain("Reads recordsRecord ID, Last, First");
  });
});

describe("AppAccessSummary outside calls", () => {
  afterEach(() => {
    cleanup();
  });
  const [events, usage] = parseAppExternalDeclaration({
    events: {
      method: "POST",
      url: "https://us.posthog.com/api/projects/{{project}}/query/",
      body: { kind: "EventsQuery" },
      params: { project: { type: "integer", min: 1, max: 999 } },
      secret: { name: "POSTHOG_KEY", header: "Authorization", prefix: "Bearer " },
    },
    usage: {
      method: "GET",
      url: "https://api.example.com/usage",
      query: { period: "month" },
      headers: { "X-Version": "2" },
      secret: { name: "EXAMPLE_KEY", header: "X-Api-Key" },
      access: "viewers",
    },
  });

  it("names each website, request, secret, answer, who runs it, and where", () => {
    render(
      <AppAccessSummary
        capabilities={[]}
        approved={null}
        external={[events!, usage!]}
        failed={false}
        onRetry={vi.fn()}
      />,
    );
    const [post, get] = screen.getAllByTestId("app-access-external");
    expect(post!.textContent).toContain("us.posthog.com");
    expect(post!.textContent).toContain("POST /api/projects/{project}/query/");
    expect(post!.textContent).toContain("POSTHOG_KEY");
    expect(post!.textContent).toContain("up to 256 KB");
    expect(post!.textContent).toContain("Only you");
    expect(post!.textContent).toContain("This computer");
    expect(post!.textContent).toContain("It can change your data on us.posthog.com.");
    expect(post!.textContent).toContain('"kind": "EventsQuery"');
    expect(get!.textContent).toContain("GET /usage?period=month");
    expect(get!.textContent).toContain("X-Version: 2");
    expect(get!.textContent).toContain("Anyone who can open the app");
    expect(get!.textContent).not.toContain("change your data");
    expect(screen.getByText(/including what these services return/)).toBeTruthy();
  });

  it("marks a call the approval does not have, or has in another form", () => {
    render(
      <AppAccessSummary
        capabilities={[]}
        approved={[]}
        external={[events!, usage!]}
        approvedExternal={[{ ...events!, path: "/api/projects/{{project}}/other/" }]}
        failed={false}
        onRetry={vi.fn()}
      />,
    );
    const [post, get] = screen.getAllByTestId("app-access-external");
    expect(post!.textContent).toContain("Changed");
    expect(get!.textContent).toContain("New");
  });
});
