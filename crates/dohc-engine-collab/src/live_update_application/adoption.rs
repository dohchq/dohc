use super::*;
use crate::{ContentKind, Ydoc};
use dohc_engine_storage::text;

/// A complete cut acquired by the authenticated owner transport. Parsing this
/// value does not authenticate it. The renderer must not construct this input.
#[derive(Clone)]
pub struct OwnerAdoptionCut {
    pub relay_database_namespace: String,
    pub adoption_id: String,
    pub source_moment_id: String,
    pub source_digest: String,
    pub source_byte_length: i64,
    pub baseline_moment_relay_sequence: i64,
    pub baseline_registered_at_ms: i64,
    pub baseline_bytes: Vec<u8>,
    pub expected_local_sequence: i64,
    pub events: Vec<AdmittedLiveUpdate>,
    pub terminal_receipt: Option<LiveUpdateReceipt>,
    /// The released prefix a successor adopts, with no events after it. None
    /// for a lineage's first adoption.
    pub retained_prefix: Option<RetainedPrefix>,
    /// Native host configuration, never decoded from the relay cut.
    pub outbox_limits: crate::OwnerOutboxLimits,
    /// Native host configuration: a successor reconstructs its prefix's
    /// accepted state within it.
    pub reconstruction: NativeHistoryReconstruction,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::owner_base_source::{retain_owner_base_source_in_tx, OwnerSeedSource};
    use crate::owner_outbox;
    use dohc_engine_domain::{VersionedTextStore, WriteText};
    use dohc_test_scratch::ScratchDir;
    include!("adoption_restore_tail_tests.rs");
    include!("activation_tests.rs");
    include!("owner_activations_tests.rs");
    include!("retirement_tests.rs");
    include!("successor_tests.rs");
    include!("inherited_tests.rs");
    include!("resume_tests.rs");
    include!("released_capture_tests.rs");
    include!("released_protection_tests.rs");
    include!("rename_tests.rs");
    include!("retired_outbox_tests.rs");
    include!("restore_cancel_tests.rs");

    /// What a held proof's memory peaks at, beside what it reserved.
    #[cfg(feature = "held-proof-memory")]
    mod held_proof_memory {
        use super::*;
        include!("held_proof_memory_tests.rs");
    }

    struct Fixture {
        store: EngineStore,
        _owner: ApplicationOwner,
        handle: ApplicationHandle,
        binding: LiveObjectBinding,
        cut: OwnerAdoptionCut,
        doc: Ydoc,
        key: DocKey,
        _scratch: ScratchDir,
    }
    impl Fixture {
        fn new() -> Self {
            Self::new_before_host(|_, _| {})
        }
        /// As [`new`](Self::new), with `before` run on the document before
        /// its host registers it.
        fn new_before_host(before: impl FnOnce(&mut EngineStore, &LiveObjectBinding)) -> Self {
            let fixture: Value = serde_json::from_str(include_str!(
                "../../tests/owner-source/owner-source-seed.json"
            ))
            .unwrap();
            let text = fixture["markdown"].as_str().unwrap().to_owned();
            let bytes: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
            Self::with_source_selectors(text, bytes, vec!["owner.md".into()], before)
        }
        fn with_source(text: String, bytes: Vec<u8>) -> Self {
            Self::with_source_selectors(text, bytes, vec!["owner.md".into()], |_, _| {})
        }
        fn with_source_selectors(
            text: String,
            bytes: Vec<u8>,
            selectors: Vec<String>,
            before: impl FnOnce(&mut EngineStore, &LiveObjectBinding),
        ) -> Self {
            let scratch = ScratchDir::new_named("existing-owner-adoption").unwrap();
            let mut store = EngineStore::open(&scratch.join("engine.db"), 0).unwrap();
            VersionedTextStore::new(&mut store)
                .ensure_main_version("workspace", "main", 0, &NoFaults)
                .unwrap();
            VersionedTextStore::new(&mut store)
                .write_text(
                    &WriteText {
                        workspace_id: "workspace".into(),
                        version_id: "main".into(),
                        object_id: "object".into(),
                        path: "owner.md".into(),
                        text: text.clone(),
                        moment_id: "original".into(),
                        metadata_origin: "user".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 1,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
            let key = DocKey::new("workspace", "main", "object").unwrap();
            durable::claim_base(&mut store, &key, ContentKind::Richdoc, &bytes, &NoFaults, 2)
                .unwrap();
            let source = OwnerSeedSource {
                moment_id: "original".into(),
                blob_sha256: hex_sha256(text.as_bytes()),
            };
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute("UPDATE ydoc_docs SET path='owner.md'", [])
                        .unwrap();
                    let seeded = Ydoc::wire();
                    seeded.apply(&bytes)?;
                    if seeded.has_reader_source() {
                        return Ok::<_, CollabError>(());
                    }
                    assert!(retain_owner_base_source_in_tx(
                        tx,
                        &key,
                        "owner.md",
                        &hex_sha256(&bytes),
                        &source,
                        None,
                    )?);
                    Ok::<_, CollabError>(())
                })
                .unwrap();
            let binding = LiveObjectBinding {
                workspace_id: "workspace".into(),
                main_version_id: "main".into(),
                object_id: "object".into(),
                lineage_claim_id: hex_sha256(&bytes),
                current_path: "owner.md".into(),
                selector_paths: selectors,
                restore_fence_generation: 0,
            };
            before(&mut store, &binding);
            let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
            let handle = owner
                .register(
                    &mut store,
                    "namespace".into(),
                    ApplicationHostCoordinate {
                        host_id: "host".into(),
                        host_epoch: 1,
                        instance_id: "instance".into(),
                        connection_id: "connection".into(),
                    },
                    binding.clone(),
                )
                .unwrap();
            let doc = Ydoc::wire();
            doc.apply(&bytes).unwrap();
            let cut = OwnerAdoptionCut {
                relay_database_namespace: "namespace".into(),
                adoption_id: "adoption".into(),
                source_moment_id: source.moment_id,
                source_digest: source.blob_sha256,
                source_byte_length: text.len() as i64,
                baseline_moment_relay_sequence: 1,
                baseline_registered_at_ms: 3,
                baseline_bytes: bytes,
                expected_local_sequence: 0,
                events: vec![],
                terminal_receipt: None,
                retained_prefix: None,
                outbox_limits: crate::OwnerOutboxLimits {
                    max_pending_bytes: 1_000_000,
                    max_pending_age_ms: 100_000,
                },
                reconstruction: NativeHistoryReconstruction {
                    working_reserve_bytes: 8 * 1024 * 1024,
                },
            };
            Self {
                _scratch: scratch,
                store,
                _owner: owner,
                handle,
                binding,
                cut,
                doc,
                key,
            }
        }
        fn edit(&mut self, acknowledge: bool) {
            self.edit_with_limit(acknowledge, 1_000_000);
        }
        fn edit_with_limit(&mut self, acknowledge: bool, max_pending_bytes: i64) {
            self.doc
                .rewrite_content_to_markdown(ContentKind::Richdoc, "owner edit")
                .unwrap();
            let bytes = self.doc.encode_full_state();
            let sequence = crate::record_local_update(
                &mut self.store,
                &mut WriterDocCache::new(),
                &self.key,
                &bytes,
                crate::LocalAppend::default(),
                &NoFaults,
                4,
                |_, _, _| Ok(()),
            )
            .unwrap();
            let TxnOutcome::Committed(sequence) = sequence else {
                panic!("record crash")
            };
            let entry = owner_outbox::append(
                &mut self.store,
                "workspace",
                owner_outbox::OwnerOutboxAppendInput {
                    binding: self.binding.clone(),
                    base_update: self.cut.baseline_bytes.clone(),
                    append_key: "edit".into(),
                    update: bytes.clone(),
                    limits: owner_outbox::OwnerOutboxLimits {
                        max_pending_bytes,
                        max_pending_age_ms: 100_000,
                    },
                    created_at_ms: 4,
                },
            )
            .unwrap();
            let receipt = LiveUpdateReceipt {
                delivery_id: entry.delivery_id,
                update_digest: entry.update_digest,
                journal_cursor: 7,
                accepting_host_epoch: 1,
            };
            if acknowledge {
                owner_outbox::acknowledge(
                    &mut self.store,
                    "workspace",
                    &entry.outbox_id,
                    &[owner_outbox::OwnerDeliveryReceipt {
                        delivery_id: receipt.delivery_id.clone(),
                        update_digest: receipt.update_digest.clone(),
                        journal_cursor: 7,
                        accepting_host_epoch: 1,
                    }],
                )
                .unwrap();
            }
            self.cut.expected_local_sequence = sequence.seq;
            self.cut.events.push(AdmittedLiveUpdate {
                metadata: AdmittedLiveUpdateMetadata {
                    accepted: RelayAcceptedLiveUpdate {
                        receipt: receipt.clone(),
                        binding: self.binding.clone(),
                        authority: ServerDerivedLiveUpdateAuthority::Owner {
                            principal_id: "owner".into(),
                        },
                        received_at_ms: 4,
                    },
                    first_seen: vec![],
                    canonical_version: None,
                    author_snapshot: None,
                    first_seen_deletes: None,
                    checkpoint_coverage: None,
                },
                update_bytes: bytes,
            });
            self.cut.terminal_receipt = Some(receipt);
        }
        fn adopt(&mut self) -> Result<OwnerAdoptionAck, ApplicationError> {
            adopt_owner_committed(
                &mut self.store,
                &self.handle,
                self.cut.clone(),
                1_000_000,
                100,
                10,
                &NoFaults,
                None,
                |_, _, _, _| Ok(()),
            )
        }
        fn local_edit_before_adoption(&mut self) {
            self.doc
                .rewrite_content_to_markdown(ContentKind::Richdoc, "edited before connecting")
                .unwrap();
            let TxnOutcome::Committed(update) = self
                .store
                .write_with(&NoFaults, |tx| {
                    durable::record_update_in_tx(
                        tx,
                        &self.key,
                        &self.doc.encode_full_state(),
                        None,
                        None,
                        4,
                    )
                })
                .unwrap()
            else {
                panic!("local edit interrupted")
            };
            self.cut.expected_local_sequence = update.seq;
        }
        fn counts(&self) -> Vec<i64> {
            [
                "moments",
                "snapshots",
                "ydoc_docs",
                "ydoc_snapshots",
                "ydoc_updates",
                "owner_ydoc_outboxes",
                "owner_ydoc_outbox_entries",
            ]
            .iter()
            .map(|t| self.store.table_row_count(t).unwrap())
            .collect()
        }
    }

