//! A folder's `access.yaml` reaches the journal before the files it covers.
//!
//! Members see a folder through its rule, and the relay replays moments in
//! origin order. Every file moment the journal records passes
//! [`check_moment`], which the sync crate's journal calls before it takes an
//! origin seq, on the actor's one writer thread. The journal records file
//! moments only once the workspace replicates, so a workspace that does not
//! commits its rules and files as they come and holds nothing. For each folder
//! over the moment's path, from the workspace root down, the check compares
//! the rule on disk with the rule last committed there. A folder's rule is
//! every file in exactly that folder whose name folds to `access.yaml`, as the
//! relay reads it; two of them are one unreadable rule, which hides the folder.
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
//! A rule moment clears its own folder only when its moment row names an
//! origin other than capture: dohc wrote it on purpose. Any other rule moment
//! is refused and judged when the command ends, like a folder that needs a
//! rule committed first, because a rule cannot commit inside another writer's
//! transaction ([`finish_command`]). So the check alone keeps a widening read
//! from disk out of the journal.
//!
//! Writers that change nothing outside their one transaction run through
//! [`ordered`], which judges each folder the check refused and runs the writer
//! again. A writer that changes something first (capture, the versioned text
//! write's callers, delete, Collection adoption and relation cleanup,
//! live-document settlement and Undo) runs [`order_paths`] before it starts
//! instead ([`order_capture`], [`order_writer`], [`order_undo`]), so a
//! refusal cannot strand that change.
//!
//! The check also keeps the order inside one command: a file under a folder
//! whose rule the command commits waits until that rule's moment, a rule
//! write after files under its folder is refused, and a rule's delete closes
//! its folder for the rest of the command. A rule never moves as a rename.

use super::ActorHandle;
use crate::EngineDbIdentity;
use crate::error::RuntimeError;
use dohc_engine_collab::LeaseRegistry;
use dohc_engine_domain::store::CAPTURE_ORIGIN;
use dohc_engine_domain::{
    CaptureIngest, CaptureIngestBinary, CaptureRetire, CompareTextFileVersions, DomainError,
    FileMergePlan, MergeTextFileFromVersion, compare_text_file_versions_in_db, plan_file_merge,
};
use dohc_engine_files::access_rules::{
    ACCESS_RULE_FILE, AccessRule, ReachBefore, RuleFileOrder, RuleFileStep, RuleOrderWork,
    access_rule_folder, is_access_rule_path, is_rule_of, level_for_email, parse_access_rule,
    rule_change_narrows, rule_file_order_is_safe, safe_rule_file_order,
};
use dohc_engine_files::floor::path_collision_key;
use dohc_engine_files::materialize::{PublicationTarget, read_publication_target};
use dohc_engine_storage::access_rule_holds::{self, AccessRuleHold};
use dohc_engine_storage::{EngineStore, FaultInjector, NoFaults, StorageError, TxnOutcome};
use dohc_engine_sync::SyncError;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
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
    /// The workspace folder was found to still hold the store in this
    /// command.
    root_checked: bool,
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
    static ROOT: RefCell<Option<Root>> = const { RefCell::new(None) };
    static SIGNALS: RefCell<Option<Arc<AccessRuleSignals>>> = const { RefCell::new(None) };
    /// Counts the rule files the ordering step committed on this thread.
    static RULE_COMMITS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn signal(pick: impl FnOnce(&AccessRuleSignals) -> &AtomicU64) {
    SIGNALS.with(|signals| {
        if let Some(signals) = signals.borrow().as_ref() {
            pick(signals).fetch_add(1, Ordering::AcqRel);
        }
    });
}

/// The workspace folder a store orders rules under, and how to tell it
/// still holds that store.
struct Root {
    folder: PathBuf,
    /// The store's path by name, under `folder`.
    named: PathBuf,
    /// The open store's file.
    store: EngineDbIdentity,
}

/// The workspace folder that holds the store at `named`, the path the
/// store was opened by, read from its name alone: the folder above
/// `.dohc/engine`.
fn workspace_folder(named: &Path) -> Option<PathBuf> {
    let named = std::path::absolute(named).ok()?;
    named
        .parent()
        .filter(|engine| engine.file_name().is_some_and(|name| name == "engine"))
        .and_then(Path::parent)
        .filter(|dohc| dohc.file_name().is_some_and(|name| name == ".dohc"))
        .and_then(Path::parent)
        .map(Path::to_path_buf)
}

/// Install the commit-point check on the actor's thread. `named` is the
/// store's path by name, which the supervisor was given; the store itself
/// may be open through a descriptor's path. A store bound to a workspace
/// must sit in that workspace's `.dohc/engine` folder, or it does not open.
/// Only a store kept anywhere else, bound to no workspace, has no rules to
/// order.
pub(super) fn install(
    named: &Path,
    store: &EngineDbIdentity,
    bound: bool,
    signals: Arc<AccessRuleSignals>,
) -> Result<(), StorageError> {
    SIGNALS.with(|cell| *cell.borrow_mut() = Some(signals));
    let root = match workspace_folder(named) {
        Some(folder) => Some(Root {
            folder,
            named: named.to_path_buf(),
            store: store.clone(),
        }),
        None if bound => {
            return Err(StorageError::InvalidInput {
                reason: "workspace store is outside its workspace folder",
            });
        }
        None => None,
    };
    ROOT.with(|cell| *cell.borrow_mut() = root);
    dohc_engine_sync::install_moment_order_check(std::rc::Rc::new(check_moment));
    Ok(())
}

/// The refusal for a write while the workspace folder no longer holds the
/// store, as when the folder moved while the store stayed open.
pub const WORKSPACE_FOLDER_MOVED: &str = "workspace-folder-moved";

/// The workspace folder to order rules under, or `None` for a store with no
/// workspace. Once per command it checks that the folder still holds this
/// store, so rules are never read from a folder the workspace left.
fn root() -> Result<Option<PathBuf>, &'static str> {
    ROOT.with(|cell| {
        let cell = cell.borrow();
        let Some(root) = cell.as_ref() else {
            return Ok(None);
        };
        let checked = CLEARED.with(|cleared| cleared.borrow().root_checked);
        if !checked {
            if EngineDbIdentity::of_existing(&root.named).ok().as_ref() != Some(&root.store) {
                return Err(WORKSPACE_FOLDER_MOVED);
            }
            CLEARED.with(|cleared| cleared.borrow_mut().root_checked = true);
        }
        Ok(Some(root.folder.clone()))
    })
}

fn moved(reason: &'static str) -> RuntimeError {
    RuntimeError::Sync(SyncError::InvalidInput { reason })
}

