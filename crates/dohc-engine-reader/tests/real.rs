// Included by the unit harness for lifecycle assertions; not a separate test target.
use super::*;
fn directory() -> PathBuf {
    std::env::var_os("DOHC_READER_FIXTURES")
        .expect("run tests/prepare.mjs; set DOHC_READER_FIXTURES")
        .into()
}
fn config() -> Config {
    Config {
        node: runtime().0,
        bundle: directory().join("bundle/reader.cjs"),
        manifest: directory().join("bundle/manifest.json"),
    }
}
fn input(name: &str, proof: bool) -> Request {
    let mut r = request("note.md");
    r.document.main_version_id = "main".into();
    r.document.object_id = "fixture".into();
    r.source = fs::read(directory().join(format!("{name}.source"))).unwrap();
    r.checkpoint = fs::read(directory().join(format!(
        "{name}.{}",
        if proof { "proof" } else { "checkpoint" }
    )))
    .unwrap();
    r.method = if proof {
        Method::Prove
    } else {
        Method::Construct
    };
    r
}
#[test]
#[ignore = "requires the built bundle and generated fixtures"]
fn real_boundaries() {
    let mut reader = Reader::new(Some(config()));
    for name in ["note", "bom", "warm", "largest"] {
        let r = input(name, false);
        let length = r.source.len();
        let sha = wire::sha(&r.source);
        let checkpoint_sha = wire::sha(&r.checkpoint);
        let result = run(reader.request(r));
        let Ok(Outcome::Constructed {
            proof,
            delta,
            checkpoint_sha256,
        }) = result
        else {
            panic!("{name}: {result:?}")
        };
        assert_eq!(checkpoint_sha256, checkpoint_sha);
        assert_eq!(proof.source_sha256, sha);
        assert_eq!(proof.source_byte_length, length);
        assert!(!delta.is_empty());
        let result = run(reader.request(input(name, true)));
        let Ok(Outcome::Proved { proof, .. }) = result else {
            panic!("{name}: {result:?}")
        };
        assert_eq!(proof.source_sha256, sha);
        assert_eq!(proof.source_byte_length, length);
    }
    let mut forged = input("note", true);
    forged.checkpoint = fs::read(directory().join("note.forged")).unwrap();
    assert!(matches!(
        run(reader.request(forged)),
        Ok(Outcome::Refused { .. })
    ));
    let mut invalid = input("note", false);
    invalid.source = vec![255];
    assert!(matches!(
        run(reader.request(invalid)),
        Ok(Outcome::Refused {
            reason: RefusalReason::InvalidSource,
            ..
        })
    ));
    finish(&mut reader);
}