    #[test]
    fn restore_preparation_authenticates_original_owner_prefix_before_adoption_terminal() {
        let mut f = Fixture::new();
        f.edit(true);
        f.adopt().unwrap();
        let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
        let operation = NativeRestoreFence {
            operation_id: "restore-owner".into(),
            relay_database_namespace: "namespace".into(),
            old_binding: f.binding.clone(),
            host_id: "host".into(),
            new_fence: 1,
            origin: RestoreDeliveryOrigin::Owner {
                id: f.cut.adoption_id.clone(),
            },
            terminal: f.cut.terminal_receipt.clone(),
            applied_sequence: f.cut.expected_local_sequence,
        };
        let fence = f
            ._owner
            .fence_restore(
                &mut f.store,
                None,
                operation,
                coordinate.clone(),
                20,
                &NoFaults,
            )
            .unwrap();
        let point = Ydoc::wire();
        point.apply(&f.cut.baseline_bytes).unwrap();
        let projection = point.project(ContentKind::Richdoc).unwrap().content;
        let source = point
            .preserved_markdown_source(&projection)
            .unwrap_or_else(|| projection.clone());
        let input = NativeRestorePreparation {
            fence,
            point: NativeRestorePoint {
                journal_cursor: 0,
                receipt_digest: f.binding.lineage_claim_id.clone(),
                markdown_digest: hex_sha256(source.as_bytes()),
                projection_digest: hex_sha256(projection.as_bytes()),
            },
        };
        for damage in ["id", "namespace", "origin", "sequence"] {
            let mut changed = input.clone();
            match damage {
                "id" => changed.fence.operation.operation_id = "other".into(),
                "namespace" => changed.fence.operation.relay_database_namespace = "other".into(),
                "origin" => {
                    changed.fence.operation.origin =
                        RestoreDeliveryOrigin::Owner { id: "other".into() }
                }
                "sequence" => changed.fence.local_head_sequence += 1,
                _ => unreachable!(),
            }
            assert!(
                f._owner
                    .prepare_restore(
                        &mut f.store,
                        None,
                        changed,
                        coordinate.clone(),
                        1_000_000,
                        100,
                        &NoFaults
                    )
                    .is_err(),
                "{damage}"
            );
        }
        let prepared = f
            ._owner
            .prepare_restore(
                &mut f.store,
                None,
                input.clone(),
                coordinate.clone(),
                1_000_000,
                100,
                &NoFaults,
            )
            .unwrap();
        assert_eq!(prepared.receipt().accepted_history.suffix.len(), 1);
        assert_eq!(prepared.receipt().point.journal_cursor, 0);
        assert_eq!(
            f.store
                .table_row_count("live_device_update_applications")
                .unwrap(),
            0
        );
        let replay = f
            ._owner
            .prepare_restore(
                &mut f.store,
                None,
                input.clone(),
                coordinate.clone(),
                1_000_000,
                100,
                &NoFaults,
            )
            .unwrap();
        assert_eq!(
            serde_json::to_vec(&prepared).unwrap(),
            serde_json::to_vec(&replay).unwrap()
        );
        let mut changed = input;
        changed.point.receipt_digest = "f".repeat(64);
        assert!(f
            ._owner
            .prepare_restore(
                &mut f.store,
                None,
                changed,
                coordinate,
                1_000_000,
                100,
                &NoFaults
            )
            .is_err());
    }

    #[test]
    fn restore_fence_refuses_late_creation_of_an_empty_owner_outbox() {
        for reopen in [false, true] {
            let mut f = Fixture::new();
            let ack = f.adopt().unwrap();
            assert_eq!(f.store.table_row_count("owner_ydoc_outboxes").unwrap(), 0);
            let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
            let input = NativeRestoreFence {
                operation_id: "empty-owner-restore".into(),
                relay_database_namespace: "namespace".into(),
                old_binding: f.binding.clone(),
                host_id: coordinate.host_id.clone(),
                new_fence: 1,
                origin: RestoreDeliveryOrigin::Owner {
                    id: ack.adoption_id,
                },
                terminal: f.cut.terminal_receipt.clone(),
                applied_sequence: ack.local_ydoc_sequence,
            };
            let receipt = f
                ._owner
                .fence_restore(
                    &mut f.store,
                    None,
                    input.clone(),
                    coordinate.clone(),
                    20,
                    &NoFaults,
                )
                .unwrap();
            let pending = owner_outbox::OwnerOutboxAppendInput {
                binding: f.binding.clone(),
                base_update: f.cut.baseline_bytes.clone(),
                append_key: "late-owner-edit".into(),
                update: f.doc.encode_full_state(),
                limits: f.cut.outbox_limits.clone(),
                created_at_ms: 21,
            };
            let path = f._scratch.join("engine.db");
            let mut store = if reopen {
                drop(f.handle);
                drop(f._owner);
                drop(f.store);
                EngineStore::open(&path, 21).unwrap()
            } else {
                f.store
            };
            let before = store.table_row_count("binary_blobs").unwrap();
            assert!(matches!(
                owner_outbox::append(&mut store, "workspace", pending),
                Err(owner_outbox::OwnerOutboxError::Frozen)
            ));
            assert_eq!(store.table_row_count("owner_ydoc_outboxes").unwrap(), 0);
            assert_eq!(
                store.table_row_count("owner_ydoc_outbox_entries").unwrap(),
                0
            );
            assert_eq!(store.table_row_count("binary_blobs").unwrap(), before);
            let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
            assert_eq!(
                owner
                    .fence_restore(&mut store, None, input, coordinate, 22, &NoFaults)
                    .unwrap(),
                receipt
            );
        }
    }

    #[test]
    fn restore_fence_keeps_owner_pending_bytes_and_separates_head_from_ack() {
        let mut f = Fixture::new();
        f.local_edit_before_adoption();
        let ack = f.adopt().unwrap();
        let terminal = f.cut.terminal_receipt.clone();
        f.edit(false);
        let pending_before:Vec<(String,String,i64)>=f.store.read_with(|c| {
            let mut q=c.prepare("SELECT update_digest,update_blob_digest,byte_length FROM owner_ydoc_outbox_entries WHERE pending=1 ORDER BY sequence").unwrap();
            q.query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap().collect::<Result<_,_>>()
        }).unwrap();
        assert!(!pending_before.is_empty());
        let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
        let input = NativeRestoreFence {
            operation_id: "owner-restore".into(),
            relay_database_namespace: "namespace".into(),
            old_binding: f.binding.clone(),
            host_id: coordinate.host_id.clone(),
            new_fence: 1,
            origin: RestoreDeliveryOrigin::Owner {
                id: ack.adoption_id,
            },
            terminal,
            applied_sequence: ack.local_ydoc_sequence,
        };
        let receipt = f
            ._owner
            .fence_restore(
                &mut f.store,
                None,
                input.clone(),
                coordinate.clone(),
                20,
                &NoFaults,
            )
            .unwrap();
        assert!(receipt.local_head_sequence > receipt.operation.applied_sequence);
        let pending_after:Vec<(String,String,i64)>=f.store.read_with(|c| {
            let mut q=c.prepare("SELECT update_digest,update_blob_digest,byte_length FROM owner_ydoc_outbox_entries WHERE pending=1 ORDER BY sequence").unwrap();
            q.query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap().collect::<Result<_,_>>()
        }).unwrap();
        assert_eq!(pending_after, pending_before);
        let outboxes: Vec<String> = f
            .store
            .read_with(|c| {
                let mut q = c
                    .prepare("SELECT outbox_id FROM owner_ydoc_outboxes")
                    .unwrap();
                q.query_map([], |r| r.get(0))
                    .unwrap()
                    .collect::<Result<_, _>>()
            })
            .unwrap();
        let mut retained = Vec::new();
        for id in outboxes {
            let p = owner_outbox::read_pending(&f.store, "workspace", &id).unwrap();
            assert_eq!(p.state, owner_outbox::OwnerOutboxState::Quarantined);
            retained.push(p);
        }
        assert!(f.adopt().is_err());
        let path = f._scratch.join("engine.db");
        drop(f.handle);
        drop(f._owner);
        drop(f.store);
        let mut store = EngineStore::open(&path, 21).unwrap();
        for original in retained {
            assert_eq!(
                owner_outbox::read_pending(&store, "workspace", &original.outbox_id).unwrap(),
                original
            );
        }
        let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
        assert_eq!(
            owner
                .fence_restore(&mut store, None, input, coordinate, 22, &NoFaults)
                .unwrap(),
            receipt
        );
    }
    #[test]
    fn native_outbox_headers_keep_only_recorded_human_edits() {
        use dohc_engine_domain::{ChangeActorKind, ChangeAttribution};
        for kind in [
            Some(ChangeActorKind::Human),
            Some(ChangeActorKind::Automation),
            None,
        ] {
            let mut f = Fixture::new();
            f.adopt().unwrap();
            let bytes = f.doc.richdoc_append_paragraph("native edit");
            let attribution = kind.map(|actor_kind| ChangeAttribution {
                actor_kind,
                on_behalf_of: None,
                depth: 0,
                run: None,
            });
            crate::record_local_update(
                &mut f.store,
                &mut WriterDocCache::new(),
                &f.key,
                &bytes,
                crate::LocalAppend {
                    actor_origin_id: Some("writer"),
                    attribution: attribution.as_ref(),
                    ..Default::default()
                },
                &NoFaults,
                11,
                |tx, outcome, _| {
                    owner_outbox::append_adopted_local_update_in_tx(
                        tx,
                        &f.key,
                        "owner.md",
                        outcome.seq,
                        &bytes,
                        11,
                    )
                },
            )
            .unwrap();
            let outbox_id: String = f
                .store
                .read_with(|conn| {
                    conn.query_row("SELECT outbox_id FROM owner_ydoc_outboxes", [], |row| {
                        row.get(0)
                    })
                })
                .unwrap();
            let pending = owner_outbox::read_pending(&f.store, "workspace", &outbox_id).unwrap();
            let entry = pending.entries.last().unwrap();
            let header = match owner_outbox::read_pending_page(
                &f.store,
                "workspace",
                &outbox_id,
                None,
                1 << 20,
            )
            .unwrap()
            {
                owner_outbox::OwnerOutboxPageResult::Page(page) => page,
                _ => panic!("unchanged outbox"),
            };
            let page = owner_outbox::read_pending_page(
                &f.store,
                "workspace",
                &outbox_id,
                Some(owner_outbox::OwnerOutboxReadCursor {
                    snapshot: header.cursor.snapshot,
                    part: owner_outbox::OwnerOutboxReadPart::EntryHeader,
                    sequence: entry.sequence,
                    offset: 0,
                }),
                1 << 20,
            )
            .unwrap();
            let owner_outbox::OwnerOutboxPageResult::Page(page) = page else {
                panic!("unchanged entry")
            };
            let json: serde_json::Value = serde_json::from_slice(&page.bytes).unwrap();
            assert_eq!(
                json.get("personEdit"),
                (kind == Some(ChangeActorKind::Human)).then_some(&serde_json::Value::Bool(true))
            );
        }
    }

