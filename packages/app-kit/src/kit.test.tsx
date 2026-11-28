// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, createRef, useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  DataTable,
  DateField,
  Field,
  Input,
  Modal,
  ProgressBar,
  Select,
  Tabs,
  Textarea,
} from "./ui";
import { BarChart, LineChart, Sparkline } from "./charts";

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

  it("keeps autoFocus in a Modal opened while another Modal is open", () => {
    function Harness() {
      const [confirming, setConfirming] = useState(false);
      return (
        <>
          <Modal open title="Edit trip" onClose={() => {}}>
            <Input aria-label="Trip name" />
            <Button onClick={() => setConfirming(true)}>Delete trip</Button>
          </Modal>
          <Modal open={confirming} title="Delete trip" onClose={() => setConfirming(false)}>
            <Input aria-label="Type the trip name" autoFocus />
          </Modal>
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Delete trip" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByLabelText("Type the trip name"));
    screen.getByLabelText("Trip name").focus();
    expect(
      screen.getByRole("dialog", { name: "Delete trip" }).contains(document.activeElement),
    ).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
  });

  it("forwards refs on Button and Select, renders Button loading spinner, and supports iconOnly", () => {
    const btn = createRef<HTMLButtonElement>();
    const sel = createRef<HTMLSelectElement>();
    const { container } = render(
      <>
        <Button ref={btn} variant="primary" loading>
          Saving
        </Button>
        <Button iconOnly aria-label="Settings">
          S
        </Button>
        <Select ref={sel} aria-label="Currency" defaultValue="USD">
          <option value="USD">USD</option>
        </Select>
      </>,
    );
    expect(btn.current).toBe(screen.getByRole("button", { name: "Saving" }));
    expect(btn.current?.disabled).toBe(true);
    expect(btn.current?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector(".kit-spinner")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settings" }).className).toContain("kit-btn-icon");
    expect(sel.current).toBe(screen.getByLabelText("Currency"));
  });

  it("wires Field error aria-invalid and required without changing accessible label names", () => {
    render(
      <>
        <Field label="Merchant" htmlFor="f-m" error="Required" required>
          <Input id="f-m" />
        </Field>
        <Field label="Group" error="Pick one">
          <div>
            <Checkbox label="Alpha" />
          </div>
        </Field>
      </>,
    );
    const input = screen.getByLabelText("Merchant");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-required")).toBe("true");
    expect(screen.getAllByRole("alert").map((node) => node.textContent)).toEqual([
      "Required",
      "Pick one",
    ]);
    const wrapper = screen.getByLabelText("Alpha").closest("div");
    expect(wrapper?.getAttribute("aria-invalid")).toBeNull();
  });

  it("renders Badge dot/info, Callout info, ProgressBar info, and Checkbox description without altering accessible name", () => {
    const checkboxRef = createRef<HTMLInputElement>();
    const { container } = render(
      <Card title="Settings">
        <Checkbox
          ref={checkboxRef}
          label="Include pending"
          description="Show unposted charges"
          defaultChecked
        />
        <Badge tone="info" dot>
          Synced
        </Badge>
        <Callout tone="info" title="Heads up">
          Offline cache ready.
        </Callout>
        <ProgressBar value={50} max={100} tone="info" label="Sync" />
        <Tabs
          value="a"
          onChange={() => {}}
          items={[{ id: "a", label: "Inbox", content: <p>Items</p> }]}
        />
      </Card>,
    );
    const box = screen.getByRole("checkbox", { name: "Include pending" }) as HTMLInputElement;
    expect(checkboxRef.current).toBe(box);
    expect(box.checked).toBe(true);
    const descId = box.getAttribute("aria-describedby");
    expect(descId).toBeTruthy();
    expect(document.getElementById(descId!)?.textContent).toBe("Show unposted charges");
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    expect(container.querySelector(".kit-badge-dot")).toBeTruthy();
    expect(container.querySelector(".kit-callout.kit-tone-info")).toBeTruthy();
    expect(container.querySelector(".kit-progress-fill-info")).toBeTruthy();
  });

  it("filters DataTable rows with native search input and renders loading skeletons", () => {
    const { rerender, container } = render(
      <DataTable
        searchable
        loading
        rows={[]}
        rowKey={(_, i) => String(i)}
        columns={[
          { key: "name", header: "Name", sortValue: (r: { name: string }) => r.name },
          { key: "amount", header: "Amount", align: "right" },
        ]}
      />,
    );
    expect(container.querySelectorAll(".kit-skeleton").length).toBe(3);

    rerender(
      <DataTable
        searchable
        rows={[
          { id: "1", name: "Coffee", amount: 5 },
          { id: "2", name: "Tea", amount: 4 },
        ]}
        rowKey={(r) => r.id}
        columns={[
          { key: "name", header: "Name", sortValue: (r) => r.name },
          { key: "amount", header: "Amount", align: "right", sortValue: (r) => r.amount },
        ]}
      />,
    );
    const search = screen.getByRole("searchbox", { name: "Filter rows" });
    fireEvent.change(search, { target: { value: "Coffee" } });
    expect(screen.queryByText("Tea")).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByText("Tea")).toBeTruthy();
  });

  it("respects defaultPrevented Escape in Modal and links description via aria-describedby", () => {
    let closed = false;
    render(
      <Modal
        open
        title="Delete record"
        description="This action moves the record to History."
        size="sm"
        onClose={() => {
          closed = true;
        }}
      >
        <p>Body</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Delete record" });
    expect(dialog.className).toContain("kit-modal-sm");
    const descId = dialog.getAttribute("aria-describedby");
    expect(descId).toBeTruthy();
    expect(document.getElementById(descId!)?.textContent).toBe(
      "This action moves the record to History.",
    );
    const prevented = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    prevented.preventDefault();
    window.dispatchEvent(prevented);
    expect(closed).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(true);
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
        <Button onClick={() => setValue("")}>Clear</Button>
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

  it("shows the date the app loads and clears", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(field().value).toBe("2026-03-01");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(field().value).toBe("");
  });

  it("leaves the date alone on Shift+ArrowUp and in a read-only field", () => {
    const changes: string[] = [];
    const date = (readOnly: boolean) => (
      <DateField
        aria-label="Closed on"
        value="2026-04-20"
        onChange={(next) => changes.push(next)}
        readOnly={readOnly}
      />
    );
    const { rerender } = render(date(false));
    fireEvent.keyDown(screen.getByLabelText("Closed on"), { key: "ArrowUp", shiftKey: true });
    rerender(date(true));
    fireEvent.keyDown(screen.getByLabelText("Closed on"), { key: "ArrowUp" });
    expect(changes).toEqual([]);
    expect(screen.getByLabelText<HTMLInputElement>("Closed on").value).toBe("2026-04-20");
  });

  it("keeps typed text while the app shows a fallback date", () => {
    function Fallback() {
      const [picked, setPicked] = useState("");
      return <DateField aria-label="Void on" value={picked || "2026-11-25"} onChange={setPicked} />;
    }
    render(<Fallback />);
    const input = screen.getByLabelText<HTMLInputElement>("Void on");
    fireEvent.change(input, { target: { value: "2026-11-2" } });
    expect(input.value).toBe("2026-11-2");
    fireEvent.change(input, { target: { value: "2026-11-20" } });
    expect(input.value).toBe("2026-11-20");
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

  it("renders smooth LineChart curves across gaps, flat series, and extreme values without NaN", () => {
    const { container } = render(
      <>
        <LineChart
          variant="area"
          curve="smooth"
          labels={["A", "B", "C", "D", "E", "F"]}
          series={[
            { name: "Spend", values: [10, 40, Number.NaN, 25, 25, 25] },
            { name: "Extreme", values: [-Number.MAX_VALUE, 0, Number.NaN, Number.MAX_VALUE, 0, 0] },
          ]}
          ariaLabel="Smooth gaps"
        />
        <BarChart
          data={[
            { label: "Q1", value: 120 },
            { label: "Q2", value: 180 },
          ]}
          ariaLabel="Sparse bars"
        />
        <LineChart
          variant="area"
          labels={["N1", "N2", "N3"]}
          series={[{ name: "Loss", values: [-5, -12, -9] }]}
          ariaLabel="Negative area"
        />
        <Sparkline values={[5, 5, 5]} ariaLabel="Flat spark" />
      </>,
    );
    expect(container.innerHTML).not.toContain("NaN");
    expect(container.innerHTML).not.toContain("Infinity");
    const smoothGroup = screen.getByRole("group", { name: "Smooth gaps" });
    expect(smoothGroup.querySelectorAll('path[fill="none"]').length).toBe(4);
    expect(smoothGroup.innerHTML).toContain(" C ");
    const gradients = [...container.getElementsByTagName("linearGradient")];
    expect(gradients.map((el) => el.getAttribute("gradientUnits"))).toEqual([
      "userSpaceOnUse",
      "userSpaceOnUse",
      "userSpaceOnUse",
      "userSpaceOnUse",
    ]);
    const negGrad = screen
      .getByRole("group", { name: "Negative area" })
      .getElementsByTagName("linearGradient")[0]!;
    expect(Number(negGrad.getAttribute("y2"))).toBeGreaterThan(Number(negGrad.getAttribute("y1")));
    const negStops = [...negGrad.getElementsByTagName("stop")].map((s) =>
      Number(s.getAttribute("stop-opacity")),
    );
    expect(negStops.some((opacity) => opacity > 0)).toBe(true);
    const barRects = [
      ...screen.getByRole("group", { name: "Sparse bars" }).querySelectorAll("rect"),
    ];
    expect(barRects).toHaveLength(2);
    for (const rect of barRects) {
      expect(Number(rect.getAttribute("width"))).toBeLessThanOrEqual(42);
    }
  });
});
