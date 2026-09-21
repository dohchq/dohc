FROM rust:1.96.1-bookworm AS native
ENV CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0
WORKDIR /source
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates/ crates/
COPY vendor/ vendor/
RUN cargo build --locked --release -p dohc-workspace-engine --bin dohc-workspace-engine

FROM node:24.14.0-bookworm-slim AS build
ENV PNPM_HOME=/pnpm ELECTRON_SKIP_BINARY_DOWNLOAD=1
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate
WORKDIR /source
COPY . .
RUN pnpm --filter @dohc/workspace-api... --filter @dohc/sync-relay... --filter @dohc/share-web... install --frozen-lockfile
RUN pnpm --filter @dohc/workspace-api build && pnpm --filter @dohc/sync-relay build && pnpm --filter @dohc/share-web build
RUN mkdir -p /release/services/workspace-api/dist /release/services/sync-relay/dist /release/services/share-web/dist /release/services/share-web/viewer/dist /release/scripts/lib /release/packages/workspace-postgres/src/db /release/tools/self-host && \
    cp -a node_modules /release/node_modules && \
    cp -a packages/. /release/packages/ && \
    cp -a services/workspace-api/node_modules /release/services/workspace-api/node_modules && \
    cp -a services/sync-relay/node_modules /release/services/sync-relay/node_modules && \
    cp -a services/share-web/node_modules /release/services/share-web/node_modules && \
    cp -r services/workspace-api/dist/. /release/services/workspace-api/dist/ && \
    cp -r services/sync-relay/dist/. /release/services/sync-relay/dist/ && \
    cp -r services/share-web/dist/. /release/services/share-web/dist/ && \
    cp -r services/share-web/viewer/dist/. /release/services/share-web/viewer/dist/ && \
    cp scripts/migrate-postgres.mjs /release/scripts/ && \
    cp scripts/lib/apply-migrations.mjs /release/scripts/lib/ && \
    cp -r packages/workspace-postgres/src/db/migrations /release/packages/workspace-postgres/src/db/ && \
    cp tools/self-host/entrypoint.mjs tools/self-host/health.mjs /release/tools/self-host/ && \
    ln -sf ../services/workspace-api/node_modules/pg /release/node_modules/pg && \
    printf '{"type":"module"}\n' > /release/package.json

FROM node:24.14.0-bookworm-slim AS runtime
ARG DOHC_REVISION=unknown
LABEL org.opencontainers.image.title="dohc collaboration services" org.opencontainers.image.revision=$DOHC_REVISION
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /release/ /app/
COPY --from=native --chown=node:node /source/target/release/dohc-workspace-engine /app/bin/dohc-workspace-engine
RUN mkdir /data /continuity /host-data && chown node:node /data /continuity /host-data
USER node
ENTRYPOINT ["node", "/app/tools/self-host/entrypoint.mjs"]
