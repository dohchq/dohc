use dohc_engine_sync::{
    parse_grant_binding, parse_grant_status, parse_link_credential_record,
    parse_share_grant_record, parse_share_principal,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    share_principals: Vectors,
    grant_statuses: Vectors,
    share_grant_records: Vectors,
    link_credential_records: Vectors,
    grant_bindings: Vectors,
}

#[derive(Deserialize)]
struct Vectors {
    accepted: Vec<Value>,
    refused: Vec<Value>,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!(
        "../../../packages/security-contract/vectors/share-grant-vectors.json"
    ))
    .expect("share grant vectors parse")
}

fn assert_vectors<T: Serialize>(
    vectors: Vectors,
    parse: impl Fn(&Value) -> Option<T>,
    contract_name: &str,
) {
    for value in vectors.accepted {
        let parsed = parse(&value)
            .unwrap_or_else(|| panic!("{contract_name} refused accepted vector {value}"));
        assert_eq!(
            serde_json::to_value(parsed).expect("accepted contract serializes"),
            value,
            "{contract_name} did not serialize to the accepted TypeScript shape"
        );
    }
    for value in vectors.refused {
        assert!(
            parse(&value).is_none(),
            "{contract_name} accepted refused vector {value}"
        );
    }
}

#[test]
fn typescript_and_rust_accept_the_same_share_grant_vectors() {
    let fixture = fixture();
    assert_vectors(
        fixture.share_principals,
        parse_share_principal,
        "SharePrincipal",
    );
    assert_vectors(fixture.grant_statuses, parse_grant_status, "GrantStatus");
    assert_vectors(
        fixture.share_grant_records,
        parse_share_grant_record,
        "ShareGrantRecord",
    );
    assert_vectors(
        fixture.link_credential_records,
        parse_link_credential_record,
        "LinkCredentialRecord",
    );
    assert_vectors(fixture.grant_bindings, parse_grant_binding, "GrantBinding");
}