/// Refuse a change while the workspace folder no longer holds the store,
/// before the change reads or writes anything.
pub(super) fn check_root() -> Result<(), RuntimeError> {
    root().map(drop).map_err(moved)
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
    if deferred.is_empty() {
        return;
    }
    // While the workspace folder no longer holds the store, every write is
    // refused, so its folders wait for one made once it does again.
    let Ok(Some(root)) = root() else {
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
    order_as(store, Writer::Deliberate, workspace_id, version_id, touches)?
        .into_iter()
        .collect()
}

/// [`order_writer`] for the members of one Undo turn, with each touch's
/// answer, so a member refused here is skipped and the others go on.
pub(super) fn order_undo(
    store: &mut EngineStore,
    workspace_id: &str,
    version_id: &str,
    touches: &[Touch<'_>],
) -> Result<Vec<Result<(), RuntimeError>>, RuntimeError> {
    order_as(store, Writer::Undo, workspace_id, version_id, touches)
}

/// The workspace folder to order `workspace_id`'s rules under, or `None`
/// when nothing needs ordering: a store with no workspace, or a workspace
/// that journals no file moments. Rules order only what the relay replays,
/// so until the workspace replicates its rules and files commit as they come.
fn ordering_root(store: &EngineStore, workspace_id: &str) -> Result<Option<PathBuf>, RuntimeError> {
    let Some(root) = root().map_err(moved)? else {
        return Ok(None);
    };
    let journals = store
        .read_with(|conn| dohc_engine_sync::workspace_journals_file_moments(conn, workspace_id))?;
    Ok(journals.then_some(root))
}

fn order_as(
    store: &mut EngineStore,
    writer: Writer,
    workspace_id: &str,
    version_id: &str,
    touches: &[Touch<'_>],
) -> Result<Vec<Result<(), RuntimeError>>, RuntimeError> {
    let Some(root) = ordering_root(store, workspace_id)? else {
        return Ok(touches.iter().map(|_| Ok(())).collect());
    };
    let leases = LeaseRegistry::new();
    let order = Order {
        root: &root,
        workspace_id,
        version_id,
        now_ms: wall_clock_ms(),
        writer,
        leases: &leases,
        faults: &NoFaults,
    };
    order_paths(store, &order, touches)
}

/// How many times [`ordered`] runs a writer. Every run after the first
/// follows a rule commit, so this bounds the folders one writer may find
/// waiting in turn.
const ORDERED_RUNS: usize = 8;

/// Run a writer that changes nothing outside its one transaction. When the
/// commit-point check refused one of its moments, judge the refused folders
/// now, which commits a rule that goes first, and run the writer again, so
/// its caller never sees the refusal. A folder that waits or is held answers
/// for the writer. A refused run left nothing behind.
pub(super) fn ordered<R>(
    store: &mut EngineStore,
    mut work: impl FnMut(&mut EngineStore) -> Result<R, RuntimeError>,
) -> Result<R, RuntimeError> {
    check_root()?;
    let mut outcome = work(store);
    for _ in 1..ORDERED_RUNS {
        let deferred = CLEARED.with(|cleared| std::mem::take(&mut cleared.borrow_mut().deferred));
        // A folder the workspace left refused the writer's moments already.
        let root = if outcome.is_err() && !deferred.is_empty() {
            root().ok().flatten()
        } else {
            None
        };
        let (Err(_), Some(root)) = (&outcome, root) else {
            CLEARED.with(|cleared| cleared.borrow_mut().deferred.extend(deferred));
            return outcome;
        };
        let commits = RULE_COMMITS.with(std::cell::Cell::get);
        let leases = LeaseRegistry::new();
        for ((workspace, version, folder), writes_under) in deferred {
            begin_command();
            let order = Order {
                root: &root,
                workspace_id: &workspace,
                version_id: &version,
                now_ms: wall_clock_ms(),
                writer: Writer::Deliberate,
                leases: &leases,
                faults: &NoFaults,
            };
            match order_folder(store, &order, &folder, writes_under)? {
                (_, Verdict::Clear(_)) => {}
                (_, Verdict::Waits) => return Err(waits()),
                (folder, Verdict::Held { reason } | Verdict::Refused { reason }) => {
                    return Err(RuntimeError::AccessRuleHeld { folder, reason });
                }
            }
        }
        begin_command();
        if RULE_COMMITS.with(std::cell::Cell::get) == commits {
            // Nothing changed that a new run would find.
            return outcome;
        }
        outcome = work(store);
    }
    outcome
}

/// Judge `folder` and the folders above it, from the root down, and say
/// where judging stopped.
fn order_folder(
    store: &mut EngineStore,
    order: &Order<'_>,
    folder: &str,
    writes_under: bool,
) -> Result<(String, Verdict), RuntimeError> {
    let mut verdict = Verdict::Clear(Clearance::Open);
    for above in folders_of(&rule_path(folder)) {
        verdict = judge_one(
            store,
            order,
            above,
            &[],
            writes_under || above != folder,
            &[],
        )?;
        if !matches!(verdict, Verdict::Clear(_)) {
            return Ok((above.to_owned(), verdict));
        }
    }
    Ok((folder.to_owned(), verdict))
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
    let Some(root) = root().map_err(refuse)? else {
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
    let moment = Moment {
        workspace: workspace_id,
        version,
        id: text("momentId"),
    };
    if let Some(source) = source.filter(|_| operation == "rename") {
        admit(tx, &root, &moment, source, true)?;
    }
    admit(tx, &root, &moment, path, operation == "delete")
}

/// The moment the check is admitting.
struct Moment<'a> {
    workspace: &'a str,
    version: &'a str,
    id: Option<&'a str>,
}

impl Moment<'_> {
    /// Whether the moment came from anything but capture. The payload names
    /// capture and Y.Doc settlement alike as a local file, so the row says.
    fn made_through_dohc(&self, tx: &Transaction<'_>) -> Result<bool, SyncError> {
        let Some(id) = self.id else {
            return Ok(false);
        };
        let origin: Option<String> = tx
            .query_row(
                "SELECT metadata_origin FROM moments WHERE workspace_id=?1 AND moment_id=?2",
                params![self.workspace, id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| SyncError::Storage(StorageError::corrupt_public(error)))?;
        Ok(origin.is_some_and(|origin| origin != CAPTURE_ORIGIN))
    }
}

fn admit(
    tx: &Transaction<'_>,
    root: &Path,
    moment: &Moment<'_>,
    path: &str,
    deletes: bool,
) -> Result<(), SyncError> {
    let (workspace, version) = (moment.workspace, moment.version);
    let own_rule = is_access_rule_path(path).then(|| access_rule_folder(path));
    if dohc_engine_sync::replaying_history() {
        // Enrolment puts committed history in order itself, rules first.
        // Only a rule on disk the store has not committed stops a file.
        if own_rule.is_none() {
            for folder in folders_of(path) {
                if clearance(workspace, version, folder).is_none() {
                    let clearance = judge_in_tx(tx, root, moment, folder, false, deletes)?;
                    set(workspace, version, folder, clearance);
                }
            }
        }
        return Ok(());
    }
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
                let clearance = judge_in_tx(tx, root, moment, folder, is_rule, deletes)?;
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
    moment: &Moment<'_>,
    folder: &str,
    is_rule: bool,
    deletes: bool,
) -> Result<Clearance, SyncError> {
    let (workspace, version) = (moment.workspace, moment.version);
    let reason = if is_rule {
        // A rule made through dohc commits as written. One from disk is
        // already in this transaction, so it is judged when the command ends.
        if moment.made_through_dohc(tx)? {
            return Ok(if deletes {
                Clearance::RuleLast
            } else {
                Clearance::RuleFirst
            });
        }
        ACCESS_RULE_WAITS
    } else {
        let scope = Scope {
            root,
            workspace_id: workspace,
            version_id: version,
            writer: Writer::Capture,
        };
        match judge_folder(tx, &scope, folder, &[], !deletes, &[]).map_err(sync_error)? {
            Plan::Verdict(Verdict::Clear(clearance)) => return Ok(clearance),
            // Until enrolment ends the workspace does not replicate, so
            // capture commits the rule as it finds it and nothing waits for
            // the owner. Enrolment waits for that, and records no hold.
            Plan::Verdict(Verdict::Held { .. } | Verdict::Refused { .. })
                if dohc_engine_sync::replaying_history() =>
            {
                signal(|signals| &signals.waits);
                return Err(retry(ACCESS_RULE_WAITS));
            }
            Plan::Verdict(Verdict::Held { .. } | Verdict::Refused { .. }) => ACCESS_RULE_HELD,
            Plan::Verdict(Verdict::Waits) | Plan::CommitRule(_) => ACCESS_RULE_WAITS,
        }
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
    /// A change made through dohc: a write, restore, merge or other
    /// operation the owner or their agent asked for. Its own rule changes
    /// commit as written, in order.
    Deliberate,
    /// Undo, replaying an operation backwards. It writes rules as written,
    /// but removes one the way a rule missing from disk goes: after the files
    /// under it, and only once none is left.
    Undo,
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
    Held {
        reason: &'static str,
    },
    /// The writer's own change cannot go now, and nothing waits for the
    /// owner: Undo would remove a rule over files it leaves behind.
    Refused {
        reason: &'static str,
    },
}

/// A folder's rule files on disk, by path.
type OnDisk = BTreeMap<String, Vec<u8>>;

/// One file of the rule last committed at a folder.
struct CommittedFile {
    sha256: String,
    /// `None` when it is binary.
    text: Option<String>,
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

/// Find the paths in exactly `folder` that may name its rule, without reading
/// the folder's other paths. `exists(low, high)` says whether a stored path
/// falls in that range; `read(low, high, name_start)` reads the paths there
/// whose name, from character `name_start`, holds no slash.
///
/// A name folds to `access.yaml` only if its characters before the first one
/// that is not ASCII spell `access.yaml` in some case. So the walk seeks only
/// the prefixes some stored path has, and reads names only where they leave
/// ASCII or once they spell the rule in full.
fn walk_rule_names(
    folder: &str,
    mut exists: impl FnMut(&str, &str) -> Result<bool, RuntimeError>,
    mut read: impl FnMut(&str, &str, i64) -> Result<(), RuntimeError>,
) -> Result<(), RuntimeError> {
    let (base, end) = folder_range(folder);
    // `substr` counts characters; a name starts after the folder's slash.
    let name_start = i64::try_from(base.chars().count() + 1).unwrap_or(i64::MAX);
    // Just past every path that starts with `prefix`, which ends in ASCII.
    let past = |prefix: &str| {
        let mut bytes = prefix.as_bytes().to_vec();
        match bytes.pop() {
            Some(last) if last < 0x7f => {
                bytes.push(last + 1);
                String::from_utf8(bytes).unwrap_or_else(|_| end.clone())
            }
            _ => end.clone(),
        }
    };
    let mut prefixes = vec![base.clone()];
    while let Some(prefix) = prefixes.pop() {
        let high = past(&prefix);
        let Some(&letter) = ACCESS_RULE_FILE.as_bytes().get(prefix.len() - base.len()) else {
            // Spelled in full; only dots and spaces may follow.
            read(&prefix, &high, name_start)?;
            continue;
        };
        // A name that leaves ASCII here folds by Unicode: read each one.
        read(&format!("{prefix}\u{80}"), &high, name_start)?;
        let (lower, upper) = (letter.to_ascii_lowercase(), letter.to_ascii_uppercase());
        for next in std::iter::once(lower).chain((upper != lower).then_some(upper)) {
            let candidate = format!("{prefix}{}", char::from(next));
            if exists(&candidate, &past(&candidate))? {
                prefixes.push(candidate);
            }
        }
    }
    Ok(())
}

/// The paths the store holds for `folder`'s rule files.
fn committed_rule_paths(
    conn: &Connection,
    workspace: &str,
    version: &str,
    folder: &str,
) -> Result<Vec<String>, RuntimeError> {
    let mut probe = conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 \
             AND path>=?3 AND path<?4)",
        )
        .map_err(StorageError::corrupt_public)?;
    let mut scan = conn
        .prepare_cached(
            "SELECT path FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 \
             AND path>=?3 AND path<?4 AND instr(substr(path, ?5), '/')=0",
        )
        .map_err(StorageError::corrupt_public)?;
    let mut rules = Vec::new();
    walk_rule_names(
        folder,
        |low, high| {
            probe
                .query_row(params![workspace, version, low, high], |row| row.get(0))
                .map_err(|error| StorageError::corrupt_public(error).into())
        },
        |low, high, name_start| {
            let paths = scan
                .query_map(params![workspace, version, low, high, name_start], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(StorageError::corrupt_public)?;
            for path in paths {
                let path = path.map_err(StorageError::corrupt_public)?;
                if is_rule_of(&path, folder) {
                    rules.push(path);
                }
            }
            Ok(())
        },
    )?;
    rules.sort_unstable();
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
                text: Some(snapshot.text),
                binary: false,
            },
            (None, Some(sha256)) => CommittedFile {
                sha256,
                text: None,
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
                params![workspace, version, path, file.sha256, CAPTURE_ORIGIN],
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

/// Why dohc could not read a folder's rule from disk.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Unread {
    /// Another program holds this rule file open without letting dohc read it.
    Locked(String),
    Other,
}

impl Unread {
    /// The refusal a decision gives while the rule can't be read: a held
    /// file says so, as a write to any held file does; anything else waits.
    fn refusal(self) -> RuntimeError {
        match self {
            Unread::Locked(_) => {
                RuntimeError::Materialize(dohc_engine_files::MaterializeError::FileLocked)
            }
            Unread::Other => waits(),
        }
    }
}

/// Read every file in exactly `folder` whose name folds to `access.yaml`.
fn read_disk_rule(root: &Path, folder: &str) -> Result<OnDisk, Unread> {
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
        Err(_) => return Err(Unread::Other),
    };
    let mut files = OnDisk::new();
    for entry in entries {
        let name = entry.map_err(|_| Unread::Other)?.file_name();
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
            Err(dohc_engine_files::MaterializeError::FileLocked) => {
                return Err(Unread::Locked(path));
            }
            Err(_) => return Err(Unread::Other),
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

/// The rule files to commit so the store matches `disk`: new files, then
/// changed ones, each in path order, then deletes. The caller must check
/// this order before committing it.
fn rule_changes(committed: Option<&Committed>, disk: &OnDisk) -> Vec<(String, Option<Vec<u8>>)> {
    let committed_sha = |path: &str| {
        committed
            .and_then(|committed| committed.files.get(path))
            .map(|file| file.sha256.clone())
    };
    let mut writes: Vec<_> = disk
        .iter()
        .filter(|(path, bytes)| committed_sha(path) != Some(dohc_engine_storage::hex_sha256(bytes)))
        .map(|(path, bytes)| (path.clone(), Some(bytes.clone())))
        .collect();
    // A stable sort keeps path order within new files and changed ones.
    writes.sort_by_key(|(path, _)| committed.is_some_and(|c| c.files.contains_key(path)));
    let deletes = committed
        .into_iter()
        .flat_map(|committed| committed.files.keys())
        .filter(|path| !disk.contains_key(*path))
        .map(|path| (path.clone(), None));
    writes.extend(deletes);
    writes
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

/// The files the store records under `folder`, other than its rule.
fn recorded_files(
    conn: &Connection,
    workspace: &str,
    version: &str,
    folder: &str,
) -> Result<Vec<String>, RuntimeError> {
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
    let mut files = Vec::new();
    for path in paths {
        let path = path.map_err(StorageError::corrupt_public)?;
        if !is_rule_of(&path, folder) {
            files.push(path);
        }
    }
    Ok(files)
}

/// Whether the store records a file under `folder`, other than its rule,
/// and whether one is still on disk.
fn folder_holds_files(
    conn: &Connection,
    root: &Path,
    workspace: &str,
    version: &str,
    folder: &str,
) -> Result<(bool, bool), RuntimeError> {
    let files = recorded_files(conn, workspace, version, folder)?;
    let on_disk = files
        .iter()
        .any(|path| std::fs::symlink_metadata(root.join(path)).is_ok());
    Ok((!files.is_empty(), on_disk))
}

/// A rule file dohc is still placing in a folder.
struct PendingRuleJob {
    path: String,
    /// The bytes a write places.
    content_sha256: String,
    /// The bytes the job expects to replace, or `None` for no file.
    preimage: Option<String>,
    deletes: bool,
}

/// The rule files dohc is still placing in `folder`.
fn pending_rule_jobs(
    conn: &Connection,
    workspace: &str,
    folder: &str,
) -> Result<Vec<PendingRuleJob>, RuntimeError> {
    let mut probe = conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM materialization_jobs WHERE workspace_id IN (?1,'') \
             AND status='pending' AND target_path>=?2 AND target_path<?3)",
        )
        .map_err(StorageError::corrupt_public)?;
    let mut scan = conn
        .prepare_cached(
            "SELECT target_path, content_sha256, operation='delete', \
             CASE WHEN preimage_present THEN preimage_sha256 END FROM materialization_jobs \
             WHERE workspace_id IN (?1,'') AND status='pending' AND target_path>=?2 \
             AND target_path<?3 AND instr(substr(target_path, ?4), '/')=0",
        )
        .map_err(StorageError::corrupt_public)?;
    let mut pending = Vec::new();
    walk_rule_names(
        folder,
        |low, high| {
            probe
                .query_row(params![workspace, low, high], |row| row.get(0))
                .map_err(|error| StorageError::corrupt_public(error).into())
        },
        |low, high, name_start| {
            let paths = scan
                .query_map(params![workspace, low, high, name_start], |row| {
                    Ok(PendingRuleJob {
                        path: row.get(0)?,
                        content_sha256: row.get(1)?,
                        deletes: row.get(2)?,
                        preimage: row.get(3)?,
                    })
                })
                .map_err(StorageError::corrupt_public)?;
            for job in paths {
                let job = job.map_err(StorageError::corrupt_public)?;
                if is_rule_of(&job.path, folder) {
                    pending.push(job);
                }
            }
            Ok(())
        },
    )?;
    Ok(pending)
}

/// Whether each rule file in `folder` on disk is the committed one, or, where
/// dohc is placing it, the bytes before or after that placement.
fn disk_matches_placement(
    root: &Path,
    folder: &str,
    pending: &[PendingRuleJob],
    committed: Option<&Committed>,
) -> bool {
    let Ok(disk) = read_disk_rule(root, folder) else {
        return false;
    };
    let mut paths: BTreeSet<&str> = disk.keys().map(String::as_str).collect();
    paths.extend(pending.iter().map(|job| job.path.as_str()));
    paths.extend(
        committed
            .iter()
            .flat_map(|own| own.files.keys().map(String::as_str)),
    );
    paths.into_iter().all(|path| {
        let on_disk = disk
            .get(path)
            .map(|bytes| dohc_engine_storage::hex_sha256(bytes));
        let on_disk = on_disk.as_deref();
        let mut jobs = pending.iter().filter(|job| job.path == path).peekable();
        if jobs.peek().is_none() {
            return on_disk
                == committed
                    .and_then(|own| own.files.get(path))
                    .map(|file| file.sha256.as_str());
        }
        jobs.any(|job| {
            let placed = (!job.deletes).then_some(job.content_sha256.as_str());
            on_disk == placed || on_disk == job.preimage.as_deref()
        })
    })
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
        // Zero files inherits from above, rather than hiding the folder.
        // Writes precede deletes, so zero can occur only at the final delete.
        // Decisions omit that step; capture judges removals separately.
        let rule = match files.len() {
            1 => files.values().next().and_then(Option::as_ref),
            _ => None,
        };
        rule_change_narrows(before, rule)
    })
}

/// Writes precede deletes. Only the first write into an empty folder or
/// the last remaining file before removal can expose one readable rule.
fn safe_rule_order(
    before: ReachBefore<'_>,
    committed: Option<&Committed>,
    mut changes: Vec<RuleChange>,
    include_final: bool,
) -> Option<Vec<RuleChange>> {
    if changes.len() > 1 {
        if committed.is_none() {
            let first = changes.iter().position(|(_, bytes)| {
                let rule = bytes
                    .as_deref()
                    .and_then(|bytes| std::str::from_utf8(bytes).ok())
                    .and_then(parse_access_rule);
                rule_change_narrows(before, rule.as_ref())
            })?;
            changes.swap(0, first);
        } else if let Some(own) = committed.filter(|own| {
            own.files.len() == changes.len() && changes.iter().all(|(_, bytes)| bytes.is_none())
        }) {
            let last = changes.iter().position(|(path, _)| {
                rule_change_narrows(
                    before,
                    own.files.get(path).and_then(|file| file.rule.as_ref()),
                )
            })?;
            let end = changes.len() - 1;
            changes.swap(last, end);
        }
    }
    let end = if include_final {
        changes.len()
    } else {
        changes.len().saturating_sub(1)
    };
    every_step_narrows(before, committed, &changes[..end]).then_some(changes)
}

/// Accept authorizes the final reach, but no intermediate rule may exceed
/// it. Hide may retain the previous reach while its files are recorded.
fn decision_rule_changes(
    conn: &Connection,
    workspace: &str,
    version: &str,
    folder: &str,
    committed: Option<&Committed>,
    disk: &OnDisk,
) -> Result<Option<Vec<RuleChange>>, RuntimeError> {
    let above = nearest_committed_above(conn, workspace, version, folder)?;
    let inherited = match &above {
        Some(above) => ReachBefore::Inherited(above.rule()),
        None => ReachBefore::WorkspaceLevel,
    };
    let target = (disk.len() == 1)
        .then(|| disk.values().next())
        .flatten()
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .and_then(parse_access_rule);
    let ceiling = match disk.len() {
        0 => inherited,
        1 => ReachBefore::Own(target.as_ref()),
        _ => committed.map_or(inherited, |own| ReachBefore::Own(own.rule())),
    };
    Ok(safe_rule_order(
        ceiling,
        committed,
        rule_changes(committed, disk),
        false,
    ))
}

fn judge_folder(
    conn: &Connection,
    order: &Scope<'_>,
    folder: &str,
    rule_touches: &[Touch<'_>],
    writes_under: bool,
    deletes_under: &[&str],
) -> Result<Plan, RuntimeError> {
    let (workspace, version) = (order.workspace_id, order.version_id);
    let committed = committed_rule(conn, workspace, version, folder)?;
    if order.writer != Writer::Capture && !rule_touches.is_empty() {
        // A change made through dohc goes as written. Only deleting every
        // file of the rule closes the folder behind it.
        let removes = rule_touches.iter().all(|touch| touch.deletes)
            && committed.as_ref().is_none_or(|committed| {
                committed
                    .files
                    .keys()
                    .all(|path| rule_touches.iter().any(|touch| touch.path == path))
            });
        if !removes {
            return Ok(Plan::Verdict(Verdict::Clear(Clearance::RuleFirst)));
        }
        // Undo widens nothing it was not asked to: the folder must be left
        // with no file the rule covered.
        if order.writer == Writer::Undo
            && (writes_under
                || recorded_files(conn, workspace, version, folder)?
                    .iter()
                    .any(|path| !deletes_under.contains(&path.as_str())))
        {
            return Ok(Plan::Verdict(Verdict::Refused {
                reason: access_rule_holds::REMOVED,
            }));
        }
        return Ok(Plan::Verdict(Verdict::Clear(Clearance::RuleLast)));
    }
    let pending = pending_rule_jobs(conn, workspace, folder)?;
    // dohc wrote this rule and its file is on the way to disk, unless capture
    // read other bytes there: those are judged like any rule on disk. A delete
    // is dohc's own only while dohc's own delete of that path is pending; a
    // pending write there leaves the file, so its loss came from outside.
    let placing = |touch: &Touch<'_>| {
        if touch.deletes {
            return pending
                .iter()
                .any(|job| job.deletes && job.path == touch.path);
        }
        touch.observed.is_none_or(|bytes| {
            let sha256 = dohc_engine_storage::hex_sha256(bytes);
            pending
                .iter()
                .any(|job| !job.deletes && job.path == touch.path && job.content_sha256 == sha256)
        })
    };
    // With no rule file captured, the disk must still show dohc's placement:
    // a rule changed there since is judged before the covered file.
    if !pending.is_empty()
        && rule_touches.iter().all(placing)
        && (!rule_touches.is_empty()
            || disk_matches_placement(order.root, folder, &pending, committed.as_ref()))
    {
        return Ok(Plan::Verdict(Verdict::Clear(Clearance::Open)));
    }
    let disk = match read_disk_rule(order.root, folder) {
        Ok(disk) => with_touches(disk, rule_touches),
        Err(_) => return Ok(Plan::Verdict(Verdict::Waits)),
    };
    let changes = rule_changes(committed.as_ref(), &disk);
    if changes.is_empty() {
        // Capture records the committed rule again; its moment dedupes.
        return Ok(Plan::Verdict(Verdict::Clear(Clearance::Open)));
    }
    if rule_touches.is_empty() && committed.as_ref().is_some_and(|c| !c.reached_disk) {
        return Ok(Plan::Verdict(Verdict::Clear(Clearance::Open)));
    }
    if disk.len() > 1 && access_rule_holds::hold_in(conn, workspace, version, folder)?.is_some() {
        return Ok(Plan::Verdict(Verdict::Held {
            reason: access_rule_holds::WIDENED,
        }));
    }
    if !settled(order.root, folder, &disk) {
        return Ok(Plan::Verdict(Verdict::Waits));
    }
    // Only a single covered change may use the writer's own moment. Several
    // changes must commit in the order judged here, before its batch runs.
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
        if rule_touches.is_empty() {
            return Ok(Plan::Verdict(Verdict::Clear(Clearance::DeletesOnly)));
        }
        let changes = match decision_rule_changes(
            conn,
            workspace,
            version,
            folder,
            committed.as_ref(),
            &disk,
        )? {
            Some(changes) => changes,
            None => {
                return Ok(Plan::Verdict(Verdict::Held {
                    reason: access_rule_holds::REMOVED,
                }));
            }
        };
        return Ok(match recorded {
            // The rule's delete waits for the deletes of its files.
            true => Plan::Verdict(Verdict::Waits),
            false if covered && changes.len() == 1 => {
                Plan::Verdict(Verdict::Clear(Clearance::RuleLast))
            }
            false => Plan::CommitRule(changes),
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
    let Some(changes) = safe_rule_order(before, committed.as_ref(), changes, true) else {
        return Ok(Plan::Verdict(Verdict::Held {
            reason: access_rule_holds::WIDENED,
        }));
    };
    Ok(if covered && changes.len() == 1 {
        Plan::Verdict(Verdict::Clear(Clearance::RuleFirst))
    } else {
        Plan::CommitRule(changes)
    })
}

/// What a writer's touches do under one folder.
#[derive(Default)]
struct Under<'a> {
    /// Its changes to the folder's own rule.
    rule: Vec<Touch<'a>>,
    /// Whether it writes a file under the folder.
    writes: bool,
    /// The files under the folder it deletes.
    deletes: Vec<&'a str>,
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
    let mut folders: BTreeMap<(usize, &str), Under<'_>> = BTreeMap::new();
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
                entry.rule.push(*touch);
            } else if touch.deletes {
                entry.deletes.push(touch.path);
            } else {
                entry.writes = true;
            }
        }
    }
    let mut verdicts: HashMap<&str, Verdict> = HashMap::new();
    for ((_, folder), under) in &folders {
        // A folder under one that waits or is held waits with it.
        let above = folders_of(folder)
            .into_iter()
            .filter(|above| above != folder)
            .find_map(|above| {
                verdicts
                    .get(above)
                    .filter(|v| !matches!(v, Verdict::Clear(_)))
            });
        let cleared = under
            .rule
            .is_empty()
            .then(|| clearance(order.workspace_id, order.version_id, folder))
            .flatten();
        let verdict = match (above, cleared) {
            (Some(_), _) => Verdict::Waits,
            (None, Some(cleared)) => Verdict::Clear(cleared),
            (None, None) => judge_one(
                store,
                order,
                folder,
                &under.rule,
                under.writes,
                &under.deletes,
            )?,
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
                    Some(Verdict::Held { reason } | Verdict::Refused { reason }) => {
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
    let Some(root) = ordering_root(store, workspace_id)? else {
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

/// Whether `error` is a folder's answer to a writer: it waits for its rule,
/// or is held for its owner.
pub(super) fn refused(error: &RuntimeError) -> bool {
    matches!(error, RuntimeError::AccessRuleHeld { .. })
        || matches!(
            error,
            RuntimeError::Sync(SyncError::RetryableState { reason }) if *reason == ACCESS_RULE_WAITS
        )
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
    let mut remaining: HashSet<_> = store
        .read_with(|conn| committed_rule_paths(conn, order.workspace_id, order.version_id, folder))?
        .into_iter()
        .collect();
    for (path, bytes) in changes {
        match bytes {
            Some(bytes) => {
                remaining.insert(path.clone());
                commit_disk_rule(store, order, folder, path, bytes)?;
            }
            None => {
                remaining.remove(&path);
                retire_rule(store, order, folder, path, remaining.is_empty())?;
            }
        }
        RULE_COMMITS.with(|commits| commits.set(commits.get() + 1));
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

/// What a hold records of the rule on disk: the bytes of its one file, or
/// `None` when it is gone or spelled more than once.
fn observed_sha256(disk: &OnDisk) -> Option<String> {
    match disk.len() {
        1 => disk
            .values()
            .next()
            .map(|bytes| dohc_engine_storage::hex_sha256(bytes)),
        _ => None,
    }
}

/// Whether a merged write of the rule at `path` waits to reach disk: the
/// Version still holds another spelling of the same rule, whose file holds
/// the name on a disk that ignores case. That spelling's merged delete places
/// it, through [`respelled_rule_writes`], so no conflict copy stands in for
/// the rule and the journal keeps a rule at every step.
pub(super) fn respelled_rule_waits(
    store: &EngineStore,
    workspace: &str,
    version: &str,
    path: &str,
) -> Result<bool, RuntimeError> {
    if !is_access_rule_path(path) {
        return Ok(false);
    }
    let key = path_collision_key(path);
    let spellings = store.read_with(|conn| {
        committed_rule_paths(conn, workspace, version, access_rule_folder(path))
    })?;
    Ok(spellings
        .iter()
        .any(|other| other != path && path_collision_key(other) == key))
}

/// The merged writes of other spellings of the rule at `path` that wait for
/// its delete.
pub(super) fn respelled_rule_writes(
    store: &EngineStore,
    workspace: &str,
    path: &str,
) -> Result<Vec<dohc_engine_storage::MaterializationJob>, RuntimeError> {
    if !is_access_rule_path(path) {
        return Ok(Vec::new());
    }
    let key = path_collision_key(path);
    Ok(store
        .list_pending_materialization_jobs()?
        .into_iter()
        .filter(|job| {
            job.workspace_id == workspace
                && job.target_path != path
                && job.job_id.starts_with("merge-mat_")
                && job.operation == dohc_engine_storage::MaterializationOperation::Write
                && job.preimage == dohc_engine_storage::Preimage::Absent
                && path_collision_key(&job.target_path) == key
        })
        .collect())
}

/// What a decision did beyond settling the folder.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct AccessRuleDecided {
    /// The rule files from outside dohc that Restore replaced or removed,
    /// each kept as a kept copy of its path.
    pub kept: Vec<String>,
}

/// One entry's reach at a held folder: before the change, and now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessRuleLevelChange {
    /// `members`, or a person's email.
    pub who: String,
    /// `view`, `comment`, `edit`, `none`, or `workspace` for the member's
    /// workspace level, which no rule from the root down sets.
    pub before: &'static str,
    pub after: &'static str,
}

/// What a held folder's notice shows, read from the store and disk when
/// the notice is listed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessRuleHoldView {
    pub hold: AccessRuleHold,
    /// Whether Accept can publish the change without a wider prefix.
    pub can_accept: bool,
    /// The rule dohc recorded at the folder, when it is one text file.
    pub recorded: Option<String>,
    /// The rule file on disk, when there is exactly one.
    pub rule_path: Option<String>,
    /// Members and each person a rule from the root down names, whose
    /// level at the folder changes, as the relay works it out from every
    /// rule above the folder as well as its own.
    pub changes: Vec<AccessRuleLevelChange>,
    /// Why dohc can't show a rule, when it can't: `recorded` for the rule
    /// it recorded, and for the rule on disk `locked` (another program
    /// holds it), `several-files` (more than one spelling), or `on-disk`.
    pub unreadable: Option<&'static str>,
    /// For a removal, the folder whose rule then applies; `None` when no
    /// rule above does, so members hold their workspace level.
    pub falls_back_to: Option<String>,
}

/// The rules dohc recorded from the workspace root down to a folder, the
/// folder's own included; `None` is a rule that cannot be read.
type Chain<'a> = Vec<Option<&'a AccessRule>>;

/// A member's reach at the end of `chain`, as the relay's `folderLevel`
/// works it out: each rule replaces the level above it, and one that leaves
/// the member out hides everything below it. `who` is a person's email, or
/// `None` for a member no rule names. `workspace` is the member's workspace
/// level, which the engine does not know.
fn chain_reach(chain: &[Option<&AccessRule>], who: Option<&str>) -> &'static str {
    let mut reach = "workspace";
    for rule in chain {
        let level = rule.and_then(|rule| match who {
            None => rule.members,
            Some(email) => level_for_email(rule, email),
        });
        match level {
            None => return "none",
            Some(level) => reach = level.as_str(),
        }
    }
    reach
}

/// Members first, then each person any rule on either chain names, with
/// their reach at the end of each chain, where it differs.
fn level_changes(
    before: &[Option<&AccessRule>],
    after: &[Option<&AccessRule>],
) -> Vec<AccessRuleLevelChange> {
    let people: std::collections::BTreeSet<&str> = before
        .iter()
        .chain(after)
        .flatten()
        .flat_map(|rule| rule.people.keys().map(String::as_str))
        .collect();
    std::iter::once(None)
        .chain(people.into_iter().map(Some))
        .map(|who| AccessRuleLevelChange {
            who: who.unwrap_or("members").to_owned(),
            before: chain_reach(before, who),
            after: chain_reach(after, who),
        })
        .filter(|change| change.before != change.after)
        .collect()
}

fn hold_view(
    conn: &Connection,
    root: &Path,
    hold: AccessRuleHold,
) -> Result<AccessRuleHoldView, RuntimeError> {
    let (workspace, version, folder) = (&hold.workspace_id, &hold.version_id, &hold.folder);
    let here = committed_rule(conn, workspace, version, folder)?;
    // The rules above the folder, nearest first.
    let mut above = Vec::new();
    let mut at = folder.as_str();
    while !at.is_empty() {
        at = access_rule_folder(at);
        if let Some(committed) = committed_rule(conn, workspace, version, at)? {
            above.push((at.to_owned(), committed));
        }
    }
    let recorded = here
        .as_ref()
        .and_then(|committed| match committed.files.len() {
            1 => committed
                .files
                .values()
                .next()
                .and_then(|file| file.text.clone()),
            _ => None,
        });
    let disk = read_disk_rule(root, folder);
    // Accept applies only the bytes the hold saw. A disk that holds others
    // since shows no changes and offers no Accept until capture judges it.
    let stale = disk
        .as_ref()
        .is_ok_and(|disk| observed_sha256(disk) != hold.observed_sha256);
    // The one rule file, or the one another program holds, so the notice
    // can name it.
    let rule_path = match &disk {
        Ok(disk) if disk.len() == 1 => disk.keys().next().cloned(),
        Err(Unread::Locked(path)) => Some(path.clone()),
        _ => None,
    };
    let mut view = AccessRuleHoldView {
        can_accept: match &disk {
            Ok(disk) if !stale => {
                decision_rule_changes(conn, workspace, version, folder, here.as_ref(), disk)?
                    .is_some()
            }
            _ => false,
        },
        recorded,
        rule_path,
        changes: Vec::new(),
        unreadable: None,
        falls_back_to: None,
        hold,
    };
    if here
        .as_ref()
        .is_some_and(|committed| committed.rule().is_none())
    {
        view.unreadable = Some("recorded");
    }
    let outer: Chain<'_> = above
        .iter()
        .rev()
        .map(|(_, committed)| committed.rule())
        .collect();
    let mut before = outer.clone();
    before.extend(here.as_ref().map(Committed::rule));
    if view.hold.reason == access_rule_holds::REMOVED {
        view.falls_back_to = above.first().map(|(at, _)| at.clone());
        if !stale {
            view.changes = level_changes(&before, &outer);
        }
        return Ok(view);
    }
    if view.unreadable.is_some() {
        return Ok(view);
    }
    let now = match rule_now(&disk) {
        Ok(now) => now,
        Err(why) => {
            view.unreadable = Some(why);
            return Ok(view);
        }
    };
    if stale {
        return Ok(view);
    }
    let mut after = outer;
    after.push(Some(&now));
    view.changes = level_changes(&before, &after);
    Ok(view)
}

/// The rule on disk a widened hold's notice compares, or why it can't.
fn rule_now(disk: &Result<OnDisk, Unread>) -> Result<AccessRule, &'static str> {
    match disk {
        Err(Unread::Locked(_)) => Err("locked"),
        Err(Unread::Other) => Err("on-disk"),
        Ok(disk) if disk.len() > 1 => Err("several-files"),
        Ok(disk) => disk
            .values()
            .next()
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .and_then(parse_access_rule)
            .ok_or("on-disk"),
    }
}

/// What the owner saw in a folder's hold when they decided.
struct SeenHold<'a> {
    /// The hold's `observed_sha256`.
    sha256: Option<&'a str>,
    /// The hold's reason.
    reason: &'a str,
}

/// Settle `folder` as its owner chose, if its rule on disk is still the one
/// they saw: the bytes and the reason its hold showed.
fn decide_on_store(
    store: &mut EngineStore,
    order: &Order<'_>,
    folder: &str,
    decision: AccessRuleDecision,
    seen: &SeenHold<'_>,
    self_writes: &dyn super::materialization::SelfWriteRecorder,
) -> Result<AccessRuleDecided, RuntimeError> {
    // Read under the capture gate, so no Version switch or other decision
    // lands between this check and the change.
    if !version_is_active(store, order)?
        || store
            .read_with(|conn| {
                access_rule_holds::hold_in(conn, order.workspace_id, order.version_id, folder)
            })?
            .is_none()
    {
        return Err(RuntimeError::AccessRuleNotHeld);
    }
    outer_rules_settle(store, order, folder)?;
    let disk = read_disk_rule(order.root, folder).map_err(Unread::refusal)?;
    // A rule gone and a rule spelled twice both record no bytes.
    let reason = if disk.is_empty() {
        access_rule_holds::REMOVED
    } else {
        access_rule_holds::WIDENED
    };
    if observed_sha256(&disk).as_deref() != seen.sha256 || reason != seen.reason {
        // Judge what is there now, so the hold the owner sees next is current.
        judge_one(store, order, folder, &[], false, &[])?;
        return Err(RuntimeError::AccessRuleChanged {
            folder: folder.to_owned(),
        });
    }
    let committed = store
        .read_with(|conn| committed_rule(conn, order.workspace_id, order.version_id, folder))?;
    let mut decided = AccessRuleDecided::default();
    match decision {
        AccessRuleDecision::Accept => {
            let Some(changes) = store.read_with(|conn| {
                decision_rule_changes(
                    conn,
                    order.workspace_id,
                    order.version_id,
                    folder,
                    committed.as_ref(),
                    &disk,
                )
            })?
            else {
                if !disk.is_empty() {
                    judge_one(store, order, folder, &[], false, &[])?;
                }
                return Err(RuntimeError::AccessRuleChanged {
                    folder: folder.to_owned(),
                });
            };
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
                    remove_rule(store, order, path, bytes, self_writes)?;
                    decided.kept.push(path.clone());
                }
            }
            for (path, file) in &files {
                let bytes = disk.get(path).map(Vec::as_slice);
                if bytes.map(dohc_engine_storage::hex_sha256).as_ref() != Some(&file.sha256) {
                    place_rule(store, order, path, &file.sha256, bytes, self_writes)?;
                    if bytes.is_some() {
                        decided.kept.push(path.clone());
                    }
                }
            }
        }
    }
    release_hold(store, order, folder)?;
    rejudge_holds_under(store, order, folder);
    Ok(decided)
}