    #[test]
    fn first_adoption_seeds_only_pending_local_state_and_preserves_history() {
        let mut f = Fixture::new();
        f.local_edit_before_adoption();
        let before = f.counts();
        let ack = f.adopt().unwrap();
        assert_eq!(ack.local_ydoc_sequence, 1);
        assert_eq!(ack.terminal_cursor, 0);
        assert_eq!(&before[..5], &f.counts()[..5]);
        assert_eq!(&f.counts()[5..], &[1, 1]);
        let (bytes, pending, created, coverage): (Vec<u8>, i64, i64, i64) = f.store.read_with(|tx| tx.query_row(
            "SELECT b.bytes,e.pending,e.created_at_ms,a.covered_outbox_sequence FROM owner_ydoc_outbox_entries e JOIN binary_blobs b ON b.sha256=e.update_blob_digest CROSS JOIN live_owner_adoptions a", [], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))).unwrap();
        assert_eq!((pending, created, coverage), (1, 10, 0));
        let credited: Option<bool> = f
            .store
            .read_with(|tx| {
                tx.query_row(
                    "SELECT person_edit FROM owner_ydoc_outbox_entries",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(credited, None);
        let seeded = Ydoc::wire();
        seeded.apply(&bytes).unwrap();
        assert!(crate::replay_parity::structurally_equal_v2(&f.doc, &seeded).unwrap());
        assert!(f.adopt().unwrap().adoption_replayed);
        assert_eq!(f.counts()[6], 1);
        let original: String = f
            .store
            .read_with(|tx| {
                tx.query_row(
                    "SELECT source_moment_id FROM ydoc_owner_base_sources",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(original, "original");
    }

    #[test]
    fn seeded_queue_seals_at_byte_and_age_limits_without_losing_the_trigger() {
        for byte_limit in [1, 1_000_000] {
            let mut f = Fixture::new();
            f.local_edit_before_adoption();
            f.cut.outbox_limits.max_pending_bytes = byte_limit;
            f.cut.outbox_limits.max_pending_age_ms = 20;
            f.adopt().unwrap();
            let state: String = f
                .store
                .read_with(|tx| {
                    tx.query_row("SELECT state FROM owner_ydoc_outboxes", [], |r| r.get(0))
                })
                .unwrap();
            assert_eq!(state, if byte_limit == 1 { "sealed" } else { "active" });
            if byte_limit != 1 {
                let result = owner_outbox::append(
                    &mut f.store,
                    "workspace",
                    crate::OwnerOutboxAppendInput {
                        binding: f.binding.clone(),
                        base_update: f.cut.baseline_bytes.clone(),
                        append_key: "later".into(),
                        update: f.doc.encode_full_state(),
                        limits: f.cut.outbox_limits.clone(),
                        created_at_ms: 30,
                    },
                )
                .unwrap();
                assert_eq!(result.state, crate::OwnerOutboxState::Sealed);
                assert_eq!(result.sequence, 2);
                assert_eq!(result.oldest_entry_at_ms, 10);
            }
            assert!(f.adopt().unwrap().adoption_replayed);
        }
    }

    #[test]
    fn adopted_queue_refuses_caller_selected_limits_without_mutation() {
        let mut f = Fixture::new();
        f.local_edit_before_adoption();
        f.adopt().unwrap();
        for (bytes, age) in [
            (2_000_000, 100_000),
            (1, 100_000),
            (1_000_000, 200_000),
            (1_000_000, 1),
        ] {
            let before = f.counts();
            assert!(owner_outbox::append(
                &mut f.store,
                "workspace",
                crate::OwnerOutboxAppendInput {
                    binding: f.binding.clone(),
                    base_update: f.cut.baseline_bytes.clone(),
                    append_key: "caller-selected".into(),
                    update: f.doc.encode_full_state(),
                    limits: crate::OwnerOutboxLimits {
                        max_pending_bytes: bytes,
                        max_pending_age_ms: age
                    },
                    created_at_ms: 11,
                }
            )
            .is_err());
            assert_eq!(before, f.counts());
        }
    }

    #[test]
    fn local_replay_budget_refuses_before_seeding() {
        let mut f = Fixture::new();
        f.local_edit_before_adoption();
        let before = f.counts();
        assert!(adopt_owner_committed(
            &mut f.store,
            &f.handle,
            f.cut.clone(),
            f.cut.baseline_bytes.len() + 1,
            100,
            10,
            &NoFaults,
            None,
            |_, _, _, _| Ok(())
        )
        .is_err());
        assert_eq!(before, f.counts());
        assert_eq!(f.store.table_row_count("live_owner_adoptions").unwrap(), 0);
    }

    #[test]
    fn bounded_seed_encoder_matches_native_state_and_refuses_overflow() {
        let mut f = Fixture::new();
        f.local_edit_before_adoption();
        let size = f.doc.encode_full_state().len();
        assert!(f.doc.encode_full_state_bounded(size - 1).is_none());
        assert!(f.doc.encode_full_state_bounded(0).is_none());
        let bytes = f.doc.encode_full_state_bounded(size).unwrap();
        assert_eq!(bytes.len(), size);
        assert_eq!(bytes, f.doc.encode_full_state());
        let decoded = Ydoc::wire();
        decoded.apply(&bytes).unwrap();
        assert!(crate::replay_parity::structurally_equal_v2(&f.doc, &decoded).unwrap());
    }
    #[test]
    fn owner_adoption_is_the_origin_for_remote_apply_and_settlement_coverage() {
        let mut f = Fixture::new();
        f.edit(true);
        f.adopt().unwrap();
        assert_eq!(
            f.store.table_row_count("live_device_bootstraps").unwrap(),
            0
        );
        let mut event = f.cut.events[0].clone();
        assert!(matches!(
            apply_committed(
                &mut f.store,
                &mut WriterDocCache::new(),
                &f.handle,
                event.clone(),
                &NoFaults,
                100_000_000,
                |_, _, _, _| Ok(())
            ),
            Err(ApplicationError::Conflict)
        ));
        f.doc
            .rewrite_content_to_markdown(ContentKind::Richdoc, "remote after adoption")
            .unwrap();
        event.update_bytes = f.doc.encode_full_state();
        event.metadata.accepted.receipt.delivery_id = "remote-after-adoption".into();
        event.metadata.accepted.receipt.journal_cursor = 8;
        event.metadata.accepted.receipt.update_digest = hex_sha256(&event.update_bytes);
        let applied = apply_committed(
            &mut f.store,
            &mut WriterDocCache::new(),
            &f.handle,
            event.clone(),
            &NoFaults,
            100_000_000,
            |_, _, _, _| Ok(()),
        )
        .unwrap();
        assert!(matches!(applied, ApplicationResult::Applied(..)));
        let result: Result<_, ApplicationError> = with_settlement(
            &mut f.store,
            &f.handle,
            Some(event.metadata.accepted.receipt.clone()),
            10,
            NativeHistoryReconstruction {
                working_reserve_bytes: 8 * 1024 * 1024,
            },
            |_, audit| Ok(audit.result("test".into(), "test-moment".into(), "a".repeat(64), false)),
        );
        let result = result.unwrap();
        assert_eq!(result.previous_cursor, 7);
        assert_eq!(result.terminal_cursor, 8);
        assert_eq!(result.application_count, 1);
        assert_eq!(result.local_ydoc_sequence, 2);
        assert_eq!(
            f.store.table_row_count("live_device_bootstraps").unwrap(),
            0
        );
        assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    }
    #[test]
    fn owner_adoption_accepts_reopened_drained_outbox_and_rejects_identity_collision() {
        let mut f = Fixture::new();
        f.edit_with_limit(true, 1);
        let (state, pending_bytes): (String, i64) = f
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT state,pending_bytes FROM owner_ydoc_outboxes",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .unwrap();
        assert_eq!(state, "active");
        assert_eq!(pending_bytes, 0);
        let before = f.counts();
        assert!(!f.adopt().unwrap().adoption_replayed);
        assert!(f.adopt().unwrap().adoption_replayed);
        f.cut.adoption_id = "different-attempt".into();
        assert!(matches!(f.adopt(), Err(ApplicationError::Conflict)));
        assert_eq!(before, f.counts());
        f.cut.adoption_id = "adoption".into();
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE owner_ydoc_outbox_entries SET update_digest=?1",
                    params![hex_sha256(b"changed")],
                )
                .map_err(write_sql)?;
                Ok::<_, ApplicationError>(())
            })
            .unwrap();
        assert!(f.adopt().is_err());
    }
    #[test]
    fn owner_adoption_replay_keeps_original_limits_after_config_change() {
        let mut f = Fixture::new();
        f.adopt().unwrap();
        for (bytes, age) in [
            (2_000_000, 200_000),
            (1_000_000, 100_000),
            (1, 100_000),
            (1_000_000, 1),
        ] {
            f.cut.outbox_limits.max_pending_bytes = bytes;
            f.cut.outbox_limits.max_pending_age_ms = age;
            if bytes < 1_000_000 || age < 100_000 {
                assert!(matches!(
                    f.adopt(),
                    Err(ApplicationError::ConfiguredBudgetMismatch)
                ));
            } else {
                assert!(f.adopt().unwrap().adoption_replayed);
            }
            let limits = f
                .store
                .read_with(|tx| {
                    tx.query_row(
                        "SELECT max_pending_bytes,max_pending_age_ms FROM live_owner_adoptions",
                        [],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )
                })
                .unwrap();
            assert_eq!(limits, (1_000_000, 100_000));
        }
    }
    #[test]
    fn owner_adoption_preserves_exact_owner_and_replays_after_later_edits() {
        for edit in [false, true] {
            let mut f = Fixture::new();
            if edit {
                f.edit(true);
            }
            let before = f.counts();
            let state = f
                .store
                .read_with(|c| durable::load_doc_in(c, &f.key))
                .unwrap();
            let ack = f.adopt().unwrap();
            assert!(!ack.adoption_replayed);
            assert_eq!(ack.local_ydoc_sequence, f.cut.expected_local_sequence);
            assert_eq!(before, f.counts());
            assert_eq!(f.store.table_row_count("live_owner_adoptions").unwrap(), 1);
            let after = f
                .store
                .read_with(|c| durable::load_doc_in(c, &f.key))
                .unwrap();
            assert!(crate::replay_parity::structurally_equal_v2(&state, &after).unwrap());
            let replay = f.adopt().unwrap();
            assert!(replay.adoption_replayed);
            assert_eq!(replay.local_ydoc_sequence, ack.local_ydoc_sequence);
            f.doc
                .rewrite_content_to_markdown(ContentKind::Richdoc, "later edit")
                .unwrap();
            let key = f.key.clone();
            let update = f.doc.encode_full_state();
            crate::record_local_update(
                &mut f.store,
                &mut WriterDocCache::new(),
                &key,
                &update,
                crate::LocalAppend::default(),
                &NoFaults,
                5,
                |tx, outcome, _| {
                    owner_outbox::append_adopted_local_update_in_tx(
                        tx,
                        &key,
                        "owner.md",
                        outcome.seq,
                        &update,
                        5,
                    )
                },
            )
            .unwrap();
            assert_eq!(
                f.adopt().unwrap().local_ydoc_sequence,
                ack.local_ydoc_sequence
            );
        }
    }
    #[test]
    fn owner_adoption_refuses_unaccounted_state_and_receipts_without_mutation() {
        for mode in 0..10 {
            let mut f = Fixture::new();
            f.edit(mode != 0);
            match mode {
                0 => {}
                1 => {
                    f.cut.events.clear();
                    f.cut.terminal_receipt = None;
                }
                2 => f.cut.source_moment_id = "same-digest-other-moment".into(),
                3 => f.cut.expected_local_sequence += 1,
                4 => f.cut.events[0].metadata.accepted.receipt.delivery_id = "forged".into(),
                5 => {
                    f.cut.events[0]
                        .metadata
                        .accepted
                        .binding
                        .restore_fence_generation += 1
                }
                6 => f
                    .store
                    .write_with(&NoFaults, |tx| {
                        tx.execute("DELETE FROM owner_ydoc_outbox_entries", [])
                            .unwrap();
                        Ok::<_, StorageError>(())
                    })
                    .map(|_| ())
                    .unwrap(),
                7 => {
                    f.cut.events[0].metadata.accepted.binding.selector_paths =
                        vec!["elsewhere".into()]
                }
                8 => f
                    .store
                    .write_with(&NoFaults, |tx| {
                        tx.execute("UPDATE ydoc_docs SET regime='local-only',lineage_claim_status='unclaimed',lineage_claim_id=NULL", [])
                            .unwrap();
                        Ok::<_, StorageError>(())
                    })
                    .map(|_| ())
                    .unwrap(),
                _ => f.cut.relay_database_namespace = "other-relay".into(),
            }
            let before = f.counts();
            assert!(f.adopt().is_err(), "mode {mode}");
            assert_eq!(before, f.counts());
            assert_eq!(f.store.table_row_count("live_owner_adoptions").unwrap(), 0);
        }
    }
    #[test]
    fn owner_adoption_refuses_missing_source_and_retired_registration() {
        let mut f = Fixture::new();
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute("DELETE FROM ydoc_owner_base_sources", [])
                    .unwrap();
                Ok::<_, StorageError>(())
            })
            .unwrap();
        assert!(f.adopt().is_err());
        let mut f = Fixture::new();
        f._owner.invalidate(&mut f.store).unwrap();
        assert!(f.adopt().is_err());
    }
    #[test]
    fn owner_source_public_vectors_match_native_validation() {
        let rows: Value = serde_json::from_str(include_str!(
            "../../tests/owner-source/owner-source-public.json"
        ))
        .unwrap();
        for row in rows.as_array().unwrap() {
            let bytes: Vec<u8> = serde_json::from_value(row["bytes"].clone()).unwrap();
            let doc = Ydoc::wire();
            doc.apply(&bytes).unwrap();
            assert_eq!(
                doc.validate_public_baseline(&bytes).is_ok(),
                row["accepted"].as_bool().unwrap(),
                "{}",
                row["name"]
            );
            if row["accepted"] == true {
                let canonical = doc.project(ContentKind::Richdoc).unwrap().content;
                assert_eq!(
                    doc.preserved_markdown_source(&canonical)
                        .unwrap_or(canonical),
                    row["markdown"].as_str().unwrap()
                );
            }
        }
    }
    #[test]
    fn owner_adoption_rolls_back_before_commit_and_replays_lost_ack_after_restart() {
        use dohc_engine_storage::{FaultAction, FaultPoint};
        struct Crash(FaultPoint);
        impl FaultInjector for Crash {
            fn poll(&self, p: FaultPoint) -> FaultAction {
                if p == self.0 {
                    FaultAction::Crash
                } else {
                    FaultAction::Continue
                }
            }
        }
        for point in [
            FaultPoint::StorageBeforePersist,
            FaultPoint::StorageAfterCommitBeforeAck,
        ] {
            let mut f = Fixture::new();
            f.local_edit_before_adoption();
            let before = f.counts();
            assert!(adopt_owner_committed(
                &mut f.store,
                &f.handle,
                f.cut.clone(),
                1_000_000,
                100,
                10,
                &Crash(point),
                None,
                |_, _, _, _| Ok(())
            )
            .is_err());
            let committed = point == FaultPoint::StorageAfterCommitBeforeAck;
            assert_eq!(&before[..5], &f.counts()[..5]);
            assert_eq!(
                &f.counts()[5..],
                &[i64::from(committed), i64::from(committed)]
            );
            assert_eq!(
                f.store.table_row_count("live_owner_adoptions").unwrap(),
                i64::from(committed)
            );
            // The registration names whatever the durable binding row names.
            let named: Option<String> = f
                .store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT activation_id FROM live_device_application_bindings",
                        [],
                        |row| row.get(0),
                    )
                })
                .unwrap();
            assert_eq!(named, committed.then(|| "adoption".to_owned()));
            assert_eq!(f.handle.activation_id(), named);
            let path = f._scratch.join("engine.db");
            drop(f.store);
            f.store = EngineStore::open(&path, 10).unwrap();
            let ack = f.adopt().unwrap();
            assert_eq!(ack.adoption_replayed, committed);
            assert_eq!(f.store.table_row_count("live_owner_adoptions").unwrap(), 1);
            assert_eq!(
                f.store
                    .table_row_count("owner_ydoc_outbox_entries")
                    .unwrap(),
                1
            );
            f.cut.adoption_id = "another-id".into();
            assert!(f.adopt().is_err());
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerAdoptionAck {
    pub adoption_id: String,
    #[serde(rename = "localYDocSequence")]
    pub local_ydoc_sequence: i64,
    pub terminal_cursor: i64,
    pub adoption_replayed: bool,
}

