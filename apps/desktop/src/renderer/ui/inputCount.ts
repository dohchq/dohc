// Counts the person's clicks and key presses in this window, and each time
// focus leaves it for another app or an embedded app's frame. A slow action
// compares the count with the one it started at, to tell whether the person
// did something else meanwhile.
let count = 0;
const mark = () => {
  count += 1;
};
window.addEventListener("pointerdown", mark, true);
window.addEventListener("keydown", mark, true);
window.addEventListener("blur", mark);

export function inputCount(): number {
  return count;
}