/// Judge each hold under `folder` again, outer first, now that its rule is
/// decided: an inner rule the decided one now covers records, and its hold
/// goes with this decision rather than on some later capture pass.
fn rejudge_holds_under(store: &mut EngineStore, order: &Order<'_>, folder: &str) {
    let Ok(holds) = store.read_with(|conn| access_rule_holds::list_in(conn, order.workspace_id))
    else {
        return;
    };
    let mut under: Vec<String> = holds
        .into_iter()
        .filter(|hold| hold.version_id == order.version_id)
        .map(|hold| hold.folder)
        .filter(|inner| {
            inner != folder && (folder.is_empty() || inner.starts_with(&format!("{folder}/")))
        })
        .collect();
    under.sort_by_key(|inner| inner.matches('/').count());
    for inner in under {
        // The decision already took effect, so a judgment that fails leaves
        // this hold for capture to judge again; it doesn't fail the decision.
        let _ = judge_one(store, order, &inner, &[], false, &[]);
    }
}

fn version_is_active(store: &mut EngineStore, order: &Order<'_>) -> Result<bool, RuntimeError> {
    Ok(dohc_engine_domain::VersionedTextStore::new(store)
        .get_active_version(order.workspace_id)?
        .version_id
        == order.version_id)
}

/// The folders above `folder` settle first: their own holds answer for them.
fn outer_rules_settle(
    store: &mut EngineStore,
    order: &Order<'_>,
    folder: &str,
) -> Result<(), RuntimeError> {
    for above in folders_of(&rule_path(folder)) {
        if above == folder {
            continue;
        }
        match judge_one(store, order, above, &[], false, &[])? {
            Verdict::Clear(_) => {}
            Verdict::Waits => return Err(waits()),
            Verdict::Held { reason } | Verdict::Refused { reason } => {
                return Err(RuntimeError::AccessRuleHeld {
                    folder: above.to_owned(),
                    reason,
                });
            }
        }
    }
    Ok(())
}

