/** A promise whose settlement the test controls. */
export function deferred<T = void>() {
  return Promise.withResolvers<T>();
}

export type Deferred<T = void> = ReturnType<typeof deferred<T>>;
