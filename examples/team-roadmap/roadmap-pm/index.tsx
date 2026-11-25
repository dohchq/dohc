import { useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, isAppBackendError, mutationKey, useApp, useDatasetQuery } from "dohc/app";
import {
  AppShell,
  Badge,
  Button,
  Callout,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Stack,
  Tabs,
  Textarea,
  type Tone,
} from "dohc/ui";

const STATUSES = ["new", "triaged", "planned", "in_progress", "done"] as const;
const STATUS_LABELS: Record<Status, string> = {
  new: "New",
  triaged: "Triaged",
  planned: "Planned",
  in_progress: "In progress",
  done: "Done",
};
const AREAS = { platform: "Platform", apps: "Apps", sync: "Sync", mobile: "Mobile" };
const PAGE = 25;

type Status = (typeof STATUSES)[number];
type Area = keyof typeof AREAS;

interface Item {
  id: string;
  title: string;
  detail: string;
  area: Area;
  status: Status;
  priority: number | null;
  milestoneId: string | null;
  milestoneName: string | null;
  estimateDays: number | null;
  triageNote: string | null;
  version: number;
}

type Cursor = [number, number, string];

interface Page {
  items: Item[];
  total: number;
  next: Cursor | null;
}

interface Rollup {
  total: number;
  statuses: Record<Status, number>;
  milestones: { id: string; name: string; dueOn: string }[];
}

interface Notice {
  tone: Tone;
  title: string;
  message?: string;
  action?: { label: string; run(): void };
}

type Dialog = { kind: "item" } | { kind: "milestone" } | { kind: "plan"; item: Item } | null;

const SAMPLE = {
  milestones: [
    { name: "Alpha", dueOn: "2027-01-15" },
    { name: "Beta", dueOn: "2027-03-01" },
    { name: "Launch", dueOn: "2027-05-03" },
  ],
  items: [
    { title: "Offline edits sync on reconnect", area: "sync", status: "done", estimateDays: 8, priority: 0, milestone: "Alpha" },
    { title: "Share a Collection with a teammate", area: "apps", status: "done", estimateDays: 5, priority: 0, milestone: "Alpha" },
    { title: "Faster workspace open", area: "platform", status: "in_progress", estimateDays: 6, priority: 1, milestone: "Alpha" },
    { title: "Phone app shows live changes", area: "mobile", status: "in_progress", estimateDays: 10, priority: 0, milestone: "Beta" },
    { title: "Undo for bulk imports", area: "apps", status: "planned", estimateDays: 4, priority: 1, milestone: "Beta" },
    { title: "Conflict view for documents", area: "sync", status: "planned", estimateDays: 9, priority: 2, milestone: "Beta" },
    { title: "Self-hosting guide", area: "platform", status: "planned", estimateDays: 3, priority: 2, milestone: "Launch" },
    { title: "Tablet layout", area: "mobile", status: "triaged", estimateDays: 12 },
    { title: "Keyboard shortcuts sheet", area: "apps", status: "triaged", estimateDays: 2 },
    { title: "Export a workspace to a folder", area: "platform", status: "new" },
    { title: "Retry failed uploads", area: "sync", status: "new" },
    { title: "Dark mode charts", area: "apps", status: "new" },
  ],
};

const priorityLabel = (priority: number | null) => (priority === null ? "—" : `P${priority}`);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong. Try again.";

