# The release image plus the trial load driver, so owners run the same engine
# binary and client code as a desktop.
ARG BASE=dohc-self-host:trial-56584a876
FROM ${BASE}
USER root
RUN mkdir /state && chown node:node /state
USER node
COPY --chown=node:node driver.ts /app/services/share-web/trial-load/driver.ts
WORKDIR /app/services/share-web
ENTRYPOINT ["/app/services/share-web/node_modules/.bin/tsx", "/app/services/share-web/trial-load/driver.ts"]
