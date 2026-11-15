//! A folder's `access.yaml` reaches the journal before the files it covers.
//!
//! Members see a folder through its rule, and the relay replays moments in
//! origin order. Every file moment passes [`check_moment`], which the sync
//! crate's journal calls before it takes an origin seq, on the actor's one
//! writer thread. For each folder over the moment's path, from the workspace
//! root down, the check compares the rule on disk with the rule last
//! committed there:
//!
//! - the same rule, or none on either side, clears the folder, as does a
//!   committed rule that never reached disk (written without publication);
//! - a rule that narrows or keeps everyone's reach commits first, as its own
//!   moment, once the folder has been quiet for [`ACCESS_RULE_SETTLE`];
//! - a rule that widens anyone's reach, or one removed while the folder still
//!   holds files, commits nothing under the folder and records an
//!   [`access_rule_holds`] row for the owner;
//! - a rule still settling, or one that could not be read, makes the writer
//!   wait ([`ACCESS_RULE_WAITS`]).
//!
//! A rule cannot commit inside another writer's transaction, so a folder that
//! needs one refuses the moment and is judged again, with its commit or hold,
//! when the command ends ([`finish_command`]). So that writers rarely meet
//! that refusal, capture ([`order_capture`]) and the versioned text and
//! binary writes, renames and deletes ([`order_writer`]) run [`order_paths`]
//! before their transaction: it commits a changed rule first. Capture judges
//! the rule bytes it read itself, so a widening it found is held rather than
//! committed. A rule moment no step judged is a change made through dohc and
//! commits as written.
//!
//! The check also keeps the order inside one command: a file under a folder
//! whose rule the command commits waits until that rule's moment, a rule
//! write after files under its folder is refused, and a rule's delete closes
//! its folder for the rest of the command. A rule never moves as a rename.

use super::ActorHandle;
use crate::error::RuntimeError;
use dohc_engine_collab::LeaseRegistry;
use dohc_engine_domain::{CaptureIngest, CaptureIngestBinary, CaptureRetire, DomainError};
use dohc_engine_files::access_rules::{
    ACCESS_RULE_FILE, AccessRule, ReachBefore, access_rule_folder, is_access_rule_path,
    parse_access_rule, rule_change_narrows,
};
use dohc_engine_files::materialize::{PublicationTarget, read_publication_target};
use dohc_engine_storage::access_rule_holds::{self, AccessRuleHold};
use dohc_engine_storage::{EngineStore, FaultInjector, NoFaults, StorageError, TxnOutcome};
use dohc_engine_sync::SyncError;
use rusqlite::{Connection, Transaction, params};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};
use tokio_util::sync::CancellationToken;

/// How long a folder and its rule must go unchanged before a rule change from
/// disk commits. Editors save by writing a copy, deleting the rule and renaming
/// the copy into place; recursive deletes and folder moves remove a rule
/// before or after the files around it. All of these finish well inside two
/// seconds, four times the watcher's 500 ms debounce, so no step of them is
/// read as the folder's settled state. A longer wait only delays a narrowing.
pub const ACCESS_RULE_SETTLE: Duration = Duration::from_secs(2);

/// A retryable refusal: a rule over the path is settling, or reading it
/// failed. Retrying after [`ACCESS_RULE_SETTLE`] judges it again.
pub const ACCESS_RULE_WAITS: &str = "access-rule-waits";

/// A refusal under a folder whose rule waits for its owner.
pub const ACCESS_RULE_HELD: &str = "access-rule-held";

const RULE_METADATA_ORIGIN: &str = "capture";

/// How the running command may journal moments under one folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Clearance {
    /// The rule matches what is committed: anything may journal.
    Open,
    /// The command commits this folder's rule. Nothing else journals under
    /// the folder until the rule's own moment does.
    RuleFirst,
    /// The command deletes this folder's rule. Everything under the folder
    /// journals before that delete; nothing after it.
    RuleLast,
    /// The rule's delete was journaled.
    Closed,
    /// The rule is gone and the folder holds no files on disk: only the
    /// deletes of the files it still records may journal.
    DeletesOnly,
}

type FolderKey = (String, String, String);

#[derive(Default)]
struct Cleared {
    folders: HashMap<FolderKey, Clearance>,
    /// Folders a file moment journaled under in this command.
    used: HashSet<FolderKey>,
    /// Folders to judge again when the command ends, and whether a write
    /// under them was refused.
    deferred: BTreeMap<FolderKey, bool>,
}

/// What a command cleared so far. See [`checkpoint`].
pub(super) struct Checkpoint {
    folders: HashMap<FolderKey, Clearance>,
    used: HashSet<FolderKey>,
}

/// What the ordering step tells capture between its passes.
#[derive(Default, Debug)]
pub struct AccessRuleSignals {
    waits: AtomicU64,
    holds: AtomicU64,
}

impl AccessRuleSignals {
    /// Counts the times a path waited for a rule to settle. When it moves,
    /// capture offers the paths again after [`ACCESS_RULE_SETTLE`].
    pub fn waits(&self) -> u64 {
        self.waits.load(Ordering::Acquire)
    }

    /// Counts the times a folder's hold was recorded or released. When it
    /// moves, capture tells the owner and offers the folder's files again.
    pub fn holds(&self) -> u64 {
        self.holds.load(Ordering::Acquire)
    }
}

