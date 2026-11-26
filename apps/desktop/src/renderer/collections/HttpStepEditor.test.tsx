// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpStepEditor, type HttpStep } from "./HttpStepEditor";

afterEach(cleanup);

describe("HttpStepEditor", () => {
  it("edits destination URL, switches to secret URL, adds headers and body fields", async () => {
    const user = userEvent.setup();
    let current: HttpStep = {
      kind: "http",
      url: { kind: "literal", url: "" },
      method: "POST",
      headers: [],
      secretHeaders: [],
      body: null,
      as: null,
    };
    const onChange = vi.fn((next: HttpStep) => {
      current = next;
    });
    const secrets = [
      {
        name: "SLACK_HOOK",
        usage: "http-url" as const,
        allowedHosts: [],
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      {
        name: "RESEND_API_KEY",
        usage: "http-header" as const,
        allowedHosts: ["api.resend.com"],
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ];

    const { rerender } = render(
      <HttpStepEditor
        number={1}
        stepKey={1}
        step={current}
        secrets={secrets}
        secretsUnavailable={null}
        problem={() => null}
        onChange={onChange}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Step 1, destination type"), "secret");
    expect(current.url).toEqual({ kind: "secret", secret: "SLACK_HOOK" });

    rerender(
      <HttpStepEditor
        number={1}
        stepKey={1}
        step={current}
        secrets={secrets}
        secretsUnavailable={null}
        problem={() => null}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add secret header" }));
    expect(current.secretHeaders).toEqual([
      { name: "Authorization", secret: "RESEND_API_KEY", prefix: "Bearer " },
    ]);

    rerender(
      <HttpStepEditor
        number={1}
        stepKey={1}
        step={current}
        secrets={secrets}
        secretsUnavailable={null}
        problem={() => null}
        onChange={onChange}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Step 1, body type"), "json");
    expect(current.body).toEqual({
      kind: "json",
      fields: [{ key: "title", value: { kind: "formula", expression: "record.Title" } }],
    });
  });

  it("switches to GET, drops and hides the body, and names the saved answer", async () => {
    const user = userEvent.setup();
    let current: HttpStep = {
      kind: "http",
      url: { kind: "literal", url: "https://api.example.com/stats" },
      method: "POST",
      headers: [],
      secretHeaders: [],
      body: { kind: "text", template: "hi" },
      as: null,
    };
    const onChange = vi.fn((next: HttpStep) => {
      current = next;
    });
    const editor = () => (
      <HttpStepEditor
        number={1}
        stepKey={1}
        step={current}
        secrets={[]}
        secretsUnavailable={null}
        problem={() => null}
        onChange={onChange}
      />
    );
    const { rerender } = render(editor());

    await user.selectOptions(screen.getByLabelText("Step 1, method"), "GET");
    expect(current).toMatchObject({ method: "GET", body: null });
    rerender(editor());
    expect(screen.queryByLabelText("Step 1, body type")).toBeNull();

    await user.type(screen.getByLabelText("Step 1, save the answer as"), "s");
    expect(current.as).toBe("s");
    rerender(editor());
    expect(screen.getByText("s.count")).toBeTruthy();
  });
});
