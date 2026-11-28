import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual, parseArgs, parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { composeArgs, gatewayConfigHash, readSettings, validateSettings } from "./config.mjs";

export function initialSettings({
  origin,
  mode = "public",
  name = "dohc",
  image = "dohc-self-host:local",
}) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password)
    throw new Error("Use an HTTPS origin without a path.");
  if (!["public", "private"].includes(mode)) throw new Error("Choose public or private mode.");
  if (mode === "public" && url.port)
    throw new Error("Public mode uses HTTPS port 443. Remove the custom port.");
  if (mode === "private" && !url.hostname.endsWith(".ts.net"))
    throw new Error("Use your Tailscale HTTPS hostname for private mode.");
  if (!name.trim() || name.length > 80 || /[\r\n'\x00]/.test(name))
    throw new Error("Use a server name of 1 to 80 characters without quotes or newlines.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9./_:@-]+$/.test(image))
    throw new Error("Use a valid release image name.");
  return {
    DOHC_PUBLIC_ORIGIN: origin,
    DOHC_PUBLIC_HOST: url.host,
    DOHC_IMAGE: image,
    DOHC_SERVER_NETWORK_ACCESS: mode,
    DOHC_SERVER_NAME: name,
    ...Object.fromEntries(
      [
        "POSTGRES_PASSWORD",
        "BETTER_AUTH_SECRET",
        "DOHC_RELAY_LINK_KEY",
        "DOHC_RELAY_EXCHANGE_KEY",
        "DOHC_SHARE_WEB_SESSION_SEAL_KEY",
        "DOHC_SNAPSHOT_KEY",
      ].map((key) => [key, randomBytes(32).toString("base64url")]),
    ),
  };
}

export function privateRouteInstructions(settings) {
  const url = new URL(settings.DOHC_PUBLIC_ORIGIN),
    port = url.port || "443";
  const backend = `http://127.0.0.1:${settings.DOHC_PRIVATE_PORT || "1791"}`;
  return [
    "On the deployment host, run: tailscale serve status --json",
    `Confirm HTTPS port ${port} has no existing route. Preserve other applications' routes.`,
    `Confirm tailscale status --json reports the hostname ${url.hostname}.`,
    `Then add this private route: tailscale serve --bg --https=${port} ${backend}`,
    `To remove it, first confirm this port still points to ${backend}.`,
    `Then run: tailscale serve --https=${port} off`,
    "Do not enable Funnel. Each recipient must belong to the tailnet and have network access.",
  ];
}

export function updateImageSetting(original, image) {
  const before = parseEnv(original);
  const assignment = /^[ \t]*(?:export[ \t]+)?DOHC_IMAGE[ \t]*=.*$/gm;
  if (!assignment.test(original)) throw new Error("Add a DOHC_IMAGE assignment before upgrading.");
  if (/[\r\n]/.test(before.DOHC_IMAGE ?? ""))
    throw new Error("Use a single-line DOHC_IMAGE assignment before upgrading.");
  const updated = original.replace(assignment, () => `DOHC_IMAGE='${image}'`);
  const after = parseEnv(updated);
  if (
    after.DOHC_IMAGE !== image ||
    Object.keys(before).length !== Object.keys(after).length ||
    Object.entries(before).some(([key, value]) => key !== "DOHC_IMAGE" && after[key] !== value)
  ) {
    throw new Error(
      "Use a single-line DOHC_IMAGE assignment outside quoted multiline values before upgrading.",
    );
  }
  return updated;
}

/** Adds the key that seals link sessions to a configuration made before that key existed. */
export function addSessionSealKey(original, key = randomBytes(32).toString("base64url")) {
  const before = parseEnv(original);
  if (before.DOHC_SHARE_WEB_SESSION_SEAL_KEY) return original;
  // An empty assignment would be read after the new one, so it is replaced where it stands.
  const empty = /^[ \t]*(?:export[ \t]+)?DOHC_SHARE_WEB_SESSION_SEAL_KEY[ \t]*=.*$/m;
  const updated = empty.test(original)
    ? original.replace(empty, () => `DOHC_SHARE_WEB_SESSION_SEAL_KEY='${key}'`)
    : `${original}${original.endsWith("\n") ? "" : "\n"}DOHC_SHARE_WEB_SESSION_SEAL_KEY='${key}'\n`;
  // A line inside a quoted multiline value can look like an assignment. Every other value must read as before.
  if (!isDeepStrictEqual(parseEnv(updated), { ...before, DOHC_SHARE_WEB_SESSION_SEAL_KEY: key }))
    throw new Error(
      "Add DOHC_SHARE_WEB_SESSION_SEAL_KEY to the configuration by hand, outside quoted multiline values.",
    );
  return updated;
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      origin: { type: "string" },
      mode: { type: "string" },
      name: { type: "string" },
      image: { type: "string" },
      "env-path": { type: "string", default: ".env.self-host" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !positionals.length) {
    console.log(
      "init --origin https://HOST [--mode public|private] [--name NAME] [--image IMAGE] [--env-path PATH]\nnetwork | start | stop [--env-path PATH]\nupgrade --image IMAGE [--env-path PATH]\nInitialization never replaces an existing file or network route. Stop preserves every data volume.",
    );
    return;
  }
  if (positionals[0] === "network") {
    const settings = readSettings(values["env-path"]);
    console.log(
      settings.DOHC_SERVER_NETWORK_ACCESS === "private"
        ? privateRouteInstructions(settings).join("\n")
        : settings.DOHC_BEHIND_CLOUDFLARE === "1"
          ? `Point Cloudflare DNS for ${settings.DOHC_PUBLIC_HOST} only to this host's IPv4 (A) record. Do not configure an origin AAAA record. Restrict inbound origin connections to Cloudflare's ranges using the provider's network firewall or Docker's DOCKER-USER chain. See docs/how-to/self-host.md for certificate setup requirements.`
          : `Point DNS for ${settings.DOHC_PUBLIC_HOST} to this host. Permit inbound TCP 80 and 443. Caddy obtains TLS certificates at startup.`,
    );
    return;
  }
  if (["start", "stop", "upgrade"].includes(positionals[0])) {
    const action = positionals[0],
      envFile = values["env-path"],
      settings = readSettings(envFile);
    if (action === "upgrade") {
      if (!values.image || !/^[a-zA-Z0-9][a-zA-Z0-9./_:@-]+$/.test(values.image))
        throw new Error("Use upgrade --image RELEASE_IMAGE.");
      const errors = validateSettings({ ...settings, DOHC_IMAGE: values.image });
      if (errors.length) throw new Error(errors.join("\n"));
      gatewayConfigHash({ ...settings, DOHC_IMAGE: values.image });
      const inspected = spawnSync("docker", ["image", "inspect", values.image], {
        stdio: "ignore",
      });
      if (inspected.error || inspected.status !== 0)
        throw new Error(
          `Docker has no image ${values.image}. Pull or load the release image before upgrading.`,
        );
      const original = readFileSync(envFile, "utf8");
      const updated = addSessionSealKey(updateImageSetting(original, values.image));
      const previous = `${envFile}.previous-${Date.now()}`;
      writeFileSync(previous, original, { flag: "wx", mode: 0o600 });
      console.log(
        `Previous configuration saved to ${previous}. Keep it private with your deployment secrets.`,
      );
      console.log(
        "Upgrade can apply database migrations. This configuration copy is not a data rollback.",
      );
      writeFileSync(envFile, updated, { mode: 0o600 });
    }
    const result =
      action === "stop"
        ? spawnSync("docker", composeArgs(envFile, settings, "stop"), { stdio: "inherit" })
        : spawnSync(
            process.execPath,
            ["scripts/check-self-host.mjs", "--start", "--env-path", envFile],
            { stdio: "inherit" },
          );
    if (result.error || result.status !== 0)
      throw new Error(
        action === "upgrade"
          ? "Upgrade did not become ready. Preserve the current data and inspect logs; no rollback was attempted."
          : `${action} failed. Inspect the reported service error.`,
      );
    return;
  }
  if (positionals[0] !== "init" || !values.origin)
    throw new Error("Use init --origin https://HOST.");
  const settings = initialSettings(values);
  let content = readFileSync(new URL("../../.env.self-host.example", import.meta.url), "utf8");
  for (const [key, value] of Object.entries(settings))
    content = content.replace(new RegExp(`^${key}=.*$`, "m"), () => `${key}='${value}'`);
  writeFileSync(values["env-path"], content, { flag: "wx", mode: 0o600 });
  console.log(
    `Created ${values["env-path"]}. Restrict access to this file and preserve its secrets during upgrades.`,
  );
  console.log(
    "Copy DOHC_SNAPSHOT_KEY to a password manager or other store away from this host. Lost keys make relay snapshots unreadable.",
  );
  console.log(
    "Set the SMTP values before starting the server. No network or containers were changed.",
  );
  console.log(`Connection URL: ${values.origin}`);
  if (settings.DOHC_SERVER_NETWORK_ACCESS === "private")
    console.log(privateRouteInstructions(settings).join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
