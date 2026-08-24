use serde::{Deserialize, Deserializer, Serialize, Serializer, de};

use crate::share::ShareAccess;

/// The tuple every derived credential and open session binds to. This is the
/// only grant-model shape that crosses the engine boundary — a device session
/// host checks it before accepting work. Grant and credential persistence
/// records stay relay-side (ADR 0005) and are never parsed here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantBinding {
    pub grant_id: String,
    #[serde(deserialize_with = "grant_generation")]
    pub generation: u64,
    #[serde(
        serialize_with = "share_access_string",
        deserialize_with = "share_access"
    )]
    pub access: ShareAccess,
}

fn grant_generation<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let generation = u64::deserialize(deserializer)?;
    if generation >= 1 {
        Ok(generation)
    } else {
        Err(de::Error::custom(
            "generation must be an integer at least 1",
        ))
    }
}

fn share_access<'de, D>(deserializer: D) -> Result<ShareAccess, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    ShareAccess::parse(&value).ok_or_else(|| de::Error::custom("unrecognized share access"))
}

fn share_access_string<S>(access: &ShareAccess, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(access.as_str())
}