thread_local! {
    static CLEARED: RefCell<Cleared> = RefCell::new(Cleared::default());
    static ROOT: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    static SIGNALS: RefCell<Option<Arc<AccessRuleSignals>>> = const { RefCell::new(None) };
}

fn signal(pick: impl FnOnce(&AccessRuleSignals) -> &AtomicU64) {
    SIGNALS.with(|signals| {
        if let Some(signals) = signals.borrow().as_ref() {
            pick(signals).fetch_add(1, Ordering::AcqRel);
        }
    });
}

/// Install the commit-point check on the actor's thread. The workspace root
/// is the folder that holds the store's `.dohc/engine` folder. A store kept
/// anywhere else belongs to no workspace on disk, so it has no rules to order.
pub(super) fn install(db_path: &Path, signals: Arc<AccessRuleSignals>) {
    SIGNALS.with(|cell| *cell.borrow_mut() = Some(signals));
    let root = db_path
        .parent()
        .filter(|engine| engine.file_name().is_some_and(|name| name == "engine"))
        .and_then(Path::parent)
        .filter(|dohc| dohc.file_name().is_some_and(|name| name == ".dohc"))
        .and_then(Path::parent)
        .map(Path::to_path_buf);
    ROOT.with(|cell| *cell.borrow_mut() = root);
    dohc_engine_sync::install_moment_order_check(std::rc::Rc::new(check_moment));
}

fn root() -> Option<PathBuf> {
    ROOT.with(|cell| cell.borrow().clone())
}

/// Forget what the previous command cleared. Every command reads the disk
/// again.
pub(super) fn begin_command() {
    CLEARED.with(|cleared| *cleared.borrow_mut() = Cleared::default());
}

/// What the command cleared so far, for a writer that rolls part of its
/// transaction back.
pub(super) fn checkpoint() -> Checkpoint {
    CLEARED.with(|cleared| {
        let cleared = cleared.borrow();
        Checkpoint {
            folders: cleared.folders.clone(),
            used: cleared.used.clone(),
        }
    })
}

/// Forget what was cleared after `checkpoint`, whose moments rolled back.
/// Folders to judge again stay.
pub(super) fn roll_back(checkpoint: Checkpoint) {
    CLEARED.with(|cleared| {
        let mut cleared = cleared.borrow_mut();
        cleared.folders = checkpoint.folders;
        cleared.used = checkpoint.used;
    });
}

/// Judge again the folders whose moments were refused during the command:
/// commit a rule that now goes first, or record a hold. Runs between
/// commands, so a writer that retries finds the rule committed.
pub(super) fn finish_command(store: &mut EngineStore) {
    let deferred = CLEARED.with(|cleared| std::mem::take(&mut cleared.borrow_mut().deferred));
    let Some(root) = root().filter(|_| !deferred.is_empty()) else {
        return;
    };
    let now_ms = wall_clock_ms();
    let leases = LeaseRegistry::new();
    for ((workspace, version, folder), writes_under) in deferred {
        begin_command();
        let order = Order {
            root: &root,
            workspace_id: &workspace,
            version_id: &version,
            now_ms,
            writer: Writer::Capture,
            leases: &leases,
            faults: &NoFaults,
        };
        // A failure leaves the folder to the writer's next attempt.
        let _ = order_folder(store, &order, &folder, writes_under);
    }
    begin_command();
}

fn wall_clock_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

