import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useDatasetQuery } from "dohc/app";
import { LineChart } from "dohc/charts";
import {
  AppShell,
  Button,
  Callout,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  Stack,
  formatNumber,
} from "dohc/ui";

type Bar = { bucket: string; mean: number; ma7: number | null; ma30: number | null };
type Report = {
  title: string;
  body: string;
  snapshot: {
    start: string;
    end: string;
    grain: "day" | "week" | "month" | "year";
    series: Array<{ id: string; name: string; unit: string; color: number; bars: Bar[] }>;
  };
};

const ranges = [
  ["30D", 30],
  ["90D", 90],
  ["1Y", 365],
  ["All", 0],
] as const;
const grains = { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" };

function periodEnd(bucket: string, grain: Report["snapshot"]["grain"]) {
  const date = new Date(bucket);
  if (grain === "week") date.setUTCDate(date.getUTCDate() + 6);
  if (grain === "month") date.setUTCMonth(date.getUTCMonth() + 1, 0);
  if (grain === "year") date.setUTCFullYear(date.getUTCFullYear() + 1, 0, 0);
  return date.getTime();
}

function ReportPage() {
  const report = useDatasetQuery<Report | null>("publishedReport");
  const [days, setDays] = useState<number>(0);
  const data = report.data;
  return (
    <AppShell width="wide">
      <PageHeader
        title={data?.title ?? "SignalBook"}
        subtitle={
          data
            ? `${data.snapshot.start} to ${data.snapshot.end} · ${grains[data.snapshot.grain]} rollups · UTC`
            : undefined
        }
        actions={
          data && (
            <Stack direction="horizontal" gap={8} wrap>
              {ranges.map(([label, count]) => (
                <Button
                  key={label}
                  aria-pressed={count === days}
                  variant={count === days ? "primary" : "secondary"}
                  onClick={() => setDays(count)}
                >
                  {label}
                </Button>
              ))}
            </Stack>
          )
        }
      />
      {report.loading && <p role="status">Loading report…</p>}
      {report.error && (
        <Callout
          tone="danger"
          title="Could not load this report"
          action={
            <Button onClick={report.reload} variant="secondary">
              Try again
            </Button>
          }
        >
          {report.error.message}
        </Callout>
      )}
      {data === null && <EmptyState title="No report is linked" />}
      {data && (
        <Stack gap={24}>
          <Card title="Research note">
            <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{data.body}</p>
          </Card>
          <Grid cols={data.snapshot.series.length === 1 ? 1 : 2} gap={16}>
            {data.snapshot.series.map((series) => {
              const cutoff = days
                ? Date.parse(data.snapshot.end) - (days - 1) * 86_400_000
                : -Infinity;
              const bars = series.bars.filter(
                (bar) => periodEnd(bar.bucket, data.snapshot.grain) >= cutoff,
              );
              return (
                <Card key={series.id} title={series.name} subtitle={series.unit || undefined}>
                  {bars.length > 0 ? (
                    <LineChart
                      labels={bars.map((bar) => bar.bucket)}
                      height={260}
                      ariaLabel={`${series.name} rollups`}
                      series={[
                        {
                          name: "Mean",
                          color: `var(--kit-chart-${series.color})`,
                          values: bars.map((bar) => bar.mean),
                        },
                        {
                          name: "30-day rolling mean",
                          color: `var(--kit-chart-${(series.color % 6) + 1})`,
                          values: bars.map((bar) => bar.ma30 ?? NaN),
                        },
                      ]}
                      formatValue={(value) => formatNumber(value, { maximumFractionDigits: 2 })}
                    />
                  ) : (
                    <EmptyState title="No observations in this date range" />
                  )}
                </Card>
              );
            })}
          </Grid>
        </Stack>
      )}
    </AppShell>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppProvider>
    <ReportPage />
  </AppProvider>,
);
