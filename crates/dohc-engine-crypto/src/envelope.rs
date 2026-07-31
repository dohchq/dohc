//! The passphrase-wrapped workspace data-key envelope, byte-exact with the TS
//! oracle (`secretKeyEnvelope.ts`).
//!
//! A 32-byte data key is sealed under a KEK derived from a user passphrase via
//! scrypt (N=2^17, r=8, p=1), then AES-256-GCM-encrypted with a random salt and
//! IV. The envelope is a JSON document carrying the parameters plus the sealed
//! key; it is what crosses a device-enrollment boundary. Unwrap re-derives the
//! KEK and opens the envelope; ANY failure collapses to a single
//! [`CryptoError::EnvelopeUnwrapFailed`] (`unwrap-failed`) so nothing
//! distinguishable about *why* an unwrap failed can leak.

use crate::base64;
use crate::error::CryptoError;
use crate::key::{SECRET_KEY_BYTES, SecretDataKey};
use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// The envelope format tag (versioned; part of the cross-engine contract).
pub const ENVELOPE_FORMAT: &str = "dohc-key-envelope-v1";
/// scrypt cost parameter N (2^17). Once-per-machine enrollment cost, not a hot
/// path. Only this exact value is accepted, matching TS.
pub const SCRYPT_N: u64 = 1 << 17;
/// scrypt block-size parameter r.
pub const SCRYPT_R: u32 = 8;
/// scrypt parallelism parameter p.
pub const SCRYPT_P: u32 = 1;
/// scrypt `log2(N)`, derived from the fixed [`SCRYPT_N`].
const SCRYPT_LOG_N: u8 = 17;

const SALT_BYTES: usize = 16;
const IV_BYTES: usize = 12;

/// The on-disk / on-wire envelope shape. Field order matches the TS
/// `JSON.stringify` output so a re-serialized envelope is byte-identical.
#[derive(Serialize, Deserialize)]
struct EnvelopeJson {
    format: String,
    #[serde(rename = "saltBase64")]
    salt_base64: String,
    #[serde(rename = "scryptN")]
    scrypt_n: u64,
    #[serde(rename = "scryptR")]
    scrypt_r: u32,
    #[serde(rename = "scryptP")]
    scrypt_p: u32,
    #[serde(rename = "ivBase64")]
    iv_base64: String,
    #[serde(rename = "authTagBase64")]
    auth_tag_base64: String,
    #[serde(rename = "ciphertextBase64")]
    ciphertext_base64: String,
}

/// The envelope AAD: `dohc-key-envelope-v1\0<workspace>`.
fn envelope_aad(workspace_id: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(ENVELOPE_FORMAT.len() + workspace_id.len() + 1);
    aad.extend_from_slice(ENVELOPE_FORMAT.as_bytes());
    aad.push(0);
    aad.extend_from_slice(workspace_id.as_bytes());
    aad
}

/// Derive the 32-byte KEK from a passphrase via scrypt with the fixed params.
/// The derived key is held in a zeroizing buffer.
fn derive_kek(passphrase: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    if passphrase.is_empty() {
        return Err(CryptoError::EnvelopeUnwrapFailed);
    }
    let params = scrypt::Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, SECRET_KEY_BYTES)
        .map_err(|_| CryptoError::EnvelopeUnwrapFailed)?;
    let mut kek = Zeroizing::new([0u8; 32]);
    scrypt::scrypt(passphrase.as_bytes(), salt, &params, kek.as_mut_slice())
        .map_err(|_| CryptoError::EnvelopeUnwrapFailed)?;
    Ok(kek)
}

/// Wrap a 32-byte data key under `passphrase`, bound to `workspace_id`.
/// Produces the envelope JSON string. Uses a random salt + IV.
pub fn wrap(
    data_key: &SecretDataKey,
    passphrase: &str,
    workspace_id: &str,
) -> Result<String, CryptoError> {
    let mut salt = [0u8; SALT_BYTES];
    let mut iv = [0u8; IV_BYTES];
    getrandom::getrandom(&mut salt).map_err(|_| CryptoError::EnvelopeUnwrapFailed)?;
    getrandom::getrandom(&mut iv).map_err(|_| CryptoError::EnvelopeUnwrapFailed)?;
    wrap_with(data_key, passphrase, workspace_id, salt, iv)
}

