import * as SecureStore from "expo-secure-store";
import type { SignInStore, StoredSignIn } from "../server/account";

// The phone's sign-in, in the keychain: readable only while the phone is unlocked, and never copied to a backup or
// another device. One item holds the server's origin with the token, so neither is ever saved without the other.
const KEY = "dohc.signIn";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

function parse(value: string): StoredSignIn | null {
  let record: unknown;
  try {
    record = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof record !== "object" || record === null) return null;
  const { origin, token, userId, email } = record as Partial<Record<keyof StoredSignIn, unknown>>;
  return typeof origin === "string" && typeof token === "string" && typeof userId === "string" && typeof email === "string"
    ? { origin, token, userId, email }
    : null;
}

export const secureSignInStore: SignInStore = {
  async load() {
    const value = await SecureStore.getItemAsync(KEY, OPTIONS);
    return value === null ? null : parse(value);
  },
  save: signIn => SecureStore.setItemAsync(KEY, JSON.stringify(signIn), OPTIONS),
  clear: () => SecureStore.deleteItemAsync(KEY, OPTIONS),
};
