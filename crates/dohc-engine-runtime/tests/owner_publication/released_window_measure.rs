//! The paired release measurement of released-window protection. Every
//! revision it compares carries this file unchanged, so fixtures, sample
//! progression and instrumentation match; each revision's own
//! `owner_publication.rs` supplies how a decision, a pull and the commit
//! that completes a pass run to their end, through [`measured_protection`],
//! [`measured_pull`] and [`measured_commit`], which time each actor
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

/// The tail input each invalidated pass's setup changes, to itself.
const INVALIDATION: &str =
    "UPDATE live_owner_activations SET source_byte_length=source_byte_length";

/// `count` acknowledged entries of the released tail's outbox, after the
/// retained one. Applied here, they are native entries, the proven history a
/// long-lived lineage keeps; never applied, each is retained work that
/// protects it, and claims no native source, which only a journal row it
/// lacks could prove. Written past the store's checks, each still reads as
/// valid.
pub(super) fn retained_history(w: &RetainedWindow, count: usize, applied: bool) {
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
            let json = applied.then(|| serde_json::to_string(&source).unwrap());
            let delivery_id = format!("history-{index}");
            let append_key = json.as_ref().map_or_else(
                || delivery_id.clone(),
                |json| format!("adopted-local:{}", hex_sha256(json.as_bytes())),
            );
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
                    append_key,
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

fn ms(time: Duration) -> f64 {
    time.as_secs_f64() * 1000.0
}

/// Statements of one class, each timed from its first step to its reset.
/// The time is inclusive: it covers the triggers a statement fired and
/// whatever its caller did between its steps, so one statement's time can
/// contain another's, and no sum of classes is a share of the segment.
#[derive(Debug, Default, Clone, Copy)]
struct Spent {
    count: u64,
    time: Duration,
}

impl Spent {
    fn json(self) -> serde_json::Value {
        serde_json::json!({ "count": self.count, "inclusive_ms": ms(self.time) })
    }
}

/// What one connection ran while a segment was taken, from SQLite's
/// statement trace, by each statement's leading keyword.
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
    fn json(&self) -> serde_json::Value {
        let invalidations: Vec<serde_json::Value> = self
            .invalidations
            .iter()
            .map(|((trigger, statement), count)| {
                serde_json::json!({ "trigger": trigger, "statement": statement, "count": count })
            })
            .collect();
        serde_json::json!({
            "generation_reads": self.generation_reads.json(),
            "mutations": self.mutations.json(),
            "commits": self.commits.json(),
            "other": self.other.json(),
            "generation_advances": self.advances,
            "invalidations": invalidations,
        })
    }
}

/// What each connection a segment used ran.
#[derive(Debug, Default)]
struct Traced {
    /// The store's connection; for a setup, the connection it writes on.
    store: Sql,
    /// The connections tails validation opened of its own.
    readers: Sql,
    readers_opened: u64,
    /// The actor's own connection, which materializes a pass's changes.
    actor: Sql,
}

/// The trace of the segment being taken; none between segments.
static TRACED: Mutex<Option<Traced>> = Mutex::new(None);

#[derive(Clone, Copy)]
enum Link {
    Store,
    Readers,
    Actor,
}

