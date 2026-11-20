use super::{DriverStatus, SecretKeyStatus};
use crate::capture_sink::{SecretKeyFailure, SecretKeyHealth};

#[test]
fn the_key_stays_unchecked_until_a_run_loads_it_fails_or_finishes_clean() {
    let status = DriverStatus::default();
    assert_eq!(status.secret_key(), SecretKeyStatus::Unchecked);

    status.record_secret_key(SecretKeyHealth::Untried, false);
    status.record_secret_key(
        SecretKeyHealth::Unavailable(SecretKeyFailure::StoreCheck),
        true,
    );
    assert_eq!(status.secret_key(), SecretKeyStatus::Unchecked);

    status.record_secret_key(SecretKeyHealth::Untried, true);
    assert_eq!(status.secret_key(), SecretKeyStatus::Clear);
}

#[test]
fn a_failed_load_keeps_its_reason_until_a_run_loads_the_key() {
    let status = DriverStatus::default();
    status.record_secret_key(
        SecretKeyHealth::Unavailable(SecretKeyFailure::Missing),
        false,
    );
    status.record_secret_key(SecretKeyHealth::Untried, false);
    status.record_secret_key(
        SecretKeyHealth::Unavailable(SecretKeyFailure::StoreCheck),
        false,
    );
    assert_eq!(
        status.secret_key(),
        SecretKeyStatus::Unavailable("key-missing")
    );

    status.record_secret_key(SecretKeyHealth::Loaded, false);
    assert_eq!(status.secret_key(), SecretKeyStatus::Clear);
}