/// The step a deliberate writer runs before its transaction, so a settled
/// rule on disk commits first and the commit-point check finds its folder
/// cleared. A rule the writer itself writes is deliberate and goes as
/// written.
pub(super) fn order_writer(
    store: &mut EngineStore,
    workspace_id: &str,
    version_id: &str,
    touches: &[Touch<'_>],
) -> Result<(), RuntimeError> {
    let Some(root) = root() else {
        return Ok(());
    };
    let leases = LeaseRegistry::new();
    let order = Order {
        root: &root,
        workspace_id,
        version_id,
        now_ms: wall_clock_ms(),
        writer: Writer::Deliberate,
        leases: &leases,
        faults: &NoFaults,
    };
    order_paths(store, &order, touches)?.into_iter().collect()
}

/// Judge `folder` and the folders above it, from the root down.
fn order_folder(
    store: &mut EngineStore,
    order: &Order<'_>,
    folder: &str,
    writes_under: bool,
) -> Result<Verdict, RuntimeError> {
    let mut verdict = Verdict::Clear(Clearance::Open);
    for above in folders_of(&rule_path(folder)) {
        verdict = judge_one(store, order, above, None, writes_under || above != folder)?;
        if !matches!(verdict, Verdict::Clear(_)) {
            break;
        }
    }
    Ok(verdict)
}

fn key(workspace: &str, version: &str, folder: &str) -> FolderKey {
    (workspace.to_owned(), version.to_owned(), folder.to_owned())
}

fn clearance(workspace: &str, version: &str, folder: &str) -> Option<Clearance> {
    CLEARED.with(|cleared| {
        cleared
            .borrow()
            .folders
            .get(&key(workspace, version, folder))
            .copied()
    })
}

fn set(workspace: &str, version: &str, folder: &str, clearance: Clearance) {
    CLEARED.with(|cleared| {
        cleared
            .borrow_mut()
            .folders
            .insert(key(workspace, version, folder), clearance);
    });
}

/// The folders whose rules govern `path`, from the root down. A rule's own
/// folder is among them.
fn folders_of(path: &str) -> Vec<&str> {
    let parent = access_rule_folder(path);
    let mut folders = vec![""];
    folders.extend(
        parent
            .match_indices('/')
            .map(|(index, _)| &parent[..index])
            .chain((!parent.is_empty()).then_some(parent)),
    );
    folders
}

fn rule_path(folder: &str) -> String {
    if folder.is_empty() {
        ACCESS_RULE_FILE.to_owned()
    } else {
        format!("{folder}/{ACCESS_RULE_FILE}")
    }
}

fn refuse(reason: &'static str) -> SyncError {
    SyncError::InvalidInput { reason }
}

fn retry(reason: &'static str) -> SyncError {
    SyncError::RetryableState { reason }
}

/// The commit-point check every file moment passes. See the module comment.
fn check_moment(
    tx: &Transaction<'_>,
    workspace_id: &str,
    payload: &serde_json::Value,
) -> Result<(), SyncError> {
    let Some(root) = root() else {
        return Ok(());
    };
    let text = |key: &str| payload.get(key).and_then(serde_json::Value::as_str);
    let (Some(version), Some(path)) = (text("versionId"), text("path")) else {
        return Err(refuse("access-rule-unordered"));
    };
    let operation = text("operation").unwrap_or("write");
    let source = text("beforePath").filter(|source| *source != path);
    if operation == "rename"
        && (is_access_rule_path(path) || source.is_some_and(is_access_rule_path))
    {
        return Err(refuse("access-rule-renamed"));
    }
    if let Some(source) = source.filter(|_| operation == "rename") {
        admit(tx, &root, workspace_id, version, source, true)?;
    }
    admit(
        tx,
        &root,
        workspace_id,
        version,
        path,
        operation == "delete",
    )
}

fn admit(
    tx: &Transaction<'_>,
    root: &Path,
    workspace: &str,
    version: &str,
    path: &str,
    deletes: bool,
) -> Result<(), SyncError> {
    let own_rule = is_access_rule_path(path).then(|| access_rule_folder(path));
    for folder in folders_of(path) {
        let is_rule = own_rule == Some(folder);
        let clearance = match clearance(workspace, version, folder) {
            Some(clearance) => clearance,
            None => {
                let clearance =
                    judge_in_tx(tx, root, workspace, version, folder, is_rule, deletes)?;
                set(workspace, version, folder, clearance);
                clearance
            }
        };
        let key = key(workspace, version, folder);
        let used = CLEARED.with(|cleared| cleared.borrow().used.contains(&key));
        let next = match (clearance, is_rule, deletes) {
            // A rule written after files under it reached them too late.
            (Clearance::Open, true, false) if used => return Err(refuse("access-rule-order")),
            (Clearance::Open | Clearance::RuleLast | Clearance::DeletesOnly, true, true) => {
                Clearance::Closed
            }
            (Clearance::Open, _, _) | (Clearance::RuleFirst, true, false) => Clearance::Open,
            (Clearance::RuleLast, false, _) => Clearance::RuleLast,
            (Clearance::DeletesOnly, false, true) => Clearance::DeletesOnly,
            _ => return Err(refuse("access-rule-order")),
        };
        CLEARED.with(|cleared| {
            let mut cleared = cleared.borrow_mut();
            if !is_rule {
                cleared.used.insert(key.clone());
            }
            cleared.folders.insert(key, next);
        });
    }
    Ok(())
}

/// Judge a folder no step cleared, from the writer's own transaction.
fn judge_in_tx(
    tx: &Transaction<'_>,
    root: &Path,
    workspace: &str,
    version: &str,
    folder: &str,
    is_rule: bool,
    deletes: bool,
) -> Result<Clearance, SyncError> {
    if is_rule {
        // Only a change made through dohc journals a rule unjudged.
        return Ok(if deletes {
            Clearance::RuleLast
        } else {
            Clearance::RuleFirst
        });
    }
    let scope = Scope {
        root,
        workspace_id: workspace,
        version_id: version,
        writer: Writer::Capture,
    };
    let plan = judge_folder(tx, &scope, folder, None, !deletes).map_err(|error| match error {
        RuntimeError::Storage(error) => SyncError::Storage(error),
        _ => retry(ACCESS_RULE_WAITS),
    })?;
    let reason = match plan {
        Plan::Verdict(Verdict::Clear(clearance)) => return Ok(clearance),
        Plan::Verdict(Verdict::Held { .. }) => ACCESS_RULE_HELD,
        Plan::Verdict(Verdict::Waits) | Plan::CommitRule(_) => ACCESS_RULE_WAITS,
    };
    CLEARED.with(|cleared| {
        let mut cleared = cleared.borrow_mut();
        let writes = cleared
            .deferred
            .entry(key(workspace, version, folder))
            .or_default();
        *writes |= !deletes;
    });
    if reason == ACCESS_RULE_WAITS {
        signal(|signals| &signals.waits);
    }
    Err(retry(reason))
}

/// A deduped capture journals nothing, but a rule it found already committed
/// still opens its folder for the files after it.
pub(super) fn note_unchanged_rule(workspace: &str, version: &str, path: &str) {
    if !is_access_rule_path(path) {
        return;
    }
    let folder = access_rule_folder(path);
    if clearance(workspace, version, folder) == Some(Clearance::RuleFirst) {
        set(workspace, version, folder, Clearance::Open);
    }
}

/// One path a writer is about to change.
#[derive(Clone, Copy, Debug)]
pub(super) struct Touch<'a> {
    pub path: &'a str,
    pub deletes: bool,
    /// The bytes capture read for a rule it is about to commit. A rule the
    /// writer does not observe is read from disk.
    pub observed: Option<&'a [u8]>,
}