/// Wrap with a caller-supplied salt + IV (deterministic; for tests/parity).
pub fn wrap_with(
    data_key: &SecretDataKey,
    passphrase: &str,
    workspace_id: &str,
    salt: [u8; SALT_BYTES],
    iv: [u8; IV_BYTES],
) -> Result<String, CryptoError> {
    let kek = derive_kek(passphrase, &salt)?;
    let cipher =
        Aes256Gcm::new_from_slice(kek.as_slice()).map_err(|_| CryptoError::EnvelopeUnwrapFailed)?;
    let aad = envelope_aad(workspace_id);
    let mut buffer = data_key_bytes(data_key);
    let tag = cipher
        .encrypt_in_place_detached(Nonce::from_slice(&iv), &aad, buffer.as_mut_slice())
        .map_err(|_| CryptoError::EnvelopeUnwrapFailed)?;
    let envelope = EnvelopeJson {
        format: ENVELOPE_FORMAT.to_owned(),
        salt_base64: base64::encode_standard(&salt),
        scrypt_n: SCRYPT_N,
        scrypt_r: SCRYPT_R,
        scrypt_p: SCRYPT_P,
        iv_base64: base64::encode_standard(&iv),
        auth_tag_base64: base64::encode_standard(tag.as_slice()),
        ciphertext_base64: base64::encode_standard(buffer.as_slice()),
    };
    serde_json::to_string(&envelope).map_err(|_| CryptoError::EnvelopeUnwrapFailed)
}

/// Unwrap an envelope JSON under `passphrase`, bound to `workspace_id`,
/// returning the 32-byte data key. Every failure mode collapses to
/// [`CryptoError::EnvelopeUnwrapFailed`].
pub fn unwrap(
    envelope_json: &str,
    passphrase: &str,
    workspace_id: &str,
) -> Result<SecretDataKey, CryptoError> {
    let envelope: EnvelopeJson =
        serde_json::from_str(envelope_json).map_err(|_| CryptoError::EnvelopeUnwrapFailed)?;
    if envelope.format != ENVELOPE_FORMAT
        || envelope.scrypt_n != SCRYPT_N
        || envelope.scrypt_r != SCRYPT_R
        || envelope.scrypt_p != SCRYPT_P
    {
        return Err(CryptoError::EnvelopeUnwrapFailed);
    }
    let salt = decode_env(&envelope.salt_base64)?;
    let iv = decode_env(&envelope.iv_base64)?;
    let tag = decode_env(&envelope.auth_tag_base64)?;
    let mut buffer = decode_env(&envelope.ciphertext_base64)?;
    // Validate every fixed-size field's length explicitly (salt/IV/tag), so a
    // malformed envelope fails closed on shape before the KDF/AEAD run rather
    // than deriving a KEK from a wrong-length salt.
    if salt.len() != SALT_BYTES
        || iv.len() != IV_BYTES
        || tag.len() != crate::aead::SECRET_TAG_BYTES
    {
        return Err(CryptoError::EnvelopeUnwrapFailed);
    }
    let kek = derive_kek(passphrase, &salt)?;
    let cipher =
        Aes256Gcm::new_from_slice(kek.as_slice()).map_err(|_| CryptoError::EnvelopeUnwrapFailed)?;
    let aad = envelope_aad(workspace_id);
    cipher
        .decrypt_in_place_detached(
            Nonce::from_slice(&iv),
            &aad,
            buffer.as_mut_slice(),
            Tag::from_slice(&tag),
        )
        .map_err(|_| CryptoError::EnvelopeUnwrapFailed)?;
    if buffer.len() != SECRET_KEY_BYTES {
        return Err(CryptoError::EnvelopeUnwrapFailed);
    }
    SecretDataKey::from_bytes(&buffer).map_err(|_| CryptoError::EnvelopeUnwrapFailed)
}

/// Copy the data-key bytes into a zeroizing buffer for in-place sealing.
fn data_key_bytes(data_key: &SecretDataKey) -> Zeroizing<Vec<u8>> {
    Zeroizing::new(data_key.as_bytes().to_vec())
}

