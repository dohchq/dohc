use crate::EngineService;
use crate::rpc::request::{OperationCancellation, parse};
use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EdgesParams {
    cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IncomingParams {
    subject: Value,
    cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveParams {
    source: String,
    literals: Vec<Literal>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Literal {
    kind: Kind,
    literal: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Wikilink,
    Markdown,
}

impl EngineService {
    pub(super) async fn links_read(
        &self,
        ctx: &RequestContext,
        workspace: Option<WorkspaceHandle>,
        params: Value,
        method: &str,
    ) -> Result<Value, WireError> {
        if params.to_string().len() > 48 * 1024 {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "links request exceeds 48 KiB",
            ));
        }
        let open = self.open(workspace.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        if method == "links.edges" {
            let p: EdgesParams = parse(params)?;
            Self::read_under_ctx(
                &cancellation,
                "links.edges",
                open.actor
                    .link_edges(open.workspace_id.clone(), p.cursor, cancellation.token()),
            )
            .await
        } else if method == "links.in" {
            let p: IncomingParams = parse(params)?;
            Self::read_under_ctx(
                &cancellation,
                "links.in",
                open.actor.incoming_links(
                    open.workspace_id.clone(),
                    super::files::resolve_target(p.subject),
                    p.cursor,
                    cancellation.token(),
                ),
            )
            .await
        } else {
            let p: ResolveParams = parse(params)?;
            if p.literals.len() > 128 || p.literals.iter().any(|l| l.literal.len() > 2048) {
                return Err(WireError::new(
                    ErrorCode::InvalidParams,
                    "links.resolve exceeds literal cap",
                ));
            }
            let literals = p
                .literals
                .into_iter()
                .map(|l| {
                    (
                        match l.kind {
                            Kind::Wikilink => "wikilink",
                            Kind::Markdown => "markdown",
                        }
                        .into(),
                        l.literal,
                    )
                })
                .collect();
            Self::read_under_ctx(
                &cancellation,
                "links.resolve",
                open.actor.resolve_links(
                    open.workspace_id.clone(),
                    p.source,
                    literals,
                    cancellation.token(),
                ),
            )
            .await
        }
    }
}
