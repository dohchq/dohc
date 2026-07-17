//! Shared test scaffolding: a fresh engine store with the Y.Doc parent rows
//! seeded, the real-yjs fixture loader, and a one-shot crash injector.

#![allow(dead_code)]

use std::path::PathBuf;

use base64::Engine as _;
use dohc_engine_collab::{CollabError, DocKey};
use dohc_engine_storage::{
    EngineStore, FaultAction, FaultInjector, FaultPoint, NoFaults, TxnOutcome,
};
use serde::Deserialize;

/// A temp engine.db that removes itself on drop.
pub struct TempStore {
    pub store: EngineStore,
    dir: PathBuf,
}

impl Drop for TempStore {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn unique_dir(tag: &str) -> PathBuf {
    let mut base = std::env::temp_dir();
    let unique = format!(
        "dohc-r11a-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    base.push(unique);
    std::fs::create_dir_all(&base).expect("mkdir temp");
    base
}

/// Open a fresh store at a unique temp path.
pub fn fresh_store(tag: &str) -> TempStore {
    let dir = unique_dir(tag);
    let store = EngineStore::open(&dir.join("engine.db"), 1_000).expect("open store");
    TempStore { store, dir }
}

/// Open a store at an explicit dir (crash tests manage the dir lifetime by hand
/// so a `drop` can close the connection without deleting the file).
pub fn open_at(dir: &std::path::Path, now_ms: i64) -> EngineStore {
    EngineStore::open(&dir.join("engine.db"), now_ms).expect("open store")
}

/// Reopen a store at the same path (crash-recovery / kill-reopen path).
pub fn reopen(dir: &std::path::Path) -> EngineStore {
    EngineStore::open(&dir.join("engine.db"), 2_000).expect("reopen store")
}

pub fn test_key() -> DocKey {
    DocKey::new("ws-1", "ver-1", "obj-1").expect("key")
}

/// Seed the FK parent rows a `ydoc_docs` marker requires: the workspace and the
/// file object.
pub fn seed_parents(store: &mut EngineStore, key: &DocKey, now_ms: i64) {
    let outcome = store
        .write_with(&NoFaults, |tx| -> Result<(), CollabError> {
            tx.execute(
                "INSERT INTO versioned_workspaces (workspace_id, main_version_id) \
                 VALUES (?1, ?2) ON CONFLICT(workspace_id) DO NOTHING",
                rusqlite::params![key.workspace_id, key.version_id],
            )
            .map_err(sql_err)?;
            tx.execute(
                "INSERT INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES (?1, ?2, ?3) ON CONFLICT(workspace_id, object_id) DO NOTHING",
                rusqlite::params![key.workspace_id, key.object_id, now_ms],
            )
            .map_err(sql_err)?;
            Ok(())
        })
        .expect("seed parents");
    assert!(matches!(outcome, TxnOutcome::Committed(())));
}

fn sql_err(e: rusqlite::Error) -> CollabError {
    CollabError::Corrupt {
        reason: e.to_string(),
    }
}

/// Count rows in a ydoc table for a key (test assertions on prune/no-prune).
pub fn count(store: &EngineStore, table: &str, key: &DocKey) -> i64 {
    store
        .read_with(|conn| -> Result<i64, CollabError> {
            let sql = format!(
                "SELECT COUNT(*) FROM {table} \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3"
            );
            conn.query_row(
                &sql,
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |r| r.get(0),
            )
            .map_err(sql_err)
        })
        .expect("count")
}

pub fn decode_b64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .expect("b64 decode")
}

// ---- fixtures ---------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct Fixture {
    pub seed: i64,
    #[serde(rename = "contentKind")]
    pub content_kind: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub updates: Vec<String>,
    #[serde(default, rename = "baseUpdateB64")]
    pub base_update_b64: Option<String>,
    #[serde(default, rename = "mergedUpdateB64")]
    pub merged_update_b64: Option<String>,
    pub expected: serde_json::Value,
}

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

#[derive(Deserialize)]
struct Manifest {
    fixtures: Vec<String>,
}

/// Every committed fixture, in manifest order.
pub fn load_all_fixtures() -> Vec<Fixture> {
    let dir = fixtures_dir();
    let manifest: Manifest =
        serde_json::from_slice(&std::fs::read(dir.join("_manifest.json")).expect("read manifest"))
            .expect("parse manifest");
    manifest
        .fixtures
        .iter()
        .map(|name| {
            serde_json::from_slice(&std::fs::read(dir.join(name)).expect("read fixture"))
                .unwrap_or_else(|e| panic!("parse fixture {name}: {e}"))
        })
        .collect()
}

/// Load one named fixture (`offsetProbe`, `nestedFrontmatter`, …).
pub fn load_fixture(name: &str) -> Fixture {
    let path = fixtures_dir().join(format!("{name}.json"));
    serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|e| panic!("read {name}: {e}")))
        .unwrap_or_else(|e| panic!("parse {name}: {e}"))
}

// ---- crash injector ---------------------------------------------------------

use std::sync::atomic::{AtomicBool, Ordering};

/// Fires [`FaultAction::Crash`] the first time the armed point is polled.
pub struct OneShotCrash {
    point: FaultPoint,
    armed: AtomicBool,
}

impl OneShotCrash {
    pub fn at(point: FaultPoint) -> Self {
        OneShotCrash {
            point,
            armed: AtomicBool::new(true),
        }
    }
}

impl FaultInjector for OneShotCrash {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == self.point && self.armed.swap(false, Ordering::AcqRel) {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}
