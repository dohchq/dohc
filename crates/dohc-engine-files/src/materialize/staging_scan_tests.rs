use super::*;
use dohc_test_scratch::ScratchDir;

#[cfg(feature = "fault-injection")]
#[test]
fn empty_and_missing_staging_use_one_listing() {
    let root = ScratchDir::new_named("staging-empty").unwrap();
    let dir = root.join("displaced");
    let target = root.join("target.md");
    dohc_engine_storage::capture_phase::enable_for_current_thread();
    for missing in [true, false] {
        if !missing {
            std::fs::create_dir(&dir).unwrap();
        }
        let before = dohc_engine_storage::capture_phase::snapshot();
        assert!(
            job_staged_names(&dir, "job", &target, &[])
                .unwrap()
                .is_empty()
        );
        let after = dohc_engine_storage::capture_phase::snapshot();
        assert_eq!(
            after.count("publication_recovery_fs_calls")
                - before.count("publication_recovery_fs_calls"),
            1
        );
    }
}

#[test]
fn listing_selects_only_this_jobs_staged_names() {
    for job_id in [String::new(), "job".to_owned(), "long-job".repeat(20)] {
        let root = ScratchDir::new_named("staging-filter").unwrap();
        let target = root.join("target.md");
        let first = staged_name(&job_id, 0);
        let last = staged_name(&job_id, MAX_DISPLACED_NAMES - 1);
        let taken = staged_name(&job_id, 3);
        for name in [
            first.clone(),
            last.clone(),
            taken.clone(),
            staged_name("another-job", 0),
            format!("{}.64", staged_key(&job_id)),
            format!("{}.01", staged_key(&job_id)),
            format!("{first}.unrelated"),
        ] {
            std::fs::write(root.join(name), b"staged").unwrap();
        }
        let mut names = job_staged_names(root.path(), &job_id, &target, &[taken]).unwrap();
        names.sort();
        assert_eq!(names, vec![first, last]);
    }
}

#[test]
fn listing_errors_are_not_an_empty_folder() {
    let root = ScratchDir::new_named("staging-not-directory").unwrap();
    let file = root.join("file");
    std::fs::write(&file, b"file").unwrap();
    assert!(job_staged_names(&file, "job", &root.join("target.md"), &[]).is_err());
}

#[cfg(windows)]
#[test]
fn listing_recovers_attribute_journals_with_or_without_the_staged_file() {
    for unlink in [false, true] {
        for has_row in [false, true] {
            let scratch = ScratchDir::new_named("staging-journal").unwrap();
            let root = std::fs::canonicalize(scratch.path()).unwrap();
            let dir = root.join(STAGING_DIR);
            std::fs::create_dir_all(&dir).unwrap();
            let name = staged_name("job", 63);
            let incoming = dir.join(&name);
            let target = root.join("target.md");
            std::fs::write(&incoming, b"outside").unwrap();
            let mut permissions = std::fs::metadata(&incoming).unwrap().permissions();
            permissions.set_readonly(true);
            std::fs::set_permissions(&incoming, permissions).unwrap();
            std::fs::hard_link(&incoming, &target).unwrap();
            assert!(
                std::panic::catch_unwind(|| {
                    let _ = readonly_link::remove(&incoming, &target, || {
                        if unlink {
                            std::fs::remove_file(&incoming)?;
                        }
                        panic!("crash before attribute restoration");
                    });
                })
                .is_err()
            );
            assert!(!std::fs::metadata(&target).unwrap().permissions().readonly());
            let taken = if has_row { vec![name.clone()] } else { vec![] };
            let names = job_staged_names(&dir, "job", &target, &taken).unwrap();
            assert_eq!(
                names,
                if !unlink && !has_row {
                    vec![name]
                } else {
                    vec![]
                }
            );
            assert!(std::fs::metadata(&target).unwrap().permissions().readonly());
            assert_eq!(std::fs::read(&target).unwrap(), b"outside");
            assert!(!incoming.with_extension("63.restore-attributes").exists());
        }
    }
}

#[cfg(windows)]
#[test]
fn listing_cleans_a_pending_journal_without_a_staged_file() {
    let root = ScratchDir::new_named("staging-pending-journal").unwrap();
    let pending = root.join(format!(
        "{}.restore-attributes-pending",
        staged_name("job", 4)
    ));
    let other = root.join(format!(
        "{}.restore-attributes-pending",
        staged_name("other", 4)
    ));
    for path in [&pending, &other] {
        std::fs::write(path, b"partial record").unwrap();
    }
    assert!(
        job_staged_names(root.path(), "job", &root.join("target.md"), &[])
            .unwrap()
            .is_empty()
    );
    assert!(!pending.exists());
    assert!(other.exists());
}

#[cfg(windows)]
#[test]
fn listing_preserves_an_invalid_attribute_journal_for_retry() {
    let root = ScratchDir::new_named("staging-invalid-journal").unwrap();
    let journal = root.join(format!("{}.restore-attributes", staged_name("job", 4)));
    std::fs::write(&journal, b"invalid record").unwrap();
    assert!(job_staged_names(root.path(), "job", &root.join("target.md"), &[]).is_err());
    assert_eq!(std::fs::read(journal).unwrap(), b"invalid record");
}
