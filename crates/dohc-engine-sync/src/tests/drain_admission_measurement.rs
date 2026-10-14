use super::*;

fn edit(store: &mut EngineStore, i: i64) -> ReplicationEnvelope {
    let before = if i == 0 {
        "seed".into()
    } else {
        format!("ordinary edit {}", i - 1)
    };
    let after = format!("ordinary edit {i}");
    let sha = dohc_engine_storage::hex_sha256(after.as_bytes());
    store
        .read_with(|c| {
            c.execute(
                "INSERT OR IGNORE INTO blobs VALUES(?1,?2,?3)",
                params![sha, after.len() as i64, after],
            )
        })
        .unwrap();
    envelope(
        "peer",
        i,
        "moment.append",
        json!({
            "momentId":format!("edit-{i}"),"versionId":"main","objectId":"bench","objectCreatedAtMs":1,
            "path":"bench.md","recordedAtMs":2000,"operation":"write",
            "payloadBeforeBlobSha256":dohc_engine_storage::hex_sha256(before.as_bytes()),"payloadBeforePath":"bench.md",
            "payloadAfterBlobSha256":sha,"payloadAfterPath":"bench.md","metadata":{"origin":"sync"},
            "beforePresent":"present","beforeObjectId":"bench","beforeVersionId":"main","beforePath":"bench.md",
            "beforeBlobSha256":dohc_engine_storage::hex_sha256(before.as_bytes()),"beforeUpdatedAtMs":if i==0{1}else{2000},
            "beforeLatestMomentId":if i==0{"seed-bench".into()}else{format!("edit-{}",i-1)},"beforeMetadata":{"origin":if i==0{"api"}else{"sync"}},
            "authors":[{"kind":"human","humanId":"person"}]
        }),
    )
}

// Paired release runs supply the performance evidence.
#[test]
#[ignore]
fn ordinary_admission_release_measurement() {
    let iterations = 250_000;
    let start = std::time::Instant::now();
    for i in 0..iterations {
        let wire = if i % 2 == 0 {
            r#"{"status":"accepted","settlementId":"settlement-one"}"#
        } else {
            r#"{"status":"refused","settlementId":"settlement-one","reason":"authorship-mismatch"}"#
        };
        let value =
            serde_json::from_str::<SettlementAdmission>(std::hint::black_box(wire)).unwrap();
        std::hint::black_box(value);
    }
    println!(
        "MEASURE decoder_ns {}",
        start.elapsed().as_nanos() / iterations
    );
    let (_dir, _path, mut store) = open_store();
    seed_identity(&mut store);
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 0, &NoFaults)
        .unwrap();
    seed_text_head(&mut store, "bench", "bench.md", "seed");
    let client = RelaySyncClient::new(FakeRelay::default());
    client
        .push_workspace(&mut store, "ws", &NoFaults, &NoLiveLeases, 2000, 0)
        .unwrap();
    let mut elapsed = 0;
    for i in 0..100 {
        let op = edit(&mut store, i);
        journal_local_replication_op(
            &mut store,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "moment.append",
            &op.payload,
            2000,
            &NoFaults,
        )
        .unwrap();
        let start = std::time::Instant::now();
        let outcome = client
            .push_workspace(&mut store, "ws", &NoFaults, &NoLiveLeases, 2000, 0)
            .unwrap();
        assert!(
            matches!(outcome, SyncPassOutcome::Complete { .. }),
            "{outcome:?}"
        );
        elapsed += start.elapsed().as_nanos();
    }
    println!("MEASURE push_ns {}", elapsed / 100);
    let (_dir, _path, mut store) = open_store();
    seed_identity(&mut store);
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 0, &NoFaults)
        .unwrap();
    seed_text_head(&mut store, "bench", "bench.md", "seed");
    let mut elapsed = 0;
    for i in 0..100 {
        let relay = FakeRelay::default();
        let op = edit(&mut store, i);
        *relay.pull.lock().unwrap() = Some(PullResponse {
            ops: vec![op],
            next_cursor: i + 1,
            has_more: false,
        });
        let client = RelaySyncClient::new(relay);
        let start = std::time::Instant::now();
        let outcome = client
            .pull_chat_workspace(
                &mut store,
                &mut Default::default(),
                "ws",
                &NoFaults,
                &NoLiveLeases,
                2000,
            )
            .unwrap();
        if let SyncPassOutcome::Complete {
            pending_cursor: Some(cursor),
            ..
        } = outcome
        {
            client
                .commit_pull_cursor(&mut store, "ws", &cursor, &NoFaults, &NoLiveLeases, 2000)
                .unwrap();
        } else {
            panic!("{outcome:?}");
        }
        elapsed += start.elapsed().as_nanos();
    }
    println!("MEASURE pull_ns {}", elapsed / 100);
    assert_eq!(store.table_row_count("moments").unwrap(), 100);
    assert_eq!(
        store
            .table_row_count("replication_pending_refusals")
            .unwrap(),
        0
    );
    assert_eq!(store.table_row_count("release_held_ops").unwrap_or(0), 0);
}
