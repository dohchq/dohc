import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isDeepStrictEqual, parseEnv } from "node:util";
import { posix, resolve } from "node:path";

export function parseSignUpEmails(value) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export function supportedComposeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 24 || (minor === 24 && patch >= 4)));
}

// How long `up --wait` waits: the relay's start_period in docker-compose.self-host.yml, then 180 s for its failing
// checks and the services that wait for it.
export const startupWaitSeconds = 480;

export function readSettings(path = ".env.self-host") {
  return parseEnv(readFileSync(path, "utf8"));
}

export function validateSettings(settings) {
  const errors = [];
  for (const name of [
    "DOHC_RELAY_APP_PUBLICATIONS",
    "DOHC_RELAY_AUTOMATIONS",
    "DOHC_BEHIND_CLOUDFLARE",
  ]) {
    if (settings[name] !== undefined && !["0", "1"].includes(settings[name]))
      errors.push(`Set ${name} to 0 or 1.`);
  }
  const participants = settings.DOHC_RELAY_APP_BACKEND_MAX_PARTICIPANTS_PER_GRANT;
  if (
    participants !== undefined &&
    (!/^[1-9]\d*$/.test(participants) || !Number.isSafeInteger(Number(participants)))
  ) {
    errors.push(
      "Set DOHC_RELAY_APP_BACKEND_MAX_PARTICIPANTS_PER_GRANT to a positive safe integer.",
    );
  }
  for (const name of [
    "DOHC_IMAGE",
    "POSTGRES_PASSWORD",
    "BETTER_AUTH_SECRET",
    "DOHC_RELAY_LINK_KEY",
    "DOHC_RELAY_EXCHANGE_KEY",
    "DOHC_SMTP_HOST",
    "DOHC_SMTP_FROM",
  ]) {
    if (!settings[name] || /change-me|example\.(com|net|org)/i.test(settings[name]))
      errors.push(`Set ${name}.`);
  }
  // The bootstrap generates the bundled database's password. An external database keeps its provider's password.
  for (const name of [
    ...(settings.DOHC_POSTGRES_HOST ? [] : ["POSTGRES_PASSWORD"]),
    "BETTER_AUTH_SECRET",
    "DOHC_RELAY_LINK_KEY",
    "DOHC_RELAY_EXCHANGE_KEY",
  ]) {
    if ((settings[name]?.length ?? 0) < 32)
      errors.push(`${name} must contain at least 32 characters.`);
  }
  // The upgrade adds this key to a configuration made before it existed. Without it, a share-web restart ends
  // every open share page.
  const sealKey = settings.DOHC_SHARE_WEB_SESSION_SEAL_KEY;
  if (sealKey && (sealKey.length < 32 || /change-me/i.test(sealKey)))
    errors.push(
      "Set DOHC_SHARE_WEB_SESSION_SEAL_KEY to the key that bootstrap generated, or to 32 or more random characters.",
    );
  // What a browser holds is made from this key, so it is no other secret of the deployment.
  for (const name of [
    "DOHC_RELAY_EXCHANGE_KEY",
    "DOHC_RELAY_LINK_KEY",
    "DOHC_SNAPSHOT_KEY",
    "BETTER_AUTH_SECRET",
    "POSTGRES_PASSWORD",
  ])
    if (sealKey && sealKey === settings[name])
      errors.push(`DOHC_SHARE_WEB_SESSION_SEAL_KEY must differ from ${name}.`);
  if (settings.DOHC_POSTGRES_HOST) {
    if (
      !/^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(
        settings.DOHC_POSTGRES_HOST,
      ) ||
      /(^|\.)example\.(com|net|org)$/i.test(settings.DOHC_POSTGRES_HOST)
    ) {
      errors.push(
        "Set DOHC_POSTGRES_HOST to your database host name or IPv4 address, or leave it empty to use the bundled database.",
      );
    }
    if (
      !/^[1-9]\d*$/.test(settings.DOHC_POSTGRES_PORT ?? "") ||
      Number(settings.DOHC_POSTGRES_PORT) < 1 ||
      Number(settings.DOHC_POSTGRES_PORT) > 65535
    ) {
      errors.push("Set DOHC_POSTGRES_PORT to your database port.");
    }
    if (!/^(\/(?!\.\.?(\/|$))[a-zA-Z0-9._-]+)+$/.test(settings.DOHC_POSTGRES_CA_FILE ?? "")) {
      errors.push(
        "Set DOHC_POSTGRES_CA_FILE to the absolute path of your database provider's CA certificate.",
      );
    }
  } else if (settings.DOHC_POSTGRES_PORT || settings.DOHC_POSTGRES_CA_FILE) {
    errors.push(
      "Set DOHC_POSTGRES_HOST to use an external database, or leave DOHC_POSTGRES_PORT and DOHC_POSTGRES_CA_FILE empty.",
    );
  }
  // Services connect through a URL. A dot segment or reserved character would come back as another database name.
  for (const name of ["POSTGRES_DB", "POSTGRES_USER"]) {
    if (!settings[name]) {
      if (settings.DOHC_POSTGRES_HOST) errors.push(`Set ${name} for the external database.`);
    } else if (!/^(?=.*[^.])[a-zA-Z0-9_.-]+$/.test(settings[name])) {
      errors.push(
        `Use only letters, digits, underscores, hyphens and dots in ${name}, with at least one character that is not a dot.`,
      );
    }
  }
  try {
    const origin = new URL(settings.DOHC_PUBLIC_ORIGIN);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== settings.DOHC_PUBLIC_ORIGIN ||
      origin.username ||
      origin.password ||
      origin.host !== settings.DOHC_PUBLIC_HOST ||
      /(^|\.)example\.(com|net|org)$/.test(origin.hostname)
    )
      throw new Error();
  } catch {
    errors.push(
      "Set DOHC_PUBLIC_ORIGIN to your HTTPS origin and DOHC_PUBLIC_HOST to its exact host.",
    );
  }
  if (!["public", "private"].includes(settings.DOHC_SERVER_NETWORK_ACCESS))
    errors.push("Set DOHC_SERVER_NETWORK_ACCESS to public or private.");
  if (settings.DOHC_BEHIND_CLOUDFLARE === "1" && settings.DOHC_SERVER_NETWORK_ACCESS !== "public") {
    errors.push(
      "Cloudflare requires public mode. Set DOHC_SERVER_NETWORK_ACCESS to public or DOHC_BEHIND_CLOUDFLARE to 0.",
    );
  }
  const appCertificate = ["DOHC_APP_TLS_CERT_FILE", "DOHC_APP_TLS_KEY_FILE"];
  if (cloudflareApps(settings)) {
    // Caddy substitutes the domain into its configuration, so it must be a plain host name.
    const domain = settings.DOHC_SHARE_WEB_APP_DOMAIN,
      host = settings.DOHC_PUBLIC_HOST ?? "";
    if (
      !/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)
    ) {
      errors.push(
        "Set DOHC_SHARE_WEB_APP_DOMAIN to a lowercase domain name without a scheme, port, or wildcard.",
      );
    } else if (host === domain || host.endsWith(`.${domain}`))
      errors.push("Keep DOHC_PUBLIC_HOST outside DOHC_SHARE_WEB_APP_DOMAIN.");
    for (const name of appCertificate) {
      if (!/^(\/(?!\.\.?(\/|$))[a-zA-Z0-9._-]+)+$/.test(settings[name] ?? ""))
        errors.push(
          `Set ${name} to the absolute path of the app domain's origin certificate file.`,
        );
    }
  } else if (appCertificate.some((name) => settings[name])) {
    errors.push(
      "The app certificate is used only behind Cloudflare with an app domain. Set DOHC_BEHIND_CLOUDFLARE=1 and DOHC_SHARE_WEB_APP_DOMAIN, " +
        "or leave DOHC_APP_TLS_CERT_FILE and DOHC_APP_TLS_KEY_FILE empty.",
    );
  }
  if (
    settings.DOHC_SERVER_NETWORK_ACCESS === "public" &&
    /:\d+$/.test(settings.DOHC_PUBLIC_HOST ?? "")
  )
    errors.push("Public mode uses HTTPS port 443. Remove the custom port from the origin.");
  if (
    settings.DOHC_SERVER_NETWORK_ACCESS === "private" &&
    !/^https:\/\/[^/]+\.ts\.net(?::[0-9]+)?$/.test(settings.DOHC_PUBLIC_ORIGIN ?? "")
  ) {
    errors.push("Private mode requires your Tailscale HTTPS hostname ending in .ts.net.");
  }
  // Only snapshots use the key, so a deployment without them may leave it empty.
  if (settings.DOHC_SNAPSHOT_KEY && !/^[A-Za-z0-9_-]{43}$/.test(settings.DOHC_SNAPSHOT_KEY))
    errors.push("Set DOHC_SNAPSHOT_KEY to the key that bootstrap generated.");
  const storage = [
    "DOHC_SNAPSHOT_S3_ENDPOINT",
    "DOHC_SNAPSHOT_S3_BUCKET",
    "DOHC_SNAPSHOT_S3_ACCESS_KEY_ID",
    "DOHC_SNAPSHOT_S3_SECRET_ACCESS_KEY",
  ];
  if (storage.some((name) => settings[name])) {
    if (!settings.DOHC_SNAPSHOT_KEY)
      errors.push(
        "Set DOHC_SNAPSHOT_KEY to the key that bootstrap generated, or clear every DOHC_SNAPSHOT_S3_ value to turn off snapshot upload.",
      );
    for (const name of storage)
      if (!settings[name])
        errors.push(
          `Set ${name}, or clear every DOHC_SNAPSHOT_S3_ value to turn off snapshot upload.`,
        );
    if (!/^https:\/\/[^/]+$/.test(settings.DOHC_SNAPSHOT_S3_ENDPOINT ?? ""))
      errors.push("Set DOHC_SNAPSHOT_S3_ENDPOINT to the storage service's HTTPS origin.");
    if (!/^[^\s@,]+@[^\s@,]+$/.test(settings.DOHC_SNAPSHOT_ALERT_EMAIL ?? ""))
      errors.push("Set DOHC_SNAPSHOT_ALERT_EMAIL to the operator address for snapshot failures.");
  }
  if (
    settings.DOHC_SNAPSHOT_HEARTBEAT_URL &&
    !settings.DOHC_SNAPSHOT_HEARTBEAT_URL.startsWith("https://")
  )
    errors.push("Set DOHC_SNAPSHOT_HEARTBEAT_URL to an HTTPS URL or leave it empty.");
  if (Boolean(settings.DOHC_SMTP_USER) !== Boolean(settings.DOHC_SMTP_PASSWORD))
    errors.push("Set both DOHC_SMTP_USER and DOHC_SMTP_PASSWORD.");
  if (!["true", "false"].includes(settings.DOHC_SMTP_SECURE))
    errors.push("Set DOHC_SMTP_SECURE to true or false.");
  if (
    !/^\d+$/.test(settings.DOHC_SMTP_PORT ?? "") ||
    Number(settings.DOHC_SMTP_PORT) < 1 ||
    Number(settings.DOHC_SMTP_PORT) > 65535
  )
    errors.push("Set DOHC_SMTP_PORT to a valid port.");
  if (apnsAlerts(settings)) {
    for (const name of apnsSettings)
      if (!settings[name])
        errors.push(
          `Set ${name}, or clear every DOHC_RELAY_APNS_ value to turn off iPhone alerts.`,
        );
    const topic = settings.DOHC_RELAY_APNS_TOPIC;
    if (topic && (topic.length > 255 || !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(topic)))
      errors.push("Set DOHC_RELAY_APNS_TOPIC to the phone app's bundle ID, app.dohc.mobile.");
    const environments = settings.DOHC_RELAY_APNS_ENVIRONMENTS?.split(",").map((name) =>
      name.trim(),
    );
    if (
      environments &&
      settings.DOHC_RELAY_APNS_ENVIRONMENTS &&
      (!environments.every((name) => ["production", "sandbox"].includes(name)) ||
        new Set(environments).size !== environments.length)
    )
      errors.push(
        "Set DOHC_RELAY_APNS_ENVIRONMENTS to production, or to production,sandbox to also alert development builds.",
      );
    for (const name of ["DOHC_RELAY_APNS_KEY_ID", "DOHC_RELAY_APNS_TEAM_ID"])
      if (settings[name] && !/^[A-Z0-9]{10}$/.test(settings[name]))
        errors.push(`Set ${name} to the 10-character ID from your Apple Developer account.`);
    const key = settings.DOHC_RELAY_APNS_KEY_FILE;
    if (key && (!/^(\/(?!\.\.?(\/|$))[a-zA-Z0-9._-]+)+$/.test(key) || !isFile(key)))
      errors.push(
        "Set DOHC_RELAY_APNS_KEY_FILE to the absolute path of the APNs auth key (.p8) on this server.",
      );
    if (
      key &&
      settings.DOHC_DATA_DIRECTORY &&
      inside(realPath(key), realPath(settings.DOHC_DATA_DIRECTORY))
    )
      errors.push(
        "Keep DOHC_RELAY_APNS_KEY_FILE outside DOHC_DATA_DIRECTORY. A deployment archive copies the deployment's folders.",
      );
  }
  if (
    settings.DOHC_DATA_DIRECTORY &&
    !/^(\/(?!\.\.?(\/|$))[a-zA-Z0-9._-]+)+$/.test(settings.DOHC_DATA_DIRECTORY)
  ) {
    errors.push(
      "Set DOHC_DATA_DIRECTORY to an absolute folder on the data disk, or leave it empty.",
    );
  }
  const invalidSignUpEmail = parseSignUpEmails(settings.DOHC_SIGN_UP_EMAILS).find(
    (email) => !/^[^\s@]+@[^\s@]+$/.test(email),
  );
  if (invalidSignUpEmail !== undefined) {
    errors.push(
      `DOHC_SIGN_UP_EMAILS must list email addresses separated by commas, got "${invalidSignUpEmail}".`,
    );
  }
  return errors;
}

