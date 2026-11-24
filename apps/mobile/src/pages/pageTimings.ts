import type { AccountState, SignIn } from "../server/account";

export interface PageOpen {
  readonly name: string;
  readonly tap: number;
  read?: number;
  started?: number;
  painted?: number;
}

export const timingOwner = (signIn: Pick<SignIn, "origin" | "userId">) =>
  JSON.stringify([signIn.origin, signIn.userId]);

export function createPageTimings(now: () => number = Date.now, keep = 10) {
  const opens: PageOpen[] = [];
  let owner: string | null = null;
  return {
    open(name: string, signIn: string, tap = now()) {
      if (signIn !== owner) opens.length = 0;
      owner = signIn;
      const open: PageOpen = { name, tap };
      opens.unshift(open);
      opens.splice(keep);
      return (step: "read" | "started" | "painted") => void (open[step] ??= now() - open.tap);
    },
    opens: (signIn: string): readonly PageOpen[] => (signIn === owner ? opens : []),
    follow: (account: { state(): AccountState; subscribe(listener: () => void): () => void }) =>
      account.subscribe(() => {
        const state = account.state();
        if (state.status === "signed-in" && timingOwner(state.signIn) === owner) return;
        owner = null;
        opens.length = 0;
      }),
  };
}

export const pageTimings =
  process.env.EXPO_PUBLIC_DOHC_TIMINGS === "1" ? createPageTimings() : null;
