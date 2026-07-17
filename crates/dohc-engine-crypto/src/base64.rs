//! Base64 with byte-exact parity to Node's `Buffer` semantics
//! (`LANGUAGE_SEMANTICS_MATRIX.md` §4.7).
//!
//! Two decode modes, deliberately distinct:
//!
//! - [`encode_standard`] / [`forgiving_decode`] reproduce
//!   `Buffer.from(bytes).toString("base64")` and `Buffer.from(str, "base64")`.
//!   Node's decoder is FORGIVING: `=` is a hard TERMINATOR (decoding stops at
//!   the first one, even mid-string); before it, bytes outside the standard
//!   alphabet (whitespace, stray punctuation) are skipped; a trailing lone
//!   leftover symbol is dropped. The TS key-file parser relies on exactly this
//!   leniency (its `try/catch` is unreachable; the 32-byte length check is the
//!   real guard). We port the leniency rather than tighten it — including the
//!   `=`-terminator rule, so we neither accept a malformed key file Node would
//!   reject nor reject one it would accept.
//! - [`strict_decode_exact`] reproduces the TS replication-ingest guard
//!   (`normalizeBase64Field`, `secretFileStore.ts:500-509`): the string must
//!   match `^[A-Za-z0-9+/]*={0,2}$`, decode to `expected_len` bytes, AND
//!   re-encode to the identical string (canonical form). Anything else is
//!   rejected — a poison replication payload never rides a non-canonical field.

use crate::error::CryptoError;

const STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard padded base64 (`Buffer.prototype.toString("base64")`).
#[must_use]
pub fn encode_standard(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut chunks = bytes.chunks_exact(3);
    for chunk in &mut chunks {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(chunk[1]) << 8) | u32::from(chunk[2]);
        out.push(STD[(n >> 18) as usize & 63] as char);
        out.push(STD[(n >> 12) as usize & 63] as char);
        out.push(STD[(n >> 6) as usize & 63] as char);
        out.push(STD[n as usize & 63] as char);
    }
    let rem = chunks.remainder();
    match rem.len() {
        1 => {
            let n = u32::from(rem[0]) << 16;
            out.push(STD[(n >> 18) as usize & 63] as char);
            out.push(STD[(n >> 12) as usize & 63] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let n = (u32::from(rem[0]) << 16) | (u32::from(rem[1]) << 8);
            out.push(STD[(n >> 18) as usize & 63] as char);
            out.push(STD[(n >> 12) as usize & 63] as char);
            out.push(STD[(n >> 6) as usize & 63] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

#[inline]
fn decode_symbol(b: u8) -> Option<u8> {
    match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Forgiving decode matching `Buffer.from(str, "base64")`. Node treats `=` as a
/// hard TERMINATOR: decoding STOPS at the first `=` (even mid-string). Before
/// that terminator, any non-alphabet byte (whitespace, stray punctuation) is
/// skipped. A trailing lone symbol (1 leftover) yields no byte — Node drops it
/// rather than erroring. Never fails.
///
/// The `=`-terminator behavior is load-bearing for parity: `"AB==CD"` decodes to
/// `[0]` (Node stops at the first `=`), not `[0, 16, 131]` (which a
/// filter-everything decoder would produce).
#[must_use]
pub fn forgiving_decode(input: &str) -> Vec<u8> {
    let symbols: Vec<u8> = input
        .bytes()
        .take_while(|b| *b != b'=')
        .filter_map(decode_symbol)
        .collect();
    let mut out = Vec::with_capacity(symbols.len() / 4 * 3 + 2);
    let mut chunks = symbols.chunks_exact(4);
    for chunk in &mut chunks {
        let n = (u32::from(chunk[0]) << 18)
            | (u32::from(chunk[1]) << 12)
            | (u32::from(chunk[2]) << 6)
            | u32::from(chunk[3]);
        out.push((n >> 16) as u8);
        out.push((n >> 8) as u8);
        out.push(n as u8);
    }
    let rem = chunks.remainder();
    match rem.len() {
        2 => {
            let n = (u32::from(rem[0]) << 18) | (u32::from(rem[1]) << 12);
            out.push((n >> 16) as u8);
        }
        3 => {
            let n =
                (u32::from(rem[0]) << 18) | (u32::from(rem[1]) << 12) | (u32::from(rem[2]) << 6);
            out.push((n >> 16) as u8);
            out.push((n >> 8) as u8);
        }
        // 0 or a lone leftover symbol (1) → no trailing byte (Node drops it).
        _ => {}
    }
    out
}

/// Strict, canonical decode to an exact length — the replication-ingest guard.
/// Rejects a non-alphabet character, wrong padding, wrong decoded length, or a
/// non-canonical encoding (one that would re-encode differently).
pub fn strict_decode_exact(input: &str, expected_len: usize) -> Result<Vec<u8>, CryptoError> {
    if !is_canonical_shape(input) {
        return Err(CryptoError::InvalidBase64);
    }
    let bytes = forgiving_decode(input);
    if bytes.len() != expected_len || encode_standard(&bytes) != input {
        return Err(CryptoError::InvalidBase64);
    }
    Ok(bytes)
}

/// Strict, canonical decode with no length constraint — the TS `parseBase64`
/// guard used by the key envelope: the string must be canonical shape AND
/// re-encode to itself. Rejects non-canonical or non-alphabet input.
pub fn strict_decode(input: &str) -> Result<Vec<u8>, CryptoError> {
    if !is_canonical_shape(input) {
        return Err(CryptoError::InvalidBase64);
    }
    let bytes = forgiving_decode(input);
    if encode_standard(&bytes) != input {
        return Err(CryptoError::InvalidBase64);
    }
    Ok(bytes)
}

/// Matches the TS `^[A-Za-z0-9+/]*={0,2}$` shape: alphabet run then 0–2 `=`.
fn is_canonical_shape(input: &str) -> bool {
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() && decode_symbol(bytes[i]).is_some() {
        i += 1;
    }
    let mut pad = 0;
    while i < bytes.len() && bytes[i] == b'=' {
        pad += 1;
        i += 1;
    }
    i == bytes.len() && pad <= 2
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    #[test]
    fn encode_matches_reference_crate() {
        for len in 0..40usize {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 7 + 1) as u8).collect();
            assert_eq!(
                encode_standard(&bytes),
                STANDARD.encode(&bytes),
                "len {len}"
            );
        }
    }

    #[test]
    fn forgiving_round_trips_canonical() {
        for len in 0..40usize {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 13 + 5) as u8).collect();
            let encoded = encode_standard(&bytes);
            assert_eq!(forgiving_decode(&encoded), bytes, "len {len}");
        }
    }

    #[test]
    fn forgiving_skips_whitespace_and_invalid() {
        // Whitespace and stray punctuation are ignored (Node Buffer parity).
        let canonical = encode_standard(b"hello world");
        let noisy = format!(" {canonical} \n\t");
        assert_eq!(forgiving_decode(&noisy), b"hello world");
        // Interleaved junk chars are skipped, not decoded.
        let interleaved: String = canonical.chars().flat_map(|c| [c, '#']).collect();
        assert_eq!(forgiving_decode(&interleaved), b"hello world");
    }

    #[test]
    fn forgiving_drops_lone_trailing_symbol() {
        // "AAAAA" = 5 symbols → one full group (3 bytes) + a lone symbol dropped.
        assert_eq!(forgiving_decode("AAAAA"), vec![0u8, 0, 0]);
    }

    #[test]
    fn forgiving_treats_equals_as_terminator_like_node() {
        // Node's Buffer.from(str, "base64") stops at the first '=' (verified
        // against Node v24). A filter-everything decoder would diverge here.
        assert_eq!(forgiving_decode("AB==CD"), vec![0u8]);
        assert_eq!(forgiving_decode("AA=A"), vec![0u8]);
        assert_eq!(forgiving_decode("A=A=A"), Vec::<u8>::new());
        // A normal trailing pad still decodes the leading group.
        assert_eq!(forgiving_decode("AA=="), vec![0u8]);
    }

    #[test]
    fn strict_decode_exact_enforces_canonical_and_length() {
        let bytes = [0xde, 0xad, 0xbe, 0xef];
        let encoded = encode_standard(&bytes);
        assert_eq!(strict_decode_exact(&encoded, 4).unwrap(), bytes);
        // Wrong expected length rejected.
        assert!(strict_decode_exact(&encoded, 3).is_err());
        // Non-canonical (whitespace) rejected by the strict guard.
        assert!(strict_decode_exact(&format!(" {encoded}"), 4).is_err());
        // Invalid alphabet rejected.
        assert!(strict_decode_exact("!!!!", 3).is_err());
    }

    #[test]
    fn strict_decode_variable_length() {
        let bytes = [1u8, 2, 3, 4, 5];
        let encoded = encode_standard(&bytes);
        assert_eq!(strict_decode(&encoded).unwrap(), bytes);
        assert!(strict_decode("not base64!!").is_err());
    }
}
