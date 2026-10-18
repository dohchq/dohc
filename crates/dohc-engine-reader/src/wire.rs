use crate::Failure;
use dohc_engine_protocol::{
    frame::{Frame, FrameDecoder, blob_chunks, encode_blob_chunk_frame, encode_control_frame},
    limits::WireLimits,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

pub(crate) const CHUNK: usize = 65536;
pub(crate) const UPDATE: usize = 20 * 1024 * 1024;
pub(crate) fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn limits() -> WireLimits {
    WireLimits {
        max_frame_bytes: CHUNK as u32,
        max_blob_chunk_bytes: CHUNK as u32,
        ..WireLimits::default()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Blob {
    pub length: usize,
    pub sha256: String,
}
impl Blob {
    pub fn of(bytes: &[u8]) -> Self {
        Self {
            length: bytes.len(),
            sha256: sha(bytes),
        }
    }
    pub fn valid(&self, max: usize) -> bool {
        self.length <= max
            && self.sha256.len() == 64
            && self
                .sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    }
}
pub(crate) struct Pipe<R, W> {
    pub reader: R,
    pub writer: W,
    decoder: FrameDecoder,
}
impl<R: Read, W: Write> Pipe<R, W> {
    pub fn new(reader: R, writer: W) -> Self {
        Self {
            reader,
            writer,
            decoder: FrameDecoder::new(limits()),
        }
    }
    pub fn control(&mut self, value: &impl Serialize) -> Result<(), Failure> {
        let bytes = serde_json::to_vec(value).map_err(|_| Failure::Crashed)?;
        let frame = encode_control_frame(&bytes, &limits()).map_err(|_| Failure::Crashed)?;
        self.writer.write_all(&frame).map_err(|_| Failure::Crashed)
    }
    pub fn blob(&mut self, id: u64, bytes: &[u8]) -> Result<(), Failure> {
        for (fin, chunk) in blob_chunks(bytes, CHUNK) {
            let frame =
                encode_blob_chunk_frame(id, fin, chunk, &limits()).map_err(|_| Failure::Crashed)?;
            self.writer
                .write_all(&frame)
                .map_err(|_| Failure::Crashed)?;
        }
        Ok(())
    }
    pub fn frame(&mut self) -> Result<Frame, Failure> {
        loop {
            if let Some(frame) = self.decoder.next_frame().map_err(|_| Failure::Crashed)? {
                return Ok(frame);
            }
            let mut bytes = [0; 8192];
            let n = self.reader.read(&mut bytes).map_err(|_| Failure::Crashed)?;
            if n == 0 {
                return Err(Failure::Crashed);
            }
            self.decoder.push(&bytes[..n]);
        }
    }
    pub fn json<T: serde::de::DeserializeOwned>(&mut self) -> Result<T, Failure> {
        match self.frame()? {
            Frame::Control(bytes) => serde_json::from_slice(&bytes).map_err(|_| Failure::Crashed),
            _ => Err(Failure::Crashed),
        }
    }
    pub fn receive(&mut self, id: u64, declared: Blob) -> Result<Vec<u8>, Failure> {
        if !declared.valid(UPDATE) {
            return Err(Failure::Crashed);
        }
        let mut bytes = Vec::with_capacity(declared.length);
        loop {
            match self.frame()? {
                Frame::BlobChunk {
                    stream_id,
                    fin,
                    bytes: chunk,
                } if stream_id == id
                    && bytes.len() + chunk.len() <= declared.length
                    && (!chunk.is_empty() || declared.length == 0) =>
                {
                    bytes.extend_from_slice(&chunk);
                    if fin {
                        break;
                    }
                    if bytes.len() == declared.length {
                        return Err(Failure::Crashed);
                    }
                }
                _ => return Err(Failure::Crashed),
            }
        }
        if bytes.len() != declared.length || sha(&bytes) != declared.sha256 {
            return Err(Failure::Crashed);
        }
        Ok(bytes)
    }
}
