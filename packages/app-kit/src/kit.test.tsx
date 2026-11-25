// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, createRef, useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Button, DateField, Field, Input, Modal, Textarea } from "./ui";
import { LineChart } from "./charts";

afterEach(cleanup);

describe("dohc/ui", () => {
  it("passes a ref to the Input and Textarea elements", () => {
    const input = createRef<HTMLInputElement>();
    const textarea = createRef<HTMLTextAreaElement>();
    render(
      <>
        <Input ref={input} aria-label="Title" />
        <Textarea ref={textarea} aria-label="Notes" />
      </>,
    );
    expect(input.current).toBe(screen.getByLabelText("Title"));
    expect(textarea.current).toBe(screen.getByLabelText("Notes"));
    textarea.current?.focus();
    expect(document.activeElement).toBe(screen.getByLabelText("Notes"));
  });

  it.each([
    ["toggles open", false, false],
    ["mounts already open", true, false],
    ["toggles open in StrictMode", false, true],
    ["mounts already open in StrictMode", true, true],
  ])(
    "keeps focus on an autoFocus field in a Modal that %s and returns it to the trigger on close",
    (_, mountOpen, strict) => {
      function Harness() {
        const [open, setOpen] = useState(false);
        const modal = (
          <Modal open={mountOpen || open} title="New note" onClose={() => setOpen(false)}>
            <Input aria-label="Note" autoFocus />
          </Modal>
        );
        return (
          <>
            <Button onClick={() => setOpen(true)}>Add note</Button>
            {mountOpen ? open && modal : modal}
          </>
        );
      }
      render(
        strict ? (
          <StrictMode>
            <Harness />
          </StrictMode>
        ) : (
          <Harness />
        ),
      );
      const trigger = screen.getByRole("button", { name: "Add note" });
      trigger.focus();
      fireEvent.click(trigger);
      expect(document.activeElement).toBe(screen.getByLabelText("Note"));
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    },
  );

  it("lets a parent effect focus a field by ref as its Modal opens", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      const field = useRef<HTMLInputElement>(null);
      useEffect(() => {
        if (open) field.current?.focus();
      }, [open]);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Rename</Button>
          <Modal open={open} title="Rename" onClose={() => setOpen(false)}>
            <Input ref={field} aria-label="Name" />
          </Modal>
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  });
});

describe("DateField", () => {
  function Harness({ min, max, initial = "" }: { min?: string; max?: string; initial?: string }) {
    const [value, setValue] = useState(initial);
    return (
      <form data-testid="form">
        <Field label="Paid on" htmlFor="paid" hint="The bank date">
          <DateField id="paid" value={value} onChange={setValue} min={min} max={max} />
        </Field>
        <output>{value || "none"}</output>
        <Button onClick={() => setValue("2026-03-01")}>Reset</Button>
      </form>
    );
  }
  const field = () => screen.getByLabelText<HTMLInputElement>("Paid on");
  const stored = () => screen.getByRole("status").textContent;

  it("stores only real ISO dates inside its bounds, and blocks the form otherwise", () => {
    render(<Harness min="2026-01-10" max="2026-12-31" />);
    expect(field().getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.change(field(), { target: { value: "2026-02-14" } });
    expect(stored()).toBe("2026-02-14");
    expect(field().validity.valid).toBe(true);

    fireEvent.change(field(), { target: { value: "2026-02-30" } });
    expect(stored()).toBe("none");
    expect(field().value).toBe("2026-02-30");
    expect(field().validationMessage).toBe("Enter a date as YYYY-MM-DD");
    expect(field().getAttribute("aria-invalid")).toBeNull();
    fireEvent.blur(field());
    expect(field().getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(field(), { target: { value: "2026-01-02" } });
    expect(stored()).toBe("none");
    expect(field().validationMessage).toBe("Enter a date from 2026-01-10 to 2026-12-31");
    expect((screen.getByTestId("form") as HTMLFormElement).checkValidity()).toBe(false);
  });

  it("steps a day with ArrowUp and ArrowDown inside its bounds, and follows the stored value", () => {
    render(<Harness initial="2026-12-30" max="2026-12-31" />);
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(stored()).toBe("2026-12-31");
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(stored()).toBe("2026-12-31");
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(field().value).toBe("2026-12-29");
    fireEvent.change(field(), { target: { value: "2026-03-" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(field().value).toBe("2026-03-01");
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(stored()).toBe("2026-02-28");
  });
});

describe("dohc/charts", () => {
  it("marks the markerIndex on a LineChart apart from the hover state", () => {
    const { container } = render(
      <LineChart
        labels={["T1", "T2", "T3"]}
        series={[{ name: "Force", values: [3, 5, 4] }]}
        markerIndex={1}
        ariaLabel="Force by turn"
      />,
    );
    const chart = screen.getByRole("group", { name: "Force by turn, marked T2" });
    const marker = container.querySelector(".kit-chart-marker");
    expect(marker?.getAttribute("x1")).toBe(marker?.getAttribute("x2"));
    const points = [...container.querySelectorAll("circle")];
    expect(points.map((point) => point.getAttribute("r"))).toEqual(["2.5", "4.5", "2.5"]);
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "End" });
    expect(container.querySelector(".kit-chart-marker")).toBeTruthy();
    expect(points.map((point) => point.getAttribute("r"))).toEqual(["2.5", "4.5", "4.5"]);
  });
});