export const realPath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const apnsSettings = [
  "DOHC_RELAY_APNS_TOPIC",
  "DOHC_RELAY_APNS_ENVIRONMENTS",
  "DOHC_RELAY_APNS_KEY_FILE",
  "DOHC_RELAY_APNS_KEY_ID",
  "DOHC_RELAY_APNS_TEAM_ID",
];
/** iPhone alerts need every APNs setting. With none of them set, the server sends no alerts. */
const apnsAlerts = (settings) => apnsSettings.some((name) => settings[name]);
/** Where the relay reads the APNs auth key. A deployment archive leaves the file bound here out. */
export const apnsKeyTarget = "/etc/dohc/apns-key.p8";

/** Refuses invalid settings, so a command stops before any Docker or database operation uses them. */
export function readValidSettings(path, settings = readSettings(path)) {
  const errors = validateSettings(settings);
  if (errors.length) throw new Error(errors.join("\n"));
  return settings;
}

/** Behind Cloudflare, an app domain adds the gateway's app route. Without Cloudflare, the operator supplies that route. */
export const cloudflareApps = (settings) =>
  settings.DOHC_BEHIND_CLOUDFLARE === "1" && Boolean(settings.DOHC_SHARE_WEB_APP_DOMAIN);

export function gatewayConfigFiles(settings, cwd = process.cwd()) {
  const local = (path) => resolve(cwd, path);
  if (settings.DOHC_SERVER_NETWORK_ACCESS === "private")
    return [local("tools/self-host/Caddyfile.private")];
  if (cloudflareApps(settings)) {
    return [
      local("tools/self-host/Caddyfile.cloudflare-apps"),
      local("tools/self-host/Caddyfile.cloudflare"),
      local("tools/self-host/cloudflare-proxies.caddy"),
      settings.DOHC_APP_TLS_CERT_FILE,
      settings.DOHC_APP_TLS_KEY_FILE,
    ].filter(Boolean);
  }
  if (settings.DOHC_BEHIND_CLOUDFLARE === "1") {
    return [
      local("tools/self-host/Caddyfile.cloudflare"),
      local("tools/self-host/cloudflare-proxies.caddy"),
    ];
  }
  return [local("tools/self-host/Caddyfile")];
}

