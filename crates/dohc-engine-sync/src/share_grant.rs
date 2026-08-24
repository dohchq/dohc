use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use serde_json::Value;

use crate::share::ShareAccess;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SharePrincipal {
    User {
        #[serde(rename = "userId")]
        user_id: String,
    },
    Email {
        email: String,
    },
    Link,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GrantStatus {
    Active,
    Revoked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareGrantRecord {
    pub grant_id: String,
    pub share_id: String,
    pub principal: SharePrincipal,
    #[serde(serialize_with = "serialize_share_access")]
    pub access: ShareAccess,
    pub generation: u64,
    pub status: GrantStatus,
    pub created_at: String,
    pub revoked_at: Option<String>,
    pub parent_grant_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawShareGrantRecord {
    grant_id: String,
    share_id: String,
    principal: SharePrincipal,
    access: String,
    generation: u64,
    status: GrantStatus,
    created_at: String,
    revoked_at: Value,
    parent_grant_id: Value,
}

impl<'de> Deserialize<'de> for ShareGrantRecord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawShareGrantRecord::deserialize(deserializer)?;
        if !is_grant_generation(raw.generation) {
            return Err(de::Error::custom(
                "generation must be an integer at least 1",
            ));
        }
        let access = ShareAccess::parse(&raw.access)
            .ok_or_else(|| de::Error::custom("unrecognized share access"))?;
        let revoked_at = nullable_string::<D::Error>(raw.revoked_at, "revokedAt")?;
        match (raw.status, revoked_at.as_ref()) {
            (GrantStatus::Active, Some(_)) => {
                return Err(de::Error::custom("an active grant cannot have revokedAt"));
            }
            (GrantStatus::Revoked, None) => {
                return Err(de::Error::custom("a revoked grant must have revokedAt"));
            }
            _ => {}
        }
        let parent_grant_id = nullable_string::<D::Error>(raw.parent_grant_id, "parentGrantId")?;
        if parent_grant_id.is_some() && !matches!(raw.principal, SharePrincipal::User { .. }) {
            return Err(de::Error::custom(
                "only a derived user grant can have parentGrantId",
            ));
        }
        Ok(Self {
            grant_id: raw.grant_id,
            share_id: raw.share_id,
            principal: raw.principal,
            access,
            generation: raw.generation,
            status: raw.status,
            created_at: raw.created_at,
            revoked_at,
            parent_grant_id,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkCredentialRecord {
    pub credential_id: String,
    pub grant_id: String,
    pub secret_hash: String,
    pub generation: u64,
    pub minted_at: String,
    pub retired_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLinkCredentialRecord {
    credential_id: String,
    grant_id: String,
    secret_hash: String,
    generation: u64,
    minted_at: String,
    retired_at: Value,
}

impl<'de> Deserialize<'de> for LinkCredentialRecord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawLinkCredentialRecord::deserialize(deserializer)?;
        if !is_grant_generation(raw.generation) {
            return Err(de::Error::custom(
                "generation must be an integer at least 1",
            ));
        }
        Ok(Self {
            credential_id: raw.credential_id,
            grant_id: raw.grant_id,
            secret_hash: raw.secret_hash,
            generation: raw.generation,
            minted_at: raw.minted_at,
            retired_at: nullable_string::<D::Error>(raw.retired_at, "retiredAt")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantBinding {
    pub grant_id: String,
    pub generation: u64,
    #[serde(serialize_with = "serialize_share_access")]
    pub access: ShareAccess,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawGrantBinding {
    grant_id: String,
    generation: u64,
    access: String,
}

impl<'de> Deserialize<'de> for GrantBinding {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawGrantBinding::deserialize(deserializer)?;
        if !is_grant_generation(raw.generation) {
            return Err(de::Error::custom(
                "generation must be an integer at least 1",
            ));
        }
        let access = ShareAccess::parse(&raw.access)
            .ok_or_else(|| de::Error::custom("unrecognized share access"))?;
        Ok(Self {
            grant_id: raw.grant_id,
            generation: raw.generation,
            access,
        })
    }
}

fn is_grant_generation(generation: u64) -> bool {
    generation >= 1
}

fn serialize_share_access<S>(access: &ShareAccess, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(match access {
        ShareAccess::View => "view",
        ShareAccess::Comment => "comment",
        ShareAccess::Edit => "edit",
    })
}

fn nullable_string<E: de::Error>(value: Value, field: &str) -> Result<Option<String>, E> {
    match value {
        Value::Null => Ok(None),
        Value::String(value) => Ok(Some(value)),
        _ => Err(E::custom(format!("{field} must be a string or null"))),
    }
}

pub fn parse_share_principal(value: &Value) -> Option<SharePrincipal> {
    serde_json::from_value(value.clone()).ok()
}

pub fn parse_grant_status(value: &Value) -> Option<GrantStatus> {
    serde_json::from_value(value.clone()).ok()
}

pub fn parse_share_grant_record(value: &Value) -> Option<ShareGrantRecord> {
    serde_json::from_value(value.clone()).ok()
}

pub fn parse_link_credential_record(value: &Value) -> Option<LinkCredentialRecord> {
    serde_json::from_value(value.clone()).ok()
}

pub fn parse_grant_binding(value: &Value) -> Option<GrantBinding> {
    serde_json::from_value(value.clone()).ok()
}