fn traced(link: Link, event: TraceEvent<'_>) {
    let mut traced = TRACED.lock().unwrap();
    let Some(traced) = traced.as_mut() else {
        return;
    };
    let sql = match link {
        Link::Store => &mut traced.store,
        Link::Readers => &mut traced.readers,
        Link::Actor => &mut traced.actor,
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

fn traced_store(event: TraceEvent<'_>) {
    traced(Link::Store, event);
}

fn traced_readers(event: TraceEvent<'_>) {
    traced(Link::Readers, event);
}

fn traced_actor(event: TraceEvent<'_>) {
    traced(Link::Actor, event);
}

fn trace_on(conn: &rusqlite::Connection, callback: fn(TraceEvent<'_>)) {
    conn.trace_v2(
        TraceEventCodes::SQLITE_TRACE_STMT | TraceEventCodes::SQLITE_TRACE_PROFILE,
        Some(callback),
    );
}

fn trace_off(conn: &rusqlite::Connection) {
    conn.trace_v2(TraceEventCodes::empty(), None);
}

/// Trace a connection tails validation opened.
fn trace_reader(conn: &rusqlite::Connection) {
    if let Some(traced) = TRACED.lock().unwrap().as_mut() {
        traced.readers_opened += 1;
    }
    trace_on(conn, traced_readers);
}

fn trace_actor(conn: &rusqlite::Connection) {
    trace_on(conn, traced_actor);
}

/// Trace the store's connection, the actor's and every connection tails
/// validation opens, or stop.
async fn trace(w: &RetainedWindow, on: bool) {
    w.store
        .read_with(|conn| {
            if on {
                trace_on(conn, traced_store);
            } else {
                trace_off(conn);
            }
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    on_released_tail_reader(on.then_some(trace_reader as fn(&rusqlite::Connection)));
    w.actor
        .on_connection(if on { trace_actor } else { trace_off })
        .await
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

/// The actor operations of the segment being taken, in milliseconds.
static OPERATIONS: Mutex<Vec<f64>> = Mutex::new(Vec::new());

/// Run `work` as one uninterrupted actor operation of the segment being
/// taken, timed whole.
pub(super) fn operation<T>(work: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let done = work();
    OPERATIONS.lock().unwrap().push(ms(started.elapsed()));
    done
}

/// One timed part of a sample: its time, each uninterrupted actor operation
/// it took, the tails scans the process ran meanwhile, and what each traced
/// connection ran.
struct Segment {
    ms: f64,
    operations: Vec<f64>,
    tail_scans: u64,
    sql: Traced,
}

impl Segment {
    fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "ms": self.ms,
            "operations_ms": self.operations,
            "tail_scans": self.tail_scans,
            "store": self.sql.store.json(),
            "readers": self.sql.readers.json(),
            "readers_opened": self.sql.readers_opened,
            "actor": self.sql.actor.json(),
        })
    }

    /// Each advance a traced connection made.
    fn invalidations(&self) -> impl Iterator<Item = (&'static str, &(String, String), u64)> {
        [
            ("store", &self.sql.store),
            ("readers", &self.sql.readers),
            ("actor", &self.sql.actor),
        ]
        .into_iter()
        .flat_map(|(link, sql)| {
            sql.invalidations
                .iter()
                .map(move |(by, count)| (link, by, *count))
        })
    }
}

/// The clock, scan count, operations and trace of the segment being taken.
struct Clock {
    started: Instant,
    scans: u64,
}

impl Clock {
    fn start() -> Self {
        *TRACED.lock().unwrap() = Some(Traced::default());
        OPERATIONS.lock().unwrap().clear();
        Self {
            scans: released_tail_scans(),
            started: Instant::now(),
        }
    }

    /// The segment so far, and the clock of the next, which starts as this
    /// one ends, so consecutive segments add up to their wall time.
    fn lap(self) -> (Segment, Self) {
        let ended = Instant::now();
        let scans = released_tail_scans();
        let sql = TRACED.lock().unwrap().replace(Traced::default()).unwrap();
        let segment = Segment {
            ms: ms(ended - self.started),
            operations: std::mem::take(&mut *OPERATIONS.lock().unwrap()),
            tail_scans: scans - self.scans,
            sql,
        };
        (
            segment,
            Self {
                started: ended,
                scans,
            },
        )
    }

    fn stop(self) -> Segment {
        let (segment, _) = self.lap();
        *TRACED.lock().unwrap() = None;
        segment
    }
}

/// One measured pass or decision: its parts in order, and the window
/// document's generation before and after it.
struct Sample {
    segments: Vec<(&'static str, Segment)>,
    generation: (Option<i64>, Option<i64>),
    /// The changes a pass materialized.
    materialized: Option<usize>,
}

impl Sample {
    /// Its wall time: its segments are consecutive.
    fn ms(&self) -> f64 {
        self.segments.iter().map(|(_, segment)| segment.ms).sum()
    }

    fn tail_scans(&self) -> u64 {
        self.segments
            .iter()
            .map(|(_, segment)| segment.tail_scans)
            .sum()
    }

    fn operations(&self) -> impl Iterator<Item = f64> + '_ {
        self.segments
            .iter()
            .flat_map(|(_, segment)| segment.operations.iter().copied())
    }
}

/// One decision on `store`, timed from just before it starts to when it
/// returns.
fn decision(store: &mut EngineStore, work: impl FnOnce(&mut EngineStore)) -> Sample {
    let before = window_generation(store);
    let clock = Clock::start();
    work(store);
    let decision = clock.stop();
    Sample {
        segments: vec![("decision", decision)],
        generation: (before, window_generation(store)),
        materialized: None,
    }
}

/// The setup of an invalidated pass: [`INVALIDATION`] written past the
/// store's checks on a connection of its own, timed and traced apart from
/// the pass, with the window document's generation before and after.
struct Setup {
    write: Segment,
    generation: (Option<i64>, Option<i64>),
}

fn invalidate(w: &RetainedWindow) -> Setup {
    let before = window_generation(&w.store);
    let raw = rusqlite::Connection::open(engine_db_path(&w.root).unwrap()).unwrap();
    raw.execute_batch("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON")
        .unwrap();
    trace_on(&raw, traced_store);
    let clock = Clock::start();
    raw.execute_batch(INVALIDATION).unwrap();
    let write = clock.stop();
    drop(raw);
    Setup {
        write,
        generation: (before, window_generation(&w.store)),
    }
}

/// What the relay keeps across a scenario's passes: every row a pass
/// applied, and where it places the next row. A held row is served only by
/// the pass that holds it, so each pass's document reads its own rows from
/// where the last commit left it.
struct Relay {
    placed: Vec<dohc_engine_sync::ReplicationEnvelope>,
    next: i64,
}

/// One complete hosted pass: [`MEASURED_SAFE_ROWS`] rows that apply,
/// `unrelated` creates of other documents beside them, then a row at another
/// path that the pass holds; the materialization of its changes, one actor
/// request; and the commit of its cursor, which holds the document there.
/// `sample_name` keeps each pass's origins apart.
async fn measured_pass(
    w: &mut RetainedWindow,
    cache: &mut dohc_engine_collab::WriterDocCache,
    relay: &mut Relay,
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
    feed.placed = relay.placed.clone();
    feed.first = relay.next;
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
    relay.placed.extend(
        feed.rows
            .lock()
            .unwrap()
            .iter()
            .filter(|op| op.origin_id != held.origin_id)
            .cloned(),
    );
    relay.next = held.relay_seq.unwrap() + 1;
    let client = dohc_engine_sync::RelaySyncClient::new(feed);
    let before = window_generation(&w.store);
    let clock = Clock::start();
    let pass = measured_pull(&mut w.store, &client, cache)
        .unwrap_or_else(|error| panic!("{sample_name}: {error:?}"));
    let (pull, clock) = clock.lap();
    let changes = pass.changed_paths.clone();
    let materialized = changes.len();
    w.actor
        .materialize_relay_page(
            "workspace".into(),
            w.root.path().to_owned(),
            changes,
            Arc::new(()),
            2_000,
            CancellationToken::new(),
        )
        .await
        .unwrap_or_else(|error| panic!("{sample_name}: {error:?}"));
    let (mut materialization, clock) = clock.lap();
    // One actor request, timed as its caller waits for it.
    materialization.operations.push(materialization.ms);
    let commit = measured_commit(
        &client,
        &mut w.store,
        cache,
        pass.pending_cursor.as_ref().unwrap(),
    );
    let completion = clock.stop();
    assert_eq!(
        pass.applied,
        MEASURED_SAFE_ROWS + unrelated,
        "{sample_name}: {:?}",
        pass.pending_cursor
    );
    assert!(
        stopped_before(&pass, &held),
        "{sample_name}: {:?}",
        pass.pending_cursor
    );
    assert!(commit.committed, "{sample_name}: {commit:?}");
    Sample {
        segments: vec![
            ("pull", pull),
            ("materialization", materialization),
            ("completion", completion),
        ],
        generation: (before, window_generation(&w.store)),
        materialized: Some(materialized),
    }
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

/// One scenario's phase, as every record of it names it.
struct Phase<'a> {
    plan: &'a Plan,
    history: &'a str,
    entries: usize,
    name: &'static str,
    unrelated: usize,
}

impl Phase<'_> {
    fn json(&self, sample: usize) -> serde_json::Map<String, serde_json::Value> {
        let serde_json::Value::Object(fields) = serde_json::json!({
            "label": self.plan.label,
            "history": self.history,
            "entries": self.entries,
            "safe_rows": MEASURED_SAFE_ROWS,
            "unrelated": self.unrelated,
            "phase": self.name,
            "sample": sample,
        }) else {
            unreachable!()
        };
        fields
    }

    /// Print one sample as a JSON record, and add it to the phase's.
    fn record(&self, samples: &mut Vec<Sample>, sample: Sample) {
        let mut fields = self.json(samples.len());
        let segments: serde_json::Map<String, serde_json::Value> = sample
            .segments
            .iter()
            .map(|(name, segment)| {
                let mut json = segment.json();
                if *name == "materialization" {
                    json["changes"] = sample.materialized.into();
                }
                ((*name).to_owned(), json)
            })
            .collect();
        fields.extend([
            ("ms".to_owned(), sample.ms().into()),
            (
                "operations_ms".to_owned(),
                sample.operations().collect::<Vec<_>>().into(),
            ),
            ("tail_scans".to_owned(), sample.tail_scans().into()),
            ("generation_before".to_owned(), sample.generation.0.into()),
            ("generation_after".to_owned(), sample.generation.1.into()),
            ("segments".to_owned(), segments.into()),
        ]);
        println!(
            "released_window_sample {}",
            serde_json::Value::Object(fields)
        );
        samples.push(sample);
    }

    /// Print one setup as a JSON record, and add it to the phase's.
    fn record_setup(&self, setups: &mut Vec<Setup>, setup: Setup) {
        let mut fields = self.json(setups.len());
        let delta = setup
            .generation
            .0
            .zip(setup.generation.1)
            .map(|(before, after)| after - before);
        fields.extend([
            ("setup".to_owned(), "invalidation".into()),
            ("statement".to_owned(), INVALIDATION.into()),
            ("generation_before".to_owned(), setup.generation.0.into()),
            ("generation_after".to_owned(), setup.generation.1.into()),
            ("generation_delta".to_owned(), delta.into()),
            (
                "write".to_owned(),
                serde_json::json!({
                    "ms": setup.write.ms,
                    "tail_scans": setup.write.tail_scans,
                    "own": setup.write.sql.store.json(),
                    "readers": setup.write.sql.readers.json(),
                    "readers_opened": setup.write.sql.readers_opened,
                    "actor": setup.write.sql.actor.json(),
                }),
            ),
        ]);
        println!(
            "released_window_setup {}",
            serde_json::Value::Object(fields)
        );
        setups.push(setup);
    }

    /// Print the phase's summary: the nearest-rank percentiles of its
    /// samples' time, of each segment's and of every actor operation they
    /// took, its tails scans and generation changes, and every invalidating
    /// statement a traced connection ran.
    fn summarize(&self, samples: &[Sample], setups: &[Setup]) {
        let rank = |prefix: &str, mut ms: Vec<f64>| {
            ms.sort_by(f64::total_cmp);
            let at = |percent: usize| ms[(ms.len() * percent).div_ceil(100) - 1];
            format!(
                "{prefix}p50_ms={:.3} {prefix}p95_ms={:.3} {prefix}max_ms={:.3}",
                at(50),
                at(95),
                at(100)
            )
        };
        let operations: Vec<f64> = samples.iter().flat_map(Sample::operations).collect();
        let mut line = format!(
            "released_window_{} label={} history={} entries={} safe_rows={MEASURED_SAFE_ROWS} unrelated={} samples={} tail_scans={} generation_moved={} {} operations={} {}",
            self.name,
            self.plan.label,
            self.history,
            self.entries,
            self.unrelated,
            samples.len(),
            samples.iter().map(Sample::tail_scans).sum::<u64>(),
            samples
                .iter()
                .filter(|sample| sample.generation.0 != sample.generation.1)
                .count(),
            rank("", samples.iter().map(Sample::ms).collect()),
            operations.len(),
            rank("operation_", operations),
        );
        for (index, (segment, _)) in samples[0].segments.iter().enumerate() {
            let times = samples
                .iter()
                .map(|sample| sample.segments[index].1.ms)
                .collect();
            line.push_str(&format!(" {}", rank(&format!("{segment}_"), times)));
        }
        println!("{line}");
        let mut invalidations: BTreeMap<(&str, &str, &(String, String)), u64> = BTreeMap::new();
        for sample in samples {
            for (segment, part) in &sample.segments {
                for (link, by, count) in part.invalidations() {
                    *invalidations.entry((*segment, link, by)).or_default() += count;
                }
            }
        }
        for setup in setups {
            for (link, by, count) in setup.write.invalidations() {
                let link = if link == "store" { "own" } else { link };
                *invalidations.entry(("setup", link, by)).or_default() += count;
            }
        }
        for ((segment, link, (trigger, statement)), count) in invalidations {
            println!(
                "released_window_{}_invalidation label={} history={} entries={} segment={segment} connection={link} count={count} trigger={trigger} statement={statement}",
                self.name, self.plan.label, self.history, self.entries
            );
        }
        if !setups.is_empty() {
            // None in a store that keeps no generations.
            let delta = setups
                .iter()
                .filter_map(|setup| setup.generation.0.zip(setup.generation.1))
                .map(|(before, after)| after - before)
                .reduce(|total, delta| total + delta)
                .map_or("none".to_owned(), |delta| delta.to_string());
            println!(
                "released_window_{}_setup label={} history={} entries={} setups={} generation_delta={delta} tail_scans={} {}",
                self.name,
                self.plan.label,
                self.history,
                self.entries,
                setups.len(),
                setups
                    .iter()
                    .map(|setup| setup.write.tail_scans)
                    .sum::<u64>(),
                rank("", setups.iter().map(|setup| setup.write.ms).collect()),
            );
        }
    }
}

/// Sol's tails-cache ruling 3: what released-window protection costs as the
/// released tail's history grows, fully proven or a long list of retained
/// work that protects the lineage. For each history: `protection` decided
/// with no kept tails and with them; then complete hosted passes of
/// [`MEASURED_SAFE_ROWS`] safe rows and a held row, each materialized and
/// committed, with the empty cache a restart leaves, with the actor's kept
/// tails, after a setup write changes a tail input, and beside creates of
/// [`UNRELATED_DOCUMENTS`] unrelated documents. Every sample prints a JSON
/// record of its time, the time of each uninterrupted actor operation it
/// took, the tails scans it ran, the window's generation and the statements
/// behind each part on every traced connection; each setup prints its own.
/// [`Plan`] reads the scenarios. The scan count is the process's, so run
/// this test alone, in a release build:
/// `cargo test --release -p dohc-engine-runtime --test owner_publication --
/// --ignored --exact released_window_measure::measure_released_window_protection
/// --nocapture --test-threads=1`.
#[tokio::test]
#[ignore = "manual release-build protection timing"]
async fn measure_released_window_protection() {
    let plan = Plan::from_env();
    for &applied in &plan.histories {
        let history = if applied { "proven" } else { "protected" };
        for &entries in &plan.entries {
            let phase = |name, unrelated| Phase {
                plan: &plan,
                history,
                entries,
                name,
                unrelated,
            };
            let mut w = retained_window(Retained::Carried).await;
            retained_history(&w, entries, applied);
            trace(&w, true).await;
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
                let listed = measured_protection(store, &protection_key, tails);
                assert_eq!(listed, if applied { 1 } else { entries + 1 });
            };
            let mut phases: Vec<(Phase<'_>, Vec<Sample>, Vec<Setup>)> = Vec::new();
            let cold = phase("protection_cold", 0);
            let mut samples = Vec::new();
            for _ in 0..plan.passes {
                let mut tails = Default::default();
                let measured = decision(&mut w.store, |store| decide(store, &mut tails));
                cold.record(&mut samples, measured);
            }
            phases.push((cold, samples, Vec::new()));
            let mut kept = Default::default();
            decide(&mut w.store, &mut kept);
            let warm = phase("protection_warm", 0);
            let mut samples = Vec::new();
            for _ in 0..plan.passes {
                let measured = decision(&mut w.store, |store| decide(store, &mut kept));
                warm.record(&mut samples, measured);
            }
            phases.push((warm, samples, Vec::new()));
            // After a restart the actor's cache starts empty.
            let mut relay = Relay {
                placed: Vec::new(),
                next: 10,
            };
            let restart = phase("pass_restart", 0);
            let mut samples = Vec::new();
            for index in 0..plan.passes {
                let mut cache = dohc_engine_collab::WriterDocCache::new();
                let name = format!("restart-{index}");
                let measured = measured_pass(&mut w, &mut cache, &mut relay, &name, 0).await;
                restart.record(&mut samples, measured);
            }
            phases.push((restart, samples, Vec::new()));
            let mut cache = dohc_engine_collab::WriterDocCache::new();
            measured_pass(&mut w, &mut cache, &mut relay, "warming", 0).await;
            for (name, unrelated, invalidated) in [
                ("pass_warm", 0, false),
                ("pass_invalidated", 0, true),
                ("pass_warm_unrelated", UNRELATED_DOCUMENTS, false),
            ] {
                let measured_phase = phase(name, unrelated);
                let (mut samples, mut setups) = (Vec::new(), Vec::new());
                for index in 0..plan.passes {
                    if invalidated {
                        measured_phase.record_setup(&mut setups, invalidate(&w));
                    }
                    let sample_name = format!("{name}-{index}");
                    let measured =
                        measured_pass(&mut w, &mut cache, &mut relay, &sample_name, unrelated)
                            .await;
                    measured_phase.record(&mut samples, measured);
                }
                phases.push((measured_phase, samples, setups));
            }
            for (phase, samples, setups) in &phases {
                phase.summarize(samples, setups);
            }
            trace(&w, false).await;
            w.close().await;
        }
    }
}
