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
}

pub fn load_state(root: &Path) -> Result<Option<StateRecord>, RehearsalError> {
    let dir = root.join(".dohc").join("engine").join(STATE_DIR);
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
        },
    )
}

pub(crate) fn transition(
    root: &Path,
    record: &StateRecord,
    next: StableState,
) -> Result<StateRecord, RehearsalError> {
    transition_inner(root, record, next, record.backup.clone())
}

/// The Settled→BackedUp transition: records the just-verified backup identity
/// alongside the state so every later resume can re-prove it.
pub(crate) fn transition_backed_up(
    root: &Path,
    record: &StateRecord,
    backup: BackupFingerprint,
) -> Result<StateRecord, RehearsalError> {
    transition_inner(root, record, StableState::BackedUp, Some(backup))
}

fn transition_inner(
    root: &Path,
    record: &StateRecord,
    next: StableState,
    backup: Option<BackupFingerprint>,
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
        },
    )
}

fn persist(root: &Path, record: StateRecord) -> Result<StateRecord, RehearsalError> {
    validate_record(&record)?;
    let dir = root.join(".dohc").join("engine").join(STATE_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| RehearsalError::io("state-dir", e))?;
    let final_path = dir.join(format!("{:020}.json", record.generation));
    let tmp_path = dir.join(format!(
        ".{:020}-{}.tmp",
        record.generation,
        std::process::id()
    ));
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
