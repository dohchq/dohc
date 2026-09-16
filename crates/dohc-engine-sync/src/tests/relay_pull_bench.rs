use super::*;

#[test]
#[ignore = "manual relay hydration benchmark; run alone with --ignored --nocapture"]
fn relay_large_blob_pull_benchmark() {
    let samples = std::env::var("DOHC_RELAY_BENCH_SAMPLES")
        .map(|value| value.parse::<usize>().expect("sample count"))
        .unwrap_or(20);
    assert!(samples > 0);
    for body_bytes in [256 * 1024, 1024 * 1024] {
        let blobs = (0..32)
            .map(|index| {
                let mut bytes = vec![b'a'; body_bytes];
                let marker = format!("blob-{index:02}\n");
                bytes[..marker.len()].copy_from_slice(marker.as_bytes());
                (dohc_engine_storage::hex_sha256(&bytes), bytes)
            })
            .collect::<BTreeMap<_, _>>();
        let snapshots = blobs
            .keys()
            .enumerate()
            .map(|(index, sha256)| {
                let mut snapshot = shipped_text_snapshot(
                    &format!("bench-object-{index}"),
                    &format!("bench-{index}.md"),
                    sha256,
                );
                snapshot["byteLength"] = json!(body_bytes);
                snapshot
            })
            .collect();
        let op = version_create_with_shipped_snapshots("bench-peer", "bench-version", snapshots);
        let mut elapsed_us = Vec::with_capacity(samples);
        // Sample zero warms code and filesystem caches with a separate store.
        for sample in 0..=samples {
            let (_scratch, _path, mut engine) = open_store();
            seed_identity(&mut engine);
            seed_replication_version(&mut engine, "main", "main");
            let mut relay = PagedRelay::new([(
                0,
                PullResponse {
                    ops: vec![op.clone()],
                    next_cursor: 1,
                    has_more: false,
                },
            )]);
            relay.blobs = blobs.clone();
            let client = RelaySyncClient::new(relay);
            let mut cache = dohc_engine_collab::WriterDocCache::new();

            let started = std::time::Instant::now();
            let outcome = client
                .pull_chat_workspace(
                    &mut engine,
                    &mut cache,
                    "ws",
                    &NoFaults,
                    &NoLiveLeases,
                    2_000,
                )
                .expect("pull complete");
            let elapsed = started.elapsed().as_micros();

            let SyncPassOutcome::Complete {
                applied,
                refused,
                pending_cursor,
                ..
            } = outcome
            else {
                panic!("pull did not complete");
            };
            assert_eq!((applied, refused), (1, 0));
            assert_eq!(pending_cursor.expect("pending cursor").cursor, 1);
            engine
                .read_with(|conn| {
                    let count: usize = conn.query_row(
                        "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' AND version_id='bench-version'",
                        [],
                        |row| row.get(0),
                    )?;
                    assert_eq!(count, blobs.len());
                    for (sha256, bytes) in &blobs {
                        let (length, text): (usize, String) = conn.query_row(
                            "SELECT byte_length,text FROM blobs WHERE sha256=?1",
                            [sha256],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )?;
                        assert_eq!(length, bytes.len());
                        assert_eq!(text.as_bytes(), bytes);
                    }
                    Ok::<_, rusqlite::Error>(())
                })
                .expect("persisted fixture");
            assert_eq!(
                client
                    .transport()
                    .download_batches
                    .lock()
                    .expect("batches")
                    .len(),
                4,
            );
            if sample > 0 {
                elapsed_us.push(elapsed);
            }
        }
        let mut sorted = elapsed_us.clone();
        sorted.sort_unstable();
        println!(
            "{}",
            json!({
                "benchmark": "relay_large_blob_pull",
                "transport": "in-process PagedRelay",
                "timed": "pull, hydration, SQLite commits, replicated version apply",
                "blob_count": blobs.len(),
                "body_bytes": body_bytes,
                "samples_us": elapsed_us,
                "median_us": sorted[sorted.len() / 2],
                "p95_us": sorted[(sorted.len() * 95).div_ceil(100) - 1],
            })
        );
    }
}
