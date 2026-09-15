use super::*;
use std::io::{self, Read, Write};

pub(super) const CHUNK_BYTES: usize = 4 * 1024 * 1024;
// Native metadata fits its u32 ingress reservation. The remainder covers
// source coordinates and the portable record wrapper, not more update bytes.
const MAX_RECORD_BYTES: u64 = u32::MAX as u64 + 32_768;
const MAX_CHUNKS: usize = MAX_RECORD_BYTES.div_ceil(CHUNK_BYTES as u64) as usize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Chunk {
    pub sha256: String,
    pub byte_length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Manifest {
    pub format_version: u32,
    pub record_digest: String,
    pub byte_length: u64,
    pub chunks: Vec<Chunk>,
}

impl Manifest {
    pub fn validate(&self) -> Result<(), SyncError> {
        if self.format_version != 1
            || !digest(&self.record_digest)
            || self.byte_length == 0
            || self.byte_length > MAX_RECORD_BYTES
            || self.chunks.len() != self.byte_length.div_ceil(CHUNK_BYTES as u64) as usize
            || self.chunks.len() > MAX_CHUNKS
        {
            return Err(invalid("invalid live audit manifest"));
        }
        let mut remaining = self.byte_length;
        for chunk in &self.chunks {
            if !digest(&chunk.sha256)
                || chunk.byte_length as u64 != remaining.min(CHUNK_BYTES as u64)
            {
                return Err(invalid("invalid live audit chunk"));
            }
            remaining -= chunk.byte_length as u64;
        }
        Ok(())
    }
}

pub(super) struct ChunkWriter<'a> {
    conn: &'a Connection,
    buffer: Vec<u8>,
    chunks: Vec<Chunk>,
    hash: Sha256,
    length: u64,
}

impl<'a> ChunkWriter<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self {
            conn,
            buffer: Vec::new(),
            chunks: Vec::new(),
            hash: Sha256::new(),
            length: 0,
        }
    }

    fn flush_chunk(&mut self) -> io::Result<()> {
        if !self.buffer.is_empty() {
            let sha256 = dohc_engine_storage::put_binary_blob(self.conn, &self.buffer)
                .map_err(io::Error::other)?;
            self.chunks.push(Chunk {
                sha256,
                byte_length: self.buffer.len(),
            });
            self.buffer.clear();
        }
        Ok(())
    }

    pub fn finish(mut self) -> Result<Manifest, SyncError> {
        self.flush_chunk().map_err(SyncError::corrupt)?;
        let manifest = Manifest {
            format_version: 1,
            record_digest: dohc_engine_storage::hex(&self.hash.finalize()),
            byte_length: self.length,
            chunks: self.chunks,
        };
        manifest.validate()?;
        Ok(manifest)
    }
}

impl Write for ChunkWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.length.saturating_add(bytes.len() as u64) > MAX_RECORD_BYTES {
            return Err(io::Error::other("live audit source exceeds native bound"));
        }
        self.hash.update(bytes);
        self.length += bytes.len() as u64;
        let mut remaining = bytes;
        while !remaining.is_empty() {
            let count = remaining.len().min(CHUNK_BYTES - self.buffer.len());
            self.buffer.extend_from_slice(&remaining[..count]);
            remaining = &remaining[count..];
            if self.buffer.len() == CHUNK_BYTES {
                self.flush_chunk()?;
            }
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Authenticating reader retains one chunk. Token bounds stop serde's string
/// scratch buffer growing with an attacker-authored record. Valid native
/// strings have at most 1,024 UTF-8 bytes; escaped controls are rejected later.
pub(super) struct ChunkReader<'a> {
    conn: &'a Connection,
    manifest: &'a Manifest,
    next: usize,
    buffer: Vec<u8>,
    offset: usize,
    hash: Sha256,
    length: u64,
    in_string: bool,
    escaped: bool,
    token_length: usize,
    depth: usize,
    bounded_container: Option<(usize, u64)>,
}

