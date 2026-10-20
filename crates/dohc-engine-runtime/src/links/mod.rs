//! Persisted derived links. Reads and writes here run only on the owning actor;
//! body integrity checks, parsing and lexical key construction run off it.
pub(crate) mod cache;
mod edges;
pub(crate) mod incoming;
mod parser;
pub(crate) mod query;
pub(crate) mod resolver;
pub(crate) mod rewrite;
#[cfg(test)]
#[path = "link_tests.rs"]
mod tests;
mod worker;

use dohc_engine_storage::text;
use dohc_engine_storage::{EngineStore, FaultInjector, NoFaults, StorageError, TxnOutcome};
use parser::{MAX_DOCUMENT_BYTES, Parsed};
use rusqlite::{Connection, OptionalExtension, params};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
pub(crate) use worker::DrainWorker;
pub use worker::{LinkDrainMetrics, SharedMetrics};

// Generation 2 uses the resolver's all-or-nothing URI decoding for probe keys.
pub const PARSER_GENERATION: i64 = 2;
const ROW_SLICE: usize = 16;
const SOURCE_SLICE: usize = 16;
pub const ACTOR_SLICE_BUDGET: Duration = Duration::from_millis(5);
pub const SETTLE_TO_INDEX_BUDGET: Duration = Duration::from_millis(100);

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
#[derive(Debug, Clone)]
pub struct Work {
    pub id: i64,
    pub revision: i64,
    pub workspace: String,
    pub version: String,
    pub object: String,
    pub queued_at_ms: i64,
}
impl Work {
    fn index_key(&self) -> String {
        format!("{}:{}:{PARSER_GENERATION}", self.id, self.revision)
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub path: String,
    pub hash: String,
    pub kind: String,
    pub byte_length: i64,
    pub text: Option<String>,
    pub aliases: Vec<String>,
    pub unindexed_reason: Option<&'static str>,
}
fn sql(error: rusqlite::Error) -> StorageError {
    StorageError::StateCorrupt {
        source: Some(Box::new(error)),
    }
}
fn head(
    conn: &Connection,
    w: &Work,
    hydrate: bool,
    current_paths: bool,
) -> Result<Option<Head>, StorageError> {
    let aliases = if current_paths {
        "path_aliases"
    } else {
        "link_aliases"
    };
    let mut h = conn.query_row(
        &format!("WITH effective AS (
          SELECT path,blob_sha256,binary_sha256,content_kind FROM snapshots
           WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3
          UNION ALL SELECT path,blob_sha256,binary_sha256,content_kind FROM fork_base_snapshots
           WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3
           AND NOT EXISTS(SELECT 1 FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)
        ) SELECT e.path,COALESCE(e.blob_sha256,e.binary_sha256),e.content_kind,COALESCE(b.byte_length,-1),
          CASE WHEN ?4 AND b.byte_length<=?5 THEN b.sha256 ELSE NULL END
          FROM effective e LEFT JOIN blobs b ON b.sha256=e.blob_sha256
          WHERE EXISTS(SELECT 1 FROM {aliases} WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3) LIMIT 1"),
        params![w.workspace,w.version,w.object,hydrate,MAX_DOCUMENT_BYTES as i64],
        |r| Ok(Head {path:r.get(0)?,hash:r.get(1)?,kind:r.get(2)?,byte_length:r.get(3)?,text:text::optional_from_row(conn, r, 4)?,aliases:Vec::new(),unindexed_reason:None}),
    ).optional().map_err(sql)?;
    if let Some(h) = h.as_mut() {
        if h.kind == "text" && h.byte_length < 0 {
            return Err(StorageError::StateCorrupt { source: None });
        }
        let mut stmt=conn.prepare_cached(&format!("SELECT path FROM {aliases} WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 ORDER BY path LIMIT 65")).map_err(sql)?;
        h.aliases = stmt
            .query_map(params![w.workspace, w.version, w.object], |r| r.get(0))
            .map_err(sql)?
            .collect::<Result<_, _>>()
            .map_err(sql)?;
        if !h.aliases.contains(&h.path)
            && let Some(path) = h.aliases.first()
        {
            h.path = path.clone();
        }
        // Path aliases in production are unique per object. Keep this read
        // bounded and refuse malformed multi-alias input rather than truncate it.
        if h.aliases.len() > 64 {
            return Err(StorageError::InvalidInput {
                reason: "too many link target aliases",
            });
        }
    }
    Ok(h)
}

type Prepared = (Work, Result<Option<Head>, StorageError>);

#[cfg(test)]
pub fn prepare(store: &EngineStore) -> Result<Option<(Work, Option<Head>)>, StorageError> {
    prepare_batch(store, 1)?
        .into_iter()
        .next()
        .map(|(w, h)| h.map(|h| (w, h)))
        .transpose()
}
fn prepare_batch(store: &EngineStore, limit: usize) -> Result<Vec<Prepared>, StorageError> {
    if store.is_passive() {
        return Ok(Vec::new());
    }
    store.read_with(|conn| {
        let began = Instant::now();
        let mut stmt = conn.prepare_cached("SELECT pending_id,revision,workspace_id,version_id,object_id,queued_at_ms FROM link_pending WHERE retry_after_ms<=?1 AND NOT EXISTS(SELECT 1 FROM link_index_state s WHERE s.workspace_id=link_pending.workspace_id AND s.version_id=link_pending.version_id AND s.seed_phase IN ('deferred','aliases')) ORDER BY pending_id LIMIT ?2").map_err(sql)?;
        let work = stmt.query_map(params![now_ms(), limit as i64],|r|Ok(Work {id:r.get(0)?,revision:r.get(1)?,workspace:r.get(2)?,version:r.get(3)?,object:r.get(4)?,queued_at_ms:r.get(5)?})).map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)?;
        let mut jobs = Vec::new();
        let mut hydrated_bytes = 0;
        for w in work {
            let h = (|| {
                let mut h = head(conn,&w,false,false)?;
                if let Some(h)=h.as_mut() {
                    let reason:Option<String>=conn.query_row("SELECT reason FROM link_sources WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND source_hash=?4 AND parser_generation=?5 AND status='unindexed'",params![w.workspace,w.version,w.object,h.hash,PARSER_GENERATION],|r|r.get(0)).optional().map_err(sql)?;
                    h.unindexed_reason=match reason.as_deref(){Some("byte-bound")=>Some("byte-bound"),Some("parse-refused")=>Some("parse-refused"),_=>None};
                }
                if h.as_ref().is_some_and(|h|h.unindexed_reason.is_none()) {h=head(conn,&w,true,false)?;}
                Ok::<_, StorageError>(h)
            })();
            if let Ok(Some(h)) = &h { hydrated_bytes += h.text.as_ref().map_or(0,String::len); }
            jobs.push((w,h));
            if hydrated_bytes >= MAX_DOCUMENT_BYTES || began.elapsed() >= ACTOR_SLICE_BUDGET / 2 { break; }
        }
        Ok(jobs)
    })
}
fn defer_sources(store: &mut EngineStore, work: &[Work]) -> Result<(), StorageError> {
    store.write_with(&NoFaults, |tx| {
        for w in work {
            tx.execute(
                "UPDATE link_pending SET retry_after_ms=?3 WHERE pending_id=?1 AND revision=?2",
                params![w.id, w.revision, now_ms() + 1000],
            )
            .map_err(sql)?;
        }
        Ok::<_, StorageError>(())
    })?;
    Ok(())
}
fn current(conn: &Connection, p: &Parsed) -> Result<bool, StorageError> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM link_pending WHERE pending_id=?1 AND revision=?2)",
            params![p.work.id, p.work.revision],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if !exists {
        return Ok(false);
    }
    let h = head(conn, &p.work, false, false)?;
    Ok(match (&h, &p.head) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            a.path == b.path && a.hash == b.hash && a.kind == b.kind && a.aliases == b.aliases
        }
        _ => false,
    })
}

