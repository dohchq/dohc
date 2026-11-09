// Hermes has no Web Crypto. The live provider needs crypto.subtle.digest
// (SHA-256) and crypto.randomUUID, so supply both from expo-crypto.
import * as ExpoCrypto from "expo-crypto";

type Subtle = Pick<SubtleCrypto, "digest">;

export function installWebCrypto(): void {
  const target = (globalThis.crypto ?? {}) as Partial<Crypto> & { subtle?: Subtle };
  if (typeof target.getRandomValues !== "function") {
    target.getRandomValues = ExpoCrypto.getRandomValues as Crypto["getRandomValues"];
  }
  if (typeof target.randomUUID !== "function") {
    target.randomUUID = ExpoCrypto.randomUUID as Crypto["randomUUID"];
  }
  if (typeof target.subtle?.digest !== "function") {
    const digest: Subtle["digest"] = async (algorithm, data) => {
      if (algorithm !== "SHA-256" && (typeof algorithm !== "object" || algorithm.name !== "SHA-256")) {
        throw new Error("Only SHA-256 is available");
      }
      return ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, data as BufferSource);
    };
    target.subtle = { ...target.subtle, digest } as SubtleCrypto;
  }
  if (globalThis.crypto !== target) {
    Object.defineProperty(globalThis, "crypto", { value: target, configurable: true });
  }
}