/// Keep the rule from outside dohc at `path` as a kept copy before Restore
/// replaces or removes it, so the owner can still save it. A Restore tried
/// again after its placement waited finds the copy it kept already.
fn keep_outside_rule(
    store: &EngineStore,
    order: &Order<'_>,
    path: &str,
    bytes: &[u8],
) -> Result<(), RuntimeError> {
    let sha256 = dohc_engine_storage::hex_sha256(bytes);
    let kept = store.list_kept_displacements(order.workspace_id)?;
    if kept.iter().any(|copy| {
        copy.job_id.starts_with("access-rule-kept_")
            && copy.target_path == path
            && copy
                .displaced_sha256
                .as_deref()
                .unwrap_or(&copy.expected_sha256)
                == sha256
    }) {
        return Ok(());
    }
    let job_id = format!(
        "access-rule-kept_{}_{}",
        dohc_engine_storage::hex_sha256(path.as_bytes()),
        order.now_ms
    );
    dohc_engine_files::materialize::keep_copy_before_change(
        store,
        order.root,
        order.workspace_id,
        &job_id,
        path,
        bytes,
        order.now_ms,
        dohc_engine_files::materialize::DurabilityPolicy::per_os(),
    )?;
    Ok(())
}

fn judge_one(
    store: &mut EngineStore,
    order: &Order<'_>,
    folder: &str,
    rule_touches: &[Touch<'_>],
    writes_under: bool,
    deletes_under: &[&str],
) -> Result<Verdict, RuntimeError> {
    let plan = store.read_with(|conn| {
        judge_folder(
            conn,
            &order.scope(),
            folder,
            rule_touches,
            writes_under,
            deletes_under,
        )
    })?;
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
            let observed = read_disk_rule(order.root, folder)
                .ok()
                .and_then(|disk| observed_sha256(&disk));
            record_hold(store, order, folder, reason, observed)?;
        }
        Verdict::Waits | Verdict::Refused { .. } => {}
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
    // The materializer replaces only bytes the store holds. The rule it
    // displaces stays as a kept copy the owner can save.
    if let Some(bytes) = disk {
        keep_outside_rule(store, order, path, bytes)?;
    }
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

/// Remove a rule nothing committed through an ordinary delete, which moves
/// it aside and puts back any bytes other than the ones judged here. It stays
/// as a kept copy, as the rule [`place_rule`] displaces does.
fn remove_rule(
    store: &mut EngineStore,
    order: &Order<'_>,
    path: &str,
    judged: &[u8],
    self_writes: &dyn super::materialization::SelfWriteRecorder,
) -> Result<(), RuntimeError> {
    keep_outside_rule(store, order, path, judged)?;
    let judged_sha256 = dohc_engine_storage::hex_sha256(judged);
    let job_id = format!(
        "access-rule-remove_{}_{}",
        dohc_engine_storage::hex_sha256(path.as_bytes()),
        order.now_ms
    );
    let spec = dohc_engine_storage::MaterializationJobSpec {
        job_id: job_id.clone(),
        workspace_id: order.workspace_id.to_owned(),
        target_path: path.to_owned(),
        content_sha256: judged_sha256.clone(),
        preimage: dohc_engine_storage::Preimage::Present(judged_sha256),
        target_generation: order.now_ms,
        now_ms: order.now_ms,
    };
    committed(store.write_with(order.faults, |tx| {
        dohc_engine_storage::put_binary_blob(tx, judged)?;
        dohc_engine_storage::enqueue_delete_job(tx, &spec)
    })?)?;
    let removed = super::materialization::materialize_expected_job(
        store,
        order.root,
        order.workspace_id,
        &job_id,
        self_writes,
        order.now_ms,
        order.faults,
        None,
    );
    if removed { Ok(()) } else { Err(waits()) }
}

/// Why the engine refused to order a merge's rule changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuleMergeRefusal {
    /// No order of single writes keeps everyone within what the target gives
    /// them before and after the merge.
    Widens,
    /// Ordering reached its work limit before it found an order. One may
    /// still exist.
    TooMany,
    /// A rule changes in a folder whose name differs from another folder's
    /// only as a disk that ignores case or Unicode form would read it, and
    /// the merge does more there than respell the folder, apart from its
    /// other rule changes. The relay hides both folders when either rule
    /// leaves a member out, which the order judges only for a respelling.
    FoldedNames,
}

