// Counts the person's clicks, key presses and menu commands in this window,
// and each time focus leaves it for another app or an embedded app's frame. A slow action
// compares the count with the one it started at, to tell whether the person
// did something else meanwhile.
let count = 0;
const waiting = new Set<() => void>();
const mark = () => {
  count += 1;
  const listeners = [...waiting];
  waiting.clear();
  for (const listener of listeners) listener();
};
window.addEventListener("pointerdown", mark, true);
window.addEventListener("keydown", mark, true);
window.addEventListener("blur", mark);

export function inputCount(): number {
  return count;
}

// Counts input the window's listeners don't see, such as a menu bar command.
export function countInput(): void {
  mark();
}

// Calls listener once, at the person's next input. Returns a cancel.
export function onNextInput(listener: () => void): () => void {
  waiting.add(listener);
  return () => {
    waiting.delete(listener);
  };
}