pub(super) fn validate_cut(
    cut: &OwnerAdoptionCut,
    binding: &LiveObjectBinding,
    max_bytes: usize,
    max_events: usize,
) -> Result<String, ApplicationError> {
    identifier(&cut.relay_database_namespace, 1024)?;
    identifier(&cut.adoption_id, 512)?;
    identifier(&cut.source_moment_id, 512)?;
    digest(&cut.source_digest)?;
    integer(
        cut.source_byte_length,
        0,
        dohc_engine_domain::MAX_TEXT_BYTES as i64,
    )?;
    integer(cut.baseline_moment_relay_sequence, 0, SAFE)?;
    integer(cut.baseline_registered_at_ms, 0, SAFE)?;
    integer(cut.expected_local_sequence, 0, SAFE)?;
    integer(cut.outbox_limits.max_pending_bytes, 1, SAFE)?;
    integer(cut.outbox_limits.max_pending_age_ms, 1, SAFE)?;
    if max_bytes == 0
        || max_events == 0
        || max_events >= i64::MAX as usize
        || cut.events.len() > max_events
        || cut.baseline_bytes.len() < 2
        || cut.baseline_bytes.len() > crate::limits::MAX_YDOC_UPDATE_BYTES
        || hex_sha256(&cut.baseline_bytes) != binding.lineage_claim_id
    {
        return Err(invalid("owner adoption baseline or capacity"));
    }
    // A successor's cut is its prefix: no events, and the prefix's terminal.
    if let Some(prefix) = &cut.retained_prefix {
        prefix.validate()?;
        if !cut.events.is_empty() || cut.terminal_receipt != prefix.terminal_receipt {
            return Err(invalid("owner adoption prefix"));
        }
    }
    let mut size = cut.baseline_bytes.len();
    let mut cursor = 0;
    let mut deliveries = std::collections::HashSet::new();
    let mut identities = Vec::with_capacity(cut.events.len());
    for event in &cut.events {
        event.validate()?;
        settlement::validate_historical_binding(&event.metadata.accepted.binding, binding)?;
        let receipt = &event.metadata.accepted.receipt;
        if receipt.journal_cursor <= cursor
            || !deliveries.insert(&receipt.delivery_id)
            || event.update_bytes.len() > crate::limits::MAX_YDOC_UPDATE_BYTES
        {
            return Err(invalid("owner adoption journal order"));
        }
        let metadata_length = bounded_evidence(
            &event.metadata,
            max_bytes
                .saturating_sub(size)
                .saturating_sub(event.update_bytes.len()),
        )?
        .0;
        size = size
            .checked_add(event.update_bytes.len())
            .and_then(|size| size.checked_add(metadata_length))
            .ok_or(invalid("owner adoption capacity"))?;
        if size > max_bytes {
            return Err(invalid("owner adoption capacity"));
        }
        cursor = receipt.journal_cursor;
        identities.push(&event.metadata);
    }
    if size > max_bytes
        || (cut.retained_prefix.is_none()
            && cut.events.last().map(|e| &e.metadata.accepted.receipt)
                != cut.terminal_receipt.as_ref())
    {
        return Err(invalid("owner adoption terminal or capacity"));
    }
    let evidence = (
        binding,
        &cut.relay_database_namespace,
        &cut.source_moment_id,
        &cut.source_digest,
        cut.source_byte_length,
        cut.baseline_moment_relay_sequence,
        cut.baseline_registered_at_ms,
        cut.expected_local_sequence,
        identities,
    );
    // The prefix is the tenth element, only when present, so a first
    // adoption's evidence keeps its nine.
    Ok(match &cut.retained_prefix {
        None => bounded_evidence(&evidence, max_bytes)?.1,
        Some(prefix) => {
            let (b, n, m, d, l, s, r, e, i) = evidence;
            bounded_evidence(&(b, n, m, d, l, s, r, e, i, prefix), max_bytes)?.1
        }
    })
}

