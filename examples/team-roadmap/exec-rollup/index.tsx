import { createRoot } from "react-dom/client";
import { AppProvider, useDatasetQuery } from "dohc/app";
import { BarChart } from "dohc/charts";
import {
  AppShell,
  Button,
  Callout,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  ProgressBar,
  Skeleton,
  Stack,
  StatCard,
  formatPercent,
} from "dohc/ui";

const AREAS: Record<string, string> = {
  platform: "Platform",
  apps: "Apps",
  sync: "Sync",
  mobile: "Mobile",
};

interface Rollup {
  total: number;
  open: number;
  p0Open: number;
  statuses: Record<"new" | "triaged" | "planned" | "in_progress" | "done", number>;
  milestones: {
    id: string;
    name: string;
    dueOn: string;
    total: number;
    done: number;
    inProgress: number;
    p0Open: number;
    openDays: number;
  }[];
  areas: { area: string; open: number; done: number }[];
}

function Overview() {
  const { data, loading, error, reload } = useDatasetQuery<Rollup>("rollup");
  return (
    <AppShell>
      <PageHeader
        eyebrow="Roadmap"
        title="Roadmap progress"
        subtitle="Totals only. Item titles, notes, and people stay with the roadmap team."
        actions={
          <Button size="sm" loading={loading && Boolean(data)} onClick={reload}>
            Refresh
          </Button>
        }
      />
      {error ? (
        <Callout
          tone="danger"
          title="Could not load roadmap progress"
          action={
            <Button size="sm" onClick={reload}>
              Try again
            </Button>
          }
        >
          {error.message}
        </Callout>
      ) : null}
      {!data ? (
        error ? null : (
          <Grid cols={4}>
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} height={96} />
            ))}
          </Grid>
        )
      ) : data.total === 0 ? (
        <EmptyState
          title="Nothing on the roadmap yet"
          description="Progress shows up here once product adds items."
        />
      ) : (
        <Stack gap={16}>
          <Grid cols={4}>
            <StatCard label="Open items" value={data.open} hint={`${data.total} in total`} />
            <StatCard
              label="Open P0"
              value={data.p0Open}
              tone={data.p0Open ? "danger" : "success"}
              delta={data.p0Open ? "Needs attention" : "Clear"}
            />
            <StatCard
              label="In progress"
              value={data.statuses.in_progress}
              hint={`${data.statuses.planned} planned next`}
            />
            <StatCard
              label="Done"
              value={formatPercent(data.statuses.done / data.total)}
              hint={`${data.statuses.done} items`}
            />
          </Grid>
          <Grid cols={2}>
            <Card title="Milestones" subtitle="Done out of planned items">
              <Stack gap={14}>
                {data.milestones.length ? (
                  data.milestones.map((milestone) => (
                    <Stack key={milestone.id} gap={4}>
                      <ProgressBar
                        label={`${milestone.name} · due ${milestone.dueOn}`}
                        value={milestone.done}
                        max={milestone.total}
                        valueLabel={`${milestone.done} of ${milestone.total}`}
                        tone={milestone.p0Open ? "warning" : "success"}
                      />
                      <span>
                        {milestone.inProgress} in progress · {milestone.p0Open} open P0 ·{" "}
                        {milestone.openDays} days of work left
                      </span>
                    </Stack>
                  ))
                ) : (
                  <span>No milestones yet.</span>
                )}
              </Stack>
            </Card>
            <Card title="By area" subtitle="Open and done items">
              <BarChart
                stacked
                ariaLabel="Open and done items by area"
                labels={data.areas.map((row) => AREAS[row.area] ?? row.area)}
                series={[
                  { name: "Open", values: data.areas.map((row) => row.open) },
                  { name: "Done", values: data.areas.map((row) => row.done) },
                ]}
              />
            </Card>
          </Grid>
        </Stack>
      )}
    </AppShell>
  );
}

const mount = document.getElementById("root");
if (mount) {
  createRoot(mount).render(
    <AppProvider>
      <Overview />
    </AppProvider>,
  );
}
