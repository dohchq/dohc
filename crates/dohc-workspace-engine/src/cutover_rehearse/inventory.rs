use super::RehearsalError;
use dohc_engine_files::hash::{HashInput, HashRun};
use dohc_engine_files::{HashOutcome, HashPool};
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

const INVENTORY_FILE: &str = "CUTOVER_REHEARSAL_INVENTORY.json";
const MAX_FILES: usize = 100_000;
const HASH_WORKERS: usize = 4;
const HASH_BUFFER_BYTES: usize = 64 * 1024;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InventoryEntry {
    pub relative_path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Inventory {
    pub record_count: usize,
    pub files: Vec<InventoryEntry>,
}

pub fn load_inventory(root: &Path) -> Result<Inventory, RehearsalError> {
    let path = inventory_path(root);
    let bytes = std::fs::read(path).map_err(|e| RehearsalError::io("inventory-read", e))?;
    let inventory: Inventory = serde_json::from_slice(&bytes).map_err(|_| RehearsalError::State)?;
    if inventory.record_count != inventory.files.len()
        || inventory
            .files
            .windows(2)
            .any(|pair| pair[0].relative_path >= pair[1].relative_path)
    {
        return Err(RehearsalError::State);
    }
    Ok(inventory)
}

pub(crate) fn load_or_record(root: &Path) -> Result<Inventory, RehearsalError> {
    match load_inventory(root) {
        Ok(inventory) => Ok(inventory),
        Err(RehearsalError::Io {
            code: "inventory-read",
        }) if !inventory_path(root).exists() => {
            let inventory = scan(root)?;
            persist(root, &inventory)?;
            Ok(inventory)
        }
        Err(error) => Err(error),
    }
}

pub(crate) fn scan(root: &Path) -> Result<Inventory, RehearsalError> {
    let mut files = Vec::new();
    enumerate(root, root, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    if files.len() > MAX_FILES {
        return Err(RehearsalError::Io {
            code: "inventory-too-many-files",
        });
    }
    let inputs: Vec<HashInput> = files
        .iter()
        .enumerate()
        .map(|(index, (_, abs, _))| HashInput {
            index,
            abs: abs.clone(),
        })
        .collect();
    let pool = HashPool::new(HASH_WORKERS, HASH_BUFFER_BYTES, MAX_FILE_BYTES)?;
    let run = pool.hash_batched(&inputs, &CancellationToken::new())?;
    let HashRun::Completed { outcomes } = run else {
        return Err(RehearsalError::Io {
            code: "inventory-cancelled",
        });
    };
    let mut entries = Vec::with_capacity(files.len());
    for ((relative_path, _, expected_size), outcome) in files.into_iter().zip(outcomes) {
        let HashOutcome::Hashed { sha256, bytes } = outcome else {
            return Err(RehearsalError::Io {
                code: "inventory-hash-incomplete",
            });
        };
        if bytes != expected_size {
            return Err(RehearsalError::Io {
                code: "inventory-size-race",
            });
        }
        entries.push(InventoryEntry {
            relative_path,
            size_bytes: bytes,
            sha256,
        });
    }
    Ok(Inventory {
        record_count: entries.len(),
        files: entries,
    })
}

fn enumerate(
    root: &Path,
    directory: &Path,
    files: &mut Vec<(String, PathBuf, u64)>,
) -> Result<(), RehearsalError> {
    let entries =
        std::fs::read_dir(directory).map_err(|e| RehearsalError::io("inventory-enumerate", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| RehearsalError::io("inventory-entry", e))?;
        if directory == root && entry.file_name() == ".dohc" {
            continue;
        }
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| RehearsalError::io("inventory-metadata", e))?;
        if metadata.file_type().is_symlink() {
            return Err(RehearsalError::Io {
                code: "inventory-alias-refused",
            });
        }
        if metadata.is_dir() {
            enumerate(root, &path, files)?;
        } else if metadata.is_file() {
            let relative = path.strip_prefix(root).map_err(|_| RehearsalError::State)?;
            let relative = portable_path(relative)?;
            files.push((relative, path, metadata.len()));
        } else {
            return Err(RehearsalError::Io {
                code: "inventory-special-file-refused",
            });
        }
    }
    Ok(())
}

fn portable_path(path: &Path) -> Result<String, RehearsalError> {
    let text = path.to_str().ok_or(RehearsalError::Io {
        code: "inventory-non-utf8-path",
    })?;
    Ok(text.replace('\\', "/"))
}

fn persist(root: &Path, inventory: &Inventory) -> Result<(), RehearsalError> {
    let path = inventory_path(root);
    let temp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(inventory).map_err(|_| RehearsalError::State)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| RehearsalError::io("inventory-temp-open", e))?;
    file.write_all(&bytes)
        .map_err(|e| RehearsalError::io("inventory-temp-write", e))?;
    file.sync_all()
        .map_err(|e| RehearsalError::io("inventory-temp-sync", e))?;
    drop(file);
    std::fs::rename(temp, path).map_err(|e| RehearsalError::io("inventory-publish", e))
}

fn inventory_path(root: &Path) -> PathBuf {
    root.join(".dohc").join("engine").join(INVENTORY_FILE)
}