impl RuleMergeRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Widens => "widens",
            Self::TooMany => "too-many",
            Self::FoldedNames => "folded-names",
        }
    }
}

/// The order a merge makes its rule changes in, or why it can't.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuleMergeOrder {
    /// Write these rules, merge the other files, then delete these. A rule
    /// the merge leaves as the target has it, or that conflicts, is in
    /// neither list: its merge writes nothing.
    Ordered {
        writes: Vec<String>,
        deletes: Vec<String>,
    },
    /// The merge must write nothing. `rules` are the ones it could not order.
    Refused {
        reason: RuleMergeRefusal,
        rules: Vec<String>,
    },
}

/// A rule file dohc can't read as text. It hides its folder, as an
/// unreadable rule does.
const UNREADABLE_RULE: &[u8] = b"\xff";

/// A rule file's bytes in `version`, or `None` when it has none there.
fn version_rule_bytes(
    conn: &Connection,
    workspace: &str,
    version: &str,
    path: &str,
) -> Result<Option<Vec<u8>>, RuntimeError> {
    let state = dohc_engine_domain::select_snapshot_by_path_in_tx(conn, workspace, version, path)?;
    Ok(match (state.snapshot, state.binary_sha256) {
        (Some(snapshot), _) => Some(snapshot.text.into_bytes()),
        (None, Some(_)) => Some(UNREADABLE_RULE.to_vec()),
        (None, None) => None,
    })
}

/// The rule files `version` holds at or under `folder`, taking one unit of
/// `work` for each path read. The workspace's own rule reads every path.
/// `None` when the work runs out first.
fn rule_paths_under(
    conn: &Connection,
    workspace: &str,
    version: &str,
    folder: &str,
    work: &mut RuleOrderWork,
) -> Result<Option<Vec<String>>, RuntimeError> {
    let (low, high) = folder_range(folder);
    let mut scan = conn
        .prepare_cached(
            "SELECT path FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 \
             AND path>=?3 AND path<?4",
        )
        .map_err(StorageError::corrupt_public)?;
    let paths = scan
        .query_map(params![workspace, version, low, high], |row| {
            row.get::<_, String>(0)
        })
        .map_err(StorageError::corrupt_public)?;
    let mut rules = Vec::new();
    for path in paths {
        let path = path.map_err(StorageError::corrupt_public)?;
        if work.take(1).is_none() {
            return Ok(None);
        }
        if is_access_rule_path(&path) {
            rules.push(path);
        }
    }
    Ok(Some(rules))
}

/// The rule files `version` holds in exactly `folder`, taking `work` for
/// the look and for each one found. `None` when the work runs out first.
fn charged_rule_paths(
    conn: &Connection,
    workspace: &str,
    version: &str,
    folder: &str,
    work: &mut RuleOrderWork,
) -> Result<Option<Vec<String>>, RuntimeError> {
    if work.take(1).is_none() {
        return Ok(None);
    }
    let rules = committed_rule_paths(conn, workspace, version, folder)?;
    Ok(work.take(rules.len()).map(|()| rules))
}

/// What a merge's rule changes would do to the target as the store holds it
/// now: the target's rules around them, and, for each rule the merge would
/// write or delete, its path with the bytes it would write, or `None` for a
/// delete. Each rule's outcome is the one the per-file merge acts on.
/// `folded` holds the steps in a folder whose name folds together with
/// another folder's, and `before` also holds every rule in such folders.
struct RuleMergeSteps {
    before: BTreeMap<String, Vec<u8>>,
    steps: Vec<(String, Option<Vec<u8>>)>,
    folded: BTreeSet<String>,
}

