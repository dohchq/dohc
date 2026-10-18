# Test-only image. Build the three binaries in WSL before building this stage.
FROM node:24.16.0-bookworm-slim AS replica-sandbox-test
WORKDIR /app
COPY . /app/
RUN mkdir /data /replicas && chown node:node /data /replicas && chmod 700 /replicas
USER node
ENTRYPOINT ["node", "/app/fixture.mjs"]
