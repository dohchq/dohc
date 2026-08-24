use dohc_engine_sync::GrantBinding;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    grant_bindings: Vectors,
}

#[derive(Deserialize)]
struct Vectors {
    accepted: Vec<Value>,
    refused: Vec<Value>,
}

// Only GrantBinding crosses the engine boundary, so only its vectors run
// here. TypeScript exercises every section of the shared file.
#[test]
fn typescript_and_rust_accept_the_same_grant_binding_vectors() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../packages/security-contract/vectors/share-grant-vectors.json"
    ))
    .expect("share grant vectors parse");
    for value in fixture.grant_bindings.accepted {
        let parsed = GrantBinding::deserialize(&value).unwrap_or_else(|error| {
            panic!("GrantBinding refused accepted vector {value}: {error}")
        });
        assert_eq!(
            serde_json::to_value(&parsed).expect("accepted binding serializes"),
            value,
            "GrantBinding did not serialize to the accepted TypeScript shape"
        );
    }
    for value in fixture.grant_bindings.refused {
        assert!(
            GrantBinding::deserialize(&value).is_err(),
            "GrantBinding accepted refused vector {value}"
        );
    }
}