fn bounded_evidence(
    value: &impl Serialize,
    max_bytes: usize,
) -> Result<(usize, String), ApplicationError> {
    use sha2::{Digest, Sha256};
    struct Evidence {
        size: usize,
        limit: usize,
        digest: Sha256,
    }
    impl std::io::Write for Evidence {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let size = self
                .size
                .checked_add(bytes.len())
                .filter(|size| *size <= self.limit)
                .ok_or_else(|| {
                    std::io::Error::other("owner adoption evidence exceeds configured budget")
                })?;
            self.digest.update(bytes);
            self.size = size;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Evidence {
        size: 0,
        limit: max_bytes,
        digest: Sha256::new(),
    };
    serde_json::to_writer(&mut writer, value)
        .map_err(|_| ApplicationError::ConfiguredByteBudgetExceeded)?;
    Ok((
        writer.size,
        writer
            .digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    ))
}

type VerifiedAdoptionSource = (
    String,
    String,
    i64,
    String,
    Option<super::activation::ImportedOwnerSource>,
);
type AdoptionSourceMetadata = (
    String,
    String,
    i64,
    Option<super::activation::ImportedOwnerSource>,
);

/// The adoption's verified source. A note the reader built proves its file
/// as its capture did, the released boundary's exception included, within
/// `max_bytes` of boundary proof. Once the adoption committed, that
/// exception proves it at the boundary the adoption recorded.
pub(super) fn read_adoption_source(
    conn: &Connection,
    namespace: &str,
    adoption_id: &str,
    binding: &LiveObjectBinding,
    resolver: Option<&crate::reader_resolver::ReaderResolver>,
    max_bytes: usize,
) -> Result<Option<VerifiedAdoptionSource>, ApplicationError> {
    let Some((moment, digest, length, imported)) =
        read_adoption_source_metadata(conn, namespace, adoption_id, binding)?
    else {
        return Ok(None);
    };
    if let Some(source) = &imported {
        let full =
            get_binary_blob(conn, &source.full_state_digest)?.ok_or(ApplicationError::Corrupt)?;
        if full.len() != source.full_state_byte_length
            || hex_sha256(&full) != source.full_state_digest
        {
            return Err(ApplicationError::Corrupt);
        }
        if source.reader_source {
            let doc = Ydoc::wire();
            doc.apply(&full)?;
            if !doc.has_reader_source() {
                return Err(ApplicationError::Corrupt);
            }
            let key = DocKey::new(
                &binding.workspace_id,
                &binding.main_version_id,
                &binding.object_id,
            )?;
            match crate::reader_snapshot::resolve(
                conn,
                &key,
                &doc,
                &doc.project(ContentKind::Richdoc)?.content,
                &crate::reader_snapshot::SnapshotIdentity {
                    moment: &source.source_moment_id,
                    path: &binding.current_path,
                    digest: &source.source_digest,
                    lineage: &binding.lineage_claim_id,
                    restore_fence: None,
                    authority: adoption_id,
                },
                resolver,
            ) {
                Ok(_) => {}
                Err(CollabError::MarkdownReaderUnavailable) => {
                    super::activation::reader_settled_at_boundary(
                        conn,
                        namespace,
                        &key,
                        &binding.current_path,
                        &binding.lineage_claim_id,
                        Some(adoption_id),
                        &doc,
                        (
                            &source.source_moment_id,
                            &source.source_digest,
                            source.source_byte_length,
                        ),
                        max_bytes,
                        resolver,
                    )?;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
    let text: String = text::read_sized(conn, &digest, length).map_err(read_sql)?;
    if text.len() as i64 != length || hex_sha256(text.as_bytes()) != digest {
        return Err(ApplicationError::Corrupt);
    }
    Ok(Some((moment, digest, length, text, imported)))
}

fn read_adoption_source_metadata(
    conn: &Connection,
    namespace: &str,
    adoption_id: &str,
    b: &LiveObjectBinding,
) -> Result<Option<AdoptionSourceMetadata>, ApplicationError> {
    let imported: Option<String> = conn.query_row(
        "SELECT descriptor_json FROM ydoc_owner_activation_sources WHERE activation_id=?1 AND relay_database_namespace=?2
         AND workspace_id=?3 AND version_id=?4 AND object_id=?5 AND lineage_claim_id=?6",
        params![adoption_id,namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],|r|r.get(0)).optional().map_err(read_sql)?;
    if let Some(json) = imported {
        if format!("ordinary-activation-{}", hex_sha256(json.as_bytes())) != adoption_id {
            return Err(ApplicationError::Corrupt);
        }
        let source: super::activation::ImportedOwnerSource =
            serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
        if source.version != 1
            || source.relay_database_namespace != namespace
            || source.workspace_id != b.workspace_id
            || source.main_version_id != b.main_version_id
            || source.object_id != b.object_id
            || source.lineage_claim_id != b.lineage_claim_id
            || source.current_path != b.current_path
            || source.base_relay_seq > source.committed_cursor
        {
            return Err(ApplicationError::Conflict);
        }
        integer(
            source.source_byte_length,
            0,
            dohc_engine_domain::MAX_TEXT_BYTES as i64,
        )?;
        integer(source.native_head_sequence, 0, SAFE)?;
        integer(source.committed_cursor, 0, SAFE)?;
        integer(source.base_origin_seq, 0, SAFE)?;
        integer(source.base_relay_seq, 0, source.committed_cursor)?;
        if source.full_state_byte_length < 2
            || source.full_state_byte_length > crate::limits::MAX_YDOC_UPDATE_BYTES
        {
            return Err(ApplicationError::Corrupt);
        }
        let valid_base: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM replication_log WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3
             AND imported=1 AND apply_disposition='applied' AND op_kind='ydoc.update'
             AND json_extract(payload_json,'$.versionId')=?4 AND json_extract(payload_json,'$.objectId')=?5
             AND json_extract(payload_json,'$.lineageClaimId')=?6 AND json_extract(payload_json,'$.updateBlobSha256')=?6
             AND json_extract(payload_json,'$.contentKind')='richdoc' AND json_extract(payload_json,'$.isBaseState')=1)",
            params![b.workspace_id,source.base_origin_id,source.base_origin_seq,b.main_version_id,b.object_id,b.lineage_claim_id],
            |row|row.get(0)).map_err(read_sql)?;
        if !valid_base {
            return Err(ApplicationError::Conflict);
        }
        let retained_length: i64 = conn
            .query_row(
                "SELECT length(bytes) FROM binary_blobs WHERE sha256=?1 AND byte_length=length(bytes)",
                [&source.full_state_digest],
                |row| row.get(0),
            )
            .map_err(read_sql)?;
        if retained_length != source.full_state_byte_length as i64 {
            return Err(ApplicationError::Corrupt);
        }
        let retained_text: Option<i64> = conn.query_row("SELECT t.byte_length FROM moments m JOIN blobs t ON t.sha256=m.after_blob_sha256
            WHERE m.workspace_id=?1 AND m.version_id=?2 AND m.object_id=?3 AND m.path=?4 AND m.moment_id=?5
            AND m.after_blob_sha256=?6 AND m.after_content_kind='text' AND t.byte_length=?7",
            params![b.workspace_id,b.main_version_id,b.object_id,source.current_path,source.source_moment_id,source.source_digest,source.source_byte_length],|r|r.get(0)).optional().map_err(read_sql)?;
        retained_text.ok_or(ApplicationError::Corrupt)?;
        return Ok(Some((
            source.source_moment_id.clone(),
            source.source_digest.clone(),
            source.source_byte_length,
            Some(source),
        )));
    }
    let source: Option<(String,String,i64)> = conn.query_row(
        "SELECT s.source_moment_id,s.source_blob_sha256,s.source_byte_length
         FROM ydoc_owner_base_sources s JOIN moments m ON m.workspace_id=s.workspace_id AND m.version_id=s.version_id
         AND m.object_id=s.object_id AND m.path=s.path AND m.moment_id=s.source_moment_id
         AND m.after_blob_sha256=s.source_blob_sha256 AND m.after_content_kind='text'
         JOIN blobs t ON t.sha256=s.source_blob_sha256 AND t.byte_length=s.source_byte_length
         WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3 AND s.lineage_claim_id=?4 AND s.path=?5",
        params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.current_path],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(read_sql)?;
    Ok(source.map(|(moment, digest, length)| (moment, digest, length, None)))
}

/// Prove an existing owner's state without changing its domain history, base,
/// update sequence, or projection. First adoption can seed a pending local cut.
/// The captured registration
/// mutex and actor writer lane remain held through the audit transaction.
#[allow(clippy::too_many_arguments)]
pub fn adopt_owner_committed(
    store: &mut EngineStore,
    handle: &ApplicationHandle,
    cut: OwnerAdoptionCut,
    max_bytes: usize,
    max_events: usize,
    now_ms: i64,
    faults: &dyn FaultInjector,
    resolver: Option<&crate::reader_resolver::ReaderResolver>,
    follow_up: impl FnOnce(
        &Transaction<'_>,
        &str,
        &LiveObjectBinding,
        i64,
    ) -> Result<(), ApplicationError>,
) -> Result<OwnerAdoptionAck, ApplicationError> {
    let mut held = handle
        .registration
        .lock()
        .map_err(|_| ApplicationError::Interrupted)?;
    if !held.live {
        return Err(ApplicationError::Interrupted);
    }
    // A retired activation never adopts, so nothing commits whose answer is
    // withheld. The durable intent refuses it below, after a restart too.
    if handle.retired.contains(&cut.adoption_id) {
        return Err(ApplicationError::Conflict);
    }
    if cut.relay_database_namespace != held.namespace {
        return Err(ApplicationError::Conflict);
    }
    settlement::validate_historical_binding(&held.binding, &held.binding)?;
    let evidence_digest = validate_cut(&cut, &held.binding, max_bytes, max_events)?;
    let b = &held.binding;
    let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
    let result = store.write_with(faults, |tx| {
        require_workspace(tx, &held)?;
        retirement::require_not_retiring(tx, &held.namespace, &cut.adoption_id)?;
        if !read_binding(tx, &held)?.is_some_and(|(binding, coordinate, available)| available && binding == *b && coordinate == held.coordinate) {
            return Err(ApplicationError::Interrupted);
        }
        let marker = durable::read_marker_in(tx, &key)?.ok_or(ApplicationError::Conflict)?;
        if marker.content_kind != ContentKind::Richdoc || marker.regime != Regime::Replicated
            || marker.lineage_claim_status != durable::LineageClaimStatus::Exact
            || marker.lineage_claim_id.as_deref() != Some(&b.lineage_claim_id)
            || marker.path.as_deref() != Some(&b.current_path) {
            return Err(ApplicationError::Conflict);
        }
        let present:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM snapshots s JOIN path_aliases p USING(workspace_id,version_id,object_id,path) WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3 AND s.path=?4 AND s.content_kind='text')",
            params![b.workspace_id,b.main_version_id,b.object_id,b.current_path],|r|r.get(0)).map_err(read_sql)?;
        if !present { return Err(ApplicationError::Conflict); }
        let (moment,digest,length,text,imported_source) = read_adoption_source(tx,&held.namespace,&cut.adoption_id,b,resolver,max_bytes)?
            .ok_or(invalid("owner adoption source evidence missing"))?;
        let evidence_digest = if let Some(source) = &imported_source {
            if source.native_head_sequence != cut.expected_local_sequence { return Err(ApplicationError::Conflict); }
            bounded_evidence(&("ordinary-replication", &evidence_digest, &source), max_bytes)?.1
        } else { evidence_digest.clone() };
        if moment != cut.source_moment_id || digest != cut.source_digest || length != cut.source_byte_length
            || text.len() as i64 != length || hex_sha256(text.as_bytes()) != digest {
            return Err(ApplicationError::Conflict);
        }
        let original: Option<String> = tx.query_row(
            "SELECT snapshot_blob_sha256 FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND up_to_seq=0",
            params![b.workspace_id,b.main_version_id,b.object_id], |r| r.get(0)).optional().map_err(read_sql)?;
        if original.as_deref() != Some(&b.lineage_claim_id)
            || get_binary_blob(tx, &b.lineage_claim_id)?.as_deref() != Some(cut.baseline_bytes.as_slice()) {
            return Err(ApplicationError::Conflict);
        }
        // A replay matches the activation this adoption made, while it is current.
        let previous = owner_activations::activation_by_id(tx,&held.namespace,&cut.adoption_id)?;
        let binding_json=serde_json::to_string(b).map_err(|_| ApplicationError::Corrupt)?;
        if let Some(previous) = previous {
            let Some(saved) = previous.adoption.filter(|_| !previous.released) else { return Err(ApplicationError::Conflict) };
            if cut.outbox_limits.max_pending_bytes < saved.max_pending_bytes || cut.outbox_limits.max_pending_age_ms < saved.max_pending_age_ms {
                return Err(ApplicationError::ConfiguredBudgetMismatch);
            }
            let origin = read_origin(tx,&held)?.ok_or(ApplicationError::Corrupt)?;
            if origin.terminal != cut.terminal_receipt { return Err(ApplicationError::Corrupt); }
            let (sequence,cursor) = (saved.local_ydoc_sequence,saved.terminal_cursor);
            if saved.evidence_digest != evidence_digest || previous.binding_json != binding_json || sequence != cut.expected_local_sequence
                || marker.head_update_seq < sequence || cursor != cut.terminal_receipt.as_ref().map_or(0,|r|r.journal_cursor) {
                return Err(ApplicationError::Conflict);
            }
            // A successor's coverage held when it adopted; its carried entries
            // apply after that. Its evidence binds the prefix it adopted.
            if cut.retained_prefix.is_none() && outbox_coverage(tx,&held,&key,&cut.events,max_events,Some(saved.covered_outbox_sequence))? != (saved.coverage_digest,saved.covered_outbox_sequence) { return Err(ApplicationError::Corrupt); }
            return Ok(OwnerAdoptionAck {adoption_id:cut.adoption_id.clone(),local_ydoc_sequence:sequence,terminal_cursor:cursor,adoption_replayed:true});
        }
        // Opus, round 3b: a retirement still settling the document decides
        // which activation follows it, so nothing adopts until it releases.
        if retirement::retiring(tx, &key)? || held.activation_id.as_ref().is_some_and(|id| *id != cut.adoption_id) {
            return Err(ApplicationError::Conflict);
        }
        // A lineage adopts once. After that only the exact successor of its
        // released chain tail activates it, under the same origin. A first
        // adoption follows exactly the released tail its capture named, and
        // one without a capture only a lineage that released nothing.
        let captured_predecessor = imported_source.as_ref().and_then(|source| source.predecessor_activation_id.clone());
        let succession = match &cut.retained_prefix {
            None if owner_activations::lineage_origin_id(tx,None,&key,&b.lineage_claim_id)?.is_some() => return Err(ApplicationError::Conflict),
            None => {
                if owner_activations::released_chain_tail(tx,&held.namespace,&key,&b.lineage_claim_id)? != captured_predecessor {
                    return Err(ApplicationError::Conflict);
                }
                None
            }
            Some(prefix) => Some(require_succession(tx, &held, &key, prefix, imported_source.as_ref(), max_events)?),
        };
        if marker.head_update_seq != cut.expected_local_sequence { return Err(invalid("owner adoption evidence is stale")); }
        require_local_replay_budget(tx, &key, max_bytes)?;
        let local = durable::load_doc_in(tx, &key)?;
        let encode_full = || local.encode_full_state_bounded(max_bytes.min(crate::limits::MAX_YDOC_UPDATE_BYTES))
            .ok_or(ApplicationError::ConfiguredByteBudgetExceeded);
        let full = match &imported_source {
            Some(source) => {
                if !super::activation::matches_imported_state(tx, &local, source, max_bytes)? {
                    return Err(ApplicationError::Conflict);
                }
                Some(encode_full()?)
            }
            None => None,
        };
        if local.has_missing_updates() {
            return Err(invalid("owner adoption journal does not account for durable state"));
        }
        let (coverage,covered_sequence,seed,current_outbox,retired) = match &succession {
            None => {
                let journal = Ydoc::wire();
                journal.apply(&cut.baseline_bytes)?;
                if imported_source.as_ref().is_some_and(|source| source.reader_source) {
                    journal.validate_reader_baseline(&cut.baseline_bytes)?;
                } else {
                    journal.validate_public_baseline(&cut.baseline_bytes)?;
                }
                for event in &cut.events { journal.apply(&event.update_bytes)?; }
                if journal.has_missing_updates() {
                    return Err(invalid("owner adoption journal does not account for durable state"));
                }
                let (coverage,covered_sequence) = outbox_coverage(tx, &held, &key, &cut.events, max_events,None)?;
                let seed = !crate::replay_parity::structurally_equal_v2(&local, &journal)?;
                if seed {
                    let existing_outbox: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4)",
                        params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id], |r|r.get(0)).map_err(read_sql)?;
                    if existing_outbox || !cut.events.is_empty() || cut.terminal_receipt.is_some() {
                        return Err(invalid("owner adoption journal does not account for durable state"));
                    }
                }
                (coverage,covered_sequence,seed,None,Vec::new())
            }
            Some(succession) => {
                // The accepted state at B, which local state must contain:
                // merging it into a copy of local state adds nothing.
                let through = succession.prefix.terminal_receipt.as_ref().map_or(0,|r|r.journal_cursor);
                let accepted = accepted_history::read_state(tx, &held, through, cut.reconstruction)?;
                let accepted_full = accepted.encode_full_state_bounded(crate::limits::MAX_YDOC_UPDATE_BYTES)
                    .ok_or(ApplicationError::ConfiguredByteBudgetExceeded)?;
                let merged = Ydoc::wire();
                merged.apply(full.as_deref().ok_or(ApplicationError::Corrupt)?)?;
                merged.apply(&accepted_full)?;
                if accepted.has_missing_updates() || merged.has_missing_updates()
                    || !crate::replay_parity::structurally_equal_v2(&merged, &local)? {
                    return Err(ApplicationError::Conflict);
                }
                let retained = retained_outbox_coverage(tx, &held, &key, succession, max_events)?;
                (retained.digest,retained.covered_sequence,!crate::replay_parity::structurally_equal_v2(&local, &accepted)?,retained.current,retained.retired)
            }
        };
        let terminal_cursor = cut.terminal_receipt.as_ref().map_or(0,|r|r.journal_cursor);
        // From adoption on, the interval names only authors of accepted
        // content. Carry the authors of local edits no settlement named yet.
        crate::author_coverage::fold_in(tx, &key, i64::MAX)?;
        if cut.events.iter().any(|event| {
            event.metadata.author_snapshot.as_ref().is_none_or(Vec::is_empty)
        }) {
            crate::author_coverage::admit_accepted_in(tx, &key, &[])?;
        }
        let terminal_json = serde_json::to_string(&cut.terminal_receipt).map_err(|_|ApplicationError::Corrupt)?;
        let host_json = serde_json::to_string(&held.coordinate).map_err(|_|ApplicationError::Corrupt)?;
        match &succession {
            None => {
                tx.execute("INSERT INTO live_owner_adoptions(relay_database_namespace,adoption_id,workspace_id,main_version_id,object_id,lineage_claim_id,binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,host_coordinate_json,max_pending_bytes,max_pending_age_ms)
                    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
                    params![held.namespace,cut.adoption_id,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,binding_json,cut.source_moment_id,cut.source_digest,cut.source_byte_length,cut.baseline_moment_relay_sequence,cut.baseline_registered_at_ms,evidence_digest,coverage,covered_sequence,marker.head_update_seq,terminal_cursor,terminal_json,host_json,cut.outbox_limits.max_pending_bytes,cut.outbox_limits.max_pending_age_ms]).map_err(write_sql)?;
                tx.execute(owner_activations::ACTIVATE_ADOPTION,params![held.namespace,cut.adoption_id,captured_predecessor]).map_err(write_sql)?;
            }
            Some(succession) => {
                tx.execute("INSERT INTO live_owner_activations (relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,origin_adoption_id,predecessor_activation_id,binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,host_coordinate_json,evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,max_pending_bytes,max_pending_age_ms,boundary_json)
                    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)",
                    params![held.namespace,cut.adoption_id,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,succession.root,succession.prefix.predecessor_activation_id,binding_json,cut.source_moment_id,cut.source_digest,cut.source_byte_length,cut.baseline_moment_relay_sequence,cut.baseline_registered_at_ms,host_json,evidence_digest,coverage,covered_sequence,marker.head_update_seq,terminal_cursor,terminal_json,cut.outbox_limits.max_pending_bytes,cut.outbox_limits.max_pending_age_ms,
                        serde_json::to_string(&succession.prefix).map_err(|_|ApplicationError::Corrupt)?]).map_err(write_sql)?;
            }
        }
        tx.execute("UPDATE live_device_application_bindings SET activation_id=?5 WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4",
            params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,cut.adoption_id]).map_err(write_sql)?;
        for outbox in &retired {
            retire_outbox(tx, outbox, b)?;
        }
        match &current_outbox {
            Some(CurrentOutbox::Reopen(outbox)) => reopen_outbox(tx, outbox)?,
            Some(CurrentOutbox::Open) => crate::owner_outbox::open_successor_outbox_in_tx(tx, b, now_ms)
                .map_err(|error| match error {
                    crate::OwnerOutboxError::Storage(error) => ApplicationError::Storage(error),
                    _ => ApplicationError::Corrupt,
                })?,
            None => {}
        }
        // The activation row exists first, so the seed is this activation's
        // own delivery, under its limits, and no released lineage's.
        if seed {
            let full = match full { Some(full) => full, None => encode_full()? };
            let append_key = format!("owner-adoption:{}",hex_sha256(&serde_json::to_vec(&(&cut.adoption_id,marker.head_update_seq,hex_sha256(&full))).map_err(|_|ApplicationError::Corrupt)?));
            let entry = crate::owner_outbox::append_in_tx(tx,&b.workspace_id,crate::OwnerOutboxAppendInput {
                binding:b.clone(),base_update:cut.baseline_bytes.clone(),append_key,update:full,
                limits:cut.outbox_limits.clone(),created_at_ms:now_ms,
            }).map_err(|error| match error {
                crate::OwnerOutboxError::Storage(error) => ApplicationError::Storage(error),
                crate::OwnerOutboxError::Corrupt => ApplicationError::Corrupt,
                _ => invalid("owner adoption local seed could not be retained"),
            })?;
            crate::owner_outbox::retain_native_source(tx,&entry,&crate::owner_outbox::OwnerOutboxNativeSource {
                binding:b.clone(),adoption_id:cut.adoption_id.clone(),native_sequence:marker.head_update_seq,
                update_digest:entry.update_digest.clone(),origin:crate::owner_outbox::OwnerOutboxNativeOrigin::AdoptionSeed,
            }).map_err(|_|ApplicationError::Corrupt)?;
        }
        // A successor continues the lineage's accepted history as it is.
        if succession.is_none() {
            accepted_history::initialize(tx, &held, &cut.baseline_bytes)?;
            for event in &cut.events { accepted_history::append_native(tx, &held, event, max_bytes)?; }
        }
        follow_up(tx, &held.namespace, b, cut.events.len() as i64)?;
        Ok(OwnerAdoptionAck { adoption_id:cut.adoption_id.clone(),local_ydoc_sequence:marker.head_update_seq,terminal_cursor,adoption_replayed:false })
    })?;
    match result {
        TxnOutcome::Committed(ack) => {
            held.activation_id = Some(ack.adoption_id.clone());
            Ok(ack)
        }
        // The binding row names the activation once the commit is durable,
        // so the registration names it too.
        TxnOutcome::Crashed { committed } => {
            if committed {
                held.activation_id = Some(cut.adoption_id.clone());
            }
            Err(ApplicationError::Interrupted)
        }
    }
}

