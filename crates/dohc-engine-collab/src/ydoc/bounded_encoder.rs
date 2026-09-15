use yrs::encoding::write::Write;
use yrs::updates::encoder::Encoder;
use yrs::{Any, ClientID, ID};

// EncoderV1 semantics from yrs 0.27.3, with a fixed output allocation. The
// encoder trait cannot return an error; overflow discards subsequent writes.
pub(super) struct BoundedEncoder {
    bytes: Vec<u8>,
    limit: usize,
    overflow: bool,
}

impl BoundedEncoder {
    pub(super) fn new(limit: usize) -> Option<Self> {
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(limit).ok()?;
        Some(Self {
            bytes,
            limit,
            overflow: false,
        })
    }

    pub(super) fn finish(self) -> Option<Vec<u8>> {
        (!self.overflow).then_some(self.bytes)
    }

    fn write_id(&mut self, id: &ID) {
        self.write_var(id.client.get());
        self.write_var(id.clock);
    }
}

impl Write for BoundedEncoder {
    fn write_all(&mut self, bytes: &[u8]) {
        if self.overflow || bytes.len() > self.limit - self.bytes.len() {
            self.overflow = true;
        } else {
            self.bytes.extend_from_slice(bytes);
        }
    }

    fn write_u8(&mut self, byte: u8) {
        self.write_all(&[byte]);
    }
}

impl Encoder for BoundedEncoder {
    fn to_vec(self) -> Vec<u8> {
        self.finish().unwrap_or_default()
    }
    fn reset_ds_cur_val(&mut self) {}
    fn write_ds_clock(&mut self, clock: u32) {
        self.write_var(clock);
    }
    fn write_ds_len(&mut self, len: u32) {
        self.write_var(len);
    }
    fn write_left_id(&mut self, id: &ID) {
        self.write_id(id);
    }
    fn write_right_id(&mut self, id: &ID) {
        self.write_id(id);
    }
    fn write_client(&mut self, client: ClientID) {
        self.write_var(client.get());
    }
    fn write_info(&mut self, info: u8) {
        self.write_u8(info);
    }
    fn write_parent_info(&mut self, is_y_key: bool) {
        self.write_var(u32::from(is_y_key));
    }
    fn write_type_ref(&mut self, info: u8) {
        self.write_u8(info);
    }
    fn write_len(&mut self, len: u32) {
        self.write_var(len);
    }
    fn write_any(&mut self, any: &Any) {
        any.encode(self);
    }
    fn write_json(&mut self, any: &Any) {
        let mut json = String::new();
        any.to_json(&mut json);
        self.write_string(&json);
    }
    fn write_key(&mut self, key: &str) {
        self.write_string(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trait_completion_cannot_return_truncated_bytes() {
        let mut encoder = BoundedEncoder::new(1).unwrap();
        encoder.write_all(&[1, 2]);
        assert!(encoder.to_vec().is_empty());
    }
}
