import { useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, isAppBackendError, mutationKey, useApp, useDatasetQuery } from "dohc/app";
import {
  AppShell,
  Badge,
  Button,
  Callout,
  DataTable,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Stack,
  Tabs,
  Textarea,
} from "dohc/ui";

const VIEWS = [
  { id: "new", label: "Needs triage" },
  { id: "planned", label: "Planned" },
  { id: "in_progress", label: "In progress" },
  { id: "done", label: "Done" },
] as const;
const AREAS = { platform: "Platform", apps: "Apps", sync: "Sync", mobile: "Mobile" };
const PAGE = 25;

type View = (typeof VIEWS)[number]["id"];
type Area = keyof typeof AREAS;

interface Item {
  id: string;
  title: string;
  detail: string;
  area: Area;
  status: View | "triaged";
  priority: number | null;
  milestoneName: string | null;
  estimateDays: number | null;
  version: number;
}

type Cursor = [number, number, string];

interface Page {
  items: Item[];
  total: number;
  next: Cursor | null;
}

interface Failure {
  message: string;
  retry?: () => void;
}

const MOVES: Partial<Record<View, { label: string; to: View }[]>> = {
  planned: [{ label: "Start", to: "in_progress" }],
  in_progress: [
    { label: "Done", to: "done" },
    { label: "Back to planned", to: "planned" },
  ],
  done: [{ label: "Reopen", to: "in_progress" }],
};

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong. Try again.";

