// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl, type SegmentedOption } from "./SegmentedControl";

afterEach(cleanup);

type Size = "small" | "medium" | "large";
const SIZES: ReadonlyArray<SegmentedOption<Size>> = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

function Harness(props: {
  options?: ReadonlyArray<SegmentedOption<Size>>;
  initial?: Size;
  disabled?: boolean;
  onChange?: (value: Size) => void;
}) {
  const [value, setValue] = useState<Size>(props.initial ?? "small");
  return (
    <SegmentedControl
      label="Size"
      value={value}
      options={props.options ?? SIZES}
      disabled={props.disabled}
      onChange={(next) => {
        props.onChange?.(next);
        setValue(next);
      }}
    />
  );
}

const radio = (name: string) => screen.getByRole("radio", { name });
const checked = () => screen.getAllByRole("radio").filter((it) => it.getAttribute("aria-checked") === "true").map((it) => it.textContent);
const tabbable = () => screen.getAllByRole("radio").filter((it) => it.tabIndex === 0).map((it) => it.textContent);

describe("SegmentedControl", () => {
  it("is a radiogroup whose chosen radio alone is in the tab order", () => {
    render(<Harness initial="medium" />);
    expect(screen.getByRole("radiogroup", { name: "Size" })).toBeTruthy();
    expect(checked()).toEqual(["Medium"]);
    expect(tabbable()).toEqual(["Medium"]);
  });

  it("chooses on click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(radio("Large"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("large");
    expect(checked()).toEqual(["Large"]);
    expect(tabbable()).toEqual(["Large"]);
  });

  it("moves the choice and the focus with the arrow keys, wrapping at the ends", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    radio("Small").focus();
    await user.keyboard("{ArrowRight}");
    expect(checked()).toEqual(["Medium"]);
    expect(document.activeElement).toBe(radio("Medium"));
    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(checked()).toEqual(["Small"]);
    expect(document.activeElement).toBe(radio("Small"));
    await user.keyboard("{ArrowLeft}");
    expect(checked()).toEqual(["Large"]);
    await user.keyboard("{ArrowUp}");
    expect(checked()).toEqual(["Medium"]);
    expect(document.activeElement).toBe(radio("Medium"));
  });

  it("goes to the first and last options with Home and End", async () => {
    const user = userEvent.setup();
    render(<Harness initial="medium" />);
    radio("Medium").focus();
    await user.keyboard("{End}");
    expect(checked()).toEqual(["Large"]);
    expect(document.activeElement).toBe(radio("Large"));
    await user.keyboard("{Home}");
    expect(checked()).toEqual(["Small"]);
    expect(document.activeElement).toBe(radio("Small"));
  });

  it("skips a disabled option from the keyboard and ignores its click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const options = SIZES.map((option) => (option.value === "medium" ? { ...option, disabled: true } : option));
    render(<Harness options={options} onChange={onChange} />);
    expect(radio("Medium").hasAttribute("disabled")).toBe(true);

    await user.click(radio("Medium"));
    expect(onChange).not.toHaveBeenCalled();

    radio("Small").focus();
    await user.keyboard("{ArrowRight}");
    expect(checked()).toEqual(["Large"]);
    await user.keyboard("{ArrowLeft}");
    expect(checked()).toEqual(["Small"]);
    expect(document.activeElement).toBe(radio("Small"));
  });

  it("puts the first enabled option in the tab order when the chosen one is disabled", async () => {
    const user = userEvent.setup();
    const options = SIZES.map((option) => (option.value === "small" ? { ...option, disabled: true } : option));
    render(<Harness options={options} initial="small" />);
    expect(checked()).toEqual(["Small"]);
    expect(tabbable()).toEqual(["Medium"]);

    radio("Medium").focus();
    await user.keyboard("{Home}");
    expect(checked()).toEqual(["Medium"]);
    await user.keyboard("{End}{ArrowRight}");
    expect(checked()).toEqual(["Medium"]);
  });

  it("moves from the focused radio when the chosen one is disabled", async () => {
    const user = userEvent.setup();
    const options = SIZES.map((option) => (option.value === "small" ? { ...option, disabled: true } : option));
    render(<Harness options={options} initial="small" />);

    radio("Medium").focus();
    await user.keyboard("{ArrowRight}");
    expect(checked()).toEqual(["Large"]);
    expect(document.activeElement).toBe(radio("Large"));

    cleanup();
    render(<Harness options={options} initial="small" />);
    radio("Medium").focus();
    await user.keyboard("{ArrowLeft}");
    expect(checked()).toEqual(["Large"]);
  });

  it("moves from the focused radio when no option matches the value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SegmentedControl<string> label="Size" value="huge" options={SIZES} onChange={onChange} />);
    expect(checked()).toEqual([]);
    expect(tabbable()).toEqual(["Small"]);

    radio("Small").focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("medium");
    expect(document.activeElement).toBe(radio("Medium"));
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("small");
    radio("Small").focus();
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("large");
  });

  it("takes no input while the group is disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness disabled onChange={onChange} />);
    for (const it of screen.getAllByRole("radio")) expect(it.hasAttribute("disabled")).toBe(true);
    await user.click(radio("Large"));
    await user.keyboard("{ArrowRight}{End}");
    expect(onChange).not.toHaveBeenCalled();
    expect(checked()).toEqual(["Small"]);
  });
});