/// Reading the store takes from `work`, which ordering goes on to use: each
/// path read, each rule compared or planned by its text, and each rule kept.
/// `None` when the work runs out first.
fn rule_merge_steps(
    conn: &Connection,
    workspace: &str,
    source: &str,
    target: &str,
    paths: &[String],
    work: &mut RuleOrderWork,
) -> Result<Option<RuleMergeSteps>, RuntimeError> {
    let mut steps = Vec::new();
    for path in paths {
        if work.take(1).is_none() {
            return Ok(None);
        }
        let comparison = compare_text_file_versions_in_db(
            conn,
            &CompareTextFileVersions {
                workspace_id: workspace.to_owned(),
                target_version_id: target.to_owned(),
                source_version_id: source.to_owned(),
                path: path.clone(),
            },
        )?;
        // The plan reads and may merge each side's text.
        let text: usize = [&comparison.base, &comparison.current, &comparison.incoming]
            .into_iter()
            .flatten()
            .filter(|side| !side.binary)
            .map(|side| side.snapshot.text.len())
            .sum();
        if work.take_bytes(text).is_none() {
            return Ok(None);
        }
        let bytes = match plan_file_merge(&comparison) {
            FileMergePlan::WriteText(text) => Some(text.into_bytes()),
            FileMergePlan::WriteBinary => Some(UNREADABLE_RULE.to_vec()),
            FileMergePlan::Delete => None,
            FileMergePlan::Unchanged(_) | FileMergePlan::Conflict => continue,
        };
        steps.push((path.clone(), bytes));
    }
    // One step goes straight from before to after, so neither the planner
    // nor the writer's check reads the rules around it.
    if steps.len() < 2 {
        return Ok(Some(RuleMergeSteps {
            before: BTreeMap::new(),
            steps,
            folded: BTreeSet::new(),
        }));
    }
    let Some((folded, spellings)) =
        folded_folders(conn, workspace, &steps, [target, source], work)?
    else {
        return Ok(None);
    };
    // Reach changes only at and under a changed folder, and there it also
    // depends on the rules above.
    let folders: BTreeSet<&str> = steps
        .iter()
        .map(|(path, _)| access_rule_folder(path))
        .collect();
    let mut paths = BTreeSet::new();
    for folder in folders {
        let Some(under) = rule_paths_under(conn, workspace, target, folder, work)? else {
            return Ok(None);
        };
        paths.extend(under);
        let mut above = folder;
        while !above.is_empty() {
            above = above.rsplit_once('/').map_or("", |(parent, _)| parent);
            let Some(rules) = charged_rule_paths(conn, workspace, target, above, work)? else {
                return Ok(None);
            };
            paths.extend(rules);
        }
    }
    // A respelling is judged against the rules in every spelling.
    for spelling in &spellings {
        let Some(rules) = charged_rule_paths(conn, workspace, target, spelling, work)? else {
            return Ok(None);
        };
        paths.extend(rules);
    }
    let mut before = BTreeMap::new();
    for path in paths {
        if let Some(bytes) = version_rule_bytes(conn, workspace, target, &path)? {
            if work.take_bytes(bytes.len()).is_none() {
                return Ok(None);
            }
            before.insert(path, bytes);
        }
    }
    Ok(Some(RuleMergeSteps {
        before,
        steps,
        folded,
    }))
}

impl RuleMergeSteps {
    fn rule_steps(&self) -> Vec<RuleFileStep<'_>> {
        self.steps
            .iter()
            .map(|(path, bytes)| match bytes {
                Some(bytes) => RuleFileStep::Write(path, bytes),
                None => RuleFileStep::Delete(path),
            })
            .collect()
    }
}

/// The steps in folded folders, and every spelling of those folders.
type FoldedFolders = (BTreeSet<String>, BTreeSet<String>);

/// The steps in a folder whose name folds together with another folder's
/// that `versions` hold a path in, or that another step names, and every
/// spelling of those folders. `None` when the work runs out first.
///
/// A name can fold to another depth: NFKC reads `a／x` as `a/x` and `℅` as
/// `c/o`, and a top folder whose name folds to nothing, such as `．`, as the
/// root. So the key of every folder each path is in is compared, whatever
/// its depth, and the root is a spelling of the empty key.
fn folded_folders(
    conn: &Connection,
    workspace: &str,
    steps: &[(String, Option<Vec<u8>>)],
    versions: [&str; 2],
    work: &mut RuleOrderWork,
) -> Result<Option<FoldedFolders>, RuntimeError> {
    let mut spellings: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (path, _) in steps {
        let folder = access_rule_folder(path);
        spellings
            .entry(path_collision_key(folder))
            .or_default()
            .insert(folder.to_owned());
    }
    if let Some(names) = spellings.get_mut("") {
        names.insert(String::new());
    }
    let mut scan = conn
        .prepare_cached("SELECT path FROM path_aliases WHERE workspace_id=?1 AND version_id=?2")
        .map_err(StorageError::corrupt_public)?;
    let mut seen = HashSet::new();
    for version in versions {
        let paths = scan
            .query_map(params![workspace, version], |row| row.get::<_, String>(0))
            .map_err(StorageError::corrupt_public)?;
        for path in paths {
            let path = path.map_err(StorageError::corrupt_public)?;
            if work.take(1).is_none() {
                return Ok(None);
            }
            // Deepest first: a folder seen before had every folder above it
            // seen too.
            let mut folder = path.as_str();
            while let Some((parent, _)) = folder.rsplit_once('/') {
                folder = parent;
                if seen.contains(folder) {
                    break;
                }
                if work.take(1).is_none() {
                    return Ok(None);
                }
                seen.insert(folder.to_owned());
                if let Some(names) = spellings.get_mut(&path_collision_key(folder)) {
                    names.insert(folder.to_owned());
                }
            }
        }
    }
    let (mut folded, mut twins) = (BTreeSet::new(), BTreeSet::new());
    for (path, _) in steps {
        let key = path_collision_key(access_rule_folder(path));
        if let Some(names) = spellings.get(&key).filter(|names| names.len() > 1) {
            folded.insert(path.clone());
            twins.extend(names.iter().cloned());
        }
    }
    Ok(Some((folded, twins)))
}

/// Every rule file either version holds. The scan keeps only rule paths,
/// which `rule_merge_steps` charges before it compares them. Charging every
/// path read here too would refuse even a one-rule merge in a version of
/// about a million paths, which the planner lets through.
fn version_rule_paths(
    conn: &Connection,
    workspace: &str,
    versions: [&str; 2],
) -> Result<Vec<String>, RuntimeError> {
    let mut scan = conn
        .prepare_cached("SELECT path FROM path_aliases WHERE workspace_id=?1 AND version_id=?2")
        .map_err(StorageError::corrupt_public)?;
    let mut rules = BTreeSet::new();
    for version in versions {
        let paths = scan
            .query_map(params![workspace, version], |row| row.get::<_, String>(0))
            .map_err(StorageError::corrupt_public)?;
        for path in paths {
            let path = path.map_err(StorageError::corrupt_public)?;
            if is_access_rule_path(&path) {
                rules.insert(path);
            }
        }
    }
    Ok(rules.into_iter().collect())
}

/// The order a merge from `source` into `target` makes its rule changes in,
/// so that no single step gives any member more anywhere than `target`
/// before and after the merge do. `writes` and `deletes` are the rule paths
/// that differ between the two. Each is judged by what its merge would write.
fn merge_rule_order(
    conn: &Connection,
    workspace: &str,
    source: &str,
    target: &str,
    writes: &[String],
    deletes: &[String],
) -> Result<RuleMergeOrder, RuntimeError> {
    let paths: Vec<String> = writes.iter().chain(deletes).cloned().collect();
    let mut work = RuleOrderWork::default();
    let Some(merge) = rule_merge_steps(conn, workspace, source, target, &paths, &mut work)? else {
        return Ok(RuleMergeOrder::Refused {
            reason: RuleMergeRefusal::TooMany,
            rules: paths,
        });
    };
    let steps = merge.rule_steps();
    let (write_steps, delete_steps): (Vec<_>, Vec<_>) = steps
        .into_iter()
        .partition(|step| matches!(step, RuleFileStep::Write(..)));
    let path = |step: &RuleFileStep<'_>| match *step {
        RuleFileStep::Write(path, _) | RuleFileStep::Delete(path) => path.to_owned(),
    };
    let paths = |list: &[RuleFileStep<'_>], indexes: Vec<usize>| -> Vec<String> {
        indexes
            .into_iter()
            .map(|index| path(&list[index]))
            .collect()
    };
    let refused = |reason, writes: Vec<usize>, deletes: Vec<usize>| RuleMergeOrder::Refused {
        reason,
        rules: paths(&write_steps, writes)
            .into_iter()
            .chain(paths(&delete_steps, deletes))
            .collect(),
    };
    Ok(
        match safe_rule_file_order(
            &merge.before,
            &write_steps,
            &delete_steps,
            &merge.folded,
            &mut work,
        ) {
            RuleFileOrder::Safe { writes, deletes } => RuleMergeOrder::Ordered {
                writes: paths(&write_steps, writes),
                deletes: paths(&delete_steps, deletes),
            },
            RuleFileOrder::Widens { writes, deletes } => {
                refused(RuleMergeRefusal::Widens, writes, deletes)
            }
            RuleFileOrder::TooMany { writes, deletes } => {
                refused(RuleMergeRefusal::TooMany, writes, deletes)
            }
            RuleFileOrder::Folded { writes, deletes } => {
                refused(RuleMergeRefusal::FoldedNames, writes, deletes)
            }
        },
    )
}

