//! The paired release measurement of released-window protection. Every
//! revision it compares carries this file unchanged, so fixtures, sample
//! progression and instrumentation match; each revision's own
//! `owner_publication.rs` supplies the tails a decision reads and how a
//! decision or pass runs to its end, through [`measured_tails`],
//! [`measured_protection`] and [`measured_pull`], which time each actor
//! operation with [`operation`].
use super::*;
use rusqlite::OptionalExtension;
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The native sequence of the first history entry, past any journal row or
/// compaction the measured passes reach, so no pass's own rows name one.
const HISTORY_SEQUENCE: i64 = 1 << 40;

const MEASURED_SAFE_ROWS: usize = 8;

/// The unrelated documents created beside each pass of that phase.
const UNRELATED_DOCUMENTS: usize = 4;

/// `count` acknowledged native entries of the released tail's outbox, after
/// the retained one. Applied here, they are the proven history a long-lived
/// lineage keeps; never applied, each is retained work that protects it.
/// Written past the store's checks, each still reads as valid.
fn retained_history(w: &RetainedWindow, count: usize, applied: bool) {
    use dohc_engine_collab::owner_outbox::{OwnerOutboxNativeOrigin, OwnerOutboxNativeSource};
    let mut raw = rusqlite::Connection::open(engine_db_path(&w.root).unwrap()).unwrap();
    raw.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
    let tx = raw.transaction().unwrap();
    let (outbox, last, template): (String, i64, String) = tx
        .query_row(
            "SELECT outbox_id,(SELECT MAX(sequence) FROM owner_ydoc_outbox_entries),native_source_json
             FROM owner_ydoc_outbox_entries WHERE update_digest=?1",
            [&w.retained_digest],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    let mut source: OwnerOutboxNativeSource = serde_json::from_str(&template).unwrap();
    assert!(matches!(
        source.origin,
        OwnerOutboxNativeOrigin::NativeUpdate { .. }
    ));
    {
        let mut entry = tx
            .prepare(
                "INSERT INTO owner_ydoc_outbox_entries (outbox_id,sequence,append_key,delivery_id,
                   update_digest,native_source_json,accepted_receipt_json,byte_length,created_at_ms,pending,
                   result_pending_bytes,result_oldest_entry_at_ms,result_state)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,1,1,0,1,1,'active')",
            )
            .unwrap();
        let mut application = tx.prepare(APPLIED_EXACTLY).unwrap();
        for index in 0..count as i64 {
            source.native_sequence = HISTORY_SEQUENCE + index;
            let json = serde_json::to_string(&source).unwrap();
            let delivery_id = format!("history-{index}");
            let receipt = dohc_engine_collab::OwnerDeliveryReceipt {
                delivery_id: delivery_id.clone(),
                update_digest: w.retained_digest.clone(),
                journal_cursor: 1_000 + index,
                accepting_host_epoch: 1,
            };
            entry
                .execute(rusqlite::params![
                    outbox,
                    last + 1 + index,
                    format!("adopted-local:{}", hex_sha256(json.as_bytes())),
                    delivery_id,
                    w.retained_digest,
                    json,
                    serde_json::to_string(&receipt).unwrap()
                ])
                .unwrap();
            if !applied {
                continue;
            }
            application
                .execute(rusqlite::params![
                    delivery_id,
                    w.lineage,
                    w.retained_digest,
                    receipt.journal_cursor,
                    receipt.accepting_host_epoch
                ])
                .unwrap();
        }
    }
    tx.commit().unwrap();
}

/// Time a class of statements took on the store's connection.
#[derive(Debug, Default, Clone, Copy)]
struct Spent {
    count: u64,
    time: Duration,
}

impl Spent {
    fn json(self) -> serde_json::Value {
        serde_json::json!({ "count": self.count, "ms": self.time.as_secs_f64() * 1000.0 })
    }
}

/// What the store's connection ran while one sample was taken, from
/// SQLite's statement trace, by each statement's leading keyword. A
/// statement's time runs from its first step to its reset, so it includes
/// the triggers it fired and whatever its caller did between its steps.
#[derive(Debug, Default)]
struct Sql {
    /// Reads of `released_tail_generations`.
    generation_reads: Spent,
    /// Inserts, updates and deletes, with their triggers.
    mutations: Spent,
    /// `COMMIT`, `END` and `RELEASE`.
    commits: Spent,
    other: Spent,
    /// Generation rows the store's triggers advanced.
    advances: u64,
    /// Each advance, by the trigger that made it and the statement that
    /// fired that trigger.
    invalidations: BTreeMap<(String, String), u64>,
    /// The trigger whose program last began.
    trigger: Option<String>,
    /// When each running statement began, by its SQL text's address, which
    /// stays its own while it is prepared. SQLite's own profile counts
    /// whole milliseconds on Windows.
    running: std::collections::HashMap<usize, Instant>,
}