// These probes are candidate supersets. The resolver checks current aliases
// and resolution precedence; no resolved target is persisted here.
fn normalize_path(path: &str) -> Option<String> {
    let mut parts = Vec::new();
    for p in path.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(p),
        }
    }
    Some(parts.join("/"))
}
fn path_keys(path: &str) -> Vec<(&'static str, String)> {
    let folded = path.to_lowercase();
    let name = path.rsplit('/').next().unwrap_or(path);
    let stem = resolver::without_extension(name);
    let extensionless = resolver::without_extension(path);
    vec![
        ("folded-path", folded),
        ("extensionless", extensionless.to_lowercase()),
        ("stem", stem.to_lowercase()),
    ]
}
fn occurrence_keys(source: &str, literal: &str, kind: &str) -> Vec<(&'static str, String)> {
    let Some(target) = resolver::target(literal) else {
        return Vec::new();
    };
    let directory = source.rsplit_once('/').map_or("", |(d, _)| d);
    let mut keys = Vec::new();
    let paths = if target.starts_with('/') {
        vec![target.trim_start_matches('/').to_owned()]
    } else if kind == "markdown" || target.starts_with("./") || target.starts_with("../") {
        vec![format!("{directory}/{target}")]
    } else if target.contains('/') {
        vec![target.to_owned()]
    } else {
        vec![format!("{directory}/{target}"), target.to_owned()]
    };
    for path in paths {
        if let Some(path) = normalize_path(&path) {
            let name = path.rsplit('/').next().unwrap_or(&path);
            let extensionless = match name.rsplit_once('.') {
                Some((_, ext))
                    if matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdx") =>
                {
                    &path[..path.len() - ext.len() - 1]
                }
                _ => &path,
            };
            keys.extend([
                ("folded-path", path.to_lowercase()),
                ("extensionless", extensionless.to_lowercase()),
                ("extensionless", path.to_lowercase()),
                ("stem", name.to_lowercase()),
                (
                    "stem",
                    extensionless
                        .rsplit('/')
                        .next()
                        .unwrap_or(extensionless)
                        .to_lowercase(),
                ),
            ]);
        }
    }
    keys.sort();
    keys.dedup();
    keys
}

