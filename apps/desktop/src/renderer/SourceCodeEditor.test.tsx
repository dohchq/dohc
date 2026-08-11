// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceCodeEditor } from "./SourceCodeEditor";

function stubCodeMirrorLayout() {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => {},
    }),
  });
}

function EchoHarness(props: {
  externalValue: string;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(props.externalValue);
  const [valueRevision, setValueRevision] = useState(0);

  useEffect(() => {
    setValue(props.externalValue);
    setValueRevision((current) => current + 1);
  }, [props.externalValue]);

  return (
    <SourceCodeEditor
      testId="source-editor"
      value={value}
      valueRevision={valueRevision}
      language="text"
      path="notes/plain.txt"
      onChange={(next) => {
        props.onChange?.(next);
        setValue(next);
      }}
      onSave={() => undefined}
    />
  );
}

describe("SourceCodeEditor value synchronization", () => {
  beforeEach(() => {
    stubCodeMirrorLayout();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps every rapid local keystroke while the parent echoes each value", async () => {
    const user = userEvent.setup();
    const changes: string[] = [];
    render(
      <EchoHarness externalValue="" onChange={(value) => changes.push(value)} />,
    );
    const content = (await screen.findByTestId("source-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;
    const typed = "OneTwoThreeFourFiveSixSevenEightNineTen";

    await user.click(content);
    await user.keyboard(typed);

    expect(content.textContent).toBe(typed);
    expect(changes.at(-1)).toBe(typed);
  });

  it("ignores a delayed stale controlled echo without dropping newer local text", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const view = render(
      <SourceCodeEditor
        testId="source-editor"
        value=""
        valueRevision={0}
        language="text"
        path="notes/plain.txt"
        onChange={onChange}
        onSave={() => undefined}
      />,
    );
    const content = (await screen.findByTestId("source-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;

    await user.click(content);
    await user.keyboard("a");
    const staleEcho = onChange.mock.lastCall?.[0] as string;
    await user.keyboard("bc");
    expect(content.textContent).toBe("abc");

    view.rerender(
      <SourceCodeEditor
        testId="source-editor"
        value={staleEcho}
        valueRevision={0}
        language="text"
        path="notes/plain.txt"
        onChange={onChange}
        onSave={() => undefined}
      />,
    );

    await waitFor(() => expect(content.textContent).toBe("abc"));
    expect(onChange.mock.lastCall?.[0]).toBe("abc");
  });

  it("applies an external value after local echoes settle", async () => {
    const user = userEvent.setup();
    const view = render(<EchoHarness externalValue="start" />);
    const content = (await screen.findByTestId("source-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;

    await user.click(content);
    await user.keyboard("{Control>}a{/Control}local draft");
    await waitFor(() => expect(content.textContent).toBe("local draft"));

    view.rerender(<EchoHarness externalValue="external replacement" />);

    await waitFor(() => expect(content.textContent).toBe("external replacement"));
  });

  it("applies an external value while a local value is awaiting its echo", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const view = render(
      <SourceCodeEditor
        testId="source-editor"
        value=""
        valueRevision={0}
        language="text"
        path="notes/plain.txt"
        onChange={onChange}
        onSave={() => undefined}
      />,
    );
    const content = (await screen.findByTestId("source-editor")).querySelector(
      ".cm-content",
    ) as HTMLElement;

    await user.click(content);
    await user.keyboard("local draft");
    expect(onChange).toHaveBeenCalled();

    view.rerender(
      <SourceCodeEditor
        testId="source-editor"
        value="local"
        valueRevision={1}
        language="text"
        path="notes/plain.txt"
        onChange={onChange}
        onSave={() => undefined}
      />,
    );

    await waitFor(() => expect(content.textContent).toBe("local"));
  });
});
