/** Each expired or refused readiness request backs off before holding another slot. */
export async function rearmDesktopAdmission(options: {
  signal: AbortSignal;
  wait(): Promise<boolean>;
  ready(): void;
}): Promise<void> {
  let delay = 1000;
  while (!options.signal.aborted) {
    let ready = false;
    try { ready = await options.wait(); } catch { /* A refused request also backs off. */ }
    if (options.signal.aborted) return;
    if (ready) { options.ready(); return; }
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); options.signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, delay);
      options.signal.addEventListener("abort", finish, {once: true});
      if (options.signal.aborted) finish();
    });
    delay = Math.min(delay * 2, 30_000);
  }
}
