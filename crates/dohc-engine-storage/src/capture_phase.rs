//! Nonshipping phase probes. SQL timings include their trigger programs.
//! Enable only in an admitted diagnostic replay, never a shipping package.
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Default)]
struct Total {
    calls: u64,
    elapsed_us: u64,
    count: u64,
}
thread_local! {
    static FORCE_ENABLED: Cell<bool> = const { Cell::new(false) };
    static PARENT: Cell<u64> = const { Cell::new(0) };
    static CORRELATION: RefCell<Option<String>> = const { RefCell::new(None) };
    static TOTALS: RefCell<BTreeMap<&'static str, Total>> = const { RefCell::new(BTreeMap::new()) };
}
static NEXT: AtomicU64 = AtomicU64::new(1);
/// Enable the existing fault-injection counters for an actor proof.
pub fn enable_for_current_thread() {
    FORCE_ENABLED.set(true);
}
fn enabled() -> bool {
    if FORCE_ENABLED.get() {
        return true;
    }
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("DOHC_CAPTURE_PHASE_DIAGNOSTICS").is_ok_and(|v| v == "1"))
}
pub fn count(label: &'static str, count: u64) {
    // Keep this invariant counter available to harness tests without timing logs.
    if matches!(
        label,
        "link_pending_row_writes" | "publication_staging_entries"
    ) || enabled()
    {
        TOTALS.with(|totals| {
            let mut totals = totals.borrow_mut();
            let total = totals.entry(label).or_default();
            total.count = total.count.saturating_add(count);
        });
    }
}
/// Copy on the actor, then compute the fence delta on its async driver.
#[derive(Clone, Default)]
pub struct Snapshot(BTreeMap<&'static str, Total>);

pub fn snapshot() -> Snapshot {
    Snapshot(TOTALS.with(|totals| totals.borrow().clone()))
}

impl Snapshot {
    pub fn count(&self, label: &str) -> u64 {
        self.0.get(label).map_or(0, |total| total.count)
    }

    pub fn delta(&self, before: &Self) -> serde_json::Value {
        let totals = self
            .0
            .iter()
            .map(|(label, after)| {
                let before = before.0.get(label).copied().unwrap_or_default();
                (
                    (*label).to_owned(),
                    serde_json::json!({
                        "calls": after.calls.saturating_sub(before.calls),
                        "elapsed_us": after.elapsed_us.saturating_sub(before.elapsed_us),
                        "count": after.count.saturating_sub(before.count),
                    }),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        totals.into()
    }
}

/// Aggregate timers on the actor thread; these never log per file or row.
pub struct Measure {
    label: &'static str,
    began: Option<Instant>,
}
impl Measure {
    pub fn new(label: &'static str) -> Self {
        Self {
            label,
            began: enabled().then(Instant::now),
        }
    }
}
impl Drop for Measure {
    fn drop(&mut self) {
        if let Some(began) = self.began {
            TOTALS.with(|totals| {
                let mut totals = totals.borrow_mut();
                let total = totals.entry(self.label).or_default();
                total.calls += 1;
                total.elapsed_us = total
                    .elapsed_us
                    .saturating_add(began.elapsed().as_micros().min(u64::MAX as u128) as u64);
            });
        }
    }
}
/// A completed phase/batch emits one line. Async phases do not read actor totals.
pub struct Phase {
    began: Option<Instant>,
    phase: &'static str,
    id: u64,
    fields: serde_json::Map<String, serde_json::Value>,
    before: Option<BTreeMap<&'static str, Total>>,
    thread: std::thread::ThreadId,
    parent: u64,
    previous_correlation: Option<String>,
}
impl Phase {
    pub fn new(
        phase: &'static str,
        correlation: Option<&str>,
        files: usize,
        actor_totals: bool,
    ) -> Self {
        let active = enabled();
        let id = if active {
            NEXT.fetch_add(1, Ordering::Relaxed)
        } else {
            0
        };
        let parent = if active { PARENT.with(Cell::get) } else { 0 };
        let previous_correlation = CORRELATION.with(|value| value.borrow().clone());
        let correlation = correlation
            .map(str::to_owned)
            .or_else(|| previous_correlation.clone());
        let mut fields = serde_json::Map::new();
        if active {
            fields.insert("parent_phase_id".into(), parent.into());
            fields.insert("correlation".into(), serde_json::json!(correlation));
            fields.insert("files".into(), serde_json::json!(files));
            fields.insert("outcome".into(), serde_json::json!("interrupted-or-error"));
            fields.insert(
                "start_unix_us".into(),
                serde_json::json!(
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_micros()
                        .min(u64::MAX as u128) as u64
                ),
            );
        }
        if active && actor_totals {
            PARENT.set(id);
            CORRELATION.with(|value| *value.borrow_mut() = correlation);
        }
        Self {
            began: active.then(Instant::now),
            phase,
            id,
            parent,
            previous_correlation,
            fields,
            before: (active && actor_totals).then(|| TOTALS.with(|t| t.borrow().clone())),
            thread: std::thread::current().id(),
        }
    }
    pub fn active(&self) -> bool {
        self.began.is_some()
    }
    pub fn field(&mut self, name: &str, value: impl Into<serde_json::Value>) {
        if self.began.is_some() {
            self.fields.insert(name.into(), value.into());
        }
    }
    pub fn finish(&mut self, outcome: &str) {
        self.field("outcome", outcome);
    }
}
impl Drop for Phase {
    fn drop(&mut self) {
        let Some(began) = self.began else {
            return;
        };
        if let Some(before) = &self.before {
            assert_eq!(
                self.thread,
                std::thread::current().id(),
                "actor probe crossed threads"
            );
            let totals = TOTALS.with(|totals| {
                totals
                    .borrow()
                    .iter()
                    .map(|(label, after)| {
                        let before = before.get(label).copied().unwrap_or_default();
                        (
                            (*label).to_owned(),
                            serde_json::json!({
                                "calls":after.calls.saturating_sub(before.calls),
                                "elapsed_us":after.elapsed_us.saturating_sub(before.elapsed_us),
                                "count":after.count.saturating_sub(before.count),
                            }),
                        )
                    })
                    .collect::<serde_json::Map<_, _>>()
            });
            self.fields.insert("totals".into(), totals.into());
            PARENT.set(self.parent);
            CORRELATION.with(|value| *value.borrow_mut() = self.previous_correlation.take());
        }
        self.fields.insert("phase".into(), self.phase.into());
        self.fields.insert("phase_id".into(), self.id.into());
        self.fields.insert(
            "elapsed_us".into(),
            (began.elapsed().as_micros().min(u64::MAX as u128) as u64).into(),
        );
        eprintln!(
            "R16_CAPTURE_PHASE {}",
            serde_json::Value::Object(std::mem::take(&mut self.fields))
        );
    }
}

// NOOP only samples the WAL header; it does not perform backfill.
pub(crate) fn wal(conn: &rusqlite::Connection, phase: &mut Phase, before: bool) {
    if !phase.active() {
        return;
    }
    if let Ok((log, backfilled)) = conn.query_row("PRAGMA main.wal_checkpoint(NOOP)", [], |r| {
        Ok((r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
    }) {
        phase.field(if before { "starting_log" } else { "ending_log" }, log);
        phase.field(
            if before {
                "starting_backfilled"
            } else {
                "ending_backfilled"
            },
            backfilled,
        );
    }
}
