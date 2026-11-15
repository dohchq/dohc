//! A folder's `access.yaml` reaches the journal before the files it covers.
//!
//! Members see a folder through its rule, and the relay replays moments in
//! origin order. Every file moment passes [`check_moment`], which the sync
//! crate's journal calls before it takes an origin seq, on the actor's one
//! writer thread. For each folder over the moment's path, from the workspace
//! root down, the check compares the rule on disk with the rule last
//! committed there. A folder's rule is every file in exactly that folder whose
//! name folds to `access.yaml`, as the relay reads it; two of them are one
//! unreadable rule, which hides the folder.
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
    ACCESS_RULE_FILE, AccessRule, ReachBefore, access_rule_folder, is_access_rule_path, is_rule_of,
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
        verdict = judge_one(store, order, above, &[], writes_under || above != folder)?;
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

fn sync_error(error: RuntimeError) -> SyncError {
    match error {
        RuntimeError::Storage(error) => SyncError::Storage(error),
        _ => retry(ACCESS_RULE_WAITS),
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
    // Deleting one of several files that spell a folder's rule changes the
    // rule rather than removing it.
    let deletes = match own_rule {
        Some(folder) if deletes => committed_rule_paths(tx, workspace, version, folder)
            .map_err(sync_error)?
            .is_empty(),
        _ => deletes,
    };
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
    let plan = judge_folder(tx, &scope, folder, &[], !deletes).map_err(sync_error)?;
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

/// A folder's rule files on disk, by path.
type OnDisk = BTreeMap<String, Vec<u8>>;

/// One file of the rule last committed at a folder.
struct CommittedFile {
    sha256: String,
    /// `None` when it is binary or does not parse.
    rule: Option<AccessRule>,
    binary: bool,
}

/// The rule last committed at a folder.
struct Committed {
    files: BTreeMap<String, CommittedFile>,
    /// Capture read one of its files from disk, or dohc placed it there. A
    /// rule written without publication lives only in the store, so a disk
    /// without it says nothing about an outside change.
    reached_disk: bool,
}

impl Committed {
    /// The rule members see: `None` when it is unreadable, as several files
    /// are.
    fn rule(&self) -> Option<&AccessRule> {
        match self.files.len() {
            1 => self
                .files
                .values()
                .next()
                .and_then(|file| file.rule.as_ref()),
            _ => None,
        }
    }
}

/// The paths at or under `folder`, as a range of the path index.
fn folder_range(folder: &str) -> (String, String) {
    if folder.is_empty() {
        (String::new(), "\u{10FFFF}".to_owned())
    } else {
        (format!("{folder}/"), format!("{folder}0"))
    }
}

/// The paths the store holds for `folder`'s rule files.
fn committed_rule_paths(
    conn: &Connection,
    workspace: &str,
    version: &str,
    folder: &str,
) -> Result<Vec<String>, RuntimeError> {
    let (low, high) = folder_range(folder);
    // `substr` counts characters; a name starts after the folder's slash.
    let name_start = folder.chars().count() + usize::from(!folder.is_empty()) + 1;
    let mut query = conn
        .prepare_cached(
            "SELECT path FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 \
             AND path>=?3 AND path<?4 AND instr(substr(path, ?5), '/')=0",
        )
        .map_err(StorageError::corrupt_public)?;
    let paths = query
        .query_map(
            params![
                workspace,
                version,
                low,
                high,
                i64::try_from(name_start).unwrap_or(i64::MAX)
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(StorageError::corrupt_public)?;
    let mut rules = Vec::new();
    for path in paths {
        let path = path.map_err(StorageError::corrupt_public)?;
        if is_rule_of(&path, folder) {
            rules.push(path);
        }
    }
    Ok(rules)
}

fn committed_rule(
    conn: &Connection,
    workspace: &str,
    version: &str,
    folder: &str,
) -> Result<Option<Committed>, RuntimeError> {
    let mut files = BTreeMap::new();
    let mut reached_disk = false;
    for path in committed_rule_paths(conn, workspace, version, folder)? {
        let state =
            dohc_engine_domain::select_snapshot_by_path_in_tx(conn, workspace, version, &path)?;
        let file = match (state.snapshot, state.binary_sha256) {
            (Some(snapshot), _) => CommittedFile {
                rule: parse_access_rule(&snapshot.text),
                sha256: snapshot.blob_sha256,
                binary: false,
            },
            (None, Some(sha256)) => CommittedFile {
                sha256,
                rule: None,
                binary: true,
            },
            (None, None) => continue,
        };
        reached_disk |= conn
            .prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM snapshots WHERE workspace_id=?1 AND version_id=?2 \
                 AND path=?3 AND metadata_origin=?5) \
                 OR EXISTS(SELECT 1 FROM materialization_jobs WHERE workspace_id IN (?1,'') \
                 AND target_path=?3 AND content_sha256=?4 AND status='complete')",
            )
            .map_err(StorageError::corrupt_public)?
            .query_row(
                params![
                    workspace,
                    version,
                    path,
                    file.sha256,
                    dohc_engine_domain::store::CAPTURE_ORIGIN
                ],
                |row| row.get::<_, bool>(0),
            )
            .map_err(StorageError::corrupt_public)?;
        files.insert(path, file);
    }
    Ok((!files.is_empty()).then_some(Committed {
        files,
        reached_disk,
    }))
}

/// Read every file in exactly `folder` whose name folds to `access.yaml`.
fn read_disk_rule(root: &Path, folder: &str) -> Result<OnDisk, ()> {
    let dir = root.join(folder);
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(OnDisk::new());
        }
        Err(_) if std::fs::symlink_metadata(&dir).is_ok_and(|meta| !meta.is_dir()) => {
            return Ok(OnDisk::new());
        }
        Err(_) => return Err(()),
    };
    let mut files = OnDisk::new();
    for entry in entries {
        let name = entry.map_err(|_| ())?.file_name();
        // A name that is not UTF-8 is nothing capture records.
        let Some(name) = name.to_str().filter(|name| is_access_rule_path(name)) else {
            continue;
        };
        let path = if folder.is_empty() {
            name.to_owned()
        } else {
            format!("{folder}/{name}")
        };
        match read_publication_target(root, &path) {
            Ok(PublicationTarget::Bytes(bytes)) => {
                files.insert(path, bytes);
            }
            // A folder or an oversized file is nothing capture records.
            Ok(PublicationTarget::Absent | PublicationTarget::Untracked) => {}
            Err(_) => return Err(()),
        }
    }
    Ok(files)
}