export function gatewayConfigHash(settings, cwd = process.cwd()) {
  const hash = createHash("sha256");
  for (const file of gatewayConfigFiles(settings, cwd)) {
    hash.update(file);
    hash.update("\0");
    try {
      const bytes = readFileSync(file);
      hash.update(String(bytes.length));
      hash.update("\0");
      hash.update(bytes);
    } catch {
      hash.update("missing");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function composeEnv(settings, cwd = process.cwd(), base = process.env) {
  return { ...base, DOHC_GATEWAY_CONFIG_HASH: gatewayConfigHash(settings, cwd) };
}

export function composeArgs(envFile, settings, ...args) {
  return [
    "compose",
    "--env-file",
    resolve(envFile),
    "-f",
    "docker-compose.self-host.yml",
    ...(settings.DOHC_SERVER_NETWORK_ACCESS === "private"
      ? ["-f", "tools/self-host/compose.private.yml"]
      : []),
    ...(settings.DOHC_DATA_DIRECTORY ? ["-f", "tools/self-host/compose.data-disk.yml"] : []),
    ...(settings.DOHC_POSTGRES_HOST ? ["-f", "tools/self-host/compose.external-postgres.yml"] : []),
    ...(apnsAlerts(settings) ? ["-f", "tools/self-host/compose.apns.yml"] : []),
    ...(settings.DOHC_BEHIND_CLOUDFLARE === "1"
      ? ["-f", "tools/self-host/compose.cloudflare.yml"]
      : []),
    ...(cloudflareApps(settings) ? ["-f", "tools/self-host/compose.cloudflare-apps.yml"] : []),
    // Hourly snapshots run only when off-site storage is configured.
    ...(settings.DOHC_SNAPSHOT_S3_BUCKET ? ["--profile", "snapshots"] : []),
    ...args,
  ];
}

// Reads through relay-initialize's volumes, so it checks the folders Docker mounts. It prints whether the deployment's
// record and database exist and which disk folders hold data. Any other result means the check failed.
const diskFolders = {
  "/data": "sync-relay",
  "/continuity": "continuity",
  "/host-data": "host-data",
  "/snapshots": "snapshots",
};
export const relayDeploymentCheck =
  "const fs=require('node:fs');const exists=path=>fs.statSync(path,{throwIfNoEntry:false})!==undefined;" +
  "const missing=['/continuity/deployment.json','/data/sync-relay.sqlite'].filter(path=>!exists(path));" +
  "if(missing.length)console.error('Missing '+missing.join(', '));" +
  `const holding=Object.entries(${JSON.stringify(diskFolders)}).filter(([path])=>fs.readdirSync(path).length).map(([,folder])=>folder);` +
  "console.log(JSON.stringify({deployment:!missing.length,holding}));";

/** `docker(args)` returns `{status, stdout, stderr}`. */
export function composeConfig(envFile, settings, docker) {
  const result = docker(composeArgs(envFile, settings, "config", "--format", "json"));
  // Compose config contains secrets. Never include its output in errors.
  if (result.status !== 0)
    throw new Error("Docker Compose could not read the deployment configuration.");
  return JSON.parse(result.stdout);
}

/** Returns undefined only when Docker reports that the volume does not exist. */
export function inspectVolume(name, docker) {
  const result = docker(["volume", "inspect", name]);
  if (result.status === 0) return JSON.parse(result.stdout)[0];
  if (/no such volume/i.test(result.stderr ?? "")) return undefined;
  throw new Error(
    `Docker could not inspect volume ${name}. Check that Docker is running, then try again.`,
  );
}

/** Docker fixes a volume's storage when it creates it, and Compose reuses an existing volume unchanged. */
export function dataDiskVolumeErrors(config, docker) {
  return Object.values(config.volumes ?? {})
    .filter((volume) => volume.driver_opts)
    .flatMap((volume) => {
      const actual = inspectVolume(volume.name, docker);
      if (
        !actual ||
        (actual.Driver === (volume.driver ?? "local") &&
          isDeepStrictEqual(actual.Options ?? {}, volume.driver_opts))
      )
        return [];
      return [
        `Docker volume ${volume.name} keeps its data in ${actual.Options?.device ?? "Docker storage"}, not ${volume.driver_opts.device}. ` +
          "Restore the previous DOHC_DATA_DIRECTORY. Never remove the volume: it holds deployment data.",
      ];
    });
}

/**
 * A first start needs empty relay storage: with a data disk, all four disk folders. Every later start needs the relay deployment.
 * An empty host-data starts: documents rebuild from the relay, but claims in progress are lost (#2016). Snapshot state is never relay data.
 * Without a data disk, relay-initialize reads the image's empty /host-data and /snapshots, so only the relay's own volumes count.
 */
export function relayDeploymentError(envFile, settings, docker, firstStart) {
  const { status, stdout } = docker(
    composeArgs(
      envFile,
      settings,
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--entrypoint",
      "node",
      "relay-initialize",
      "-e",
      relayDeploymentCheck,
    ),
  );
  const directory = settings.DOHC_DATA_DIRECTORY;
  let result;
  try {
    result = status === 0 ? JSON.parse(stdout.trim().split("\n").at(-1)) : undefined;
  } catch {
    result = undefined;
  }
  if (
    typeof result?.deployment !== "boolean" ||
    !Array.isArray(result.holding) ||
    !result.holding.every((folder) => Object.values(diskFolders).includes(folder))
  ) {
    return directory
      ? `Could not check the data disk in ${directory}. Check that the disk is mounted there and Docker is running, then try again.`
      : "Could not check the relay's Docker volumes. Check that Docker is running, then try again.";
  }
  const relayData = result.holding.some(
    (folder) => folder === "sync-relay" || folder === "continuity",
  );
  if (firstStart) {
    if (!result.holding.length) return "";
    if (!directory)
      return "The relay's Docker volumes already hold relay data. Start without --first-start.";
    const folders = result.holding.map((folder) => `${directory}/${folder}`).join(", ");
    return (
      `${folders} already ${result.holding.length === 1 ? "holds" : "hold"} data. A first start needs empty disk folders. ` +
      (relayData
        ? "Start without --first-start."
        : "Check that DOHC_DATA_DIRECTORY names a new deployment folder.")
    );
  }
  if (!relayData) {
    return directory
      ? `No relay deployment found in ${directory}. Mount the data disk there and try again. ` +
          "Never recreate its folders: setup would create a new deployment."
      : "The relay's Docker volumes hold no relay deployment. Start on the host that holds them. " +
          "Start with --first-start only to create a new relay deployment that holds none of the existing workspaces.";
  }
  if (!result.deployment) {
    return directory
      ? `The relay deployment in ${directory} is missing its record or its database. Keep the disk unchanged and check that it is this deployment's disk.`
      : "The relay deployment in the relay's Docker volumes is missing its record or its database. Keep the volumes unchanged and check that this host ran the deployment.";
  }
  return "";
}

const lostAccounts =
  "Without it, people sign up again as new accounts that cannot open their workspaces.";

/** An external database must hold dohc's schema. The bundled accounts volume is inspected before a container mounts it: mounting a missing volume would create an empty one. */
export function accountsDatabaseError(envFile, settings, config, docker) {
  // Each check prints its result, because Docker exits 1 for some of its own failures too.
  if (settings.DOHC_POSTGRES_HOST) {
    const { status, stdout } = docker(
      composeArgs(
        envFile,
        settings,
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "postgres-migrate",
        "check-accounts",
      ),
    );
    const result = status === 0 ? stdout?.trim() : undefined,
      database = `${settings.POSTGRES_DB} on ${settings.DOHC_POSTGRES_HOST}`;
    if (result === "present") return "";
    if (result === "missing")
      return `Database ${database} holds no dohc accounts. Check DOHC_POSTGRES_HOST and POSTGRES_DB, or restore the database from your provider's backup. ${lostAccounts}`;
    return `Could not check database ${database}. Check that Docker is running and that its host, port, user, password and DOHC_POSTGRES_CA_FILE are correct, then try again.`;
  }
  const accounts = config.volumes.dohc_self_host_postgres.name;
  const missing = `Docker volume ${accounts} holds no accounts database. Restore it from the old host or your backup before you start. ${lostAccounts}`;
  if (!inspectVolume(accounts, docker)) return missing;
  const { status, stdout } = docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--mount",
    `type=volume,source=${accounts},target=/pg,readonly`,
    "--entrypoint",
    "sh",
    config.services.postgres.image,
    "-c",
    "if test -s /pg/PG_VERSION; then echo present; else echo missing; fi",
  ]);
  const result = status === 0 ? stdout?.trim() : undefined;
  if (result === "present") return "";
  if (result === "missing") return missing;
  return `Could not check Docker volume ${accounts} for the accounts database. Check that Docker is running and the image ${config.services.postgres.image} is available, then try again.`;
}

/** Returns `[name, problem]` pairs to check before Compose mounts any volume. An empty problem passes; the first problem ends the checks. */
export function deploymentChecks(envFile, settings, docker, { start, firstStart }) {
  const checks = [];
  let config;
  if (settings.DOHC_DATA_DIRECTORY) {
    let problems;
    try {
      config = composeConfig(envFile, settings, docker);
      problems = dataDiskVolumeErrors(config, docker);
    } catch (error) {
      problems = [error.message];
    }
    checks.push(["data disk volumes", problems.join(" ")]);
    if (problems.length) return checks;
  }
  // With an external database, a first start creates accounts that would not own an existing relay deployment's workspaces,
  // and a later start on empty relay volumes would create a new relay deployment under the existing accounts.
  if (start && (settings.DOHC_DATA_DIRECTORY || settings.DOHC_POSTGRES_HOST)) {
    const problem = relayDeploymentError(envFile, settings, docker, firstStart);
    checks.push([
      settings.DOHC_DATA_DIRECTORY ? "relay deployment on the data disk" : "relay deployment",
      problem,
    ]);
    if (problem) return checks;
  }
  // Every start after the first needs the accounts that own the deployment's workspaces.
  if (start && !firstStart && (settings.DOHC_DATA_DIRECTORY || settings.DOHC_POSTGRES_HOST)) {
    let problem;
    try {
      problem = accountsDatabaseError(envFile, settings, config, docker);
    } catch (error) {
      problem = error.message;
    }
    checks.push(["accounts database", problem]);
  }
  return checks;
}

const normalizeDirectory = (path) =>
  path ? posix.normalize(path).replace(/(.)\/+$/, "$1") : undefined;
const bindDirectory = (options) =>
  options?.o?.split(",").some((option) => option === "bind" || option === "rbind")
    ? normalizeDirectory(options.device)
    : undefined;
const inside = (path, folder) =>
  path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
const overlapping = (a, b) => inside(a, b) || inside(b, a);

// A bound volume that Docker has not created yet still names its folder.
const storageFolders = (config, volumes) =>
  [
    ...volumes.flatMap((volume) => [
      bindDirectory(volume.Options),
      normalizeDirectory(volume.Mountpoint),
    ]),
    ...Object.values(config.volumes ?? {}).map((volume) => bindDirectory(volume.driver_opts)),
  ].filter(Boolean);

/** Returns each APNs auth key file inside the deployment's storage, where an archive would copy it. */
export function apnsKeysInStorage(config, volumes) {
  const storage = storageFolders(config, volumes).map(realPath);
  return Object.values(config.services ?? {})
    .flatMap((service) => service.volumes ?? [])
    .filter((volume) => volume.type === "bind" && volume.target === apnsKeyTarget)
    .map((volume) => volume.source)
    .filter((source) =>
      storage.some((folder) => inside(realPath(normalizeDirectory(source)), folder)),
    );
}

/**
 * Returns a function that lists each running container's writable mount that reaches the deployment's storage.
 * `volumes` are the deployment's existing volumes as Docker inspects them. `run(args)` returns Docker's output and throws when Docker fails.
 */
export function storageWriters(config, volumes, run) {
  const volumeNames = new Set(Object.values(config.volumes ?? {}).map((volume) => volume.name));
  // A writable mount of a deployment folder, or of a folder inside or above it, can change deployment data.
  const storage = storageFolders(config, volumes);
  return () => {
    const ids = run(["ps", "--quiet"]).trim().split(/\r?\n/).filter(Boolean);
    if (!ids.length) return [];
    const writable = JSON.parse(run(["inspect", ...ids])).flatMap((container) =>
      (container.Mounts ?? []).filter((mount) => mount.RW).map((mount) => ({ container, mount })),
    );
    const others = [
      ...new Set(
        writable
          .filter(({ mount }) => mount.Type === "volume" && !volumeNames.has(mount.Name))
          .map(({ mount }) => mount.Name),
      ),
    ];
    const devices = new Map(
      others.length
        ? JSON.parse(run(["volume", "inspect", ...others])).map((volume) => [
            volume.Name,
            bindDirectory(volume.Options),
          ])
        : [],
    );
    return writable.filter(
      ({ mount }) =>
        (mount.Type === "volume" && volumeNames.has(mount.Name)) ||
        [normalizeDirectory(mount.Source), devices.get(mount.Name)].some(
          (path) => path && storage.some((folder) => overlapping(path, folder)),
        ),
    );
  };
}

export const describeWriters = (matches) =>
  [
    ...new Set(
      matches.map(
        ({ container, mount }) =>
          `${container.Name?.replace(/^\//, "") || container.Id} (${mount.Type === "volume" ? mount.Name : mount.Source})`,
      ),
    ),
  ].join(", ");
