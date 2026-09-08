use dohc_engine_domain::normalize_tracked_workspace_path;
use serde::{Deserialize, Serialize};

pub const LIVE_OBJECT_BINDING_IDENTIFIER_MAX_BYTES: usize = 512;
pub const LIVE_OBJECT_BINDING_PATH_MAX_BYTES: usize = 1_024;
pub const LIVE_OBJECT_BINDING_SELECTOR_PATH_MAX_COUNT: usize = 100;
const JAVASCRIPT_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveObjectBinding {
    pub workspace_id: String,
    pub main_version_id: String,
    pub object_id: String,
    pub lineage_claim_id: String,
    pub current_path: String,
    pub selector_paths: Vec<String>,
    pub restore_fence_generation: i64,
}
impl LiveObjectBinding {
    pub fn validate_canonical(&self) -> Result<(), &'static str> {
        if self.clone().normalized()? != *self {
            return Err("noncanonical binding");
        }
        Ok(())
    }

    pub(crate) fn normalized(mut self) -> Result<Self, &'static str> {
        for value in [
            self.workspace_id.as_str(),
            self.main_version_id.as_str(),
            self.object_id.as_str(),
            self.lineage_claim_id.as_str(),
        ] {
            if value.is_empty()
                || value.len() > LIVE_OBJECT_BINDING_IDENTIFIER_MAX_BYTES
                || value.bytes().any(|byte| byte.is_ascii_control())
            {
                return Err(
                    "binding identifiers must be non-empty, bounded, and contain no control bytes",
                );
            }
        }
        if !(0..=JAVASCRIPT_MAX_SAFE_INTEGER).contains(&self.restore_fence_generation) {
            return Err("restore fence generation must be a non-negative safe integer");
        }
        if self.selector_paths.is_empty()
            || self.selector_paths.len() > LIVE_OBJECT_BINDING_SELECTOR_PATH_MAX_COUNT
        {
            return Err("selector paths must contain from 1 through 100 entries");
        }

        self.current_path = normalize_path(&self.current_path)?;
        self.selector_paths = self
            .selector_paths
            .iter()
            .map(|path| normalize_path(path))
            .collect::<Result<Vec<_>, _>>()?;
        self.selector_paths.sort();
        self.selector_paths.dedup();
        if self.selector_paths.is_empty() {
            return Err("selector paths must not be empty");
        }
        Ok(self)
    }
}

fn normalize_path(path: &str) -> Result<String, &'static str> {
    let normalized = normalize_tracked_workspace_path(path)
        .map_err(|_| "binding path is not tracked workspace plaintext")?;
    if normalized.is_empty()
        || normalized.len() > LIVE_OBJECT_BINDING_PATH_MAX_BYTES
        || normalized.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err("binding path must be non-empty, bounded, and contain no control bytes");
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::Value;

    #[derive(Deserialize)]
    struct BindingVectors {
        accepted: Vec<AcceptedRow>,
        refused: Vec<RefusedRow>,
    }

    #[derive(Deserialize)]
    struct AcceptedRow {
        name: String,
        input: Value,
        normalized: Value,
    }

    #[derive(Deserialize)]
    struct RefusedRow {
        name: String,
        input: Value,
    }

    fn parse_normalized(value: Value) -> Result<LiveObjectBinding, ()> {
        serde_json::from_value::<LiveObjectBinding>(value)
            .map_err(|_| ())?
            .normalized()
            .map_err(|_| ())
    }

    #[test]
    fn shared_typescript_vectors_match_rust_normalization_and_refusal() {
        let vectors: BindingVectors = serde_json::from_str(include_str!(
            "../../../packages/live-session-contract/src/liveObjectBinding.vectors.json"
        ))
        .expect("shared LiveObjectBinding vectors");

        for row in vectors.accepted {
            let expected: LiveObjectBinding =
                serde_json::from_value(row.normalized).expect("accepted normalized binding");
            let actual = parse_normalized(row.input)
                .unwrap_or_else(|_| panic!("accepted vector refused: {}", row.name));
            assert_eq!(actual, expected, "accepted vector differed: {}", row.name);
        }

        for row in vectors.refused {
            assert!(
                parse_normalized(row.input).is_err(),
                "refused vector accepted: {}",
                row.name
            );
        }
    }

    #[test]
    fn authority_shaped_unknown_field_is_refused() {
        let vectors: BindingVectors = serde_json::from_str(include_str!(
            "../../../packages/live-session-contract/src/liveObjectBinding.vectors.json"
        ))
        .expect("shared LiveObjectBinding vectors");
        let row = vectors
            .refused
            .into_iter()
            .find(|row| row.name == "refuses-authority-shaped-grant-field")
            .expect("authority-shaped refusal vector");
        assert!(parse_normalized(row.input).is_err());
    }

    #[test]
    fn domain_floor_accepts_the_three_tracked_path_parity_rows() {
        let vectors: BindingVectors = serde_json::from_str(include_str!(
            "../../../packages/live-session-contract/src/liveObjectBinding.vectors.json"
        ))
        .expect("shared LiveObjectBinding vectors");
        let required = [
            "normalizes-backslash-path",
            "accepts-non-segment-double-dot-path",
            "accepts-relative-colon-at-byte-one",
        ];
        let mut failures = Vec::new();
        for name in required {
            let row = vectors
                .accepted
                .iter()
                .find(|row| row.name == name)
                .unwrap_or_else(|| panic!("missing accepted parity vector: {name}"));
            let expected: LiveObjectBinding = serde_json::from_value(row.normalized.clone())
                .expect("accepted normalized binding");
            if parse_normalized(row.input.clone()).as_ref() != Ok(&expected) {
                failures.push(name);
            }
        }
        assert!(
            failures.is_empty(),
            "accepted parity vectors refused: {}",
            failures.join(", ")
        );
    }
}