function Roadmap() {
  const client = useApp();
  const rollup = useDatasetQuery<Rollup>("rollup");
  const [status, setStatus] = useState<Status>("triaged");
  const [milestone, setMilestone] = useState("");
  const [cursors, setCursors] = useState<Cursor[]>([]);
  const list = useDatasetQuery<Page>("listItems", {
    status,
    limit: PAGE,
    ...(milestone ? { milestoneId: milestone } : {}),
    ...(cursors.length ? { after: cursors.at(-1) } : {}),
  });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const milestones = rollup.data?.milestones ?? [];

  async function run<T>(
    operation: string,
    input: unknown,
    done?: (result: T) => void,
    key = mutationKey(operation),
  ) {
    setBusy(true);
    try {
      const reply = await client.invoke<T>(operation, input, key);
      setNotice(null);
      done?.(reply.result);
    } catch (error) {
      const refusal = isAppBackendError(error) ? error.refusal : undefined;
      if (refusal?.code === "conflict" || refusal?.code === "not_found") {
        setDialog(null);
        rollup.reload();
        list.reload();
      }
      setNotice({
        tone: "danger",
        title: "That change didn't go through",
        message: errorText(error),
        action: refusal
          ? undefined
          : { label: "Try again", run: () => void run(operation, input, done, key) },
      });
    } finally {
      setBusy(false);
    }
  }

  function show(next: Dialog) {
    setNotice(null);
    setDialog(next);
  }

  function archive(item: Item) {
    void run<{ undo: { id: string; version: number } }>(
      "archiveItem",
      { id: item.id, version: item.version },
      ({ undo }) =>
        setNotice({
          tone: "success",
          title: `Archived “${item.title}”`,
          action: {
            label: "Undo",
            run: () => void run("restoreItem", undo, () => setNotice(null)),
          },
        }),
    );
  }

  const columns = [
    {
      key: "title",
      header: "Item",
      render: (item: Item) => (
        <Stack gap={2}>
          <strong>{item.title}</strong>
          {item.triageNote ? <span>{item.triageNote}</span> : null}
        </Stack>
      ),
    },
    { key: "area", header: "Area", render: (item: Item) => <Badge>{AREAS[item.area]}</Badge> },
    {
      key: "priority",
      header: "Priority",
      render: (item: Item) => (
        <Badge tone={item.priority === 0 ? "danger" : "neutral"}>
          {priorityLabel(item.priority)}
        </Badge>
      ),
    },
    { key: "milestone", header: "Milestone", render: (item: Item) => item.milestoneName ?? "—" },
    {
      key: "estimate",
      header: "Days",
      align: "right" as const,
      render: (item: Item) => item.estimateDays ?? "—",
    },
    {
      key: "actions",
      header: "Actions",
      render: (item: Item) => (
        <Stack direction="horizontal" gap={6}>
          {item.status !== "new" && item.status !== "done" ? (
            <Button size="sm" onClick={() => show({ kind: "plan", item })}>
              {item.status === "triaged" ? "Plan" : "Replan"}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => archive(item)}>
            Archive
          </Button>
        </Stack>
      ),
    },
  ];

  const empty = rollup.data && rollup.data.total === 0 && milestones.length === 0;
  const page = list.data;
  const alert = notice ? (
    <Callout
      tone={notice.tone}
      title={notice.title}
      action={
        notice.action ? (
          <Button size="sm" disabled={busy} onClick={notice.action.run}>
            {notice.action.label}
          </Button>
        ) : null
      }
    >
      {notice.message ?? ""}
    </Callout>
  ) : null;
  return (
    <AppShell width="wide">
      <PageHeader
        eyebrow="Roadmap"
        title="Plan the roadmap"
        subtitle="Engineering triages new items. You set priority and milestone, and archive what's out."
        actions={
          <Stack direction="horizontal" gap={8} wrap>
            <Button onClick={() => show({ kind: "milestone" })}>New milestone</Button>
            <Button variant="primary" onClick={() => show({ kind: "item" })}>
              New item
            </Button>
          </Stack>
        }
      />
      <Stack gap={16}>
        {dialog ? null : alert}
        {rollup.error || list.error ? (
          <Callout
            tone="danger"
            title="Could not load the roadmap"
            action={
              <Button
                size="sm"
                onClick={() => {
                  rollup.reload();
                  list.reload();
                }}
              >
                Try again
              </Button>
            }
          >
            {(rollup.error ?? list.error)?.message ?? ""}
          </Callout>
        ) : null}
        {empty ? (
          <EmptyState
            title="No roadmap yet"
            description="Add items one at a time, or load a sample roadmap to see how the triage and rollup apps share it."
            action={
              <Button
                variant="primary"
                loading={busy}
                onClick={() => void run("importItems", SAMPLE)}
              >
                Load sample roadmap
              </Button>
            }
          />
        ) : (
          <Stack gap={12}>
            <Stack direction="horizontal" gap={12} wrap align="end" justify="space-between">
              <Tabs
                label="Status"
                value={status}
                onChange={(next) => {
                  setStatus(next as Status);
                  setCursors([]);
                }}
                items={STATUSES.map((id) => ({
                  id,
                  label: `${STATUS_LABELS[id]} ${rollup.data?.statuses[id] ?? ""}`.trim(),
                }))}
              />
              <Field label="Milestone" htmlFor="milestone-filter">
                <Select
                  id="milestone-filter"
                  value={milestone}
                  onChange={(event) => {
                    setMilestone(event.target.value);
                    setCursors([]);
                  }}
                >
                  <option value="">All milestones</option>
                  {milestones.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
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
              emptyTitle={`Nothing ${STATUS_LABELS[status].toLowerCase()}`}
              emptyDescription={
                status === "new"
                  ? "New items wait here until engineering triages them."
                  : "Items show up here as they move through the roadmap."
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
        )}
      </Stack>
      <ItemDialog
        open={dialog?.kind === "item"}
        alert={alert}
        busy={busy}
        onClose={() => show(null)}
        onSubmit={(input) =>
          void run("createItem", input, () => {
            setDialog(null);
            setStatus("new");
          })
        }
      />
      <MilestoneDialog
        open={dialog?.kind === "milestone"}
        alert={alert}
        busy={busy}
        onClose={() => show(null)}
        onSubmit={(input) => void run("createMilestone", input, () => setDialog(null))}
      />
      {dialog?.kind === "plan" ? (
        <PlanDialog
          item={dialog.item}
          milestones={milestones}
          alert={alert}
          busy={busy}
          onClose={() => show(null)}
          onSubmit={(input) => void run("planItem", input, () => setDialog(null))}
        />
      ) : null}
    </AppShell>
  );
}

function submitWith(handler: () => void) {
  return (event: FormEvent) => {
    event.preventDefault();
    handler();
  };
}

function ItemDialog(props: {
  open: boolean;
  alert: ReactNode;
  busy: boolean;
  onClose(): void;
  onSubmit(input: { title: string; detail: string; area: Area }): void;
}) {
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [area, setArea] = useState<Area>("apps");
  return (
    <Modal
      open={props.open}
      title="New roadmap item"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-item" loading={props.busy}>
            Add item
          </Button>
        </>
      }
    >
      <form id="new-item" onSubmit={submitWith(() => props.onSubmit({ title, detail, area }))}>
        <Stack gap={12}>
          {props.alert}
          <Field label="Title" htmlFor="item-title">
            <Input
              id="item-title"
              required
              maxLength={120}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label="Area" htmlFor="item-area">
            <Select
              id="item-area"
              value={area}
              onChange={(event) => setArea(event.target.value as Area)}
            >
              {Object.entries(AREAS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Detail" htmlFor="item-detail" hint="Optional">
            <Textarea
              id="item-detail"
              maxLength={2000}
              rows={4}
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
            />
          </Field>
        </Stack>
      </form>
    </Modal>
  );
}

function MilestoneDialog(props: {
  open: boolean;
  alert: ReactNode;
  busy: boolean;
  onClose(): void;
  onSubmit(input: { name: string; dueOn: string }): void;
}) {
  const [name, setName] = useState("");
  const [dueOn, setDueOn] = useState("");
  return (
    <Modal
      open={props.open}
      title="New milestone"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-milestone" loading={props.busy}>
            Add milestone
          </Button>
        </>
      }
    >
      <form id="new-milestone" onSubmit={submitWith(() => props.onSubmit({ name, dueOn }))}>
        <Stack gap={12}>
          {props.alert}
          <Field label="Name" htmlFor="milestone-name">
            <Input
              id="milestone-name"
              required
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Due" htmlFor="milestone-due">
            <Input
              id="milestone-due"
              type="date"
              required
              value={dueOn}
              onChange={(event) => setDueOn(event.target.value)}
            />
          </Field>
        </Stack>
      </form>
    </Modal>
  );
}

function PlanDialog(props: {
  item: Item;
  milestones: Rollup["milestones"];
  alert: ReactNode;
  busy: boolean;
  onClose(): void;
  onSubmit(input: { id: string; version: number; priority: number; milestoneId: string }): void;
}) {
  const { item } = props;
  const [priority, setPriority] = useState(item.priority ?? 2);
  const [milestoneId, setMilestoneId] = useState(item.milestoneId ?? props.milestones[0]?.id ?? "");
  return (
    <Modal
      open
      title={`Plan “${item.title}”`}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="plan-item"
            loading={props.busy}
            disabled={!milestoneId}
          >
            Save plan
          </Button>
        </>
      }
    >
      <form
        id="plan-item"
        onSubmit={submitWith(() =>
          props.onSubmit({ id: item.id, version: item.version, priority, milestoneId }),
        )}
      >
        <Stack gap={12}>
          {props.alert}
          <Field label="Priority" htmlFor="plan-priority" hint="P0 is the most urgent.">
            <Select
              id="plan-priority"
              value={priority}
              onChange={(event) => setPriority(Number(event.target.value))}
            >
              {[0, 1, 2, 3].map((value) => (
                <option key={value} value={value}>
                  {priorityLabel(value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Milestone"
            htmlFor="plan-milestone"
            hint={props.milestones.length ? undefined : "Add a milestone first."}
          >
            <Select
              id="plan-milestone"
              value={milestoneId}
              onChange={(event) => setMilestoneId(event.target.value)}
            >
              {props.milestones.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} · due {option.dueOn}
                </option>
              ))}
            </Select>
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
      <Roadmap />
    </AppProvider>,
  );
}