impl Sql {
    fn total(&self) -> Duration {
        self.generation_reads.time + self.mutations.time + self.commits.time + self.other.time
    }
}

/// The trace of the sample being taken; none between samples.
static TRACED: Mutex<Option<Sql>> = Mutex::new(None);

fn traced(event: TraceEvent<'_>) {
    let mut traced = TRACED.lock().unwrap();
    let Some(sql) = traced.as_mut() else {
        return;
    };
    match event {
        // A statement's trigger programs and their steps report as comments
        // against it. Every row a generation update reaches runs this
        // trigger's program.
        TraceEvent::Stmt(statement, text) => {
            match text.strip_prefix("-- TRIGGER ") {
                Some("released_tail_generation_advance") => {
                    sql.advances += 1;
                    let by = sql.trigger.clone().unwrap_or_default();
                    let statement: String = statement
                        .sql()
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .chars()
                        .take(160)
                        .collect();
                    *sql.invalidations.entry((by, statement)).or_default() += 1;
                }
                Some(trigger) => sql.trigger = Some(trigger.to_owned()),
                None if !text.starts_with("--") => sql.trigger = None,
                None => {}
            }
            sql.running
                .entry(statement.sql().as_ptr() as usize)
                .or_insert_with(Instant::now);
        }
        TraceEvent::Profile(statement, profiled) => {
            let text = statement.sql();
            let time = sql
                .running
                .remove(&(text.as_ptr() as usize))
                .map_or(profiled, |began| began.elapsed());
            let keyword = text
                .trim_start()
                .split(|c: char| !c.is_ascii_alphabetic())
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase();
            let spent = match keyword.as_str() {
                "COMMIT" | "END" | "RELEASE" => &mut sql.commits,
                "INSERT" | "UPDATE" | "DELETE" | "REPLACE" => &mut sql.mutations,
                _ if text.contains("released_tail_generations") => &mut sql.generation_reads,
                _ => &mut sql.other,
            };
            spent.count += 1;
            spent.time += time;
        }
        _ => {}
    }
}

/// Trace the store's connection, or stop.
fn trace(store: &EngineStore, on: bool) {
    store
        .read_with(|conn| {
            if on {
                conn.trace_v2(
                    TraceEventCodes::SQLITE_TRACE_STMT | TraceEventCodes::SQLITE_TRACE_PROFILE,
                    Some(traced),
                );
            } else {
                conn.trace_v2(TraceEventCodes::empty(), None);
            }
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
}

/// The window document's released tail generation; none before its first
/// activation, or in a store that keeps no generations.
fn window_generation(store: &EngineStore) -> Option<i64> {
    let key = window_key();
    store
        .read_with(|conn| {
            let kept: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='released_tail_generations')",
                [],
                |row| row.get(0),
            )?;
            if !kept {
                return Ok(None);
            }
            conn.query_row(
                "SELECT generation FROM released_tail_generations
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |row| row.get(0),
            )
            .optional()
        })
        .unwrap()
}

/// One measured pass or decision: its time to its end, each uninterrupted
/// actor operation it took, the tails scans it ran, and what its statements
/// did.
struct Sample {
    ms: f64,
    operations: Vec<f64>,
    validations: u64,
    generation: (Option<i64>, Option<i64>),
    sql: Sql,
}

/// The actor operations of the sample being taken, in milliseconds.
static OPERATIONS: Mutex<Vec<f64>> = Mutex::new(Vec::new());

/// Run `work` as one uninterrupted actor operation of the sample being
/// taken, timed whole.
pub(super) fn operation<T>(work: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let done = work();
    OPERATIONS
        .lock()
        .unwrap()
        .push(started.elapsed().as_secs_f64() * 1000.0);
    done
}

/// Measure `work` on `store`, timed from just before it starts to when it
/// returns.
fn sample<T>(store: &mut EngineStore, work: impl FnOnce(&mut EngineStore) -> T) -> (Sample, T) {
    let before = window_generation(store);
    let scans = released_tail_scans();
    OPERATIONS.lock().unwrap().clear();
    *TRACED.lock().unwrap() = Some(Sql::default());
    let started = Instant::now();
    let done = work(store);
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    let sql = TRACED.lock().unwrap().take().unwrap();
    let sample = Sample {
        ms,
        operations: std::mem::take(&mut *OPERATIONS.lock().unwrap()),
        validations: released_tail_scans() - scans,
        generation: (before, window_generation(store)),
        sql,
    };
    (sample, done)
}