pub struct Staged {
    pub parsed: Parsed,
    rows: Vec<(parser::Occurrence, Vec<(&'static str, String)>)>,
    targets: Vec<(&'static str, String)>,
    offset: usize,
    target_offset: usize,
}
impl Staged {
    // Called on the parser thread, never on the actor.
    pub fn new(parsed: Parsed) -> Self {
        let rows = parsed
            .occurrences
            .iter()
            .cloned()
            .map(|o| {
                let keys = occurrence_keys(
                    parsed.head.as_ref().map_or("", |h| h.path.as_str()),
                    &o.literal,
                    o.kind,
                );
                (o, keys)
            })
            .collect();
        let mut targets = parsed.head.as_ref().map_or_else(Vec::new, |h| {
            h.aliases.iter().flat_map(|a| path_keys(a)).collect()
        });
        targets.sort();
        targets.dedup();
        Self {
            parsed,
            rows,
            targets,
            offset: 0,
            target_offset: 0,
        }
    }
    fn step_in_tx(
        &self,
        tx: &rusqlite::Transaction<'_>,
        began: Instant,
    ) -> Result<(bool, usize, usize), StorageError> {
        let p = &self.parsed;
        let w = &p.work;
        let key = w.index_key();
        let start = self.offset;
        let target_start = self.target_offset;

        if !current(tx, p)? {
            return Ok((true, start, target_start));
        }
        tx.execute(
            "INSERT OR IGNORE INTO link_gc VALUES(?1,?2,?3,?4)",
            params![w.workspace, w.version, w.object, key],
        )
        .map_err(sql)?;
        let mut insert_link = tx
            .prepare_cached(
                "INSERT OR REPLACE INTO links VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            )
            .map_err(sql)?;
        let mut insert_occurrence_key = tx
            .prepare_cached(
                "INSERT OR IGNORE INTO link_occurrence_keys VALUES(?1,?2,?3,?4,?5,?6,?7)",
            )
            .map_err(sql)?;

        let mut end = start;
        for (ordinal, (o, keys)) in self.rows.iter().enumerate().skip(start).take(ROW_SLICE) {
            insert_link
                .execute(params![
                    w.workspace,
                    w.version,
                    w.object,
                    key,
                    ordinal as i64,
                    o.literal,
                    o.kind,
                    o.fragment,
                    o.start_utf16 as i64,
                    o.end_utf16 as i64,
                    o.line as i64,
                    o.snippet
                ])
                .map_err(sql)?;
            for (kind, value) in keys {
                insert_occurrence_key
                    .execute(params![
                        w.workspace,
                        w.version,
                        w.object,
                        key,
                        ordinal as i64,
                        kind,
                        value
                    ])
                    .map_err(sql)?;
            }
            end = ordinal + 1;
            if began.elapsed() >= ACTOR_SLICE_BUDGET / 2 {
                break;
            }
        }
        if end < self.rows.len() {
            return Ok((false, end, target_start));
        }
        let mut insert_target_key = tx
            .prepare_cached("INSERT OR IGNORE INTO link_target_keys VALUES(?1,?2,?3,?4,?5,?6)")
            .map_err(sql)?;
        let mut target_end = target_start;
        for (kind, value) in self.targets.iter().skip(target_start).take(ROW_SLICE) {
            insert_target_key
                .execute(params![w.workspace, w.version, w.object, key, kind, value])
                .map_err(sql)?;
            target_end += 1;
            if began.elapsed() >= ACTOR_SLICE_BUDGET / 2 {
                break;
            }
        }
        if target_end < self.targets.len() {
            return Ok((false, end, target_end));
        }
        tx.execute("INSERT OR IGNORE INTO link_gc SELECT workspace_id,version_id,object_id,index_key FROM link_sources WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![w.workspace,w.version,w.object]).map_err(sql)?;
        if let Some(h) = &p.head {
            tx.execute("INSERT INTO link_sources VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET source_hash=excluded.source_hash,path=excluded.path,title=excluded.title,parser_generation=excluded.parser_generation,status=excluded.status,reason=excluded.reason,index_key=excluded.index_key",params![w.workspace,w.version,w.object,h.hash,h.path,p.title,PARSER_GENERATION,if p.reason.is_some(){"unindexed"}else{"indexed"},p.reason,key]).map_err(sql)?;
        } else {
            tx.execute(
                "DELETE FROM link_sources WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![w.workspace, w.version, w.object],
            )
            .map_err(sql)?;
        }
        tx.execute("DELETE FROM link_gc WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND index_key=?4 AND EXISTS(SELECT 1 FROM link_sources WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND index_key=?4)",params![w.workspace,w.version,w.object,key]).map_err(sql)?;
        tx.execute(
            "DELETE FROM link_pending WHERE pending_id=?1 AND revision=?2",
            params![w.id, w.revision],
        )
        .map_err(sql)?;
        Ok::<_, StorageError>((true, end, target_end))
    }

    #[cfg(test)]
    pub fn step(
        &mut self,
        store: &mut EngineStore,
        faults: &dyn FaultInjector,
    ) -> Result<bool, StorageError> {
        let began = Instant::now();
        match store.write_with(faults, |tx| self.step_in_tx(tx, began))? {
            TxnOutcome::Committed((done, end, target_end)) => {
                self.offset = end;
                self.target_offset = target_end;
                Ok(done)
            }
            TxnOutcome::Crashed { .. } => Ok(true),
        }
    }
}

fn stage_batch(
    staged: &mut std::collections::VecDeque<Staged>,
    store: &mut EngineStore,
    faults: &dyn FaultInjector,
) -> Result<Vec<Work>, StorageError> {
    let began = Instant::now();
    let mut failed_source = None;
    let outcome = store.write_with(faults, |tx| {
        let mut results = Vec::new();
        for item in staged.iter().take(SOURCE_SLICE) {
            let (done, end, target_end) = match item.step_in_tx(tx, began) {
                Ok(progress) => progress,
                Err(error) => {
                    failed_source = Some(item.parsed.work.clone());
                    return Err(error);
                }
            };
            let certified = done && tx.query_row("SELECT EXISTS(SELECT 1 FROM link_sources WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND index_key=?4)", params![item.parsed.work.workspace,item.parsed.work.version,item.parsed.work.object,item.parsed.work.index_key()], |r|r.get::<_,bool>(0)).map_err(sql)?;
            results.push((done, end, target_end, certified));
            if !done || began.elapsed() >= ACTOR_SLICE_BUDGET / 2 { break; }
        }
        Ok::<_, StorageError>(results)
    });
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            if let Some(work) = failed_source {
                let _ = defer_sources(store, &[work]);
            }
            return Err(error);
        }
    };
    let mut certified = Vec::new();
    if let TxnOutcome::Committed(results) = outcome {
        for (done, end, target_end, was_certified) in results {
            let item = staged.front_mut().expect("staged transaction input");
            item.offset = end;
            item.target_offset = target_end;
            if done {
                let item = staged.pop_front().expect("completed transaction input");
                if was_certified {
                    certified.push(item.parsed.work);
                }
            }
        }
    }
    Ok(certified)
}

pub fn gc_step(store: &mut EngineStore) -> Result<bool, StorageError> {
    if store.is_passive() {
        return Ok(false);
    }
    if !store
        .read_with(|c| {
            c.query_row("SELECT EXISTS(SELECT 1 FROM link_gc)", [], |r| {
                r.get::<_, bool>(0)
            })
        })
        .map_err(sql)?
    {
        return Ok(false);
    }
    let outcome=store.write_with(&NoFaults,|tx| {
        let work=tx.query_row("SELECT workspace_id,version_id,object_id,index_key FROM link_gc LIMIT 1",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).optional().map_err(sql)?;
        let Some((ws,v,o,k))=work else {return Ok(false);};
        for statement in [
            "DELETE FROM link_occurrence_keys WHERE rowid IN (SELECT rowid FROM link_occurrence_keys WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND index_key=?4 LIMIT 32)",
            "DELETE FROM links WHERE rowid IN (SELECT rowid FROM links WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND index_key=?4 LIMIT 32)",
            "DELETE FROM link_target_keys WHERE rowid IN (SELECT rowid FROM link_target_keys WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND index_key=?4 LIMIT 32)",
        ] {
            let n=tx.execute(statement,params![ws,v,o,k]).map_err(sql)?;
            if n>0 {return Ok(true);}
        }
        tx.execute("DELETE FROM link_gc WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND index_key=?4",params![ws,v,o,k]).map_err(sql)?;
        Ok::<_,StorageError>(true)
    })?;
    Ok(matches!(outcome, TxnOutcome::Committed(true)))
}

pub fn reseed_step(store: &mut EngineStore) -> Result<bool, StorageError> {
    if store.is_passive() {
        return Ok(false);
    }
    if !store
        .read_with(|c| {
            c.query_row(
                "SELECT EXISTS(SELECT 1 FROM link_index_state WHERE parser_generation<>?1)",
                [PARSER_GENERATION],
                |r| r.get::<_, bool>(0),
            )
        })
        .map_err(sql)?
    {
        return Ok(false);
    }
    let outcome=store.write_with(&NoFaults,|tx| {
        let state=tx.query_row("SELECT workspace_id,version_id,seed_after_object_id FROM link_index_state WHERE parser_generation<>?1 LIMIT 1",[PARSER_GENERATION],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional().map_err(sql)?;
        let Some((ws,v,after))=state else{return Ok(false);};
        let mut stmt=tx.prepare("SELECT a.object_id,EXISTS(SELECT 1 FROM link_sources s WHERE s.workspace_id=a.workspace_id AND s.version_id=a.version_id AND s.object_id=a.object_id AND s.parser_generation=?4) FROM link_aliases a WHERE a.workspace_id=?1 AND a.version_id=?2 AND a.object_id>?3 ORDER BY a.object_id LIMIT 32").map_err(sql)?;
        let objects=stmt.query_map(params![ws,v,after,PARSER_GENERATION],|r|Ok((r.get::<_,String>(0)?,r.get::<_,bool>(1)?))).map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)?;
        let mut previous = None;
        for (o,current) in &objects {
            if previous == Some(o) { continue; }
            previous = Some(o);
            if *current { continue; }
            tx.execute("INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) VALUES(?1,?2,?3,?4) ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1,queued_at_ms=excluded.queued_at_ms,retry_after_ms=0",params![ws,v,o,now_ms()]).map_err(sql)?;
        }
        if let Some((last,_))=objects.last() {
            tx.execute("UPDATE link_index_state SET seed_after_object_id=?3 WHERE workspace_id=?1 AND version_id=?2",params![ws,v,last]).map_err(sql)?;
        } else {
            tx.execute("UPDATE link_index_state SET parser_generation=?3,seed_after_object_id='' WHERE workspace_id=?1 AND version_id=?2",params![ws,v,PARSER_GENERATION]).map_err(sql)?;
        }
        Ok::<_,StorageError>(true)
    })?;
    Ok(matches!(outcome, TxnOutcome::Committed(true)))
}

// Only the drain calls this seam, after capture holds release. Path order uses
// the authoritative primary key; each transaction visits at most 32 aliases.
// Once scanning starts, edit triggers cover changes behind the durable cursor.
fn seed_step(store: &mut EngineStore) -> Result<bool, StorageError> {
    seed_step_with(store, &NoFaults)
}
fn seed_step_with(
    store: &mut EngineStore,
    faults: &dyn FaultInjector,
) -> Result<bool, StorageError> {
    if store.is_passive() {
        return Ok(false);
    }
    let needed = store
        .read_with(|c| {
            c.query_row(
        "SELECT EXISTS(SELECT 1 FROM link_index_state WHERE seed_phase IN ('deferred','aliases'))",
        [], |r| r.get::<_, bool>(0))
        })
        .map_err(sql)?;
    if !needed {
        return Ok(false);
    }
    #[cfg(feature = "fault-injection")]
    let mut phase = dohc_engine_storage::capture_phase::Phase::new("link_seed", None, 0, true);
    let outcome = store.write_with(faults, |tx| {
        let state = tx.query_row(
            "SELECT workspace_id,version_id,seed_after_path FROM link_index_state WHERE seed_phase IN ('deferred','aliases') LIMIT 1",
            [], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
            .optional().map_err(sql)?;
        let Some((ws,v,after)) = state else { return Ok(false); };
        tx.execute("UPDATE link_index_state SET parser_generation=CASE WHEN seed_phase='deferred' THEN ?3 ELSE parser_generation END,seed_phase='aliases' WHERE workspace_id=?1 AND version_id=?2",params![ws,v,PARSER_GENERATION]).map_err(sql)?;
        let mut stmt = tx.prepare("SELECT path,object_id FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 AND path>?3 ORDER BY path LIMIT 32").map_err(sql)?;
        let aliases = stmt.query_map(params![ws,v,after], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))
            .map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)?;
        #[cfg(feature = "fault-injection")]
        phase.field("aliases", aliases.len() as u64);
        for (path,object) in &aliases {
            tx.execute("INSERT INTO link_aliases(workspace_id,version_id,object_id,path) VALUES(?1,?2,?3,?4) ON CONFLICT(workspace_id,version_id,path) DO UPDATE SET object_id=excluded.object_id",params![ws,v,object,path]).map_err(sql)?;
            tx.execute("INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) VALUES(?1,?2,?3,?4) ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1,queued_at_ms=excluded.queued_at_ms,retry_after_ms=0",params![ws,v,object,now_ms()]).map_err(sql)?;
        }
        if let Some((last,_)) = aliases.last() {
            tx.execute("UPDATE link_index_state SET seed_after_path=?3 WHERE workspace_id=?1 AND version_id=?2",params![ws,v,last]).map_err(sql)?;
        } else {
            tx.execute("UPDATE link_index_state SET seed_phase=CASE WHEN EXISTS(SELECT 1 FROM link_pending p WHERE p.workspace_id=?1 AND p.version_id=?2) THEN 'draining' ELSE 'ready' END,seed_after_path='' WHERE workspace_id=?1 AND version_id=?2",params![ws,v]).map_err(sql)?;
        }
        Ok::<_, StorageError>(true)
    })?;
    #[cfg(feature = "fault-injection")]
    phase.finish(if matches!(outcome, TxnOutcome::Committed(true)) {
        "committed"
    } else {
        "interrupted"
    });
    Ok(matches!(outcome, TxnOutcome::Committed(true)))
}
