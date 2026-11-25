import { useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useDatasetMutation, useDatasetQuery } from "dohc/app";
import {
  AppShell,
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  EmptyState,
  Field,
  Grid,
  Input,
  Modal,
  PageHeader,
  Select,
  Stack,
  StatCard,
  Tabs,
  formatCurrency,
} from "dohc/ui";
import { BarChart, Sparkline } from "dohc/charts";

interface ExpenseRow {
  id: string;
  date: string;
  merchant: string;
  category: string;
  amount: number;
  note: string | null;
}

interface WorkoutRow {
  id: string;
  date: string;
  activity: string;
  minutes: number;
  effort: string;
  notes: string | null;
}

const CATEGORIES = ["Food", "Transport", "Housing", "Health", "Gear", "Other"];
const EFFORTS = ["Easy", "Moderate", "Hard"];

function todayIso(): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function PersonalControlTower() {
  const expenses = useDatasetQuery<ExpenseRow[]>("listExpenses", {}, { dataset: "expenses" });
  const workouts = useDatasetQuery<WorkoutRow[]>("listWorkouts", {}, { dataset: "workouts" });
  const addExpense = useDatasetMutation<
    { date: string; merchant: string; category: string; amount: number; note: string },
    ExpenseRow
  >("addExpense", { dataset: "expenses" });
  const deleteExpense = useDatasetMutation<{ id: string }, { deleted: boolean }>("deleteExpense", {
    dataset: "expenses",
  });
  const logWorkout = useDatasetMutation<
    { date: string; activity: string; minutes: number; effort: string; notes: string },
    WorkoutRow
  >("logWorkout", { dataset: "workouts" });
  const deleteWorkout = useDatasetMutation<{ id: string }, { deleted: boolean }>("deleteWorkout", {
    dataset: "workouts",
  });

  const [tab, setTab] = useState("expenses");
  const [expenseModal, setExpenseModal] = useState(false);
  const [workoutModal, setWorkoutModal] = useState(false);

  const [expDate, setExpDate] = useState(todayIso);
  const [merchant, setMerchant] = useState("");
  const [category, setCategory] = useState("Food");
  const [amount, setAmount] = useState("");
  const [expNote, setExpNote] = useState("");

  const [wrkDate, setWrkDate] = useState(todayIso);
  const [activity, setActivity] = useState("");
  const [minutes, setMinutes] = useState("30");
  const [effort, setEffort] = useState("Moderate");
  const [wrkNotes, setWrkNotes] = useState("");

  const expenseRows = expenses.data ?? [];
  const workoutRows = workouts.data ?? [];

  const totalSpent = useMemo(
    () => expenseRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    [expenseRows],
  );
  const totalMinutes = useMemo(
    () => workoutRows.reduce((sum, row) => sum + Number(row.minutes || 0), 0),
    [workoutRows],
  );
  const spendByCategory = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of expenseRows) {
      totals.set(row.category, (totals.get(row.category) ?? 0) + Number(row.amount || 0));
    }
    return CATEGORIES.map((label) => ({ label, value: totals.get(label) ?? 0 })).filter(
      (entry) => entry.value > 0,
    );
  }, [expenseRows]);
  const workoutTrend = useMemo(
    () =>
      [...workoutRows]
        .reverse()
        .slice(-14)
        .map((row) => Number(row.minutes || 0)),
    [workoutRows],
  );

  const submitExpense = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await addExpense.mutate({
        date: expDate,
        merchant,
        category,
        amount: Number(amount),
        note: expNote,
      });
      setMerchant("");
      setAmount("");
      setExpNote("");
      setExpenseModal(false);
      expenses.reload();
    } catch {
      return;
    }
  };

  const submitWorkout = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await logWorkout.mutate({
        date: wrkDate,
        activity,
        minutes: Number(minutes),
        effort,
        notes: wrkNotes,
      });
      setActivity("");
      setMinutes("30");
      setWrkNotes("");
      setWorkoutModal(false);
      workouts.reload();
    } catch {
      return;
    }
  };

  return (
    <AppShell>
      <PageHeader
        eyebrow="Personal"
        title="Control Tower"
        subtitle="Track spending and workouts in one local workspace."
        actions={
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" onClick={() => setWorkoutModal(true)}>
              Log workout
            </Button>
            <Button variant="primary" onClick={() => setExpenseModal(true)}>
              Add expense
            </Button>
          </div>
        }
      />

      <Stack gap={16}>
        {expenses.error ? (
          <Callout
            tone="danger"
            title="Could not load expenses"
            action={
              <Button size="sm" onClick={expenses.reload}>
                Try again
              </Button>
            }
          >
            {expenses.error.message}
          </Callout>
        ) : null}
        {workouts.error ? (
          <Callout
            tone="danger"
            title="Could not load workouts"
            action={
              <Button size="sm" onClick={workouts.reload}>
                Try again
              </Button>
            }
          >
            {workouts.error.message}
          </Callout>
        ) : null}
        {deleteExpense.error ? (
          <Callout tone="danger" title="Could not remove expense">
            {deleteExpense.error.message}
          </Callout>
        ) : null}
        {deleteWorkout.error ? (
          <Callout tone="danger" title="Could not remove workout">
            {deleteWorkout.error.message}
          </Callout>
        ) : null}

        <Grid cols={4}>
          <StatCard
            label={expenseRows.length >= 200 ? "Total spend (latest 200)" : "Total spend"}
            value={formatCurrency(totalSpent)}
          />
          <StatCard
            label={expenseRows.length >= 200 ? "Expenses (latest 200)" : "Expenses"}
            value={String(expenseRows.length)}
          />
          <StatCard
            label={workoutRows.length >= 200 ? "Active minutes (latest 200)" : "Active minutes"}
            value={`${totalMinutes} min`}
          />
          <StatCard
            label={workoutRows.length >= 200 ? "Workouts (latest 200)" : "Workouts"}
            value={String(workoutRows.length)}
          />
        </Grid>

        <Grid cols={2}>
          <Card
            title="Spending by category"
            subtitle={expenseRows.length >= 200 ? "From latest 200 expenses" : "From Expenses"}
          >
            {spendByCategory.length > 0 ? (
              <BarChart
                data={spendByCategory}
                formatValue={(value) => formatCurrency(value)}
                ariaLabel="Spending by category"
              />
            ) : (
              <EmptyState
                title="No expenses yet"
                description="Add an expense to see spending by category."
                action={
                  <Button variant="primary" onClick={() => setExpenseModal(true)}>
                    Add expense
                  </Button>
                }
              />
            )}
          </Card>
          <Card title="Recent workout duration" subtitle="Minutes per session">
            {workoutTrend.length > 0 ? (
              <Sparkline
                values={workoutTrend}
                width={280}
                height={96}
                ariaLabel="Recent workout duration"
              />
            ) : (
              <EmptyState
                title="No workouts yet"
                description="Log a workout to track session duration."
                action={
                  <Button variant="secondary" onClick={() => setWorkoutModal(true)}>
                    Log workout
                  </Button>
                }
              />
            )}
          </Card>
        </Grid>

        <Card>
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              {
                id: "expenses",
                label: `Expenses (${expenseRows.length})`,
                content: (
                  <DataTable
                    rows={expenseRows}
                    rowKey={(row) => row.id}
                    loading={expenses.loading && expenseRows.length === 0}
                    emptyTitle="No expenses logged"
                    emptyDescription="Use Add expense to record your first transaction."
                    columns={[
                      { key: "date", header: "Date", render: (row) => row.date },
                      { key: "merchant", header: "Merchant", render: (row) => row.merchant },
                      {
                        key: "category",
                        header: "Category",
                        render: (row) => <Badge>{row.category}</Badge>,
                      },
                      {
                        key: "amount",
                        header: "Amount",
                        align: "right",
                        render: (row) => formatCurrency(Number(row.amount || 0)),
                      },
                      {
                        key: "actions",
                        header: "",
                        align: "right",
                        render: (row) => (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              void deleteExpense
                                .mutate({ id: row.id })
                                .then(() => expenses.reload())
                                .catch(() => undefined);
                            }}
                          >
                            Remove
                          </Button>
                        ),
                      },
                    ]}
                  />
                ),
              },
              {
                id: "workouts",
                label: `Workouts (${workoutRows.length})`,
                content: (
                  <DataTable
                    rows={workoutRows}
                    rowKey={(row) => row.id}
                    loading={workouts.loading && workoutRows.length === 0}
                    emptyTitle="No workouts logged"
                    emptyDescription="Use Log workout to record your first session."
                    columns={[
                      { key: "date", header: "Date", render: (row) => row.date },
                      { key: "activity", header: "Activity", render: (row) => row.activity },
                      {
                        key: "effort",
                        header: "Effort",
                        render: (row) => (
                          <Badge
                            tone={
                              row.effort === "Hard"
                                ? "warning"
                                : row.effort === "Moderate"
                                  ? "success"
                                  : "neutral"
                            }
                          >
                            {row.effort}
                          </Badge>
                        ),
                      },
                      {
                        key: "minutes",
                        header: "Duration",
                        align: "right",
                        render: (row) => `${row.minutes} min`,
                      },
                      {
                        key: "actions",
                        header: "",
                        align: "right",
                        render: (row) => (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              void deleteWorkout
                                .mutate({ id: row.id })
                                .then(() => workouts.reload())
                                .catch(() => undefined);
                            }}
                          >
                            Remove
                          </Button>
                        ),
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
        </Card>
      </Stack>

      <Modal
        open={expenseModal}
        title="Add expense"
        onClose={() => {
          if (!addExpense.pending) setExpenseModal(false);
        }}
      >
        <form onSubmit={submitExpense}>
          <fieldset
            disabled={addExpense.pending}
            style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 12 }}
          >
            {addExpense.error ? (
              <Callout tone="danger" title="Could not save expense">
                {addExpense.error.message}
              </Callout>
            ) : null}
            <Field label="Date" htmlFor="exp-date">
              <Input
                id="exp-date"
                type="date"
                value={expDate}
                onChange={(event) => setExpDate(event.target.value)}
                required
              />
            </Field>
            <Field label="Merchant" htmlFor="exp-merchant">
              <Input
                id="exp-merchant"
                value={merchant}
                onChange={(event) => setMerchant(event.target.value)}
                placeholder="Blue Bottle Coffee"
                required
              />
            </Field>
            <Field label="Category" htmlFor="exp-category">
              <Select
                id="exp-category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                {CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount" htmlFor="exp-amount">
              <Input
                id="exp-amount"
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="12.50"
                required
              />
            </Field>
            <Field label="Note" htmlFor="exp-note">
              <Input
                id="exp-note"
                value={expNote}
                onChange={(event) => setExpNote(event.target.value)}
                placeholder="Optional note"
              />
            </Field>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button
                type="button"
                variant="secondary"
                disabled={addExpense.pending}
                onClick={() => setExpenseModal(false)}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={addExpense.pending}>
                Save expense
              </Button>
            </div>
          </fieldset>
        </form>
      </Modal>

      <Modal
        open={workoutModal}
        title="Log workout"
        onClose={() => {
          if (!logWorkout.pending) setWorkoutModal(false);
        }}
      >
        <form onSubmit={submitWorkout}>
          <fieldset
            disabled={logWorkout.pending}
            style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 12 }}
          >
            {logWorkout.error ? (
              <Callout tone="danger" title="Could not save workout">
                {logWorkout.error.message}
              </Callout>
            ) : null}
            <Field label="Date" htmlFor="wrk-date">
              <Input
                id="wrk-date"
                type="date"
                value={wrkDate}
                onChange={(event) => setWrkDate(event.target.value)}
                required
              />
            </Field>
            <Field label="Activity" htmlFor="wrk-activity">
              <Input
                id="wrk-activity"
                value={activity}
                onChange={(event) => setActivity(event.target.value)}
                placeholder="Morning 5K run"
                required
              />
            </Field>
            <Field label="Minutes" htmlFor="wrk-minutes">
              <Input
                id="wrk-minutes"
                type="number"
                min="1"
                max="1440"
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
                required
              />
            </Field>
            <Field label="Effort" htmlFor="wrk-effort">
              <Select
                id="wrk-effort"
                value={effort}
                onChange={(event) => setEffort(event.target.value)}
              >
                {EFFORTS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Notes" htmlFor="wrk-notes">
              <Input
                id="wrk-notes"
                value={wrkNotes}
                onChange={(event) => setWrkNotes(event.target.value)}
                placeholder="Optional notes"
              />
            </Field>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button
                type="button"
                variant="secondary"
                disabled={logWorkout.pending}
                onClick={() => setWorkoutModal(false)}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={logWorkout.pending}>
                Save workout
              </Button>
            </div>
          </fieldset>
        </form>
      </Modal>
    </AppShell>
  );
}

const mount = document.getElementById("root");
if (mount) {
  createRoot(mount).render(
    <AppProvider>
      <PersonalControlTower />
    </AppProvider>,
  );
}