/// One complete hosted pass: [`MEASURED_SAFE_ROWS`] rows that apply,
/// `unrelated` creates of other documents beside them, then a row at another
/// path that the pass holds and retries. `sample` keeps each pass's origins
/// apart, and `placed` keeps every row a pass applied, which the relay
/// still knows in later passes.
fn measured_pass(
    w: &mut RetainedWindow,
    cache: &mut dohc_engine_collab::WriterDocCache,
    placed: &mut Vec<dohc_engine_sync::ReplicationEnvelope>,
    sample_name: &str,
    unrelated: usize,
) -> Sample {
    let documents: Vec<(String, String)> = (0..unrelated)
        .map(|index| {
            let object = format!("unrelated-{sample_name}-{index}");
            let path = format!("notes/{object}.md");
            execute(
                &mut w.store,
                &format!(
                    "INSERT INTO hosted_documents(workspace_id,object_id,path,state,scope_generation)
                     VALUES ('workspace','{object}','{path}','ready',1)"
                ),
            );
            (object, path)
        })
        .collect();
    // The scope keeps every document an earlier pass created.
    let hosted: Vec<(String, String)> = w
        .store
        .read_with(|conn| {
            conn.prepare("SELECT object_id,path FROM hosted_documents ORDER BY object_id")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<_, _>>()
        })
        .unwrap();
    let scope: Vec<(&str, &str)> = hosted
        .iter()
        .map(|(object, path)| (object.as_str(), path.as_str()))
        .collect();
    let mut feed = HostedFeed::new(&scope);
    feed.placed = placed.clone();
    let doc = w.head();
    for row in 0..MEASURED_SAFE_ROWS {
        let bytes = doc.richdoc_append_paragraph(&format!("Row {sample_name}.{row}"));
        let op = ydoc_row(
            &format!("safe-{sample_name}-{row}"),
            &bytes,
            &w.lineage,
            WINDOW_PATH,
            false,
        );
        feed.serve(op, bytes);
    }
    for (object, path) in &documents {
        feed.write_as(
            &format!("unrelated-{sample_name}"),
            object,
            path,
            None,
            "Elsewhere.\n",
        );
    }
    let moved = doc.richdoc_append_paragraph("Moved");
    let held = feed.serve(
        ydoc_row(
            &format!("moved-{sample_name}"),
            &moved,
            &w.lineage,
            "notes/moved.md",
            false,
        ),
        moved,
    );
    placed.extend(
        feed.rows
            .lock()
            .unwrap()
            .iter()
            .filter(|op| op.origin_id != held.origin_id)
            .cloned(),
    );
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let (measured, pass) = sample(&mut w.store, |store| {
        measured_pull(store, &client, cache)
            .unwrap_or_else(|error| panic!("{sample_name}: {error:?}"))
    });
    assert_eq!(
        pass.applied,
        MEASURED_SAFE_ROWS + unrelated,
        "{:?}",
        pass.pending_cursor
    );
    assert!(stopped_before(&pass, &held), "{:?}", pass.pending_cursor);
    measured
}

/// What one run measures, from the environment: `DOHC_MEASURE_PASSES`
/// passes and decisions in each phase (100), `DOHC_MEASURE_ENTRIES` history
/// sizes (0,1000,10000,50000), `DOHC_MEASURE_HISTORY` (proven,protected),
/// and `DOHC_MEASURE_LABEL`, which every record carries.
struct Plan {
    passes: usize,
    entries: Vec<usize>,
    histories: Vec<bool>,
    label: String,
}

impl Plan {
    fn from_env() -> Self {
        let var =
            |name: &str, default: &str| std::env::var(name).unwrap_or_else(|_| default.into());
        let list = |name: &str, default: &str| -> Vec<String> {
            var(name, default)
                .split(',')
                .map(|item| item.trim().to_owned())
                .filter(|item| !item.is_empty())
                .collect()
        };
        let passes = var("DOHC_MEASURE_PASSES", "100").parse().unwrap();
        assert!(passes > 0, "DOHC_MEASURE_PASSES");
        Self {
            passes,
            entries: list("DOHC_MEASURE_ENTRIES", "0,1000,10000,50000")
                .iter()
                .map(|entries| entries.parse().unwrap())
                .collect(),
            histories: list("DOHC_MEASURE_HISTORY", "proven,protected")
                .iter()
                .map(|history| match history.as_str() {
                    "proven" => true,
                    "protected" => false,
                    other => panic!("DOHC_MEASURE_HISTORY: {other}"),
                })
                .collect(),
            label: var("DOHC_MEASURE_LABEL", "unlabelled"),
        }
    }
}

