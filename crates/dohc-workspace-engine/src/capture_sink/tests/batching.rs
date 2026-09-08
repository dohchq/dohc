use super::*;

#[test]
fn parallel_added_text_preparation_preserves_the_ordered_text_prefix() {
    let scratch = ScratchDir::new().expect("scratch");
    write_file(scratch.path(), "a.md", b"alpha");
    write_file(scratch.path(), "b.md", b"bravo");
    write_file(scratch.path(), "c.png", b"binary route");
    write_file(scratch.path(), "d.md", b"discarded suffix");
    let captured_root = CapturedRoot::bind(scratch.path()).expect("captured root");
    let candidates = [
        AddedTextCandidate {
            path: "a.md",
            media_type: "text/markdown",
        },
        AddedTextCandidate {
            path: "b.md",
            media_type: "text/markdown",
        },
        AddedTextCandidate {
            path: "c.png",
            media_type: "image/png",
        },
        AddedTextCandidate {
            path: "d.md",
            media_type: "text/markdown",
        },
    ];

    let PreparedTextPrefix::Ready(prepared) =
        prepare_added_text_prefix_parallel(scratch.path(), &captured_root, &candidates)
    else {
        panic!("the leading text files should form a batch prefix");
    };

    assert_eq!(prepared.len(), 2);
    assert_eq!(prepared[0].text, "alpha");
    assert_eq!(prepared[0].sha256, hex_sha256(b"alpha"));
    assert_eq!(prepared[1].text, "bravo");
    assert_eq!(prepared[1].sha256, hex_sha256(b"bravo"));
    assert!(matches!(
        prepare_added_text_prefix_parallel(scratch.path(), &captured_root, &candidates[2..],),
        PreparedTextPrefix::FallbackFirst
    ));
}

#[test]
fn parallel_root_mismatch_discards_an_already_prepared_prefix() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let moved_root = root.with_file_name(format!(
        "{}-moved",
        root.file_name().expect("root name").to_string_lossy()
    ));
    write_file(&root, "a.md", b"alpha");
    write_file(&root, "b.md", b"bravo");
    let captured_root = CapturedRoot::bind(&root).expect("captured root");
    let candidates = [
        AddedTextCandidate {
            path: "a.md",
            media_type: "text/markdown",
        },
        AddedTextCandidate {
            path: "b.md",
            media_type: "text/markdown",
        },
    ];
    let first_prepared = AtomicBool::new(false);
    let swapped = AtomicBool::new(false);

    let prepared = prepare_added_text_prefix_parallel_with(
        &candidates,
        |candidate| {
            if candidate.path == "a.md" {
                first_prepared.store(true, Ordering::Release);
                return Ok(CurrentContent::Text("alpha".to_owned()));
            }
            while !first_prepared.load(Ordering::Acquire) {
                std::thread::yield_now();
            }
            if !swapped.swap(true, Ordering::AcqRel) {
                std::fs::rename(&root, &moved_root).expect("move original capture root");
                std::fs::create_dir(&root).expect("recreate capture root");
                write_file(&root, "b.md", b"replacement workspace content");
            }
            read_current_with_canonical_root(
                &root,
                &captured_root,
                candidate.path,
                candidate.media_type,
            )
        },
        || captured_root.still_names(&root),
    );

    std::fs::remove_dir_all(&root).expect("remove replacement capture root");
    std::fs::rename(&moved_root, &root).expect("restore original capture root");
    assert!(matches!(
        prepared,
        PreparedTextPrefix::RootMismatch { attempted: 2 }
    ));
}

#[test]
fn parallel_path_escape_falls_back_without_poisoning_sibling_progress() {
    let candidates = [
        AddedTextCandidate {
            path: "a.md",
            media_type: "text/markdown",
        },
        AddedTextCandidate {
            path: "linked/b.md",
            media_type: "text/markdown",
        },
        AddedTextCandidate {
            path: "c.md",
            media_type: "text/markdown",
        },
    ];
    let read = |candidate: AddedTextCandidate<'_>| match candidate.path {
        "linked/b.md" => Err(ESCAPES_ROOT),
        path => Ok(CurrentContent::Text(path.to_owned())),
    };

    let first = prepare_added_text_prefix_parallel_with(&candidates, read, || true);
    let PreparedTextPrefix::Ready(first) = first else {
        panic!("the good prefix must remain committable");
    };
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].text, "a.md");

    assert!(matches!(
        prepare_added_text_prefix_parallel_with(&candidates[1..], read, || true),
        PreparedTextPrefix::FallbackFirst
    ));
    let PreparedTextPrefix::Ready(last) =
        prepare_added_text_prefix_parallel_with(&candidates[2..], read, || true)
    else {
        panic!("the good suffix must progress after the refused path");
    };
    assert_eq!(last.len(), 1);
    assert_eq!(last[0].text, "c.md");
}
