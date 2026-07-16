//! Codec measurements grounding the R03 protocol recommendation.
//!
//! Measures encode/decode throughput and encoded size for the three
//! candidate envelope codecs (JSON via serde_json, CBOR via ciborium,
//! MessagePack via rmp-serde) plus Protobuf (prost, hand-derived messages —
//! representative of prost codegen output) on three representative payloads:
//!
//! 1. a small request envelope (the common case),
//! 2. a 10,000-entry file manifest (the metadata-heavy worst case,
//!    modeled on `kernel.scan`/`kernel.reconcile` results),
//! 3. a 4 MiB blob — as raw chunk frames (the design), versus base64-inside-
//!    JSON (the anti-pattern the design avoids), versus native binary in
//!    CBOR / MessagePack / Protobuf.
//!
//! Usage: `cargo run --release --example codec_bench`

use dohc_engine_protocol::WireLimits;
use dohc_engine_protocol::frame::encode_blob_chunk_frame;
use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileMetadata {
    path: String,
    size: u64,
    sha256: String,
    media_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Manifest {
    files: Vec<FileMetadata>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SmallRequest {
    id: u64,
    method: String,
    deadline_ms: u32,
    idempotency_key: String,
    params: SmallParams,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct SmallParams {
    profile: String,
    warm: bool,
}

// Hand-derived prost messages (what prost-build would generate).
#[derive(Clone, PartialEq, prost::Message)]
struct PbFileMetadata {
    #[prost(string, tag = "1")]
    path: String,
    #[prost(uint64, tag = "2")]
    size: u64,
    #[prost(string, tag = "3")]
    sha256: String,
    #[prost(string, tag = "4")]
    media_type: String,
}

#[derive(Clone, PartialEq, prost::Message)]
struct PbManifest {
    #[prost(message, repeated, tag = "1")]
    files: Vec<PbFileMetadata>,
}

#[derive(Clone, PartialEq, prost::Message)]
struct PbSmallRequest {
    #[prost(uint64, tag = "1")]
    id: u64,
    #[prost(string, tag = "2")]
    method: String,
    #[prost(uint32, tag = "3")]
    deadline_ms: u32,
    #[prost(string, tag = "4")]
    idempotency_key: String,
    #[prost(string, tag = "5")]
    profile: String,
    #[prost(bool, tag = "6")]
    warm: bool,
}

#[derive(Clone, PartialEq, prost::Message)]
struct PbBlob {
    #[prost(bytes = "vec", tag = "1")]
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Base64Blob {
    data: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct BinaryBlob {
    #[serde(with = "serde_bytes_shim")]
    data: Vec<u8>,
}

/// Minimal serde bytes shim so CBOR/MessagePack use native binary encoding
/// without pulling the serde_bytes crate into the spike.
mod serde_bytes_shim {
    use serde::de::Error;
    use serde::{Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(bytes)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Vec<u8>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("bytes")
            }
            fn visit_bytes<E: Error>(self, v: &[u8]) -> Result<Vec<u8>, E> {
                Ok(v.to_vec())
            }
            fn visit_byte_buf<E: Error>(self, v: Vec<u8>) -> Result<Vec<u8>, E> {
                Ok(v)
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Vec<u8>, A::Error> {
                let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(0));
                while let Some(byte) = seq.next_element::<u8>()? {
                    out.push(byte);
                }
                Ok(out)
            }
        }
        deserializer.deserialize_byte_buf(Visitor)
    }
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(BASE64[(n >> 18) as usize & 63] as char);
        out.push(BASE64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            BASE64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn base64_decode(input: &str) -> Vec<u8> {
    let mut table = [255u8; 256];
    for (index, byte) in BASE64.iter().enumerate() {
        table[*byte as usize] = index as u8;
    }
    let bytes: Vec<u8> = input
        .bytes()
        .filter(|b| table[*b as usize] != 255)
        .collect();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        if chunk.len() < 2 {
            break;
        }
        let n = chunk
            .iter()
            .fold(0u32, |acc, b| (acc << 6) | u32::from(table[*b as usize]));
        let n = n << (6 * (4 - chunk.len() as u32));
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    out
}

/// Deterministic pseudo-random generator (reproducible payloads).
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0
    }
}

fn build_manifest(entries: usize) -> Manifest {
    let mut rng = Lcg(42);
    let files = (0..entries)
        .map(|index| {
            let hash: String = (0..64)
                .map(|_| char::from_digit((rng.next() % 16) as u32, 16).unwrap_or('0'))
                .collect();
            FileMetadata {
                path: format!(
                    "notes/area-{}/topic-{}/document-{index}.md",
                    index % 37,
                    index % 111
                ),
                size: rng.next() % 2_000_000,
                sha256: hash,
                media_type: "text/markdown".to_string(),
            }
        })
        .collect();
    Manifest { files }
}

fn build_blob(bytes: usize) -> Vec<u8> {
    let mut rng = Lcg(7);
    (0..bytes).map(|_| (rng.next() >> 32) as u8).collect()
}

struct Measurement {
    encode_ms: f64,
    decode_ms: f64,
    encoded_bytes: usize,
}

/// Time `iters` runs of encode and decode; returns per-op milliseconds
/// (best of `runs` batches, to shed scheduler noise).
fn measure<E, D, T>(iters: usize, mut encode: E, mut decode: D) -> Measurement
where
    E: FnMut() -> Vec<u8>,
    D: FnMut(&[u8]) -> T,
{
    let sample = encode();
    let encoded_bytes = sample.len();
    let runs = 5usize;

    let mut best_encode = f64::MAX;
    let mut best_decode = f64::MAX;
    for _ in 0..runs {
        let started = Instant::now();
        for _ in 0..iters {
            std::hint::black_box(encode());
        }
        best_encode = best_encode.min(started.elapsed().as_secs_f64() * 1000.0 / iters as f64);

        let started = Instant::now();
        for _ in 0..iters {
            std::hint::black_box(decode(&sample));
        }
        best_decode = best_decode.min(started.elapsed().as_secs_f64() * 1000.0 / iters as f64);
    }
    Measurement {
        encode_ms: best_encode,
        decode_ms: best_decode,
        encoded_bytes,
    }
}

fn row(label: &str, payload_bytes: usize, m: &Measurement) {
    let encode_mbps = payload_bytes as f64 / 1_000_000.0 / (m.encode_ms / 1000.0);
    let decode_mbps = payload_bytes as f64 / 1_000_000.0 / (m.decode_ms / 1000.0);
    println!(
        "| {label} | {} | {:.2} | {:.2} | {:.0} | {:.0} |",
        m.encoded_bytes,
        m.encode_ms * 1000.0,
        m.decode_ms * 1000.0,
        encode_mbps,
        decode_mbps
    );
}

fn main() {
    let limits = WireLimits::SPIKE_DEFAULTS;

    // ---- Payload 1: small request envelope --------------------------------
    let small = SmallRequest {
        id: 42,
        method: "workspace.open".into(),
        deadline_ms: 5000,
        idempotency_key: "open-42-6d1f".into(),
        params: SmallParams {
            profile: "default".into(),
            warm: true,
        },
    };
    let pb_small = PbSmallRequest {
        id: 42,
        method: "workspace.open".into(),
        deadline_ms: 5000,
        idempotency_key: "open-42-6d1f".into(),
        profile: "default".into(),
        warm: true,
    };

    println!("### Small request envelope (~140 B logical)\n");
    println!("| codec | bytes | encode us/op | decode us/op | enc MB/s | dec MB/s |");
    println!("| --- | --- | --- | --- | --- | --- |");
    let iters = 200_000;
    let json_len = serde_json::to_vec(&small).expect("json").len();
    row(
        "JSON (serde_json)",
        json_len,
        &measure(
            iters,
            || serde_json::to_vec(&small).expect("json encode"),
            |bytes| serde_json::from_slice::<SmallRequest>(bytes).expect("json decode"),
        ),
    );
    row(
        "CBOR (ciborium)",
        json_len,
        &measure(
            iters,
            || {
                let mut out = Vec::new();
                ciborium::into_writer(&small, &mut out).expect("cbor encode");
                out
            },
            |bytes| ciborium::from_reader::<SmallRequest, _>(bytes).expect("cbor decode"),
        ),
    );
    row(
        "MessagePack (rmp, named)",
        json_len,
        &measure(
            iters,
            || rmp_serde::to_vec_named(&small).expect("msgpack encode"),
            |bytes| rmp_serde::from_slice::<SmallRequest>(bytes).expect("msgpack decode"),
        ),
    );
    row(
        "Protobuf (prost)",
        json_len,
        &measure(
            iters,
            || prost::Message::encode_to_vec(&pb_small),
            |bytes| <PbSmallRequest as prost::Message>::decode(bytes).expect("pb decode"),
        ),
    );

    // ---- Payload 2: 10k-entry manifest -------------------------------------
    let manifest = build_manifest(10_000);
    let pb_manifest = PbManifest {
        files: manifest
            .files
            .iter()
            .map(|file| PbFileMetadata {
                path: file.path.clone(),
                size: file.size,
                sha256: file.sha256.clone(),
                media_type: file.media_type.clone(),
            })
            .collect(),
    };
    let manifest_logical = serde_json::to_vec(&manifest).expect("json").len();

    println!("\n### 10,000-entry file manifest (scan/reconcile shape)\n");
    println!("| codec | bytes | encode us/op | decode us/op | enc MB/s | dec MB/s |");
    println!("| --- | --- | --- | --- | --- | --- |");
    let iters = 30;
    row(
        "JSON (serde_json)",
        manifest_logical,
        &measure(
            iters,
            || serde_json::to_vec(&manifest).expect("json encode"),
            |bytes| serde_json::from_slice::<Manifest>(bytes).expect("json decode"),
        ),
    );
    row(
        "CBOR (ciborium)",
        manifest_logical,
        &measure(
            iters,
            || {
                let mut out = Vec::new();
                ciborium::into_writer(&manifest, &mut out).expect("cbor encode");
                out
            },
            |bytes| ciborium::from_reader::<Manifest, _>(bytes).expect("cbor decode"),
        ),
    );
    row(
        "MessagePack (rmp, named)",
        manifest_logical,
        &measure(
            iters,
            || rmp_serde::to_vec_named(&manifest).expect("msgpack encode"),
            |bytes| rmp_serde::from_slice::<Manifest>(bytes).expect("msgpack decode"),
        ),
    );
    row(
        "Protobuf (prost)",
        manifest_logical,
        &measure(
            iters,
            || prost::Message::encode_to_vec(&pb_manifest),
            |bytes| <PbManifest as prost::Message>::decode(bytes).expect("pb decode"),
        ),
    );

    // ---- Payload 3: 4 MiB blob ---------------------------------------------
    let blob = build_blob(4 * 1024 * 1024);
    let pb_blob = PbBlob {
        bytes: blob.clone(),
    };
    let binary_blob = BinaryBlob { data: blob.clone() };

    println!("\n### 4 MiB blob\n");
    println!("| encoding | bytes | encode us/op | decode us/op | enc MB/s | dec MB/s |");
    println!("| --- | --- | --- | --- | --- | --- |");
    let iters = 20;
    row(
        "raw chunk frames (design)",
        blob.len(),
        &measure(
            iters,
            || {
                let mut out = Vec::with_capacity(blob.len() + blob.len() / 1024);
                for (index, chunk) in blob
                    .chunks(limits.max_blob_chunk_bytes as usize)
                    .enumerate()
                {
                    let fin = (index + 1) * limits.max_blob_chunk_bytes as usize >= blob.len();
                    out.extend(encode_blob_chunk_frame(3, fin, chunk, &limits).expect("chunk"));
                }
                out
            },
            |bytes| {
                let mut decoder = dohc_engine_protocol::FrameDecoder::new(limits.clone());
                decoder.push(bytes);
                let mut total = 0usize;
                while let Ok(Some(frame)) = decoder.next_frame() {
                    if let dohc_engine_protocol::Frame::BlobChunk { bytes, .. } = frame {
                        total += bytes.len();
                    }
                }
                total
            },
        ),
    );
    row(
        "base64 in JSON (anti-pattern)",
        blob.len(),
        &measure(
            iters,
            || {
                serde_json::to_vec(&Base64Blob {
                    data: base64_encode(&blob),
                })
                .expect("json encode")
            },
            |bytes| {
                let parsed: Base64Blob = serde_json::from_slice(bytes).expect("json decode");
                base64_decode(&parsed.data)
            },
        ),
    );
    row(
        "CBOR native bytes",
        blob.len(),
        &measure(
            iters,
            || {
                let mut out = Vec::new();
                ciborium::into_writer(&binary_blob, &mut out).expect("cbor encode");
                out
            },
            |bytes| ciborium::from_reader::<BinaryBlob, _>(bytes).expect("cbor decode"),
        ),
    );
    row(
        "MessagePack native bytes",
        blob.len(),
        &measure(
            iters,
            || rmp_serde::to_vec_named(&binary_blob).expect("msgpack encode"),
            |bytes| rmp_serde::from_slice::<BinaryBlob>(bytes).expect("msgpack decode"),
        ),
    );
    row(
        "Protobuf bytes field",
        blob.len(),
        &measure(
            iters,
            || prost::Message::encode_to_vec(&pb_blob),
            |bytes| <PbBlob as prost::Message>::decode(bytes).expect("pb decode"),
        ),
    );

    println!("\n(bytes = encoded size; MB/s relative to the logical payload size; best of 5 runs)");
}