/// Print one sample as a JSON record, and add it to its phase.
fn record(
    plan: &Plan,
    scenario: (&str, usize),
    phase: &str,
    samples: &mut Vec<Sample>,
    sample: Sample,
) {
    let (history, entries) = scenario;
    let sql = &sample.sql;
    let invalidations: Vec<serde_json::Value> = sql
        .invalidations
        .iter()
        .map(|((trigger, statement), count)| {
            serde_json::json!({ "trigger": trigger, "statement": statement, "count": count })
        })
        .collect();
    println!(
        "released_window_sample {}",
        serde_json::json!({
            "label": plan.label,
            "history": history,
            "entries": entries,
            "safe_rows": MEASURED_SAFE_ROWS,
            "phase": phase,
            "sample": samples.len(),
            "ms": sample.ms,
            "operations_ms": sample.operations,
            "validations": sample.validations,
            "generation_before": sample.generation.0,
            "generation_after": sample.generation.1,
            "generation_advances": sql.advances,
            "generation_reads": sql.generation_reads.json(),
            "mutations": sql.mutations.json(),
            "commits": sql.commits.json(),
            "other_sql": sql.other.json(),
            "unattributed_ms": sample.ms - sql.total().as_secs_f64() * 1000.0,
            "invalidations": invalidations,
        })
    );
    samples.push(sample);
}

/// Print a phase's summary: its timing percentiles, validations, generation
/// changes and mean statement time, and every invalidating statement.
fn summarize(plan: &Plan, scenario: (&str, usize), phase: &str, samples: &[Sample]) {
    let (history, entries) = scenario;
    let p95 = |values: &[f64]| values[(values.len() * 95).div_ceil(100) - 1];
    let mut ms: Vec<f64> = samples.iter().map(|sample| sample.ms).collect();
    ms.sort_by(f64::total_cmp);
    let mut operations: Vec<f64> = samples
        .iter()
        .flat_map(|sample| sample.operations.iter().copied())
        .collect();
    operations.sort_by(f64::total_cmp);
    let count = samples.len() as f64;
    let mean = |spent: fn(&Sql) -> Spent| {
        samples
            .iter()
            .map(|sample| spent(&sample.sql).time.as_secs_f64() * 1000.0)
            .sum::<f64>()
            / count
    };
    let validations: u64 = samples.iter().map(|sample| sample.validations).sum();
    let advances: u64 = samples.iter().map(|sample| sample.sql.advances).sum();
    let moved = samples
        .iter()
        .filter(|sample| sample.generation.0 != sample.generation.1)
        .count();
    println!(
        "released_window_{phase} label={} history={history} entries={entries} safe_rows={MEASURED_SAFE_ROWS} samples={} validations={validations} generation_moved={moved} generation_advances={advances} p50_ms={:.3} p95_ms={:.3} max_ms={:.3} operations={} operation_p95_ms={:.3} operation_max_ms={:.3} mean_generation_reads_ms={:.3} mean_mutations_ms={:.3} mean_commits_ms={:.3} mean_other_sql_ms={:.3}",
        plan.label,
        samples.len(),
        ms[ms.len() / 2],
        p95(&ms),
        ms[ms.len() - 1],
        operations.len(),
        p95(&operations),
        operations[operations.len() - 1],
        mean(|sql| sql.generation_reads),
        mean(|sql| sql.mutations),
        mean(|sql| sql.commits),
        mean(|sql| sql.other),
    );
    let mut invalidations: BTreeMap<&(String, String), u64> = BTreeMap::new();
    for sample in samples {
        for (by, count) in &sample.sql.invalidations {
            *invalidations.entry(by).or_default() += count;
        }
    }
    for ((trigger, statement), count) in invalidations {
        println!(
            "released_window_{phase}_invalidation label={} history={history} entries={entries} count={count} trigger={trigger} statement={statement}",
            plan.label
        );
    }
}

