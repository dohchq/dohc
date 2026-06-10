export interface ConflictInput {
  path: string;
  localDescription: string;
  remoteDescription: string;
}

// Conflicts read like a sentence, never like Git markers.
export function describeConflict(input: ConflictInput): string {
  return (
    `Both sides changed ${input.path}: ${input.localDescription}, ` +
    `while ${input.remoteDescription}. Both versions are kept until you choose.`
  );
}
