import { ensureLocalhostTls } from "./device-control/localhostTls.js";

// Workers read NODE_EXTRA_CA_CERTS when they start, so the fixture CA must exist first.
export default async function setup(): Promise<void> {
  process.env.NODE_EXTRA_CA_CERTS = (await ensureLocalhostTls()).certificate;
}
