use super::RehearsalError;
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

const STATE_DIR: &str = "CUTOVER_REHEARSAL_STATE";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StableState {
    NotStarted,
    Settled,
    BackedUp,
    MovedAside,
    Initialized,
    Capturing,
    Complete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum RehearsalState {
    NotStarted,
    Settled,
    BackedUp,
    MovedAside,
    Initialized,
    Capturing,
    Complete,
    Failed { reason: String, at: StableState },
}

impl RehearsalState {
    pub fn stable(&self) -> Option<StableState> {
        match self {
            Self::NotStarted => Some(StableState::NotStarted),
            Self::Settled => Some(StableState::Settled),
            Self::BackedUp => Some(StableState::BackedUp),
            Self::MovedAside => Some(StableState::MovedAside),
            Self::Initialized => Some(StableState::Initialized),
            Self::Capturing => Some(StableState::Capturing),
            Self::Complete => Some(StableState::Complete),
            Self::Failed { .. } => None,
        }
    }
}

impl From<StableState> for RehearsalState {
    fn from(value: StableState) -> Self {
        match value {
            StableState::NotStarted => Self::NotStarted,
            StableState::Settled => Self::Settled,
            StableState::BackedUp => Self::BackedUp,
            StableState::MovedAside => Self::MovedAside,
            StableState::Initialized => Self::Initialized,
            StableState::Capturing => Self::Capturing,
            StableState::Complete => Self::Complete,
        }
    }
}

/// Identity of the restore-tested backup recorded at the BackedUp transition.
/// A resume must re-verify the on-disk backup against this before any
/// destructive step; a record claiming BackedUp-or-later without it is invalid.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupFingerprint {
    /// Canonicalized recovery directory the backup was written to.
    pub recovery_dir: String,
    /// sha-256 of the vacuumed DB backup (its manifest checksum).
    pub db_checksum: String,
    /// sha-256 of the directory-backup manifest file.
    pub directory_manifest_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StateRecord {
    pub generation: u64,
    pub current: RehearsalState,
    pub history: Vec<StableState>,
    pub backup: Option<BackupFingerprint>,
    /// The freshly-initialized store's `engine_uuid`, recorded at the
    /// Initialized transition. The reset-freshness proof: a stale same-clone
    /// db (old store or backup copy, bound to the same shadow token) carries
    /// a DIFFERENT identity and must be refused on resume.
    #[serde(default)]
    pub fresh_engine_uuid: Option<String>,
}

/// The state dir path, refusing any symlinked component so records can never
/// be written through an alias that escapes the workspace root.
fn state_dir(root: &Path) -> Result<std::path::PathBuf, RehearsalError> {
    let dohc = root.join(".dohc");
    let engine = dohc.join("engine");
    let state = engine.join(STATE_DIR);
    for dir in [&dohc, &engine, &state] {
        if let Ok(metadata) = std::fs::symlink_metadata(dir)
            && metadata.file_type().is_symlink()
        {
            return Err(RehearsalError::State);
        }
    }
    Ok(state)
}

pub fn load_state(root: &Path) -> Result<Option<StateRecord>, RehearsalError> {
    let dir = state_dir(root)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(RehearsalError::State),
    };
    let mut records = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| RehearsalError::State)?;
        let name = entry.file_name();
        let name = name.to_str().ok_or(RehearsalError::State)?;
        if !name.ends_with(".json") {
            continue;
        }
        // A state record supplied through an alias is a resume driven by a
        // mutable file outside the clone — refuse before reading it.
        if super::require_real_file(&entry.path(), "state-record-alias-refused")?.is_none() {
            return Err(RehearsalError::State);
        }
        let bytes = std::fs::read(entry.path()).map_err(|_| RehearsalError::State)?;
        let record: StateRecord =
            serde_json::from_slice(&bytes).map_err(|_| RehearsalError::State)?;
        records.push(record);
    }
    records.sort_by_key(|record| record.generation);
    let Some(latest) = records.pop() else {
        return Ok(None);
    };
    validate_record(&latest)?;
    Ok(Some(latest))
}

pub(crate) fn initialize(root: &Path) -> Result<StateRecord, RehearsalError> {
    if let Some(record) = load_state(root)? {
        return Ok(record);
    }
    persist(
        root,
        StateRecord {
            generation: 0,
            current: RehearsalState::NotStarted,
            history: vec![StableState::NotStarted],
            backup: None,
            fresh_engine_uuid: None,
        },
    )
}

pub(crate) fn transition(
    root: &Path,
    record: &StateRecord,
    next: StableState,
) -> Result<StateRecord, RehearsalError> {
    transition_inner(
        root,
        record,
        next,
        record.backup.clone(),
        record.fresh_engine_uuid.clone(),
    )
}

/// The Settled→BackedUp transition: records the just-verified backup identity
/// alongside the state so every later resume can re-prove it.
pub(crate) fn transition_backed_up(
    root: &Path,
    record: &StateRecord,
    backup: BackupFingerprint,
) -> Result<StateRecord, RehearsalError> {
    transition_inner(
        root,
        record,
        StableState::BackedUp,
        Some(backup),
        record.fresh_engine_uuid.clone(),
    )
}