/// Sol's tails-cache ruling 3: what released-window protection costs as the
/// released tail's history grows, fully proven or a long list of retained
/// work that protects the lineage. For each history: `protection` decided
/// with no kept tails and with them; then complete hosted passes of
/// [`MEASURED_SAFE_ROWS`] safe rows and a held row the pass retries, with
/// the empty cache a restart leaves, with the actor's kept tails, after a
/// tail input changes, and beside creates of [`UNRELATED_DOCUMENTS`]
/// unrelated documents. Every sample prints a JSON record of its time to its
/// end, the time of each uninterrupted actor operation it took, the tails
/// scans it ran, the window's generation and the statements behind it;
/// [`Plan`] reads the scenarios. Run in a release build:
/// `cargo test --release -p dohc-engine-runtime --test owner_publication
/// measure_released_window_protection -- --ignored --nocapture --test-threads=1`.
#[tokio::test]
#[ignore = "manual release-build protection timing"]
async fn measure_released_window_protection() {
    let plan = Plan::from_env();
    for &applied in &plan.histories {
        let history = if applied { "proven" } else { "protected" };
        for &entries in &plan.entries {
            let scenario = (history, entries);
            let mut w = retained_window(Retained::Carried).await;
            retained_history(&w, entries, applied);
            trace(&w.store, true);
            let incoming = IncomingCoordinate {
                relay_namespace: Some("relay".into()),
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
                origin_id: "measure".into(),
                origin_seq: 0,
                relay_seq: 1,
            };
            let key = window_key();
            let protection_key = ProtectionKey {
                doc: &key,
                lineage_claim_id: &w.lineage,
                incoming: &incoming,
            };
            let decide = |store: &mut EngineStore, tails: &mut _| {
                let Protection::Protected { binding, .. } =
                    measured_protection(store, &protection_key, tails)
                else {
                    panic!("protected");
                };
                let ProtectedTails::Listed(tails) =
                    std::borrow::Borrow::<ProtectedTails>::borrow(&binding.tails)
                else {
                    panic!("listed");
                };
                let listed: usize = tails
                    .iter()
                    .map(|tail| match &tail.coverage {
                        RetainedCoverage::Unproven(unproven) => unproven.len(),
                        RetainedCoverage::Invalid => panic!("readable"),
                    })
                    .sum();
                assert_eq!(listed, if applied { 1 } else { entries + 1 });
            };
            let mut phases: Vec<(&str, Vec<Sample>)> = Vec::new();
            let mut cold = Vec::new();
            for _ in 0..plan.passes {
                let mut tails = measured_tails(&w.store);
                let (measured, ()) = sample(&mut w.store, |store| decide(store, &mut tails));
                record(&plan, scenario, "protection_cold", &mut cold, measured);
            }
            phases.push(("protection_cold", cold));
            let mut kept = measured_tails(&w.store);
            decide(&mut w.store, &mut kept);
            let mut warm = Vec::new();
            for _ in 0..plan.passes {
                let (measured, ()) = sample(&mut w.store, |store| decide(store, &mut kept));
                record(&plan, scenario, "protection_warm", &mut warm, measured);
            }
            phases.push(("protection_warm", warm));
            // After a restart the actor's cache starts empty.
            let mut placed = Vec::new();
            let mut restart = Vec::new();
            for index in 0..plan.passes {
                let mut cache = dohc_engine_collab::WriterDocCache::new();
                let name = format!("restart-{index}");
                let measured = measured_pass(&mut w, &mut cache, &mut placed, &name, 0);
                record(&plan, scenario, "pass_restart", &mut restart, measured);
            }
            phases.push(("pass_restart", restart));
            let mut cache = dohc_engine_collab::WriterDocCache::new();
            measured_pass(&mut w, &mut cache, &mut placed, "warming", 0);
            for (phase, unrelated, invalidate) in [
                ("pass_warm", 0, false),
                ("pass_invalidated", 0, true),
                ("pass_warm_unrelated", UNRELATED_DOCUMENTS, false),
            ] {
                let mut samples = Vec::new();
                for index in 0..plan.passes {
                    if invalidate {
                        write_unchecked(
                            &w,
                            "UPDATE live_owner_activations SET source_byte_length=source_byte_length",
                        );
                    }
                    let name = format!("{phase}-{index}");
                    let measured = measured_pass(&mut w, &mut cache, &mut placed, &name, unrelated);
                    record(&plan, scenario, phase, &mut samples, measured);
                }
                phases.push((phase, samples));
            }
            for (phase, samples) in &phases {
                summarize(&plan, scenario, phase, samples);
            }
            trace(&w.store, false);
            w.close().await;
        }
    }
}