/// Decode an envelope base64 field, normalizing any failure to `unwrap-failed`.
fn decode_env(value: &str) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    base64::strict_decode(value)
        .map(Zeroizing::new)
        .map_err(|_| CryptoError::EnvelopeUnwrapFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

    // scrypt N=2^17 costs ~128 MiB and a fraction of a second per derivation;
    // these tests each do 1–2 derivations. Deterministic salt/IV keep them
    // reproducible.
    fn data_key() -> SecretDataKey {
        SecretDataKey::from_bytes(&[0x5Au8; SECRET_KEY_BYTES]).unwrap()
    }

    #[test]
    fn wrap_unwrap_round_trips() {
        let key = data_key();
        let envelope =
            wrap_with(&key, "passw0rd!", "wsA", [1u8; SALT_BYTES], [2u8; IV_BYTES]).unwrap();
        let recovered = unwrap(&envelope, "passw0rd!", "wsA").unwrap();
        assert_eq!(recovered, key);
    }

    #[test]
    fn wrong_passphrase_fails_closed() {
        let envelope = wrap_with(
            &data_key(),
            "right",
            "wsA",
            [1u8; SALT_BYTES],
            [2u8; IV_BYTES],
        )
        .unwrap();
        assert_eq!(
            unwrap(&envelope, "wrong", "wsA").unwrap_err(),
            CryptoError::EnvelopeUnwrapFailed
        );
    }

    #[test]
    fn wrong_workspace_aad_fails_closed() {
        let envelope =
            wrap_with(&data_key(), "pw", "wsA", [1u8; SALT_BYTES], [2u8; IV_BYTES]).unwrap();
        assert_eq!(
            unwrap(&envelope, "pw", "wsB").unwrap_err(),
            CryptoError::EnvelopeUnwrapFailed
        );
    }

    /// The TS suite flipped a byte in each of `ciphertextBase64`,
    /// `authTagBase64` and `saltBase64` and required the SAME generic
    /// `unwrap-failed` for all three, so nothing distinguishable about why an
    /// unwrap failed can leak. Rust had wrong-passphrase and wrong-AAD but no
    /// per-field tamper test at all, and this envelope carries a fourth field
    /// the TS test never touched.
    ///
    /// All four tampers keep the field valid base64 of the same length, so they
    /// all land on the AEAD check rather than on a decode or shape guard.
    ///
    /// Honest about what this adds: it does NOT have a mutation of its own.
    /// Giving `decrypt_in_place_detached`'s `map_err` a different error kills
    /// this test AND `wrong_passphrase_fails_closed` AND
    /// `wrong_workspace_aad_fails_closed`, because all three reach that one
    /// call. What it closes is an INPUT-CLASS gap -- nothing else here feeds
    /// unwrap a corrupted field -- plus the cross-field invariant that all four
    /// produce the same generic error rather than distinguishable ones.
    #[test]
    fn every_tampered_envelope_field_fails_closed_the_same_way() {
        let envelope =
            wrap_with(&data_key(), "pw", "wsA", [1u8; SALT_BYTES], [2u8; IV_BYTES]).unwrap();
        for field in [
            "ciphertextBase64",
            "authTagBase64",
            "saltBase64",
            "ivBase64",
        ] {
            let mut parsed: serde_json::Value = serde_json::from_str(&envelope).unwrap();
            let encoded = parsed[field].as_str().unwrap().to_owned();
            let mut bytes =
                base64::strict_decode(&encoded).unwrap_or_else(|_| panic!("{field} is not base64"));
            assert!(!bytes.is_empty(), "{field} carries no bytes to tamper with");
            bytes[0] ^= 0xff;
            parsed[field] = serde_json::Value::String(base64::encode_standard(&bytes));
            let tampered = serde_json::to_string(&parsed).unwrap();
            assert_ne!(tampered, envelope, "the {field} tamper changed nothing");
            assert_eq!(
                unwrap(&tampered, "pw", "wsA").unwrap_err(),
                CryptoError::EnvelopeUnwrapFailed,
                "a tampered {field} must fail closed with the generic error"
            );
        }
    }

    #[test]
    fn envelope_json_shape_matches_ts_fields() {
        let envelope =
            wrap_with(&data_key(), "pw", "wsA", [1u8; SALT_BYTES], [2u8; IV_BYTES]).unwrap();
        // Field order + names match `JSON.stringify` of the TS envelope.
        assert!(envelope.starts_with("{\"format\":\"dohc-key-envelope-v1\","));
        for field in [
            "saltBase64",
            "scryptN",
            "scryptR",
            "scryptP",
            "ivBase64",
            "authTagBase64",
            "ciphertextBase64",
        ] {
            assert!(
                envelope.contains(&format!("\"{field}\"")),
                "missing {field}"
            );
        }
    }

    #[test]
    fn malformed_or_wrong_params_fail_closed() {
        assert_eq!(
            unwrap("not json", "pw", "wsA").unwrap_err(),
            CryptoError::EnvelopeUnwrapFailed
        );
        // Correct JSON but wrong scryptN is rejected.
        let bad = r#"{"format":"dohc-key-envelope-v1","saltBase64":"AAAAAAAAAAAAAAAAAAAAAA==","scryptN":16384,"scryptR":8,"scryptP":1,"ivBase64":"AAAAAAAAAAAAAAAA","authTagBase64":"AAAAAAAAAAAAAAAAAAAAAA==","ciphertextBase64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}"#;
        assert_eq!(
            unwrap(bad, "pw", "wsA").unwrap_err(),
            CryptoError::EnvelopeUnwrapFailed
        );
    }
}
