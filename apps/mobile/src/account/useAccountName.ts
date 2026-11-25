import { useEffect, useState } from "react";
import type { SignIn } from "../server/account";

/** The sign-in's account name as the server has it: undefined until it's read, null when the account has none. */
export function useAccountName(signIn: SignIn): string | null | undefined {
  const [read, setRead] = useState<{ readonly signIn: SignIn; readonly name: string | null }>();
  useEffect(() => {
    let live = true;
    signIn.accountName().then(
      (name) => {
        if (live && signIn.isCurrent()) setRead({ signIn, name });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [signIn]);
  return read?.signIn === signIn ? read.name : undefined;
}
