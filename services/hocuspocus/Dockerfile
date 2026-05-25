FROM node:22-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app

RUN corepack enable

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services/hocuspocus/package.json services/hocuspocus/package.json

RUN pnpm install --filter @dohc/hocuspocus --frozen-lockfile

FROM deps AS build

COPY services/hocuspocus services/hocuspocus
RUN pnpm --filter @dohc/hocuspocus build

FROM base AS prod-deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/hocuspocus/package.json services/hocuspocus/package.json

RUN pnpm install --filter @dohc/hocuspocus --prod --frozen-lockfile

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV="production"
WORKDIR /app/services/hocuspocus

COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/services/hocuspocus/node_modules ./node_modules
COPY --from=prod-deps /app/services/hocuspocus/package.json ./package.json
COPY --from=build /app/services/hocuspocus/dist ./dist

EXPOSE 1234

CMD ["node", "dist/server.js"]
