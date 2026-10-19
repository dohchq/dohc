use super::*;

#[test]
#[ignore = "manual base repair benchmark; run alone with --ignored --nocapture"]
fn relay_base_repair_unpushed_benchmark() {
    let samples = std::env::var("DOHC_RELAY_BENCH_SAMPLES")
        .map(|value| value.parse::<usize>().expect("sample count"))
        .unwrap_or(10);
    assert!(samples >= 10);
    let expected_lookups = std::env::var("DOHC_BASE_REPAIR_EXPECTED_LOOKUPS")
        .map(|value| value.parse::<usize>().expect("lookup count"))
        .unwrap_or(400);
    let expected_probes = std::env::var("DOHC_BASE_REPAIR_EXPECTED_PROBES")
        .map(|value| value.parse::<usize>().expect("probe count"))
        .unwrap_or(1);
    let expected_remaining = std::env::var("DOHC_BASE_REPAIR_EXPECTED_REMAINING")
        .map(|value| value.parse::<i64>().expect("remaining candidate count"))
        .unwrap_or(600);
    let mut elapsed_us = Vec::with_capacity(samples);
    let mut lookup_counts = Vec::with_capacity(samples);
    let mut probe_counts = Vec::with_capacity(samples);
    let mut probe_us = Vec::with_capacity(samples);
    // Warm code and filesystem caches with a separate store.
    for sample in 0..=samples {
        let (_scratch, _path, mut engine) = open_store();
        seed_identity(&mut engine);
        seed_replication_version(&mut engine, "main", "main");
        let seed = relay_pull::seed_base_repair_candidate(&mut engine, "seed", "local", 1);
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute_batch(
                    "DELETE FROM ydoc_base_relay_candidates;
                UPDATE ydoc_docs SET base_relay_confirmed_absent=1;
                CREATE TEMP TABLE benchmark_ids AS
                WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<999)
                SELECT n,'bench-'||n AS object_id,
                       CASE WHEN n<600 THEN 'local' ELSE 'peer' END AS origin_id,n+2 AS origin_seq
                FROM ids;
                INSERT INTO file_objects (workspace_id,object_id,created_at_ms)
                SELECT 'ws',object_id,1100 FROM benchmark_ids;
                INSERT INTO ydoc_docs (workspace_id,version_id,object_id,content_kind,regime,
                    updated_at_ms,path,lineage_claim_status,lineage_claim_id)
                SELECT 'ws','main',ids.object_id,'plaintext','replicated',1100,
                    'notes/'||ids.object_id||'.md','exact',seed.lineage_claim_id
                FROM benchmark_ids ids JOIN ydoc_docs seed ON seed.object_id='seed';
                INSERT INTO ydoc_base_relay_candidates
                    (workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq)
                SELECT 'ws','main',ids.object_id,seed.lineage_claim_id,ids.origin_id,ids.origin_seq
                FROM benchmark_ids ids JOIN ydoc_docs seed ON seed.object_id='seed';",
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "INSERT INTO replication_log (workspace_id,origin_id,origin_seq,
                    op_kind,payload_json,recorded_at_ms,imported,apply_disposition)
                SELECT 'ws',origin_id,origin_seq,'ydoc.update',
                    json_set(?1,'$.objectId',object_id,'$.path','notes/'||object_id||'.md'),
                    1100,CASE WHEN origin_id='local' THEN 0 ELSE 1 END,'applied'
                FROM benchmark_ids",
                    [seed.payload.to_string()],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed 1000 candidates");
        let mut relay = relay_pull::empty_base_repair_relay();
        for n in 0..1000 {
            relay = relay.with_coordinate(
                if n < 600 { "local" } else { "peer" },
                n + 2,
                LogCoordinateResponse::Absent,
            );
        }
        let client = RelaySyncClient::new(relay);
        let identity = read_sync_identity(&engine, "ws").unwrap().unwrap();
        let started = std::time::Instant::now();
        client
            .repair_pending_ydoc_base_orders(&mut engine, "ws", &identity, &NoFaults, &[])
            .expect("repair fixture");
        let elapsed = started.elapsed().as_micros();
        let probes = client.transport().pushes.lock().unwrap().len();
        assert_eq!(probes, expected_probes);
        assert!(
            client
                .transport()
                .pushes
                .lock()
                .unwrap()
                .iter()
                .all(|push| push.ops.is_empty())
        );
        let lookups = client.transport().coordinate_lookups.lock().unwrap().len();
        assert_eq!(lookups, expected_lookups);
        let remaining: i64 = engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_base_relay_candidates",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(remaining, expected_remaining);
        if sample > 0 {
            elapsed_us.push(elapsed);
            lookup_counts.push(lookups);
            probe_counts.push(probes);
            probe_us.push(
                client
                    .transport()
                    .origin_max_probe_elapsed
                    .lock()
                    .unwrap()
                    .iter()
                    .map(std::time::Duration::as_micros)
                    .sum::<u128>(),
            );
        }
    }
    let mut sorted = elapsed_us.clone();
    sorted.sort_unstable();
    let median = if sorted.len() % 2 == 0 {
        (sorted[sorted.len() / 2 - 1] + sorted[sorted.len() / 2]) / 2
    } else {
        sorted[sorted.len() / 2]
    };
    println!(
        "{}",
        json!({
            "benchmark": "relay_base_repair_unpushed",
            "transport": "in-process PagedRelay, immediate Absent responses",
            "timed": "repair phase only: SQLite reads, conditional origin-max probe, coordinate lookups, absence commits",
            "candidates": 1000, "own_unpushed": 600,
            "remaining_candidates": expected_remaining, "absence_commits": 1000 - expected_remaining,
            "lookup_counts": lookup_counts, "probe_counts": probe_counts, "probe_samples_us": probe_us, "samples_us": elapsed_us,
            "median_us": median,
        })
    );
}

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
                    let count: i64 = conn.query_row(
                        "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' AND version_id='bench-version'",
                        [],
                        |row| row.get(0),
                    )?;
                    assert_eq!(usize::try_from(count).expect("snapshot count"), blobs.len());
                    for (sha256, bytes) in &blobs {
                        let (length, text): (i64, String) = conn.query_row(
                            "SELECT byte_length,text FROM blobs WHERE sha256=?1",
                            [sha256],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )?;
                        assert_eq!(usize::try_from(length).expect("blob length"), bytes.len());
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