pub(super) fn require_local_replay_budget(
    conn: &Connection,
    key: &DocKey,
    max_bytes: usize,
) -> Result<usize, ApplicationError> {
    let (sequence, digest) =
        durable::latest_snapshot(conn, key)?.ok_or(ApplicationError::Corrupt)?;
    let mut total: i64 = conn
        .query_row(
            "SELECT length(bytes) FROM binary_blobs WHERE sha256=?1",
            [digest],
            |r| r.get(0),
        )
        .map_err(read_sql)?;
    let mut statement = conn.prepare("SELECT length(b.bytes) FROM ydoc_updates u LEFT JOIN binary_blobs b ON b.sha256=u.update_blob_sha256 WHERE u.workspace_id=?1 AND u.version_id=?2 AND u.object_id=?3 AND u.seq>?4 ORDER BY u.seq").map_err(read_sql)?;
    let rows = statement
        .query_map(
            params![key.workspace_id, key.version_id, key.object_id, sequence],
            |r| r.get::<_, i64>(0),
        )
        .map_err(read_sql)?;
    for size in rows {
        total = total
            .checked_add(size.map_err(read_sql)?)
            .ok_or(ApplicationError::Corrupt)?;
        if total < 0 {
            return Err(ApplicationError::Corrupt);
        };
        if total as u64 > max_bytes as u64 {
            return Err(ApplicationError::ConfiguredByteBudgetExceeded);
        }
    }
    if total < 0 {
        return Err(ApplicationError::Corrupt);
    };
    if total as u64 > max_bytes as u64 {
        return Err(ApplicationError::ConfiguredByteBudgetExceeded);
    }
    usize::try_from(total).map_err(|_| ApplicationError::Corrupt)
}

/// A first adoption's coverage of the outbox at its binding: each entry
/// through the terminal sequence either an Owner receipt from the cut, in
/// journal order, or a strictly refused draft. A first adoption follows no
/// adopted chain, so a refused native source refuses it. Entries keep the
/// representation a successor's coverage has.
fn outbox_coverage(
    conn: &Connection,
    held: &Registration,
    key: &DocKey,
    events: &[AdmittedLiveUpdate],
    max_events: usize,
    replay_sequence: Option<i64>,
) -> Result<(String, i64), ApplicationError> {
    let b = &held.binding;
    let selectors =
        serde_json::to_string(&b.selector_paths).map_err(|_| ApplicationError::Corrupt)?;
    let parent: Option<(String,String,String,i64,i64)> = conn.query_row(
        "SELECT outbox_id,state,base_update_digest,pending_bytes,next_sequence FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND current_path=?5 AND selector_paths_json=?6 AND restore_fence_generation=?7",
        params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.current_path,selectors,b.restore_fence_generation],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(read_sql)?;
    let receipts: std::collections::HashMap<_, _> = events
        .iter()
        .map(|event| {
            (
                &event.metadata.accepted.receipt.delivery_id,
                &event.metadata.accepted,
            )
        })
        .collect();
    let mut coverage = Vec::new();
    if let Some((id, state, base, pending, next)) = parent {
        let terminal = replay_sequence.unwrap_or(next - 1);
        if (state != "active" && state != "sealed")
            || base != b.lineage_claim_id
            || (replay_sequence.is_none() && pending != 0)
            || next < 1
            || terminal < 0
            || terminal >= next
            || terminal as u64 > max_events as u64
        {
            return Err(invalid("owner adoption outbox is not drained"));
        }
        let mut query = conn.prepare("SELECT sequence,delivery_id,update_digest,pending,terminal_reason IS NOT NULL OR terminal_blob_digest IS NOT NULL FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND sequence<=?2 ORDER BY sequence LIMIT ?3").map_err(read_sql)?;
        let rows = query
            .query_map(params![id, terminal, max_events as i64 + 1], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, bool>(4)?,
                ))
            })
            .map_err(read_sql)?;
        let mut cursor = 0;
        for row in rows {
            let (sequence, delivery, digest, pending, terminal) = row.map_err(read_sql)?;
            if sequence != coverage.len() as i64 + 1 || pending != 0 {
                return Err(ApplicationError::Conflict);
            }
            let Some(accepted) = receipts.get(&delivery) else {
                let refusal = retirement::refused_entry(
                    conn,
                    &held.namespace,
                    key,
                    &b.lineage_claim_id,
                    &id,
                    sequence,
                )?
                .ok_or(invalid("owner adoption receipt coverage missing"))?;
                if refusal.source.is_some() {
                    return Err(ApplicationError::Conflict);
                }
                coverage.push((
                    id.clone(),
                    sequence,
                    retirement::Disposition::Refused {
                        delivery_id: refusal.delivery_id,
                        update_digest: refusal.update_digest,
                        terminal_reason: refusal.terminal_reason,
                    },
                ));
                continue;
            };
            let receipt = &accepted.receipt;
            // Acceptance evidence beside terminal evidence contradicts itself.
            if terminal
                || receipt.update_digest != digest
                || !matches!(
                    accepted.authority,
                    ServerDerivedLiveUpdateAuthority::Owner { .. }
                )
                || receipt.journal_cursor <= cursor
            {
                return Err(ApplicationError::Conflict);
            }
            cursor = receipt.journal_cursor;
            coverage.push((
                id.clone(),
                sequence,
                retirement::Disposition::Receipt {
                    receipt: receipt.clone(),
                },
            ));
        }
        if coverage.len() as i64 != terminal {
            return Err(invalid("owner adoption retained outbox coverage missing"));
        }
    } else {
        let exists: bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4)",params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],|r|r.get(0)).map_err(read_sql)?;
        if exists || replay_sequence.is_some_and(|sequence| sequence != 0) {
            return Err(ApplicationError::Conflict);
        }
    }
    Ok((
        hex_sha256(&serde_json::to_vec(&coverage).map_err(|_| ApplicationError::Corrupt)?),
        coverage.len() as i64,
    ))
}

/// What a successor proved about the released chain it follows.
struct Succession {
    /// The lineage's immutable origin, which the successor keeps.
    root: String,
    prefix: RetainedPrefix,
    /// The chain, walked once within its budget.
    chain: ChainBindings,
    /// The chain's Carried deliveries, each at its original entry.
    carried: Vec<retirement::InheritedEntry>,
}

