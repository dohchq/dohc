use std::collections::HashMap;

use rusqlite::Connection;

use crate::durable::reconstruct_for_replay_gate;
use crate::replay_parity::{scan_v1, validate_replay_parity_cached, WireStructure};
use crate::{CollabError, DocKey, Ydoc};

pub struct CachedBase {
    base: Ydoc,
    base_full: Vec<u8>,
    base_structure: WireStructure,
    head_update_seq: i64,
}

impl CachedBase {
    pub(crate) fn validate(&self, candidate: &[u8]) -> Result<(), CollabError> {
        validate_replay_parity_cached(&self.base, &self.base_full, &self.base_structure, candidate)
    }
}

#[derive(Default)]
pub struct ReplayBaseCache {
    bases: HashMap<DocKey, CachedBase>,
    hits: usize,
    misses: usize,
}

impl ReplayBaseCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn get_or_reconstruct(
        &mut self,
        conn: &Connection,
        key: &DocKey,
        expected_seq: i64,
    ) -> Result<&CachedBase, CollabError> {
        let hit = self
            .bases
            .get(key)
            .is_some_and(|cached| cached.head_update_seq == expected_seq);
        if hit {
            self.hits += 1;
            return self.bases.get(key).ok_or_else(cache_entry_missing);
        }

        self.misses += 1;
        let base = reconstruct_for_replay_gate(conn, key)?;
        let base_full = base.encode_full_state();
        let base_structure = scan_v1(&base_full)?;
        self.bases.insert(
            key.clone(),
            CachedBase {
                base,
                base_full,
                base_structure,
                head_update_seq: expected_seq,
            },
        );
        self.bases.get(key).ok_or_else(cache_entry_missing)
    }

    pub fn advance(&mut self, key: &DocKey, committed_update: &[u8], new_seq: i64) {
        let advanced = self
            .bases
            .get_mut(key)
            .is_some_and(|cached| advance_cached_base(cached, committed_update, new_seq));
        if !advanced {
            self.invalidate(key);
        }
    }

    pub fn invalidate(&mut self, key: &DocKey) {
        self.bases.remove(key);
    }

    pub fn hit_count(&self) -> usize {
        self.hits
    }

    pub fn miss_count(&self) -> usize {
        self.misses
    }
}

fn advance_cached_base(cached: &mut CachedBase, update: &[u8], new_seq: i64) -> bool {
    if cached.head_update_seq.checked_add(1) != Some(new_seq) || cached.base.apply(update).is_err()
    {
        return false;
    }
    let base_full = cached.base.encode_full_state();
    let Ok(base_structure) = scan_v1(&base_full) else {
        return false;
    };
    cached.base_full = base_full;
    cached.base_structure = base_structure;
    cached.head_update_seq = new_seq;
    true
}

fn cache_entry_missing() -> CollabError {
    CollabError::Corrupt {
        reason: "replay cache entry disappeared".to_owned(),
    }
}
