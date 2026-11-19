import { createECDH, createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import {
  isApnsEnvironment,
  type ApnsEnvironment,
} from "@dohc/workspace-contracts/push-subscriptions";
import { parsePushVapidPublicKey } from "./pushRoutes";
import { DEFAULT_PUSH_HOSTS } from "./pushEndpoints";

export interface PushConfig {
  publicKey: string;
  privateKey: KeyObject;
  keyId: string;
  subject: string;
  hosts: ReadonlySet<string>;
}

/** Keys are persistent operator configuration. Partial configuration stops the service. */
export function readPushConfig(env: Record<string, string | undefined>): PushConfig | undefined {
  const required = [
    "DOHC_RELAY_PUSH_VAPID_PUBLIC_KEY",
    "DOHC_RELAY_PUSH_VAPID_PRIVATE_KEY",
    "DOHC_RELAY_PUSH_VAPID_SUBJECT",
  ];
  const configured = [...required, "DOHC_RELAY_PUSH_HOSTS"].some((name) => env[name] !== undefined);
  if (!configured) return undefined;
  const missing = required.filter((name) => !env[name]);
  if (missing.length) throw new TypeError(`Missing push configuration: ${missing.join(", ")}.`);
  const publicKey = env.DOHC_RELAY_PUSH_VAPID_PUBLIC_KEY!;
  const privateKey = env.DOHC_RELAY_PUSH_VAPID_PRIVATE_KEY!;
  const subject = env.DOHC_RELAY_PUSH_VAPID_SUBJECT!;
  try {
    const parsed = parsePushVapidPublicKey(publicKey);
    if (!/^[A-Za-z0-9_-]{43}$/u.test(privateKey)) throw Error();
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
    const point = ecdh.getPublicKey();
    if (point.toString("base64url") !== publicKey) throw Error();
    const contact = new URL(subject);
    if (
      (contact.protocol !== "mailto:" && contact.protocol !== "https:") ||
      contact.username ||
      contact.password ||
      contact.hash ||
      /[\p{Cc}\s]/u.test(subject) ||
      subject.length > 512 ||
      (contact.protocol === "mailto:" && !contact.pathname.includes("@"))
    )
      throw Error();
    const hosts = new Set(
      (env.DOHC_RELAY_PUSH_HOSTS ?? [...DEFAULT_PUSH_HOSTS].join(","))
        .split(",")
        .map((host) => host.trim().toLowerCase()),
    );
    if (
      !hosts.size ||
      [...hosts].some(
        (host) =>
          !/^\.?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(host) || isIP(host) !== 0,
      )
    )
      throw Error();
    return {
      ...parsed,
      subject,
      hosts,
      privateKey: createPrivateKey({
        format: "jwk",
        key: {
          kty: "EC",
          crv: "P-256",
          x: point.subarray(1, 33).toString("base64url"),
          y: point.subarray(33).toString("base64url"),
          d: privateKey,
        },
      }),
    };
  } catch {
    throw new TypeError("Invalid push sender configuration.");
  }
}

export interface ApnsConfig {
  topic: string;
  environments: ReadonlySet<ApnsEnvironment>;
  keyId: string;
  teamId: string;
  privateKey: KeyObject;
}

const APNS_NAMES = [
  "DOHC_RELAY_APNS_TOPIC",
  "DOHC_RELAY_APNS_ENVIRONMENTS",
  "DOHC_RELAY_APNS_KEY_FILE",
  "DOHC_RELAY_APNS_KEY_ID",
  "DOHC_RELAY_APNS_TEAM_ID",
];

/**
 * The phone's alert topic, the APNs environments it may register in, and the
 * token-signing key that sends to them. All or none. The `.p8` key is read
 * and parsed once, here; errors name variables, never their values.
 */
export function readApnsConfig(
  env: Record<string, string | undefined>,
  readKeyFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ApnsConfig | undefined {
  if (APNS_NAMES.every((name) => env[name] === undefined)) return undefined;
  const missing = APNS_NAMES.filter((name) => !env[name]);
  if (missing.length) throw new TypeError(`Missing APNs configuration: ${missing.join(", ")}.`);
  const invalid = (...names: string[]) =>
    new TypeError(`Invalid APNs configuration: ${names.join(", ")}.`);
  const topic = env.DOHC_RELAY_APNS_TOPIC!;
  const environments = env.DOHC_RELAY_APNS_ENVIRONMENTS!.split(",").map((name) => name.trim());
  if (
    topic.length > 255 ||
    !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(topic) ||
    !environments.every(isApnsEnvironment) ||
    new Set(environments).size !== environments.length
  )
    throw invalid("DOHC_RELAY_APNS_TOPIC", "DOHC_RELAY_APNS_ENVIRONMENTS");
  const keyId = env.DOHC_RELAY_APNS_KEY_ID!;
  const teamId = env.DOHC_RELAY_APNS_TEAM_ID!;
  if (!/^[A-Z0-9]{10}$/u.test(keyId) || !/^[A-Z0-9]{10}$/u.test(teamId))
    throw invalid("DOHC_RELAY_APNS_KEY_ID", "DOHC_RELAY_APNS_TEAM_ID");
  let privateKey: KeyObject;
  try {
    const pem = readKeyFile(env.DOHC_RELAY_APNS_KEY_FILE!);
    // Apple's `.p8` is a PKCS#8 P-256 key.
    if (!pem.includes("-----BEGIN PRIVATE KEY-----")) throw Error();
    privateKey = createPrivateKey({ key: pem, format: "pem" });
    if (privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw Error();
  } catch {
    throw invalid("DOHC_RELAY_APNS_KEY_FILE");
  }
  return { topic, environments: new Set(environments), keyId, teamId, privateKey };
}