/// A successor follows exactly its namespace's released chain tail, at the
/// boundary that tail kept, while no namespace holds the lineage and its
/// accepted history still ends there. Only a captured source names the
/// activation it follows. The chain fits `max_events` before anything
/// resolves through it.
fn require_succession(
    tx: &Transaction<'_>,
    held: &Registration,
    key: &DocKey,
    prefix: &RetainedPrefix,
    source: Option<&super::activation::ImportedOwnerSource>,
    max_events: usize,
) -> Result<Succession, ApplicationError> {
    let lineage = &held.binding.lineage_claim_id;
    let predecessor = prefix.predecessor_activation_id.as_str();
    if source.and_then(|source| source.predecessor_activation_id.as_deref()) != Some(predecessor) {
        return Err(ApplicationError::Conflict);
    }
    let root = owner_activations::lineage_origin_id(tx, Some(&held.namespace), key, lineage)?
        .ok_or(ApplicationError::Conflict)?;
    if owner_activations::current_activation(tx, None, key, lineage)?.is_some()
        || owner_activations::released_chain_tail(tx, &held.namespace, key, lineage)?.as_deref()
            != Some(predecessor)
    {
        return Err(ApplicationError::Conflict);
    }
    let (boundary, _) = retirement::released_tail(tx, &held.namespace, predecessor)?;
    if boundary.as_ref() != Some(&prefix.body())
        || retirement::accepted_endpoint(tx, &held.namespace, key, lineage)? != prefix.body()
    {
        return Err(ApplicationError::Conflict);
    }
    let chain = chain_bindings(tx, &held.namespace, key, lineage, predecessor, max_events)?;
    let carried = retirement::inherited_in_chain(
        tx,
        &held.namespace,
        key,
        lineage,
        predecessor,
        &chain.activations,
    )?;
    Ok(Succession {
        root,
        prefix: prefix.clone(),
        chain,
        carried,
    })
}

/// A quarantine a successor may end: its predecessor's seed failed
/// provenance and was strictly abandoned.
const PROVENANCE_REFUSED: &str = "provenance-refused";

/// The quarantine a successor's adoption gives each outbox its coverage
/// proved at an earlier binding of its restore generation, so the outbox at
/// its own binding is the generation's one writable outbox. The observed
/// binding names that successor.
pub(crate) const SUCCESSION_RETIRED: &str = "succession-retired";

/// What a successor's adoption does to the outbox at its binding.
#[derive(Debug, PartialEq, Eq)]
enum CurrentOutbox {
    /// Reopen the one a seed's provenance refusal or an earlier succession
    /// quarantined.
    Reopen(String),
    /// Open it beside the outboxes the chain left at earlier bindings of this
    /// restore generation, so the successor's own deliveries have one.
    Open,
}

/// A successor's coverage of the outboxes its released chain left.
struct RetainedOutboxes {
    /// Each covered entry's outbox, sequence and disposition, hashed.
    digest: String,
    /// The high-water mark of the outbox at the successor's binding.
    covered_sequence: i64,
    current: Option<CurrentOutbox>,
    /// Covered outboxes at earlier bindings that are still open, which the
    /// adoption retires.
    retired: Vec<String>,
}

/// A successor's coverage of every outbox its released chain left in the
/// document's lineage, under one budget: the outbox at its exact binding, and
/// each at a binding an adopted activation of the chain held at this restore
/// generation. Each binding the chain held must be one this document held
/// before, so an arbitrary one refuses. The coverage takes no outbox at an
/// earlier generation, which stays behind its restore fence. Any other
/// outbox in this generation refuses the succession, even an empty one.
/// A quarantined outbox counts only when its totals show nothing pending and
/// - a seed's provenance refusal quarantined it, at its own binding, and the
///   seed was strictly abandoned; or
/// - an earlier succession retired it, and the binding it names is one an
///   adopted activation of the chain held after this outbox's.
///
/// The successor reopens either at its binding. Every other quarantine
/// refuses the succession. Each open outbox at an earlier binding, drained,
/// is retired.
fn retained_outbox_coverage(
    tx: &Transaction<'_>,
    held: &Registration,
    key: &DocKey,
    succession: &Succession,
    max_events: usize,
) -> Result<RetainedOutboxes, ApplicationError> {
    let b = &held.binding;
    let chain = &succession.chain;
    require_historical(tx, held, key, &chain.bindings(), max_events)?;
    type Row = (
        String,
        String,
        String,
        i64,
        String,
        String,
        Option<String>,
        Option<String>,
        i64,
        Option<i64>,
        i64,
    );
    let rows: Vec<Row> = {
        let mut query = tx.prepare(
            "SELECT outbox_id,current_path,selector_paths_json,restore_fence_generation,state,base_update_digest,
                quarantine_reason,observed_binding_json,pending_bytes,oldest_entry_at_ms,pending_entry_count
             FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4
             ORDER BY outbox_id LIMIT ?5",
        ).map_err(read_sql)?;
        let limit = i64::try_from(max_events)
            .map_err(|_| over_budget())?
            .saturating_add(1);
        let rows = query
            .query_map(
                params![
                    b.workspace_id,
                    b.main_version_id,
                    b.object_id,
                    b.lineage_claim_id,
                    limit
                ],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                        r.get(10)?,
                    ))
                },
            )
            .map_err(read_sql)?
            .collect::<Result<_, _>>()
            .map_err(read_sql)?;
        rows
    };
    if rows.len() > max_events {
        return Err(over_budget());
    }
    let (mut current, mut retained, mut abandoning, mut retired) =
        (None, Vec::new(), Vec::new(), Vec::new());
    // Whether the chain left an outbox at an earlier binding of this
    // generation.
    let mut moved = false;
    for (id, path, selectors, generation, state, base, reason, observed, pending, oldest, count) in
        rows
    {
        if generation != b.restore_fence_generation {
            continue;
        }
        let binding = LiveObjectBinding {
            workspace_id: b.workspace_id.clone(),
            main_version_id: b.main_version_id.clone(),
            object_id: b.object_id.clone(),
            lineage_claim_id: b.lineage_claim_id.clone(),
            current_path: path,
            selector_paths: serde_json::from_str(&selectors)
                .map_err(|_| ApplicationError::Corrupt)?,
            restore_fence_generation: generation,
        };
        let at_binding = binding == *b;
        if (!at_binding && !chain.contains(&binding)) || base != b.lineage_claim_id {
            return Err(ApplicationError::Conflict);
        }
        let drained = pending == 0 && oldest.is_none() && count == 0;
        let observed = observed
            .map(|json| serde_json::from_str::<LiveObjectBinding>(&json))
            .transpose()
            .map_err(|_| ApplicationError::Corrupt)?;
        let quarantined = match (state.as_str(), reason.as_deref()) {
            ("active" | "sealed", _) if at_binding => false,
            ("active" | "sealed", _) if drained => {
                retired.push(id.clone());
                false
            }
            ("quarantined", Some(PROVENANCE_REFUSED))
                if drained
                    && observed
                        .as_ref()
                        .is_none_or(|observed| *observed == binding) =>
            {
                abandoning.push(id.clone());
                true
            }
            ("quarantined", Some(SUCCESSION_RETIRED))
                if drained
                    && observed
                        .as_ref()
                        .is_some_and(|observed| chain.followed(&binding, observed)) =>
            {
                true
            }
            _ => return Err(ApplicationError::Conflict),
        };
        if !at_binding {
            moved = true;
        } else if current.replace((id.clone(), quarantined)).is_some() {
            return Err(ApplicationError::Conflict);
        }
        retained.push(id);
    }
    let coverage = retirement::retained_coverage(
        tx,
        &held.namespace,
        key,
        &b.lineage_claim_id,
        &retained,
        &succession.prefix,
        &succession.carried,
        &chain.activations,
        max_events,
    )?;
    let abandoned = |outbox: &String| {
        coverage.iter().any(|(id, _, disposition)| {
            id == outbox && *disposition == retirement::Disposition::Abandoned
        })
    };
    if !abandoning.iter().all(abandoned) {
        return Err(ApplicationError::Conflict);
    }
    let covered_sequence = coverage
        .iter()
        .filter(|(id, ..)| current.as_ref().is_some_and(|(current, _)| current == id))
        .count() as i64;
    let current = match current {
        Some((id, quarantined)) => quarantined.then_some(CurrentOutbox::Reopen(id)),
        None => moved.then_some(CurrentOutbox::Open),
    };
    Ok(RetainedOutboxes {
        digest: hex_sha256(&serde_json::to_vec(&coverage).map_err(|_| ApplicationError::Corrupt)?),
        covered_sequence,
        current,
        retired,
    })
}

/// The bindings the adopted activations of a released chain held, each with
/// the nearest and farthest distance from the chain's tail an activation
/// held it at, and every activation the chain walk visited.
struct ChainBindings {
    bindings: Vec<(LiveObjectBinding, usize, usize)>,
    index: std::collections::HashMap<LiveObjectBinding, usize>,
    activations: std::collections::HashSet<String>,
}

impl ChainBindings {
    fn bindings(&self) -> Vec<&LiveObjectBinding> {
        self.bindings.iter().map(|(binding, ..)| binding).collect()
    }

    fn contains(&self, binding: &LiveObjectBinding) -> bool {
        self.index.contains_key(binding)
    }

    /// Whether an activation holding `later` followed one holding `earlier`.
    fn followed(&self, earlier: &LiveObjectBinding, later: &LiveObjectBinding) -> bool {
        match (self.index.get(earlier), self.index.get(later)) {
            (Some(&earlier), Some(&later)) => self.bindings[later].1 < self.bindings[earlier].2,
            _ => false,
        }
    }
}

/// The error for coverage, or the proof it rests on, past its budget.
fn over_budget() -> ApplicationError {
    invalid("owner adoption retained outbox coverage exceeds its budget")
}