/// The MovedAside→Initialized transition: records the fresh store's identity
/// so every later resume can re-prove the reset actually happened.
pub(crate) fn transition_initialized(
    root: &Path,
    record: &StateRecord,
    fresh_engine_uuid: String,
) -> Result<StateRecord, RehearsalError> {
    transition_inner(
        root,
        record,
        StableState::Initialized,
        record.backup.clone(),
        Some(fresh_engine_uuid),
    )
}

fn transition_inner(
    root: &Path,
    record: &StateRecord,
    next: StableState,
    backup: Option<BackupFingerprint>,
    fresh_engine_uuid: Option<String>,
) -> Result<StateRecord, RehearsalError> {
    let current = record.current.stable().ok_or(RehearsalError::State)?;
    if next_index(next) != next_index(current).saturating_add(1) {
        return Err(RehearsalError::State);
    }
    let mut history = record.history.clone();
    history.push(next);
    persist(
        root,
        StateRecord {
            generation: record.generation.saturating_add(1),
            current: next.into(),
            history,
            backup,
            fresh_engine_uuid,
        },
    )
}

pub(crate) fn fail(
    root: &Path,
    record: &StateRecord,
    reason: &'static str,
) -> Result<StateRecord, RehearsalError> {
    let at = record.current.stable().ok_or(RehearsalError::State)?;
    persist(
        root,
        StateRecord {
            generation: record.generation.saturating_add(1),
            current: RehearsalState::Failed {
                reason: reason.to_owned(),
                at,
            },
            history: record.history.clone(),
            backup: record.backup.clone(),
            fresh_engine_uuid: record.fresh_engine_uuid.clone(),
        },
    )
}

fn persist(root: &Path, record: StateRecord) -> Result<StateRecord, RehearsalError> {
    validate_record(&record)?;
    let dir = state_dir(root)?;
    std::fs::create_dir_all(&dir).map_err(|e| RehearsalError::io("state-dir", e))?;
    let final_path = dir.join(format!("{:020}.json", record.generation));
    let tmp_path = dir.join(format!(
        ".{:020}-{}.tmp",
        record.generation,
        std::process::id()
    ));
    // A stale temp from a crash before publication (PID reuse included) is
    // uncommitted scratch; clear it so the resume is not wedged by
    // `create_new`.
    if std::fs::symlink_metadata(&tmp_path).is_ok() {
        std::fs::remove_file(&tmp_path).map_err(|e| RehearsalError::io("state-temp-clear", e))?;
    }
    let bytes = serde_json::to_vec(&record).map_err(|_| RehearsalError::State)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)
        .map_err(|e| RehearsalError::io("state-temp-open", e))?;
    file.write_all(&bytes)
        .map_err(|e| RehearsalError::io("state-temp-write", e))?;
    file.sync_all()
        .map_err(|e| RehearsalError::io("state-temp-sync", e))?;
    drop(file);
    std::fs::rename(&tmp_path, &final_path).map_err(|e| RehearsalError::io("state-publish", e))?;
    // The rename itself must be durable before the machine acts on the new
    // state — a power loss must not resurrect the previous generation. The
    // parent sync makes a freshly created state DIRECTORY reachable too.
    super::fsync_dir(&dir)?;
    if let Some(parent) = dir.parent() {
        super::fsync_dir(parent)?;
    }
    Ok(record)
}

fn validate_record(record: &StateRecord) -> Result<(), RehearsalError> {
    if record.history.first() != Some(&StableState::NotStarted)
        || record
            .history
            .windows(2)
            .any(|pair| next_index(pair[1]) != next_index(pair[0]).saturating_add(1))
    {
        return Err(RehearsalError::State);
    }
    let expected_generation = record.history.len().saturating_sub(1) as u64
        + u64::from(matches!(record.current, RehearsalState::Failed { .. }));
    if record.generation != expected_generation {
        return Err(RehearsalError::State);
    }
    // A record claiming BackedUp-or-later must carry the backup fingerprint it
    // was recorded with; a record before BackedUp must not carry one.
    if record.backup.is_some() != record.history.contains(&StableState::BackedUp) {
        return Err(RehearsalError::State);
    }
    // Same discipline for the reset-identity proof at Initialized.
    if record.fresh_engine_uuid.is_some() != record.history.contains(&StableState::Initialized) {
        return Err(RehearsalError::State);
    }
    match &record.current {
        RehearsalState::Failed { at, .. } if record.history.last() == Some(at) => Ok(()),
        state if state.stable() == record.history.last().copied() => Ok(()),
        _ => Err(RehearsalError::State),
    }
}

const fn next_index(state: StableState) -> u8 {
    match state {
        StableState::NotStarted => 0,
        StableState::Settled => 1,
        StableState::BackedUp => 2,
        StableState::MovedAside => 3,
        StableState::Initialized => 4,
        StableState::Capturing => 5,
        StableState::Complete => 6,
    }
}
