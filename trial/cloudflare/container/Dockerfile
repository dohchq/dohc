# One dohc cell for Cloudflare Containers: the unchanged release image plus
# Caddy as the in-container path router and Mailpit for trial mail.
FROM caddy:2.11.2-alpine AS caddy
FROM axllent/mailpit@sha256:94f6b70c1436defae6799d9ac7ff0eeff9540465b842026d5cdb018f1c0234ea AS mailpit

FROM dohc-self-host:trial-56584a876
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
COPY --from=mailpit /mailpit /usr/local/bin/mailpit
COPY Caddyfile /etc/dohc-trial/Caddyfile
COPY cell.mjs /app/trial/cell.mjs
EXPOSE 8080
ENTRYPOINT ["node", "/app/trial/cell.mjs"]