impl<'a> Touch<'a> {
    pub fn delete(path: &'a str) -> Self {
        Self {
            path,
            deletes: true,
            observed: None,
        }
    }

    pub fn write(path: &'a str) -> Self {
        Self {
            path,
            deletes: false,
            observed: None,
        }
    }

    pub fn observed(path: &'a str, bytes: &'a [u8]) -> Self {
        Self {
            path,
            deletes: false,
            observed: Some(bytes),
        }
    }
}

/// Who is changing the paths.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Writer {
    /// Capture, recording what it found on disk. A rule it records is judged
    /// like any rule found on disk.
    Capture,
    /// A change made through dohc: a write, restore, undo, merge or other
    /// operation the owner or their agent asked for. Its own rule changes
    /// commit as written, in order.
    Deliberate,
}

pub(super) struct Order<'a> {
    pub root: &'a Path,
    pub workspace_id: &'a str,
    pub version_id: &'a str,
    pub now_ms: i64,
    pub writer: Writer,
    pub leases: &'a LeaseRegistry,
    pub faults: &'a dyn FaultInjector,
}

impl Order<'_> {
    fn scope(&self) -> Scope<'_> {
        Scope {
            root: self.root,
            workspace_id: self.workspace_id,
            version_id: self.version_id,
            writer: self.writer,
        }
    }
}

/// What judging a folder reads.
struct Scope<'a> {
    root: &'a Path,
    workspace_id: &'a str,
    version_id: &'a str,
    writer: Writer,
}

/// What the step decided for one folder.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Verdict {
    Clear(Clearance),
    Waits,
    Held { reason: &'static str },
}

/// What is on disk at a folder's rule.
enum OnDisk {
    Absent,
    Bytes(Vec<u8>),
}

/// The rule last committed at a folder.
struct Committed {
    sha256: String,
    /// `None` when it is binary or does not parse.
    rule: Option<AccessRule>,
    /// Capture read it from disk, or dohc placed it there. A rule written
    /// without publication lives only in the store, so a disk without it
    /// says nothing about an outside change.
    reached_disk: bool,
}

fn committed_rule(
    conn: &Connection,
    workspace: &str,
    version: &str,
    folder: &str,
) -> Result<Option<Committed>, RuntimeError> {
    let path = rule_path(folder);
    let state = dohc_engine_domain::select_snapshot_by_path_in_tx(conn, workspace, version, &path)?;
    let (sha256, rule) = match (state.snapshot, state.binary_sha256) {
        (Some(snapshot), _) => (snapshot.blob_sha256, parse_access_rule(&snapshot.text)),
        (None, Some(sha256)) => (sha256, None),
        (None, None) => return Ok(None),
    };
    let reached_disk = conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM snapshots WHERE workspace_id=?1 AND version_id=?2              AND path=?3 AND metadata_origin=?5)              OR EXISTS(SELECT 1 FROM materialization_jobs WHERE workspace_id IN (?1,'')              AND target_path=?3 AND content_sha256=?4 AND status='complete')",
        )
        .map_err(StorageError::corrupt_public)?
        .query_row(
            params![workspace, version, path, sha256, dohc_engine_domain::store::CAPTURE_ORIGIN],
            |row| row.get(0),
        )
        .map_err(StorageError::corrupt_public)?;
    Ok(Some(Committed {
        sha256,
        rule,
        reached_disk,
    }))
}

fn read_disk_rule(root: &Path, folder: &str) -> Result<OnDisk, ()> {
    match read_publication_target(root, &rule_path(folder)) {
        Ok(PublicationTarget::Bytes(bytes)) => Ok(OnDisk::Bytes(bytes)),
        // A folder or an oversized file is nothing capture records.
        Ok(PublicationTarget::Absent | PublicationTarget::Untracked) => Ok(OnDisk::Absent),
        Err(_) => Err(()),
    }
}

/// Whether the folder and its rule have gone unchanged for the settle
/// period. A folder that is gone answers for its nearest existing ancestor,
/// whose entry list changed when it went.
fn settled(root: &Path, folder: &str) -> bool {
    let modified = |path: &Path| std::fs::symlink_metadata(path).and_then(|m| m.modified());
    let mut newest = modified(&root.join(rule_path(folder))).ok();
    let mut candidate = Some(folder);
    while let Some(dir) = candidate {
        if let Ok(time) = modified(&root.join(dir)) {
            newest = newest.max(Some(time));
            break;
        }
        candidate = (!dir.is_empty()).then(|| access_rule_folder(dir));
    }
    newest.is_none_or(|time| {
        SystemTime::now()
            .duration_since(time)
            .is_ok_and(|quiet| quiet >= ACCESS_RULE_SETTLE)
    })
}

fn nearest_committed_above(
    conn: &Connection,
    workspace: &str,
    version: &str,
    folder: &str,
) -> Result<Option<Committed>, RuntimeError> {
    let mut above = folder;
    while !above.is_empty() {
        above = access_rule_folder(above);
        if let Some(committed) = committed_rule(conn, workspace, version, above)? {
            return Ok(Some(committed));
        }
    }
    Ok(None)
}