/// The bindings the adopted activations of the released chain ending at
/// `tail` held in this document's lineage. The walk counts every activation
/// it visits, however many held one binding, and refuses past `max_events`
/// rather than take a cut-off chain as whole.
fn chain_bindings(
    conn: &Connection,
    namespace: &str,
    key: &DocKey,
    lineage: &str,
    tail: &str,
    max_events: usize,
) -> Result<ChainBindings, ApplicationError> {
    let mut query = conn
        .prepare(
            "WITH RECURSIVE chain(activation_id,depth) AS (SELECT ?2,0 UNION ALL
               SELECT v.predecessor_activation_id,c.depth+1 FROM chain c JOIN live_owner_activations v
                 ON v.relay_database_namespace=?1 AND v.activation_id=c.activation_id
               WHERE v.predecessor_activation_id IS NOT NULL LIMIT ?7)
             SELECT c.depth,c.activation_id,v.binding_json FROM chain c LEFT JOIN live_owner_activations v
               ON v.relay_database_namespace=?1 AND v.activation_id=c.activation_id
               AND v.workspace_id=?3 AND v.main_version_id=?4 AND v.object_id=?5 AND v.lineage_claim_id=?6
               AND v.released_at_ms IS NOT NULL AND v.evidence_digest IS NOT NULL
             ORDER BY c.depth",
        )
        .map_err(read_sql)?;
    let limit = i64::try_from(max_events)
        .map_err(|_| ApplicationError::Corrupt)?
        .saturating_add(1);
    let rows = query
        .query_map(
            params![
                namespace,
                tail,
                key.workspace_id,
                key.version_id,
                key.object_id,
                lineage,
                limit
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .map_err(read_sql)?;
    let mut chain = ChainBindings {
        bindings: Vec::new(),
        index: std::collections::HashMap::new(),
        activations: std::collections::HashSet::new(),
    };
    for (visited, row) in rows.enumerate() {
        let (depth, activation, json) = row.map_err(read_sql)?;
        if visited >= max_events {
            return Err(over_budget());
        }
        chain.activations.insert(activation);
        let Some(json) = json else { continue };
        let binding: LiveObjectBinding =
            serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
        let depth = usize::try_from(depth).map_err(|_| ApplicationError::Corrupt)?;
        match chain.index.get(&binding) {
            Some(&at) => chain.bindings[at].2 = depth,
            None => {
                chain.index.insert(binding.clone(), chain.bindings.len());
                chain.bindings.push((binding, depth, depth));
            }
        }
    }
    Ok(chain)
}

/// Each binding the released chain held must be one this document held
/// before the registration's: at its path, or one lineage-preserving renames
/// moved it from, and at its restore generation, or one that resumed restores
/// led from to it. Rename and restore history are each walked once, for
/// every binding.
fn require_historical(
    conn: &Connection,
    held: &Registration,
    key: &DocKey,
    chain: &[&LiveObjectBinding],
    max_events: usize,
) -> Result<(), ApplicationError> {
    let b = &held.binding;
    for historical in chain {
        settlement::validate_historical_binding(historical, historical)?;
    }
    let moved_from: std::collections::HashSet<&str> = chain
        .iter()
        .map(|historical| historical.current_path.as_str())
        .filter(|path| *path != b.current_path)
        .collect();
    let renamed = renamed_from(conn, key, &b.current_path, &moved_from, max_events)?;
    let resumed = if chain
        .iter()
        .any(|historical| historical.restore_fence_generation != b.restore_fence_generation)
    {
        resumed_generations(conn, held, max_events)?
    } else {
        std::collections::HashSet::new()
    };
    for historical in chain {
        let mut moved = (*historical).clone();
        if historical.current_path != b.current_path {
            if !renamed.contains(&historical.current_path) {
                return Err(ApplicationError::Conflict);
            }
            moved.current_path = b.current_path.clone();
            moved.selector_paths = b.selector_paths.clone();
        }
        restore_resume::validate_origin_binding(conn, held, &moved)?;
        if !resumed.contains(&historical.restore_fence_generation)
            && historical.restore_fence_generation != b.restore_fence_generation
        {
            return Err(ApplicationError::Conflict);
        }
    }
    Ok(())
}

/// The generations resumed restores, or restores cancelled after their
/// fences, of this document's lineage led from to the registration's, its
/// own included. The walk counts every generation it visits and refuses past
/// `max_events`.
fn resumed_generations(
    conn: &Connection,
    held: &Registration,
    max_events: usize,
) -> Result<std::collections::HashSet<i64>, ApplicationError> {
    let b = &held.binding;
    let mut query = conn
        .prepare(
            "WITH RECURSIVE resumed(generation,cancelled) AS (SELECT ?6,0 UNION ALL
               SELECT f.old_generation,f.cancelled_json IS NOT NULL FROM live_restore_fences f JOIN resumed r ON f.new_generation=r.generation
               WHERE f.relay_database_namespace=?1 AND f.workspace_id=?2 AND f.main_version_id=?3 AND f.object_id=?4
                 AND f.lineage_claim_id=?5 AND (f.resume_receipt_json IS NOT NULL OR f.cancelled_json IS NOT NULL) LIMIT ?7)
             SELECT generation,cancelled FROM resumed",
        )
        .map_err(read_sql)?;
    let doc = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
    let limit = i64::try_from(max_events)
        .map_err(|_| ApplicationError::Corrupt)?
        .saturating_add(1);
    let rows = query
        .query_map(
            params![
                held.namespace,
                b.workspace_id,
                b.main_version_id,
                b.object_id,
                b.lineage_claim_id,
                b.restore_fence_generation,
                limit
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?)),
        )
        .map_err(read_sql)?;
    let mut generations = std::collections::HashSet::new();
    for (visited, row) in rows.enumerate() {
        let (generation, cancelled) = row.map_err(read_sql)?;
        if visited >= max_events {
            return Err(over_budget());
        }
        // A cancellation carried the lineage from this generation to the next.
        if cancelled
            && restore_fence::cancelled_at(
                conn,
                &held.namespace,
                &doc,
                Some(&b.lineage_claim_id),
                generation + 1,
                None,
            )?
            .is_none()
        {
            return Err(ApplicationError::Corrupt);
        }
        generations.insert(generation);
    }
    Ok(generations)
}

/// The paths renames of this document moved it from to `to`, keeping its
/// object and its text. Walking back from `to`, each rename landed on the path
/// the walk reached; any other move ends the proof. The walk ends once it has
/// proved each path in `needed`, and refuses rather than read more than
/// `max_events` renames.
fn renamed_from(
    conn: &Connection,
    key: &DocKey,
    to: &str,
    needed: &std::collections::HashSet<&str>,
    max_events: usize,
) -> Result<std::collections::HashSet<String>, ApplicationError> {
    let mut proved = std::collections::HashSet::new();
    if needed.is_empty() {
        return Ok(proved);
    }
    let mut query = conn
        .prepare(
            "SELECT payload_before_path,path,after_content_kind='text' AND after_blob_sha256 IS before_blob_sha256
             FROM moments WHERE workspace_id=?1 AND object_id=?2 AND version_id=?3 AND operation='rename'
             ORDER BY moment_order DESC LIMIT ?4",
        )
        .map_err(read_sql)?;
    let limit = i64::try_from(max_events)
        .map_err(|_| ApplicationError::Corrupt)?
        .saturating_add(1);
    let mut rows = query
        .query(params![
            key.workspace_id,
            key.object_id,
            key.version_id,
            limit
        ])
        .map_err(read_sql)?;
    let (mut path, mut remaining, mut read) = (to.to_owned(), needed.len(), 0);
    while let Some(row) = rows.next().map_err(read_sql)? {
        read += 1;
        if read > max_events {
            return Err(over_budget());
        }
        let (before, after, kept): (Option<String>, String, bool) = (
            row.get(0).map_err(read_sql)?,
            row.get(1).map_err(read_sql)?,
            row.get(2).map_err(read_sql)?,
        );
        let Some(before) = before.filter(|_| kept && after == path) else {
            break;
        };
        if needed.contains(before.as_str()) && proved.insert(before.clone()) {
            remaining -= 1;
            if remaining == 0 {
                break;
            }
        }
        path = before;
    }
    Ok(proved)
}

/// Reopen the outbox a successor's coverage proved, keeping its entries,
/// sequence, receipts and refusals. Its totals must still be zero.
fn reopen_outbox(tx: &Transaction<'_>, outbox_id: &str) -> Result<(), ApplicationError> {
    let reopened = tx.execute(
        "UPDATE owner_ydoc_outboxes SET state='active',quarantine_reason=NULL,observed_binding_json=NULL
         WHERE outbox_id=?1 AND state='quarantined' AND pending_bytes=0 AND oldest_entry_at_ms IS NULL
           AND pending_entry_count=0",
        [outbox_id],
    ).map_err(write_sql)?;
    if reopened != 1 {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
}

/// Retire an outbox a successor's coverage proved at an earlier binding,
/// keeping its entries, sequence, receipts and refusals. Nothing may be
/// pending in it; the successor's binding is what it observed.
fn retire_outbox(
    tx: &Transaction<'_>,
    outbox_id: &str,
    successor: &LiveObjectBinding,
) -> Result<(), ApplicationError> {
    let retired = tx.execute(
        "UPDATE owner_ydoc_outboxes SET state='quarantined',quarantine_reason=?2,observed_binding_json=?3
         WHERE outbox_id=?1 AND state IN ('active','sealed') AND pending_bytes=0 AND oldest_entry_at_ms IS NULL
           AND pending_entry_count=0",
        params![
            outbox_id,
            SUCCESSION_RETIRED,
            serde_json::to_string(successor).map_err(|_| ApplicationError::Corrupt)?
        ],
    ).map_err(write_sql)?;
    if retired != 1 {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
}

pub(super) struct AdoptedOrigin {
    pub binding: LiveObjectBinding,
    pub source_moment: String,
    pub source_digest: String,
    pub sequence: i64,
    pub terminal: Option<LiveUpdateReceipt>,
    /// It adopted its released chain's retained prefix.
    pub successor: bool,
}

pub(super) fn read_origin(
    conn: &Connection,
    held: &Registration,
) -> Result<Option<AdoptedOrigin>, ApplicationError> {
    read_origin_with(conn, held, None)
}

/// The current activation's adopted origin. With a budget, its row, source
/// metadata, the original snapshot, and any resumed generation are charged
/// before they are read.
pub(super) fn read_origin_with(
    conn: &Connection,
    held: &Registration,
    mut budget: Option<&mut restore_content::Budget>,
) -> Result<Option<AdoptedOrigin>, ApplicationError> {
    let b = &held.binding;
    if let Some(budget) = budget.as_deref_mut() {
        let length: i64 = conn.query_row(
            &format!("SELECT coalesce((SELECT length(CAST(a.binding_json AS BLOB))+length(CAST(a.source_moment_id AS BLOB))+length(CAST(a.source_digest AS BLOB))+length(CAST(a.terminal_receipt_json AS BLOB))+length(CAST(a.activation_id AS BLOB))
               +coalesce((SELECT sum(length(CAST(s.descriptor_json AS BLOB))) FROM ydoc_owner_activation_sources s WHERE s.activation_id=a.activation_id),0)
               +coalesce((SELECT sum(length(CAST(o.source_moment_id AS BLOB))+length(CAST(o.source_blob_sha256 AS BLOB))) FROM ydoc_owner_base_sources o WHERE o.workspace_id=a.workspace_id AND o.version_id=a.main_version_id AND o.object_id=a.object_id AND o.lineage_claim_id=a.lineage_claim_id),0)
               +coalesce((SELECT sum(length(CAST(n.snapshot_blob_sha256 AS BLOB))) FROM ydoc_snapshots n WHERE n.workspace_id=a.workspace_id AND n.version_id=a.main_version_id AND n.object_id=a.object_id AND n.up_to_seq=0),0)
             FROM {} a WHERE a.relay_database_namespace=?1 AND a.workspace_id=?2 AND a.main_version_id=?3 AND a.object_id=?4 AND a.lineage_claim_id=?5),0)", owner_activations::CURRENT_ACTIVATIONS),
            params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],
            |r| r.get(0),
        ).map_err(read_sql)?;
        budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
    }
    type OriginRow = (String, String, String, i64, i64, String, String, bool);
    // Only the columns charged above.
    let raw: Option<OriginRow> = conn.query_row(
        &format!("SELECT binding_json,source_moment_id,source_digest,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,activation_id,boundary_json IS NOT NULL FROM {}
         WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5", owner_activations::CURRENT_ACTIVATIONS),
        params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).optional().map_err(read_sql)?;
    let Some((
        binding,
        source_moment,
        source_digest,
        sequence,
        cursor,
        terminal,
        adoption_id,
        successor,
    )) = raw
    else {
        return Ok(None);
    };
    let binding: LiveObjectBinding =
        serde_json::from_str(&binding).map_err(|_| ApplicationError::Corrupt)?;
    // This document selected the row, and its decoded binding scopes the
    // source reads below. It must name this document before any of them.
    if binding.workspace_id != b.workspace_id
        || binding.main_version_id != b.main_version_id
        || binding.object_id != b.object_id
        || binding.lineage_claim_id != b.lineage_claim_id
    {
        return Err(ApplicationError::Conflict);
    }
    let Some((verified_moment, verified_digest, _, _)) =
        read_adoption_source_metadata(conn, &held.namespace, &adoption_id, &binding)?
    else {
        return Err(ApplicationError::Corrupt);
    };
    if verified_moment != source_moment || verified_digest != source_digest {
        return Err(ApplicationError::Corrupt);
    }
    let original: Option<String> = conn.query_row("SELECT snapshot_blob_sha256 FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND up_to_seq=0",
        params![b.workspace_id,b.main_version_id,b.object_id],|r|r.get(0)).optional().map_err(read_sql)?;
    if original.as_deref() != Some(b.lineage_claim_id.as_str()) {
        return Err(ApplicationError::Corrupt);
    }
    restore_resume::validate_origin_binding_with(conn, held, &binding, budget)?;
    let terminal: Option<LiveUpdateReceipt> =
        serde_json::from_str(&terminal).map_err(|_| ApplicationError::Corrupt)?;
    if let Some(receipt) = &terminal {
        receipt.validate()?;
    }
    if terminal.as_ref().map_or(0, |r| r.journal_cursor) != cursor || sequence < 0 {
        return Err(ApplicationError::Corrupt);
    }
    Ok(Some(AdoptedOrigin {
        binding,
        source_moment,
        source_digest,
        sequence,
        terminal,
        successor,
    }))
}
