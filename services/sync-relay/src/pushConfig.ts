import { createECDH, createPrivateKey, type KeyObject } from "node:crypto";
import { isIP } from "node:net";
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
  const required = ["DOHC_RELAY_PUSH_VAPID_PUBLIC_KEY", "DOHC_RELAY_PUSH_VAPID_PRIVATE_KEY", "DOHC_RELAY_PUSH_VAPID_SUBJECT"];
  const configured = [...required, "DOHC_RELAY_PUSH_HOSTS"].some(name => env[name] !== undefined);
  if (!configured) return undefined;
  const missing = required.filter(name => !env[name]);
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
    if ((contact.protocol !== "mailto:" && contact.protocol !== "https:") || contact.username || contact.password || contact.hash ||
      /[\p{Cc}\s]/u.test(subject) || subject.length > 512 || (contact.protocol === "mailto:" && !contact.pathname.includes("@"))) throw Error();
    const hosts = new Set((env.DOHC_RELAY_PUSH_HOSTS ?? [...DEFAULT_PUSH_HOSTS].join(","))
      .split(",").map(host => host.trim().toLowerCase()));
    if (!hosts.size || [...hosts].some(host => !/^\.?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(host) || isIP(host) !== 0)) throw Error();
    return {...parsed, subject, hosts, privateKey: createPrivateKey({format: "jwk", key: {kty: "EC", crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url"), d: privateKey}})};
  } catch {
    throw new TypeError("Invalid push sender configuration.");
  }
}