/// Whether a file the store records under `folder`, other than its rule,
/// is still on disk.
fn folder_holds_files(
    conn: &Connection,
    root: &Path,
    workspace: &str,
    version: &str,
    folder: &str,
) -> Result<(bool, bool), RuntimeError> {
    let (low, high) = if folder.is_empty() {
        (String::new(), "\u{10FFFF}".to_owned())
    } else {
        (format!("{folder}/"), format!("{folder}0"))
    };
    let rule = rule_path(folder);
    let mut query = conn
        .prepare_cached(
            "SELECT path FROM snapshots WHERE workspace_id=?1 AND version_id=?2 \
             AND path>=?3 AND path<?4 AND path<>?5",
        )
        .map_err(StorageError::corrupt_public)?;
    let paths = query
        .query_map(params![workspace, version, low, high, rule], |row| {
            row.get::<_, String>(0)
        })
        .map_err(StorageError::corrupt_public)?;
    let mut recorded = false;
    for path in paths {
        let path = path.map_err(StorageError::corrupt_public)?;
        recorded = true;
        if std::fs::symlink_metadata(root.join(&path)).is_ok() {
            return Ok((true, true));
        }
    }
    Ok((recorded, false))
}

fn materialization_pending(
    conn: &Connection,
    workspace: &str,
    folder: &str,
) -> Result<bool, RuntimeError> {
    conn.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM materialization_jobs \
         WHERE workspace_id IN (?1,'') AND target_path=?2 AND status='pending')",
    )
    .map_err(StorageError::corrupt_public)?
    .query_row(params![workspace, rule_path(folder)], |row| row.get(0))
    .map_err(StorageError::corrupt_public)
    .map_err(RuntimeError::from)
}

/// What to do at one folder before the writer's transaction opens.
enum Plan {
    Verdict(Verdict),
    /// Commit the disk's rule first, as its own moment.
    CommitRule(Vec<u8>),
}

fn judge_folder(
    conn: &Connection,
    order: &Scope<'_>,
    folder: &str,
    rule_touch: Option<&Touch<'_>>,
    writes_under: bool,
) -> Result<Plan, RuntimeError> {
    let (workspace, version) = (order.workspace_id, order.version_id);
    if order.writer == Writer::Deliberate
        && let Some(touch) = rule_touch
    {
        let clearance = if touch.deletes {
            Clearance::RuleLast
        } else {
            Clearance::RuleFirst
        };
        return Ok(Plan::Verdict(Verdict::Clear(clearance)));
    }
    if materialization_pending(conn, workspace, folder)? {
        // dohc wrote this rule and its file is on the way to disk.
        return Ok(Plan::Verdict(Verdict::Clear(Clearance::Open)));
    }
    let committed = committed_rule(conn, workspace, version, folder)?;
    let disk = match rule_touch {
        Some(Touch {
            observed: Some(bytes),
            ..
        }) => OnDisk::Bytes(bytes.to_vec()),
        Some(Touch { deletes: true, .. }) => OnDisk::Absent,
        _ => match read_disk_rule(order.root, folder) {
            Ok(disk) => disk,
            Err(()) => return Ok(Plan::Verdict(Verdict::Waits)),
        },
    };
    match (disk, committed) {
        (OnDisk::Absent, None) => Ok(Plan::Verdict(Verdict::Clear(Clearance::Open))),
        (OnDisk::Bytes(bytes), Some(committed))
            if dohc_engine_storage::hex_sha256(&bytes) == committed.sha256 =>
        {
            // Capture records the committed rule again; its moment dedupes.
            Ok(Plan::Verdict(Verdict::Clear(Clearance::Open)))
        }
        (_, Some(committed)) if rule_touch.is_none() && !committed.reached_disk => {
            Ok(Plan::Verdict(Verdict::Clear(Clearance::Open)))
        }
        _ if !settled(order.root, folder) => Ok(Plan::Verdict(Verdict::Waits)),
        (OnDisk::Bytes(bytes), committed) => {
            let next = std::str::from_utf8(&bytes).ok().and_then(parse_access_rule);
            let above = match &committed {
                Some(_) => None,
                None => nearest_committed_above(conn, workspace, version, folder)?,
            };
            let before = match (&committed, &above) {
                (Some(own), _) => ReachBefore::Own(own.rule.as_ref()),
                (None, Some(above)) => ReachBefore::Inherited(above.rule.as_ref()),
                (None, None) => ReachBefore::WorkspaceLevel,
            };
            if !rule_change_narrows(before, next.as_ref()) {
                return Ok(Plan::Verdict(Verdict::Held {
                    reason: access_rule_holds::WIDENED,
                }));
            }
            if rule_touch.is_some() {
                Ok(Plan::Verdict(Verdict::Clear(Clearance::RuleFirst)))
            } else {
                Ok(Plan::CommitRule(bytes))
            }
        }
        (OnDisk::Absent, Some(_)) => {
            let (recorded, on_disk) =
                folder_holds_files(conn, order.root, workspace, version, folder)?;
            if on_disk || writes_under {
                return Ok(Plan::Verdict(Verdict::Held {
                    reason: access_rule_holds::REMOVED,
                }));
            }
            Ok(Plan::Verdict(match (rule_touch, recorded) {
                // The rule's delete waits for the deletes of its files.
                (Some(_), true) => Verdict::Waits,
                (Some(_), false) => Verdict::Clear(Clearance::RuleLast),
                (None, _) => Verdict::Clear(Clearance::DeletesOnly),
            }))
        }
    }
}