/// Refuses a merge's rule write unless `order`, the rule being merged first,
/// holds every rule change the merge still has to make, as the engine reads
/// them from the version and the target now, and making them in that order,
/// one at a time, keeps everyone within what the target gives them before
/// and after. The order comes from the caller, and Main or the version may
/// have changed since it was planned. Running out of work refuses too.
pub(super) fn check_rule_merge_order(
    conn: &Connection,
    input: &MergeTextFileFromVersion,
    order: &[String],
) -> Result<(), RuntimeError> {
    let (workspace, source, target) = (
        input.workspace_id.as_str(),
        input.source_version_id.as_str(),
        input.target_version_id.as_str(),
    );
    let mut work = RuleOrderWork::default();
    let rules = version_rule_paths(conn, workspace, [target, source])?;
    let Some(merge) = rule_merge_steps(conn, workspace, source, target, &rules, &mut work)? else {
        return Err(RuntimeError::RuleMergeOrderChanged);
    };
    let place: HashMap<&str, usize> = order
        .iter()
        .enumerate()
        .map(|(index, path)| (path.as_str(), index))
        .collect();
    let mut steps = Vec::with_capacity(merge.steps.len());
    for step in merge.rule_steps() {
        let (RuleFileStep::Write(path, _) | RuleFileStep::Delete(path)) = step;
        let Some(&index) = place.get(path) else {
            return Err(RuntimeError::RuleMergeOrderChanged);
        };
        steps.push((index, step));
    }
    steps.sort_by_key(|(index, _)| *index);
    let steps: Vec<RuleFileStep<'_>> = steps.into_iter().map(|(_, step)| step).collect();
    if rule_file_order_is_safe(&merge.before, &steps, &merge.folded, &mut work) {
        Ok(())
    } else {
        Err(RuntimeError::RuleMergeOrderChanged)
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

    /// The order a merge from `source_version_id` makes the changes to these
    /// rule files in, so that no step widens anyone's reach past both the
    /// target before and after it, judged by what each rule's merge writes.
    pub async fn access_rule_merge_order(
        &self,
        workspace_id: String,
        source_version_id: String,
        target_version_id: String,
        writes: Vec<String>,
        deletes: Vec<String>,
    ) -> Result<RuleMergeOrder, RuntimeError> {
        self.run(move |store, _| {
            store.read_with(|conn| {
                merge_rule_order(
                    conn,
                    &workspace_id,
                    &source_version_id,
                    &target_version_id,
                    &writes,
                    &deletes,
                )
            })
        })
        .await
    }

    /// What each of `holds` shows its owner: who reaches the folder
    /// differently, read from the store and the rule on disk now.
    pub async fn access_rule_hold_views(
        &self,
        root: std::path::PathBuf,
        holds: Vec<AccessRuleHold>,
    ) -> Result<Vec<AccessRuleHoldView>, RuntimeError> {
        self.run(move |store, _| {
            store.read_with(|conn| {
                holds
                    .into_iter()
                    .map(|hold| hold_view(conn, &root, hold))
                    .collect()
            })
        })
        .await
    }

    /// Settle a held folder: accept what is on disk, or restore the rule
    /// last committed. Either takes effect at once; the files under the
    /// folder follow on the next capture pass. A rule on disk other than the
    /// one the owner saw, by bytes or by reason, refuses with
    /// [`RuntimeError::AccessRuleChanged`].
    #[allow(clippy::too_many_arguments)]
    pub async fn decide_access_rule(
        &self,
        workspace_id: String,
        version_id: String,
        folder: String,
        decision: AccessRuleDecision,
        expected_sha256: Option<String>,
        expected_reason: String,
        root: std::path::PathBuf,
        self_writes: std::sync::Arc<dyn super::materialization::SelfWriteRecorder>,
        now_ms: i64,
        faults: std::sync::Arc<dyn FaultInjector>,
    ) -> Result<AccessRuleDecided, RuntimeError> {
        self.run(move |store, _| {
            begin_command();
            check_root()?;
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
            decide_on_store(
                store,
                &order,
                &folder,
                decision,
                &SeenHold {
                    sha256: expected_sha256.as_deref(),
                    reason: &expected_reason,
                },
                self_writes.as_ref(),
            )
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rule lookup seeks prefixes rather than reading every name in a
    /// folder, and must still find each spelling a full read would.
    #[test]
    fn finds_every_spelling_of_a_rule_a_full_read_finds() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE path_aliases (workspace_id TEXT, version_id TEXT, path TEXT, \
             object_id TEXT, PRIMARY KEY (workspace_id, version_id, path)); \
             CREATE TABLE materialization_jobs (workspace_id TEXT, target_path TEXT, \
             content_sha256 TEXT, preimage_present INTEGER, preimage_sha256 TEXT, status TEXT, \
             operation TEXT, PRIMARY KEY (workspace_id, target_path))",
        )
        .unwrap();
        let names = [
            "access.yaml",
            "ACCESS.YAML",
            "Access.yaml.",
            "access.yaml ",
            "a\u{200B}ccess.yaml",
            "\u{FF41}ccess.yaml",
            "acce\u{DF}.yaml",
            "acc\u{E9}ss.yaml",
            "access.yaml.tmp",
            "access.yml",
            "apps",
            "b.md",
            "\u{65E5}\u{672C}.md",
        ];
        let mut paths = Vec::new();
        for folder in ["", "T", "T/sub", "\u{65E5}\u{672C}"] {
            for name in names {
                let path = if folder.is_empty() {
                    name.to_owned()
                } else {
                    format!("{folder}/{name}")
                };
                paths.push(format!("{path}/access.yaml"));
                paths.push(path);
            }
        }
        paths.extend(["T0".to_owned(), "Tx/access.yaml".to_owned()]);
        for path in &paths {
            conn.execute(
                "INSERT INTO path_aliases VALUES ('ws','main',?1,'o')",
                [path],
            )
            .unwrap();
            // Every rule but those in `T/sub` is still on its way to disk.
            let status = if path.starts_with("T/sub/") {
                "complete"
            } else {
                "pending"
            };
            conn.execute(
                "INSERT INTO materialization_jobs \
                 (workspace_id,target_path,content_sha256,preimage_present,status,operation) \
                 VALUES ('ws',?1,'sha',0,?2,'write')",
                [path.as_str(), status],
            )
            .unwrap();
        }
        for folder in ["", "T", "T/sub", "T/apps", "\u{65E5}\u{672C}", "U"] {
            assert_eq!(
                !pending_rule_jobs(&conn, "ws", folder).unwrap().is_empty(),
                folder != "T/sub" && paths.iter().any(|path| is_rule_of(path, folder)),
                "pending in {folder:?}"
            );
            let mut expected: Vec<String> = paths
                .iter()
                .filter(|path| is_rule_of(path, folder))
                .cloned()
                .collect();
            expected.sort_unstable();
            assert_eq!(
                committed_rule_paths(&conn, "ws", "main", folder).unwrap(),
                expected,
                "folder {folder:?}"
            );
        }
        assert_eq!(
            committed_rule_paths(&conn, "ws", "main", "T")
                .unwrap()
                .len(),
            7,
            "seven of the names fold to the rule"
        );
    }

    /// Enrolment backfills history recorded before the workspace replicated.
    /// Rules go before the files they cover, and the last delete of a rule
    /// since removed goes after them. A rule removed and written again in one
    /// folder replays as it happened, which the in-command order would refuse.
    #[test]
    fn enrolment_backfills_rules_before_their_files() {
        use dohc_engine_domain::{DeleteTextFile, VersionedTextStore, WriteText};
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let db = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&db, 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .unwrap();
        let (view, nobody) = ("members: view\n", "people: {}\n");
        let history: [(&str, Option<&str>); 14] = [
            ("team/a.md", Some("alpha")),
            ("team/access.yaml", Some(view)),
            ("crew/access.yaml", Some(nobody)),
            ("crew/b.md", Some("beta")),
            ("crew/b.md", None),
            ("crew/access.yaml", None),
            ("ops/access.yaml", Some(view)),
            ("ops/access.yaml", None),
            ("ops/access.yaml", Some(nobody)),
            ("ops/c.md", Some("gamma")),
            ("dev/access.yaml", Some(view)),
            ("dev/access.yaml", None),
            ("dev/access.yaml", Some(nobody)),
            ("dev/access.yaml", None),
        ];
        for (index, (path, text)) in history.into_iter().enumerate() {
            let moment_id = format!("m-{index}");
            let mut versioned = VersionedTextStore::new(&mut store);
            match text {
                Some(text) => drop(
                    versioned
                        .write_text(
                            &WriteText {
                                workspace_id: "ws".to_owned(),
                                version_id: "main".to_owned(),
                                object_id: format!("object-{index}"),
                                path: path.to_owned(),
                                text: text.to_owned(),
                                moment_id,
                                metadata_origin: "cli".to_owned(),
                                metadata_summary: None,
                                metadata_correlation_id: None,
                                author_json: None,
                                now_ms: 10,
                                request_id: None,
                            },
                            &NoFaults,
                        )
                        .unwrap(),
                ),
                None => drop(
                    versioned
                        .delete_text_file(
                            &DeleteTextFile {
                                workspace_id: "ws".to_owned(),
                                version_id: "main".to_owned(),
                                path: path.to_owned(),
                                moment_id,
                                request_id: None,
                                metadata_origin: "cli".to_owned(),
                                metadata_summary: None,
                                metadata_correlation_id: None,
                                author_json: None,
                                now_ms: 10,
                            },
                            &NoFaults,
                        )
                        .unwrap(),
                ),
            }
        }
        let identity = EngineDbIdentity::of_existing(&db).unwrap();
        install(&db, &identity, true, Arc::new(AccessRuleSignals::default())).unwrap();
        begin_command();
        dohc_engine_sync::adopt_join_identity(
            &mut store, "ws", "local", "epoch", "stream", 20, &NoFaults,
        )
        .unwrap();
        dohc_engine_sync::commit_relay_cursor(
            &mut store,
            "ws",
            &dohc_engine_sync::RelayCursor {
                cursor: 1,
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
                bootstrap_complete: true,
                settlement_report_id: None,
                ordinary_pull: None,
            },
            &NoFaults,
            &dohc_engine_sync::NoLiveLeases,
            30,
        )
        .expect("enrol");
        let journal: Vec<String> = store
            .read_with(|conn| {
                conn.prepare(
                    "SELECT json_extract(payload_json,'$.operation') || ' ' || \
                     json_extract(payload_json,'$.path') FROM replication_log \
                     WHERE workspace_id='ws' AND op_kind='moment.append' ORDER BY origin_seq",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()
            })
            .unwrap();
        assert_eq!(
            journal,
            [
                "write team/access.yaml",
                "write crew/access.yaml",
                "write ops/access.yaml",
                "delete ops/access.yaml",
                "write ops/access.yaml",
                "write dev/access.yaml",
                "delete dev/access.yaml",
                "write dev/access.yaml",
                "write team/a.md",
                "write crew/b.md",
                "delete crew/b.md",
                "write ops/c.md",
                "delete crew/access.yaml",
                "delete dev/access.yaml",
            ]
        );
    }

    /// Rules order only once a workspace replicates. A widening captured
    /// before then is committed history: enrolment journals it as it stands,
    /// with no hold, so it reaches members at sharing without a Notice. A
    /// widening on disk that nothing committed yet makes enrolment wait, with
    /// no hold: capture commits it as it would any rule before sharing, and
    /// the next attempt journals it like the first case.
    #[test]
    fn a_rule_widened_before_enrolment() {
        use dohc_engine_domain::VersionedTextStore;
        let (view, edit) = ("members: view\n", "members: edit\n");
        let mut seen = Vec::new();
        for captured in [true, false] {
            let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
            let root = std::path::absolute(scratch.path()).unwrap();
            let db = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
            let mut store = EngineStore::open(&db, 1).unwrap();
            VersionedTextStore::new(&mut store)
                .ensure_main_version("ws", "main", 1, &NoFaults)
                .unwrap();
            let mut history = vec![("team/access.yaml", view), ("team/a.md", "alpha")];
            if captured {
                history.push(("team/access.yaml", edit));
            }
            for (path, text) in history {
                ingest(&mut store, path, text).unwrap();
            }
            put_settled(&root, "team/a.md", "alpha");
            put_settled(&root, "team/access.yaml", edit);
            let identity = EngineDbIdentity::of_existing(&db).unwrap();
            let signals = Arc::new(AccessRuleSignals::default());
            install(&db, &identity, true, signals.clone()).unwrap();
            begin_command();
            dohc_engine_sync::adopt_join_identity(
                &mut store, "ws", "local", "epoch", "stream", 20, &NoFaults,
            )
            .unwrap();
            let enrol = |store: &mut EngineStore| {
                begin_command();
                let enrolled = dohc_engine_sync::commit_relay_cursor(
                    store,
                    "ws",
                    &dohc_engine_sync::RelayCursor {
                        cursor: 1,
                        replication_epoch: "epoch".into(),
                        stream_identity: "stream".into(),
                        bootstrap_complete: true,
                        settlement_report_id: None,
                        ordinary_pull: None,
                    },
                    &NoFaults,
                    &dohc_engine_sync::NoLiveLeases,
                    30,
                );
                finish_command(store);
                enrolled.is_ok()
            };
            let mut attempts = vec![enrol(&mut store)];
            // A waiting enrolment signals, so capture rescans without another trigger.
            let signalled = signals.waits() > 0;
            if !attempts[0] {
                // Capture runs before the next attempt, as the refusal's
                // signal asks, and finds the rule on disk.
                begin_command();
                order_capture(
                    &mut store,
                    "ws",
                    "main",
                    40,
                    &LeaseRegistry::new(),
                    &NoFaults,
                    &[Touch::observed("team/access.yaml", edit.as_bytes())],
                )
                .unwrap()
                .into_iter()
                .collect::<Result<(), _>>()
                .unwrap();
                ingest_rule(&mut store, edit).unwrap();
                finish_command(&mut store);
                attempts.push(enrol(&mut store));
            }
            let journal: Vec<String> = store
                .read_with(|conn| {
                    conn.prepare(
                        "SELECT json_extract(payload_json,'$.path') FROM replication_log \
                         WHERE workspace_id='ws' AND op_kind='moment.append' ORDER BY origin_seq",
                    )?
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()
                })
                .unwrap();
            let holds = store
                .read_with(|conn| access_rule_holds::list_in(conn, "ws"))
                .unwrap()
                .into_iter()
                .map(|hold| (hold.folder, hold.reason))
                .collect::<Vec<_>>();
            seen.push((captured, attempts, signalled, journal, holds));
            ROOT.with(|cell| *cell.borrow_mut() = None);
        }
        let (rule, file) = ("team/access.yaml".to_owned(), "team/a.md".to_owned());
        let journal = vec![rule.clone(), rule, file];
        assert_eq!(
            seen,
            [
                (true, vec![true], false, journal.clone(), Vec::new()),
                (false, vec![false, true], true, journal, Vec::new()),
            ]
        );
    }

    /// A replicating workspace store under its workspace folder, with the
    /// commit-point check installed.
    fn replicating_store(scratch: &dohc_engine_testkit::ScratchDir) -> EngineStore {
        use dohc_engine_domain::VersionedTextStore;
        let db = dohc_engine_testkit::engine_db_path(scratch).unwrap();
        let mut store = EngineStore::open(&db, 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .unwrap();
        rusqlite::Connection::open(&db)
            .unwrap()
            .execute_batch(
                "INSERT INTO sync_identity (workspace_id, origin_id, replication_epoch, \
                 stream_identity, created_at_ms) VALUES ('ws', 'origin', 'epoch', 'stream', 1); \
                 INSERT INTO sync_relay_push_state (workspace_id, origin_id, pushed_seq) \
                 VALUES ('ws', 'origin', 0);",
            )
            .unwrap();
        let identity = EngineDbIdentity::of_existing(&db).unwrap();
        install(&db, &identity, true, Arc::new(AccessRuleSignals::default())).unwrap();
        store
    }

    /// Put `text` at `path` under `root` and make the folder look settled.
    fn put_settled(root: &Path, path: &str, text: &str) {
        let absolute = root.join(path);
        std::fs::create_dir_all(absolute.parent().unwrap()).unwrap();
        std::fs::write(&absolute, text).unwrap();
        let then =
            filetime::FileTime::from_system_time(SystemTime::now() - Duration::from_secs(60));
        filetime::set_file_mtime(&absolute, then).unwrap();
        filetime::set_file_mtime(absolute.parent().unwrap(), then).unwrap();
    }

    /// Capture's ingest of the team folder's rule, without the ordering step
    /// capture runs before it.
    fn ingest_rule(store: &mut EngineStore, text: &str) -> Result<(), RuntimeError> {
        ingest(store, "team/access.yaml", text)
    }

    fn ingest(store: &mut EngineStore, path: &str, text: &str) -> Result<(), RuntimeError> {
        let input = CaptureIngest {
            workspace_id: "ws".to_owned(),
            version_id: "main".to_owned(),
            path: path.to_owned(),
            text: text.to_owned(),
            metadata_origin: CAPTURE_ORIGIN.to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 10,
            request_id: None,
            claim_foreign_head: true,
        };
        super::super::capture::capture_ingest_unordered_on_store(
            store,
            &input,
            &super::super::capture::CaptureIndexing::Skip,
            &LeaseRegistry::new(),
            &NoFaults,
            &CancellationToken::new(),
        )
        .map(drop)
    }

    fn rule_writes(store: &EngineStore) -> usize {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT count(*) FROM replication_log WHERE op_kind='moment.append' \
                     AND json_extract(payload_json,'$.path')='team/access.yaml'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(StorageError::corrupt_public)
            })
            .unwrap()
            .try_into()
            .unwrap()
    }

    /// A rule capture recorded from disk with no ordering step is judged at
    /// the commit point, as a file under it is. Capture's own step is not
    /// what keeps a widening from members: a path that skips it is refused,
    /// and the widening waits for the owner.
    #[test]
    fn a_widened_rule_captured_without_a_step_holds_at_the_commit_point() {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let root = std::path::absolute(scratch.path()).unwrap();
        let mut store = replicating_store(&scratch);
        put_settled(&root, "team/access.yaml", "members: view\n");
        put_settled(&root, "team/a.md", "alpha");
        // Capture's own step judges the first rule, which then commits.
        begin_command();
        order_capture(
            &mut store,
            "ws",
            "main",
            10,
            &LeaseRegistry::new(),
            &NoFaults,
            &[Touch::observed("team/access.yaml", b"members: view\n")],
        )
        .unwrap()
        .into_iter()
        .collect::<Result<(), _>>()
        .unwrap();
        ingest_rule(&mut store, "members: view\n").unwrap();
        finish_command(&mut store);
        assert_eq!(rule_writes(&store), 1);

        put_settled(&root, "team/access.yaml", "members: edit\n");
        begin_command();
        let ingested = ingest_rule(&mut store, "members: edit\n").is_ok();
        finish_command(&mut store);
        let holds = store
            .read_with(|conn| access_rule_holds::list_in(conn, "ws"))
            .unwrap()
            .into_iter()
            .map(|hold| (hold.folder, hold.reason))
            .collect::<Vec<_>>();
        // Refused, the widening not journaled, the folder held.
        assert_eq!(
            (ingested, rule_writes(&store), holds),
            (
                false,
                1,
                vec![("team".to_owned(), access_rule_holds::WIDENED.to_owned())]
            )
        );
        ROOT.with(|cell| *cell.borrow_mut() = None);
    }

    /// The workspace folder still holds the store only while the store's
    /// path by name reaches the open store's file.
    #[test]
    fn a_folder_that_no_longer_holds_the_store_is_no_root() {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let named = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
        std::fs::write(&named, b"").unwrap();
        let elsewhere = scratch.path().join("elsewhere.db");
        std::fs::write(&elsewhere, b"").unwrap();
        let signals = Arc::new(AccessRuleSignals::default());
        for (store, expected) in [
            (
                &named,
                Ok(Some(std::path::absolute(scratch.path()).unwrap())),
            ),
            (&elsewhere, Err(WORKSPACE_FOLDER_MOVED)),
        ] {
            let store = EngineDbIdentity::of_existing(store).unwrap();
            install(&named, &store, true, signals.clone()).unwrap();
            begin_command();
            assert_eq!(root(), expected);
        }
        ROOT.with(|cell| *cell.borrow_mut() = None);
    }

    fn committed(files: &[(&str, &str)]) -> Committed {
        Committed {
            files: files
                .iter()
                .map(|(path, text)| {
                    let file = CommittedFile {
                        sha256: dohc_engine_storage::hex_sha256(text.as_bytes()),
                        rule: parse_access_rule(text),
                        text: Some((*text).to_owned()),
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
    fn four_rule_files_choose_a_safe_first_write_and_last_delete() {
        let view = parse_access_rule("members: view\n").unwrap();
        let disk = OnDisk::from([
            ("T/ACCESS.yaml".to_owned(), b"members: edit\n".to_vec()),
            ("T/Access.yaml".to_owned(), b"members: view\n".to_vec()),
            ("T/aCcess.yaml".to_owned(), b"members: edit\n".to_vec()),
            ("T/access.yaml".to_owned(), b"members: edit\n".to_vec()),
        ]);
        let changes = safe_rule_order(
            ReachBefore::Inherited(Some(&view)),
            None,
            rule_changes(None, &disk),
            false,
        )
        .expect("a safe first write");
        assert_eq!(changes[0].0, "T/Access.yaml");
        assert!(every_step_narrows(
            ReachBefore::Inherited(Some(&view)),
            None,
            &changes
        ));
        let recorded = committed(&[
            ("T/ACCESS.yaml", "members: edit\n"),
            ("T/Access.yaml", "members: view\n"),
            ("T/aCcess.yaml", "members: edit\n"),
            ("T/access.yaml", "members: edit\n"),
        ]);
        let changes = safe_rule_order(
            ReachBefore::Inherited(Some(&view)),
            Some(&recorded),
            rule_changes(Some(&recorded), &OnDisk::new()),
            false,
        )
        .expect("a safe last deletion");
        assert_eq!(changes.last().unwrap().0, "T/Access.yaml");
        assert!(every_step_narrows(
            ReachBefore::Inherited(Some(&view)),
            Some(&recorded),
            &changes[..3]
        ));
    }

    #[test]
    fn a_notice_says_why_it_cannot_show_the_rule_on_disk() {
        let one = |text: &[u8]| OnDisk::from([("T/access.yaml".to_owned(), text.to_vec())]);
        assert!(rule_now(&Ok(one(b"members: edit\n"))).is_ok());
        assert_eq!(
            rule_now(&Err(Unread::Locked("T/access.yaml".to_owned()))).err(),
            Some("locked")
        );
        assert_eq!(rule_now(&Err(Unread::Other)).err(), Some("on-disk"));
        assert_eq!(rule_now(&Ok(one(&[0xff]))).err(), Some("on-disk"));
        let both = OnDisk::from([
            ("T/ACCESS.yaml".to_owned(), b"members: edit\n".to_vec()),
            ("T/access.yaml".to_owned(), b"members: view\n".to_vec()),
        ]);
        assert_eq!(rule_now(&Ok(both)).err(), Some("several-files"));
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

    /// Opus's case from review: one rule change passes through no state
    /// between before and after, so its merge reads none of the paths under
    /// its folder, however many the version holds.
    #[test]
    fn a_one_rule_merge_reads_no_path_under_its_folder() {
        use dohc_engine_domain::{CreateNamedVersion, VersionedTextStore, WriteText};
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let db = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&db, 1).unwrap();
        let mut versioned = VersionedTextStore::new(&mut store);
        versioned
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .unwrap();
        let mut write = |version: &str, path: String, text: &str| {
            let input = WriteText {
                workspace_id: "ws".to_owned(),
                version_id: version.to_owned(),
                object_id: format!("object-{path}"),
                moment_id: format!("m-{version}-{path}"),
                path,
                text: text.to_owned(),
                metadata_origin: "cli".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 10,
                request_id: None,
            };
            drop(versioned.write_text(&input, &NoFaults).unwrap());
        };
        write("main", "access.yaml".to_owned(), "members: edit\n");
        for index in 0..100 {
            write("main", format!("notes/{index}.md"), "note");
        }
        versioned
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws".to_owned(),
                    new_version_id: "feature".to_owned(),
                    name: "feature".to_owned(),
                    from_version_id: "main".to_owned(),
                    now_ms: 11,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        let input = WriteText {
            workspace_id: "ws".to_owned(),
            version_id: "feature".to_owned(),
            object_id: "object-access.yaml".to_owned(),
            moment_id: "m-feature-root".to_owned(),
            path: "access.yaml".to_owned(),
            text: "members: view\n".to_owned(),
            metadata_origin: "cli".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 12,
            request_id: None,
        };
        drop(versioned.write_text(&input, &NoFaults).unwrap());
        let conn = Connection::open(&db).unwrap();
        // Fewer units than the paths under the root.
        let mut work = RuleOrderWork::limited(50);
        let merge = rule_merge_steps(
            &conn,
            "ws",
            "feature",
            "main",
            &["access.yaml".to_owned()],
            &mut work,
        )
        .unwrap()
        .expect("within 50 units");
        assert_eq!(merge.steps.len(), 1);
        assert!(merge.before.is_empty());
    }
}