/// The rule on disk once the writer's own changes land: capture's observed
/// bytes stand for what it read, and its deletes for the files it found gone.
fn with_touches(mut disk: OnDisk, touches: &[Touch<'_>]) -> OnDisk {
    for touch in touches {
        match (touch.observed, touch.deletes) {
            (Some(bytes), _) => {
                disk.insert(touch.path.to_owned(), bytes.to_vec());
            }
            (None, true) => {
                disk.remove(touch.path);
            }
            (None, false) => {}
        }
    }
    disk
}

/// The rule files to commit so the store matches `disk`: writes first, in
/// path order, then deletes, so no step holds fewer rule files than both
/// ends do.
fn rule_changes(committed: Option<&Committed>, disk: &OnDisk) -> Vec<(String, Option<Vec<u8>>)> {
    let committed_sha = |path: &str| {
        committed
            .and_then(|committed| committed.files.get(path))
            .map(|file| file.sha256.clone())
    };
    let writes = disk
        .iter()
        .filter(|(path, bytes)| committed_sha(path) != Some(dohc_engine_storage::hex_sha256(bytes)))
        .map(|(path, bytes)| (path.clone(), Some(bytes.clone())));
    let deletes = committed
        .into_iter()
        .flat_map(|committed| committed.files.keys())
        .filter(|path| !disk.contains_key(*path))
        .map(|path| (path.clone(), None));
    writes.chain(deletes).collect()
}

/// Whether the folder and its rule files have gone unchanged for the settle
/// period. A folder that is gone answers for its nearest existing ancestor,
/// whose entry list changed when it went.
fn settled(root: &Path, folder: &str, disk: &OnDisk) -> bool {
    let modified = |path: &Path| std::fs::symlink_metadata(path).and_then(|m| m.modified());
    let mut newest = disk
        .keys()
        .filter_map(|path| modified(&root.join(path)).ok())
        .max();
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
    let (low, high) = folder_range(folder);
    let mut query = conn
        .prepare_cached(
            "SELECT path FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 \
             AND path>=?3 AND path<?4",
        )
        .map_err(StorageError::corrupt_public)?;
    let paths = query
        .query_map(params![workspace, version, low, high], |row| {
            row.get::<_, String>(0)
        })
        .map_err(StorageError::corrupt_public)?;
    let mut recorded = false;
    for path in paths {
        let path = path.map_err(StorageError::corrupt_public)?;
        if is_rule_of(&path, folder) {
            continue;
        }
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
    let (low, high) = folder_range(folder);
    let mut query = conn
        .prepare_cached(
            "SELECT target_path FROM materialization_jobs WHERE workspace_id IN (?1,'') \
             AND status='pending' AND target_path>=?2 AND target_path<?3",
        )
        .map_err(StorageError::corrupt_public)?;
    let paths = query
        .query_map(params![workspace, low, high], |row| row.get::<_, String>(0))
        .map_err(StorageError::corrupt_public)?;
    for path in paths {
        if is_rule_of(&path.map_err(StorageError::corrupt_public)?, folder) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A rule file to commit: its bytes, or `None` to delete it.
type RuleChange = (String, Option<Vec<u8>>);

/// What to do at one folder before the writer's transaction opens.
enum Plan {
    Verdict(Verdict),
    /// Commit the disk's rule first, each file as its own moment.
    CommitRule(Vec<RuleChange>),
}

/// Whether each rule members see while `changes` commit one by one gives
/// nobody more than `before`. Several files are one unreadable rule.
fn every_step_narrows(
    before: ReachBefore<'_>,
    committed: Option<&Committed>,
    changes: &[RuleChange],
) -> bool {
    let mut files: BTreeMap<&str, Option<AccessRule>> = committed
        .iter()
        .flat_map(|committed| committed.files.iter())
        .map(|(path, file)| (path.as_str(), file.rule.clone()))
        .collect();
    changes.iter().all(|(path, bytes)| {
        match bytes {
            Some(bytes) => {
                let rule = std::str::from_utf8(bytes).ok().and_then(parse_access_rule);
                files.insert(path, rule);
            }
            None => {
                files.remove(path.as_str());
            }
        }
        let rule = match files.len() {
            1 => files.values().next().and_then(Option::as_ref),
            _ => None,
        };
        rule_change_narrows(before, rule)
    })
}

fn judge_folder(
    conn: &Connection,
    order: &Scope<'_>,
    folder: &str,
    rule_touches: &[Touch<'_>],
    writes_under: bool,
) -> Result<Plan, RuntimeError> {
    let (workspace, version) = (order.workspace_id, order.version_id);
    let committed = committed_rule(conn, workspace, version, folder)?;
    if order.writer == Writer::Deliberate && !rule_touches.is_empty() {
        // A change made through dohc goes as written. Only deleting every
        // file of the rule closes the folder behind it.
        let removes = rule_touches.iter().all(|touch| touch.deletes)
            && committed.as_ref().is_none_or(|committed| {
                committed
                    .files
                    .keys()
                    .all(|path| rule_touches.iter().any(|touch| touch.path == path))
            });
        let clearance = if removes {
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
    let disk = match read_disk_rule(order.root, folder) {
        Ok(disk) => with_touches(disk, rule_touches),
        Err(()) => return Ok(Plan::Verdict(Verdict::Waits)),
    };
    let changes = rule_changes(committed.as_ref(), &disk);
    if changes.is_empty() {
        // Capture records the committed rule again; its moment dedupes.
        return Ok(Plan::Verdict(Verdict::Clear(Clearance::Open)));
    }
    if rule_touches.is_empty() && committed.as_ref().is_some_and(|c| !c.reached_disk) {
        return Ok(Plan::Verdict(Verdict::Clear(Clearance::Open)));
    }
    if !settled(order.root, folder, &disk) {
        return Ok(Plan::Verdict(Verdict::Waits));
    }
    // The writer's own moments commit the change when they cover all of it.
    let covered = changes
        .iter()
        .all(|(path, _)| rule_touches.iter().any(|touch| touch.path == path));
    if disk.is_empty() {
        let (recorded, on_disk) = folder_holds_files(conn, order.root, workspace, version, folder)?;
        if on_disk || writes_under {
            return Ok(Plan::Verdict(Verdict::Held {
                reason: access_rule_holds::REMOVED,
            }));
        }
        return Ok(match (rule_touches.is_empty(), recorded) {
            (true, _) => Plan::Verdict(Verdict::Clear(Clearance::DeletesOnly)),
            // The rule's delete waits for the deletes of its files.
            (false, true) => Plan::Verdict(Verdict::Waits),
            (false, false) if covered => Plan::Verdict(Verdict::Clear(Clearance::RuleLast)),
            (false, false) => Plan::CommitRule(changes),
        });
    }
    let above = match &committed {
        Some(_) => None,
        None => nearest_committed_above(conn, workspace, version, folder)?,
    };
    let before = match (&committed, &above) {
        (Some(own), _) => ReachBefore::Own(own.rule()),
        (None, Some(above)) => ReachBefore::Inherited(above.rule()),
        (None, None) => ReachBefore::WorkspaceLevel,
    };
    if !every_step_narrows(before, committed.as_ref(), &changes) {
        return Ok(Plan::Verdict(Verdict::Held {
            reason: access_rule_holds::WIDENED,
        }));
    }
    Ok(if covered {
        Plan::Verdict(Verdict::Clear(Clearance::RuleFirst))
    } else {
        Plan::CommitRule(changes)
    })
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
    let mut folders: BTreeMap<(usize, &str), (Vec<Touch<'_>>, bool)> = BTreeMap::new();
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
                entry.0.push(*touch);
            } else if !touch.deletes {
                entry.1 = true;
            }
        }
    }
    let mut verdicts: HashMap<&str, Verdict> = HashMap::new();
    for ((_, folder), (rule_touches, writes_under)) in &folders {
        // A folder under one that waits or is held waits with it.
        let above = folders_of(folder)
            .into_iter()
            .filter(|above| above != folder)
            .find_map(|above| {
                verdicts
                    .get(above)
                    .filter(|v| !matches!(v, Verdict::Clear(_)))
            });
        let cleared = rule_touches
            .is_empty()
            .then(|| clearance(order.workspace_id, order.version_id, folder))
            .flatten();
        let verdict = match (above, cleared) {
            (Some(_), _) => Verdict::Waits,
            (None, Some(cleared)) => Verdict::Clear(cleared),
            (None, None) => judge_one(store, order, folder, rule_touches, *writes_under)?,
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

/// Commit `changes`, the folder's rule files as they are on disk, each as its
/// own moment and in the order given.
fn commit_rule_changes(
    store: &mut EngineStore,
    order: &Order<'_>,
    folder: &str,
    changes: Vec<RuleChange>,
) -> Result<(), RuntimeError> {
    let writes = changes.iter().filter(|(_, bytes)| bytes.is_some()).count();
    let deletes = changes.len() - writes;
    let remains = store
        .read_with(|conn| committed_rule_paths(conn, order.workspace_id, order.version_id, folder))?
        .len()
        + writes
        > deletes;
    for (path, bytes) in changes {
        match bytes {
            Some(bytes) => commit_disk_rule(store, order, folder, path, bytes)?,
            None => retire_rule(store, order, folder, path, !remains)?,
        }
    }
    Ok(())
}

/// Commit `bytes`, one of the folder's rule files as it is on disk, as its
/// own moment.
fn commit_disk_rule(
    store: &mut EngineStore,
    order: &Order<'_>,
    folder: &str,
    path: String,
    bytes: Vec<u8>,
) -> Result<(), RuntimeError> {
    set(
        order.workspace_id,
        order.version_id,
        folder,
        Clearance::RuleFirst,
    );
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

/// Delete one of the folder's committed rule files as its own moment.
/// `closes` when no other file of the rule remains.
fn retire_rule(
    store: &mut EngineStore,
    order: &Order<'_>,
    folder: &str,
    path: String,
    closes: bool,
) -> Result<(), RuntimeError> {
    set(
        order.workspace_id,
        order.version_id,
        folder,
        if closes {
            Clearance::RuleLast
        } else {
            Clearance::RuleFirst
        },
    );
    let input = CaptureRetire {
        workspace_id: order.workspace_id.to_owned(),
        version_id: order.version_id.to_owned(),
        path,
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
        match judge_one(store, order, above, &[], false)? {
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
    let committed = store
        .read_with(|conn| committed_rule(conn, order.workspace_id, order.version_id, folder))?;
    match decision {
        AccessRuleDecision::Accept => {
            let changes = rule_changes(committed.as_ref(), &disk);
            commit_rule_changes(store, order, folder, changes)?;
        }
        AccessRuleDecision::Restore => {
            let files = committed
                .map(|committed| committed.files)
                .unwrap_or_default();
            if files.values().any(|file| file.binary) {
                return Err(RuntimeError::Domain(DomainError::InvalidInput {
                    reason: "an unreadable binary access rule cannot be restored",
                }));
            }
            // Files nothing committed go first: on a disk that ignores case,
            // a committed spelling can only return once they are gone.
            for (path, bytes) in &disk {
                if !files.contains_key(path) {
                    remove_rule(order.root, path, &dohc_engine_storage::hex_sha256(bytes))?;
                }
            }
            for (path, file) in &files {
                let bytes = disk.get(path).map(Vec::as_slice);
                if bytes.map(dohc_engine_storage::hex_sha256).as_ref() != Some(&file.sha256) {
                    place_rule(store, order, path, &file.sha256, bytes, self_writes)?;
                }
            }
        }
    }
    release_hold(store, order, folder)
}

fn judge_one(
    store: &mut EngineStore,
    order: &Order<'_>,
    folder: &str,
    rule_touches: &[Touch<'_>],
    writes_under: bool,
) -> Result<Verdict, RuntimeError> {
    let plan = store
        .read_with(|conn| judge_folder(conn, &order.scope(), folder, rule_touches, writes_under))?;
    let verdict = match plan {
        Plan::Verdict(verdict) => verdict,
        Plan::CommitRule(changes) => {
            commit_rule_changes(store, order, folder, changes)?;
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
                Ok(disk) if disk.len() == 1 => disk
                    .values()
                    .next()
                    .map(|bytes| dohc_engine_storage::hex_sha256(bytes)),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn committed(files: &[(&str, &str)]) -> Committed {
        Committed {
            files: files
                .iter()
                .map(|(path, text)| {
                    let file = CommittedFile {
                        sha256: dohc_engine_storage::hex_sha256(text.as_bytes()),
                        rule: parse_access_rule(text),
                        binary: false,
                    };
                    ((*path).to_owned(), file)
                })
                .collect(),
            reached_disk: true,
        }
    }

    fn write(path: &str, text: &str) -> RuleChange {
        (path.to_owned(), Some(text.as_bytes().to_vec()))
    }

    #[test]
    fn two_spellings_of_a_rule_are_one_unreadable_rule() {
        let view = committed(&[("T/access.yaml", "members: view\n")]);
        let before = ReachBefore::Own(view.rule());
        // A second spelling that grants edit hides the folder: it narrows.
        assert!(every_step_narrows(
            before,
            Some(&view),
            &[write("T/ACCESS.yaml", "members: edit\n")]
        ));
        // Taking one of two spellings away makes the other readable again,
        // which widens a hidden folder.
        let both = committed(&[
            ("T/ACCESS.yaml", "members: edit\n"),
            ("T/access.yaml", "members: view\n"),
        ]);
        assert!(both.rule().is_none());
        assert!(!every_step_narrows(
            ReachBefore::Own(both.rule()),
            Some(&both),
            &[("T/ACCESS.yaml".to_owned(), None)]
        ));
    }

    #[test]
    fn a_respelled_rule_is_judged_at_every_step() {
        let view = committed(&[("T/access.yaml", "members: view\n")]);
        let disk = OnDisk::from([("T/ACCESS.yaml".to_owned(), b"members: view\n".to_vec())]);
        let changes = rule_changes(Some(&view), &disk);
        assert_eq!(
            changes,
            [
                write("T/ACCESS.yaml", "members: view\n"),
                ("T/access.yaml".to_owned(), None)
            ]
        );
        assert!(every_step_narrows(
            ReachBefore::Own(view.rule()),
            Some(&view),
            &changes
        ));
        let disk = OnDisk::from([("T/ACCESS.yaml".to_owned(), b"members: edit\n".to_vec())]);
        assert!(!every_step_narrows(
            ReachBefore::Own(view.rule()),
            Some(&view),
            &rule_changes(Some(&view), &disk)
        ));
    }

    #[test]
    fn reads_every_spelling_of_a_rule_in_exactly_that_folder() {
        let scratch = dohc_engine_testkit::ScratchDir::new().expect("scratch");
        let root = scratch.path();
        std::fs::create_dir_all(root.join("T/sub")).unwrap();
        std::fs::write(root.join("T/ACCESS.yaml"), "members: view\n").unwrap();
        std::fs::write(root.join("T/access.yaml.tmp"), "members: edit\n").unwrap();
        std::fs::write(root.join("T/sub/access.yaml"), "members: edit\n").unwrap();
        std::fs::write(root.join("Access.YAML"), "members: edit\n").unwrap();
        let disk = read_disk_rule(root, "T").expect("read");
        assert_eq!(disk.keys().collect::<Vec<_>>(), ["T/ACCESS.yaml"]);
        let disk = read_disk_rule(root, "").expect("read");
        assert_eq!(disk.keys().collect::<Vec<_>>(), ["Access.YAML"]);
        assert!(read_disk_rule(root, "missing").expect("read").is_empty());
    }
}
