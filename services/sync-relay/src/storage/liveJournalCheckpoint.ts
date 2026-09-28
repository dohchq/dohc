// A journal suffix ends in a checkpoint at its 4095th update or once it holds 20 MiB.
// `count` and `bytes` include the update being admitted.
export function liveJournalCheckpointDue(count: number, bytes: number): boolean {
  return count === 4095 || bytes >= 20_971_520;
}