/// Put the access rules over `touches` in order before a writer changes
/// them, and say for each touch whether the writer may go on. An `Err` in
/// the outer result is a store failure; an `Err` for one touch is that
/// path's refusal: [`ACCESS_RULE_WAITS`] to retry, or
/// [`RuntimeError::AccessRuleHeld`] until the owner decides.
pub(super) fn order_paths(
    store: &mut EngineStore,
    order: &Order<'_>,
    touches: &[Touch<'_>],
) -> Result<Vec<Result<(), RuntimeError>>, RuntimeError> {
    let mut folders: BTreeMap<(usize, &str), (Option<Touch<'_>>, bool)> = BTreeMap::new();
    for touch in touches {
        let own = is_access_rule_path(touch.path).then(|| access_rule_folder(touch.path));
        for folder in folders_of(touch.path) {
            let entry = folders
                .entry((
                    folder.matches('/').count() + usize::from(!folder.is_empty()),
                    folder,
                ))
                .or_default();
            if own == Some(folder) {
                entry.0 = Some(*touch);
            } else if !touch.deletes {
                entry.1 = true;
            }
        }
    }
    let mut verdicts: HashMap<&str, Verdict> = HashMap::new();
    for ((_, folder), (rule_touch, writes_under)) in &folders {
        // A folder under one that waits or is held waits with it.
        let above = folders_of(folder)
            .into_iter()
            .filter(|above| above != folder)
            .find_map(|above| {
                verdicts
                    .get(above)
                    .filter(|v| !matches!(v, Verdict::Clear(_)))
            });
        let cleared = rule_touch
            .is_none()
            .then(|| clearance(order.workspace_id, order.version_id, folder))
            .flatten();
        let verdict = match (above, cleared) {
            (Some(_), _) => Verdict::Waits,
            (None, Some(cleared)) => Verdict::Clear(cleared),
            (None, None) => judge_one(store, order, folder, rule_touch.as_ref(), *writes_under)?,
        };
        verdicts.insert(folder, verdict);
    }
    Ok(touches
        .iter()
        .map(|touch| {
            let own = is_access_rule_path(touch.path).then(|| access_rule_folder(touch.path));
            for folder in folders_of(touch.path) {
                match verdicts.get(folder) {
                    Some(Verdict::Clear(Clearance::DeletesOnly))
                        if !touch.deletes || own == Some(folder) =>
                    {
                        return Err(waits());
                    }
                    Some(Verdict::Clear(_)) => {}
                    Some(Verdict::Waits) | None => return Err(waits()),
                    Some(Verdict::Held { reason }) => {
                        return Err(RuntimeError::AccessRuleHeld {
                            folder: folder.to_owned(),
                            reason,
                        });
                    }
                }
            }
            Ok(())
        })
        .collect())
}

/// [`order_paths`] for capture, before its transaction opens. A store with
/// no workspace on disk lets every touch go on.
#[allow(clippy::too_many_arguments)]
pub(super) fn order_capture(
    store: &mut EngineStore,
    workspace_id: &str,
    version_id: &str,
    now_ms: i64,
    leases: &LeaseRegistry,
    faults: &dyn FaultInjector,
    touches: &[Touch<'_>],
) -> Result<Vec<Result<(), RuntimeError>>, RuntimeError> {
    let Some(root) = root() else {
        return Ok(touches.iter().map(|_| Ok(())).collect());
    };
    let order = Order {
        root: &root,
        workspace_id,
        version_id,
        now_ms,
        writer: Writer::Capture,
        leases,
        faults,
    };
    order_paths(store, &order, touches)
}

pub(super) fn waits() -> RuntimeError {
    signal(|signals| &signals.waits);
    RuntimeError::Sync(SyncError::RetryableState {
        reason: ACCESS_RULE_WAITS,
    })
}

fn committed<T>(outcome: TxnOutcome<T>) -> Result<T, RuntimeError> {
    match outcome {
        TxnOutcome::Committed(value) => Ok(value),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn release_hold(
    store: &mut EngineStore,
    order: &Order<'_>,
    folder: &str,
) -> Result<(), RuntimeError> {
    let (workspace, version) = (order.workspace_id, order.version_id);
    let held =
        store.read_with(|conn| access_rule_holds::hold_in(conn, workspace, version, folder))?;
    if held.is_some() {
        committed(store.write_with(order.faults, |tx| {
            access_rule_holds::clear_in(tx, workspace, version, folder)
        })?)?;
        signal(|signals| &signals.holds);
    }
    Ok(())
}

fn record_hold(
    store: &mut EngineStore,
    order: &Order<'_>,
    folder: &str,
    reason: &'static str,
    observed_sha256: Option<String>,
) -> Result<bool, RuntimeError> {
    let hold = AccessRuleHold {
        workspace_id: order.workspace_id.to_owned(),
        version_id: order.version_id.to_owned(),
        folder: folder.to_owned(),
        reason: reason.to_owned(),
        observed_sha256,
        recorded_at_ms: order.now_ms,
    };
    let recorded =
        committed(store.write_with(order.faults, |tx| access_rule_holds::record_in(tx, &hold))?)?;
    if recorded {
        signal(|signals| &signals.holds);
    }
    Ok(recorded)
}

/// Commit `bytes`, the folder's rule as it is on disk, as its own moment.
fn commit_disk_rule(
    store: &mut EngineStore,
    order: &Order<'_>,
    folder: &str,
    bytes: Vec<u8>,
) -> Result<(), RuntimeError> {
    set(
        order.workspace_id,
        order.version_id,
        folder,
        Clearance::RuleFirst,
    );
    let path = rule_path(folder);
    let token = CancellationToken::new();
    let summary = Some(format!("Updated {ACCESS_RULE_FILE}"));
    match String::from_utf8(bytes) {
        Ok(text) => {
            let input = CaptureIngest {
                workspace_id: order.workspace_id.to_owned(),
                version_id: order.version_id.to_owned(),
                path,
                text,
                metadata_origin: RULE_METADATA_ORIGIN.to_owned(),
                metadata_summary: summary,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: order.now_ms,
                request_id: None,
                claim_foreign_head: true,
            };
            let indexing = super::capture::CaptureIndexing::ReadRoot(order.root.to_owned());
            let result = super::capture::capture_ingest_unordered_on_store(
                store,
                &input,
                &indexing,
                order.leases,
                order.faults,
                &token,
            )?;
            if result.deduped {
                note_unchanged_rule(order.workspace_id, order.version_id, &input.path);
            }
        }
        Err(error) => {
            let input = CaptureIngestBinary {
                workspace_id: order.workspace_id.to_owned(),
                version_id: order.version_id.to_owned(),
                path,
                bytes: error.into_bytes(),
                metadata_origin: RULE_METADATA_ORIGIN.to_owned(),
                metadata_summary: summary,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: order.now_ms,
                request_id: None,
                claim_foreign_head: true,
            };
            let result = super::capture::capture_ingest_binary_unordered_on_store(
                store,
                &input,
                order.leases,
                order.faults,
                &token,
            )?;
            if result.deduped {
                note_unchanged_rule(order.workspace_id, order.version_id, &input.path);
            }
        }
    }
    Ok(())
}

/// Delete the folder's committed rule as its own moment.
fn retire_rule(
    store: &mut EngineStore,
    order: &Order<'_>,
    folder: &str,
) -> Result<(), RuntimeError> {
    set(
        order.workspace_id,
        order.version_id,
        folder,
        Clearance::RuleLast,
    );
    let input = CaptureRetire {
        workspace_id: order.workspace_id.to_owned(),
        version_id: order.version_id.to_owned(),
        path: rule_path(folder),
        metadata_summary: Some(format!("Removed {ACCESS_RULE_FILE}")),
        metadata_correlation_id: None,
        now_ms: order.now_ms,
        request_id: None,
        only_if_text_head: false,
        only_if_capture_origin: false,
        allow_ydoc_origin: false,
    };
    committed(store.write_with(order.faults, |tx| {
        let result = dohc_engine_domain::capture_retire_in_tx(tx, &input)?;
        if let Some(retired) = result.retired.as_ref()
            && !result.deduped
            && !retired.deduped
        {
            crate::search::delete_file_search_index(
                tx,
                &input.workspace_id,
                &input.version_id,
                &retired.object.object_id,
            )?;
            super::journal::journal_moment_outbound_in_tx(
                tx,
                &input.workspace_id,
                &retired.moment.moment_id,
                false,
            )?;
        }
        Ok::<_, RuntimeError>(())
    })?)
}

/// Settle a held folder the way its owner chose.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccessRuleDecision {
    /// Commit the rule on disk now, or its removal, and release the hold.
    Accept,
    /// Write the last committed rule back to disk and release the hold.
    Restore,
}

fn decide_on_store(
    store: &mut EngineStore,
    order: &Order<'_>,
    folder: &str,
    decision: AccessRuleDecision,
    self_writes: &dyn super::materialization::SelfWriteRecorder,
) -> Result<(), RuntimeError> {
    // The folders above settle first: their own holds answer for them.
    for above in folders_of(&rule_path(folder)) {
        if above == folder {
            continue;
        }
        match judge_one(store, order, above, None, false)? {
            Verdict::Clear(_) => {}
            Verdict::Waits => return Err(waits()),
            Verdict::Held { reason } => {
                return Err(RuntimeError::AccessRuleHeld {
                    folder: above.to_owned(),
                    reason,
                });
            }
        }
    }
    let disk = read_disk_rule(order.root, folder).map_err(|()| waits())?;
    let path = rule_path(folder);
    match decision {
        AccessRuleDecision::Accept => {
            let committed = store.read_with(|conn| {
                committed_rule(conn, order.workspace_id, order.version_id, folder)
            })?;
            match disk {
                OnDisk::Bytes(bytes) => commit_disk_rule(store, order, folder, bytes)?,
                OnDisk::Absent if committed.is_some() => retire_rule(store, order, folder)?,
                OnDisk::Absent => {}
            }
        }
        AccessRuleDecision::Restore => {
            let disk = match &disk {
                OnDisk::Bytes(bytes) => Some(bytes.as_slice()),
                OnDisk::Absent => None,
            };
            let disk_sha256 = disk.map(dohc_engine_storage::hex_sha256);
            let committed = store.read_with(|conn| {
                let state = dohc_engine_domain::select_snapshot_by_path_in_tx(
                    conn,
                    order.workspace_id,
                    order.version_id,
                    &path,
                )?;
                if state.binary_sha256.is_some() {
                    return Err(RuntimeError::Domain(DomainError::InvalidInput {
                        reason: "an unreadable binary access rule cannot be restored",
                    }));
                }
                Ok(state.snapshot.map(|snapshot| snapshot.blob_sha256))
            })?;
            match (committed, disk_sha256) {
                (Some(committed), sha256) if sha256.as_deref() != Some(committed.as_str()) => {
                    place_rule(store, order, &path, &committed, disk, self_writes)?;
                }
                (Some(_), _) | (None, None) => {}
                (None, Some(sha256)) => remove_rule(order.root, &path, &sha256)?,
            }
        }
    }
    release_hold(store, order, folder)
}

fn judge_one(
    store: &mut EngineStore,
    order: &Order<'_>,
    folder: &str,
    rule_touch: Option<&Touch<'_>>,
    writes_under: bool,
) -> Result<Verdict, RuntimeError> {
    let plan = store
        .read_with(|conn| judge_folder(conn, &order.scope(), folder, rule_touch, writes_under))?;
    let verdict = match plan {
        Plan::Verdict(verdict) => verdict,
        Plan::CommitRule(bytes) => {
            commit_disk_rule(store, order, folder, bytes)?;
            Verdict::Clear(Clearance::Open)
        }
    };
    match &verdict {
        Verdict::Clear(clearance) => {
            set(order.workspace_id, order.version_id, folder, *clearance);
            release_hold(store, order, folder)?;
        }
        Verdict::Held { reason } => {
            let observed = match read_disk_rule(order.root, folder) {
                Ok(OnDisk::Bytes(bytes)) => Some(dohc_engine_storage::hex_sha256(&bytes)),
                _ => None,
            };
            record_hold(store, order, folder, reason, observed)?;
        }
        Verdict::Waits => {}
    }
    Ok(verdict)
}

/// Put the committed rule back on disk through an ordinary placement, which
/// refuses to replace bytes other than the ones judged here.
fn place_rule(
    store: &mut EngineStore,
    order: &Order<'_>,
    path: &str,
    content_sha256: &str,
    disk: Option<&[u8]>,
    self_writes: &dyn super::materialization::SelfWriteRecorder,
) -> Result<(), RuntimeError> {
    let job_id = format!(
        "access-rule-restore_{}_{}",
        dohc_engine_storage::hex_sha256(path.as_bytes()),
        order.now_ms
    );
    let spec = dohc_engine_storage::MaterializationJobSpec {
        job_id: job_id.clone(),
        workspace_id: order.workspace_id.to_owned(),
        target_path: path.to_owned(),
        content_sha256: content_sha256.to_owned(),
        preimage: match disk {
            Some(bytes) => {
                dohc_engine_storage::Preimage::Present(dohc_engine_storage::hex_sha256(bytes))
            }
            None => dohc_engine_storage::Preimage::Absent,
        },
        target_generation: order.now_ms,
        now_ms: order.now_ms,
    };
    // The materializer replaces only bytes the store holds, so the widened
    // rule it displaces stays recoverable.
    committed(store.write_with(order.faults, |tx| {
        if let Some(bytes) = disk {
            dohc_engine_storage::put_binary_blob(tx, bytes)?;
        }
        dohc_engine_storage::enqueue_job(tx, &spec)
    })?)?;
    let placed = super::materialization::materialize_expected_job(
        store,
        order.root,
        order.workspace_id,
        &job_id,
        self_writes,
        order.now_ms,
        order.faults,
        None,
    );
    if placed { Ok(()) } else { Err(waits()) }
}

/// Remove a rule nothing committed, if it still holds the judged bytes.
fn remove_rule(root: &Path, path: &str, judged_sha256: &str) -> Result<(), RuntimeError> {
    match read_publication_target(root, path) {
        Ok(PublicationTarget::Bytes(bytes))
            if dohc_engine_storage::hex_sha256(&bytes) == judged_sha256 => {}
        Ok(PublicationTarget::Absent) => return Ok(()),
        _ => return Err(waits()),
    }
    match std::fs::remove_file(root.join(path)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            Err(RuntimeError::Storage(StorageError::persist_public(error)))
        }
        _ => Ok(()),
    }
}

impl ActorHandle {
    /// What the ordering step tells capture between its passes.
    pub fn access_rule_signals(&self) -> &AccessRuleSignals {
        &self.access_rules
    }

    /// The folders whose access rule waits for the owner.
    pub async fn access_rule_holds(
        &self,
        workspace_id: String,
    ) -> Result<Vec<AccessRuleHold>, RuntimeError> {
        self.run(move |store, _| {
            store
                .read_with(|conn| access_rule_holds::list_in(conn, &workspace_id))
                .map_err(RuntimeError::from)
        })
        .await
    }

    /// Settle a held folder: accept what is on disk, or restore the rule
    /// last committed. Either takes effect at once; the files under the
    /// folder follow on the next capture pass.
    #[allow(clippy::too_many_arguments)]
    pub async fn decide_access_rule(
        &self,
        workspace_id: String,
        version_id: String,
        folder: String,
        decision: AccessRuleDecision,
        root: std::path::PathBuf,
        self_writes: std::sync::Arc<dyn super::materialization::SelfWriteRecorder>,
        now_ms: i64,
        faults: std::sync::Arc<dyn FaultInjector>,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            begin_command();
            let leases = LeaseRegistry::new();
            let order = Order {
                root: &root,
                workspace_id: &workspace_id,
                version_id: &version_id,
                now_ms,
                writer: Writer::Deliberate,
                leases: &leases,
                faults: faults.as_ref(),
            };
            decide_on_store(store, &order, &folder, decision, self_writes.as_ref())
        })
        .await
    }
}