function Triage() {
  const client = useApp();
  const [view, setView] = useState<View>("new");
  const [area, setArea] = useState("");
  const [cursors, setCursors] = useState<Cursor[]>([]);
  const list = useDatasetQuery<Page>("listItems", {
    status: view,
    limit: PAGE,
    ...(area ? { area } : {}),
    ...(cursors.length ? { after: cursors.at(-1) } : {}),
  });
  const [triaging, setTriaging] = useState<Item | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(operation: string, input: unknown, done?: () => void, key = mutationKey(operation)) {
    setBusy(true);
    try {
      await client.invoke(operation, input, key);
      setFailure(null);
      done?.();
    } catch (error) {
      const refusal = isAppBackendError(error) ? error.refusal : undefined;
      if (refusal?.code === "conflict" || refusal?.code === "not_found") {
        setTriaging(null);
        list.reload();
      }
      setFailure({
        message: errorText(error),
        retry: refusal ? undefined : () => void run(operation, input, done, key),
      });
    } finally {
      setBusy(false);
    }
  }

  function triage(item: Item | null) {
    setFailure(null);
    setTriaging(item);
  }

  const columns = [
    {
      key: "title",
      header: "Item",
      render: (item: Item) => (
        <Stack gap={2}>
          <strong>{item.title}</strong>
          {item.detail ? <span>{item.detail}</span> : null}
        </Stack>
      ),
    },
    { key: "area", header: "Area", render: (item: Item) => <Badge>{AREAS[item.area]}</Badge> },
    ...(view === "new"
      ? []
      : [
          {
            key: "priority",
            header: "Priority",
            render: (item: Item) => (
              <Badge tone={item.priority === 0 ? "danger" : "neutral"}>P{item.priority}</Badge>
            ),
          },
          { key: "milestone", header: "Milestone", render: (item: Item) => item.milestoneName },
          {
            key: "estimate",
            header: "Days",
            align: "right" as const,
            render: (item: Item) => item.estimateDays,
          },
        ]),
    {
      key: "actions",
      header: "Actions",
      render: (item: Item) => (
        <Stack direction="horizontal" gap={6} wrap>
          {view === "new" ? (
            <Button size="sm" variant="primary" onClick={() => triage(item)}>
              Triage
            </Button>
          ) : (
            (MOVES[view] ?? []).map((move) => (
              <Button
                key={move.to}
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run("updateStatus", { id: item.id, version: item.version, status: move.to })
                }
              >
                {move.label}
              </Button>
            ))
          )}
        </Stack>
      ),
    },
  ];

  const page = list.data;
  const alert = failure ? (
    <Callout
      tone="danger"
      title="That change didn't go through"
      action={
        failure.retry ? (
          <Button size="sm" disabled={busy} onClick={failure.retry}>
            Try again
          </Button>
        ) : null
      }
    >
      {failure.message}
    </Callout>
  ) : null;
  return (
    <AppShell width="wide">
      <PageHeader
        eyebrow="Engineering"
        title="Triage and track work"
        subtitle="Estimate new requests so product can plan them, then move planned work along."
      />
      <Stack gap={16}>
        {triaging ? null : alert}
        {list.error ? (
          <Callout
            tone="danger"
            title="Could not load items"
            action={
              <Button size="sm" onClick={list.reload}>
                Try again
              </Button>
            }
          >
            {list.error.message}
          </Callout>
        ) : null}
        <Stack direction="horizontal" gap={12} wrap align="end" justify="space-between">
          <Tabs
            label="Work"
            value={view}
            onChange={(next) => {
              setView(next as View);
              setCursors([]);
            }}
            items={VIEWS}
          />
          <Field label="Area" htmlFor="area-filter">
            <Select
              id="area-filter"
              value={area}
              onChange={(event) => {
                setArea(event.target.value);
                setCursors([]);
              }}
            >
              <option value="">All areas</option>
              {Object.entries(AREAS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        </Stack>
        <DataTable
          rows={page?.items ?? []}
          columns={columns}
          rowKey={(item) => item.id}
          loading={list.loading && !page}
          emptyTitle={view === "new" ? "Nothing to triage" : "Nothing here"}
          emptyDescription={
            view === "new"
              ? "New requests from product show up here."
              : "Items move here as work progresses."
          }
        />
        {cursors.length || page?.next ? (
          <Stack direction="horizontal" gap={8} justify="end">
            <Button size="sm" disabled={!cursors.length} onClick={() => setCursors(cursors.slice(0, -1))}>
              Previous
            </Button>
            <Button
              size="sm"
              disabled={!page?.next}
              onClick={() => page?.next && setCursors([...cursors, page.next])}
            >
              Next
            </Button>
          </Stack>
        ) : null}
      </Stack>
      {triaging ? (
        <TriageDialog
          item={triaging}
          alert={alert}
          busy={busy}
          onClose={() => triage(null)}
          onSubmit={(input) => void run("triageItem", input, () => setTriaging(null))}
        />
      ) : null}
    </AppShell>
  );
}

function TriageDialog(props: {
  item: Item;
  alert: ReactNode;
  busy: boolean;
  onClose(): void;
  onSubmit(input: { id: string; version: number; estimateDays: number; note: string }): void;
}) {
  const { item } = props;
  const [estimate, setEstimate] = useState("");
  const [note, setNote] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSubmit({ id: item.id, version: item.version, estimateDays: Number(estimate), note });
  };
  return (
    <Modal
      open
      title={`Triage “${item.title}”`}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="triage-item" loading={props.busy}>
            Mark triaged
          </Button>
        </>
      }
    >
      <form id="triage-item" onSubmit={submit}>
        <Stack gap={12}>
          {props.alert}
          <Field label="Estimate in days" htmlFor="triage-estimate" hint="1 to 60 working days.">
            <Input
              id="triage-estimate"
              type="number"
              inputMode="numeric"
              required
              min={1}
              max={60}
              step={1}
              value={estimate}
              onChange={(event) => setEstimate(event.target.value)}
            />
          </Field>
          <Field label="Note for product" htmlFor="triage-note" hint="Optional">
            <Textarea
              id="triage-note"
              rows={3}
              maxLength={500}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
        </Stack>
      </form>
    </Modal>
  );
}

const mount = document.getElementById("root");
if (mount) {
  createRoot(mount).render(
    <AppProvider>
      <Triage />
    </AppProvider>,
  );
}