impl<'a> ChunkReader<'a> {
    pub fn new(conn: &'a Connection, manifest: &'a Manifest) -> Result<Self, SyncError> {
        manifest.validate()?;
        Ok(Self {
            conn,
            manifest,
            next: 0,
            buffer: Vec::new(),
            offset: 0,
            hash: Sha256::new(),
            length: 0,
            in_string: false,
            escaped: false,
            token_length: 0,
            depth: 0,
            bounded_container: None,
        })
    }

    fn token(&mut self, byte: u8, position: u64) -> io::Result<()> {
        // The accepted header is bounded separately from its range array.
        // Each range also gets a bound before wire_integer can build a Value.
        if self
            .bounded_container
            .is_some_and(|(_, start)| position - start > 262_144)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "oversized live audit object",
            ));
        }
        if self.in_string {
            self.token_length += 1;
            if self.token_length > 8192 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "oversized live audit string",
                ));
            }
            if self.escaped {
                self.escaped = false;
            } else if byte == b'\\' {
                self.escaped = true;
            } else if byte == b'"' {
                self.in_string = false;
                self.token_length = 0;
            }
        } else {
            match byte {
                b'"' => {
                    self.in_string = true;
                    self.token_length = 0;
                }
                b'{' | b'[' => {
                    self.depth += 1;
                    self.token_length = 0;
                    if self.bounded_container.is_none()
                        && ((self.depth == 3 && byte == b'{') || self.depth == 4)
                    {
                        self.bounded_container = Some((self.depth, position));
                    }
                    if self.depth > 32 {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "oversized live audit nesting",
                        ));
                    }
                }
                b'}' | b']' => {
                    if self
                        .bounded_container
                        .is_some_and(|(depth, _)| self.depth == depth)
                    {
                        self.bounded_container = None;
                    }
                    self.depth = self.depth.saturating_sub(1);
                    self.token_length = 0;
                }
                b',' | b':' | b' ' | b'\n' | b'\r' | b'\t' => self.token_length = 0,
                _ => {
                    self.token_length += 1;
                    if self.token_length > 64 {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "oversized live audit scalar",
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    pub fn finish(self) -> Result<(), SyncError> {
        if self.length != self.manifest.byte_length
            || dohc_engine_storage::hex(&self.hash.finalize()) != self.manifest.record_digest
        {
            return Err(SyncError::BlobInvalid);
        }
        Ok(())
    }
}

impl Read for ChunkReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        if self.offset == self.buffer.len() {
            let Some(chunk) = self.manifest.chunks.get(self.next) else {
                return Ok(0);
            };
            let lengths: Option<(i64, i64)> = self
                .conn
                .query_row(
                    "SELECT byte_length,length(bytes) FROM binary_blobs WHERE sha256=?1",
                    [&chunk.sha256],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(io::Error::other)?;
            if lengths != Some((chunk.byte_length as i64, chunk.byte_length as i64)) {
                return Err(io::Error::other("live audit chunk unavailable"));
            }
            // Drop the previous allocation before the bounded blob read.
            self.buffer = Vec::new();
            self.buffer = dohc_engine_storage::get_binary_blob(self.conn, &chunk.sha256)
                .map_err(io::Error::other)?
                .ok_or_else(|| io::Error::other("live audit chunk unavailable"))?;
            self.offset = 0;
            self.next += 1;
        }
        let count = output.len().min(self.buffer.len() - self.offset);
        for index in 0..count {
            self.token(self.buffer[self.offset + index], self.length + index as u64)?;
        }
        output[..count].copy_from_slice(&self.buffer[self.offset..self.offset + count]);
        self.hash.update(&output[..count]);
        self.length += count as u64;
        self.offset += count;
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multi_chunk_roundtrip_authenticates_order_and_canonical_geometry() {
        let (_scratch, _path, store) = dohc_engine_testkit::open_store();
        store
            .read_with(|conn| {
                let mut writer = ChunkWriter::new(conn);
                writer.write_all(b"{\"metadata\":{\"firstSeen\":[").unwrap();
                let range = b"{\"clientId\":0,\"startClock\":0,\"endClock\":1},";
                for _ in 0..CHUNK_BYTES / range.len() + 1 {
                    writer.write_all(range).unwrap();
                }
                writer.write_all(b"{}]}}").unwrap();
                let manifest = writer.finish().unwrap();
                assert_eq!(manifest.chunks.len(), 2);
                let mut reader = ChunkReader::new(conn, &manifest).unwrap();
                let mut buffer = [0_u8; 4096];
                let mut length = 0;
                loop {
                    let n = reader.read(&mut buffer).unwrap();
                    if n == 0 {
                        break;
                    }
                    length += n;
                }
                assert_eq!(length as u64, manifest.byte_length);
                reader.finish().unwrap();
                let mut corrupt = manifest.clone();
                corrupt.record_digest = "f".repeat(64);
                let mut reader = ChunkReader::new(conn, &corrupt).unwrap();
                io::copy(&mut reader, &mut io::sink()).unwrap();
                assert!(reader.finish().is_err());
                corrupt.chunks.reverse();
                assert!(corrupt.validate().is_err());
                Ok::<_, SyncError>(())
            })
            .unwrap();
    }

    #[test]
    fn manifest_upper_bound_fits_existing_envelope() {
        let mut remaining = MAX_RECORD_BYTES;
        let mut chunks = Vec::new();
        while remaining > 0 {
            let byte_length = remaining.min(CHUNK_BYTES as u64) as usize;
            chunks.push(Chunk {
                sha256: "a".repeat(64),
                byte_length,
            });
            remaining -= byte_length as u64;
        }
        let manifest = Manifest {
            format_version: 1,
            record_digest: "b".repeat(64),
            byte_length: MAX_RECORD_BYTES,
            chunks,
        };
        manifest.validate().unwrap();
        assert_eq!(manifest.chunks.len(), 1025);
        assert!(
            serde_json::to_vec(&manifest).unwrap().len() + 16_384 < crate::MAX_PAYLOAD_JSON_BYTES
        );
    }

    #[test]
    fn untrusted_string_is_stopped_before_serde_can_retain_the_record() {
        let (_scratch, _path, store) = dohc_engine_testkit::open_store();
        store
            .read_with(|conn| {
                let mut writer = ChunkWriter::new(conn);
                writer.write_all(b"\"").unwrap();
                writer.write_all(&vec![b'a'; 16384]).unwrap();
                writer.write_all(b"\"").unwrap();
                let manifest = writer.finish().unwrap();
                let reader = ChunkReader::new(conn, &manifest).unwrap();
                assert!(serde_json::from_reader::<_, String>(reader).is_err());
                Ok::<_, SyncError>(())
            })
            .unwrap();
    }

    #[test]
    fn untrusted_header_array_is_bounded_before_deserialization_finishes() {
        let (_scratch, _path, store) = dohc_engine_testkit::open_store();
        store
            .read_with(|conn| {
                let mut writer = ChunkWriter::new(conn);
                writer
                    .write_all(b"{\"metadata\":{\"accepted\":{\"binding\":{\"selectorPaths\":[")
                    .unwrap();
                for _ in 0..90_000 {
                    writer.write_all(b"\"a\",").unwrap();
                }
                writer.write_all(b"\"b\"]}}}}").unwrap();
                let manifest = writer.finish().unwrap();
                let reader = std::io::BufReader::new(ChunkReader::new(conn, &manifest).unwrap());
                let error = serde_json::from_reader::<_, serde_json::Value>(reader).unwrap_err();
                assert_eq!(error.io_error_kind(), Some(io::ErrorKind::InvalidData));
                Ok::<_, SyncError>(())
            })
            .unwrap();
    }
}
