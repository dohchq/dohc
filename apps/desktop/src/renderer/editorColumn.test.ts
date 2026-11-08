// @vitest-environment jsdom
import { beforeAll, expect, it } from "vitest";
import css from "./styles.css?raw";

// The whole stylesheet, so each check reads what the cascade gives in the app.
beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
});

// A task list as the editor draws it, with an optional list inside its item.
const taskList = (nested = "") =>
  `<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>Pack</p>${nested}</div></li></ul>`;

// The label hangs one 15px checkbox and its 8px gap left of the item's text.
it("starts a top-level task list's checkbox on the text column, and steps each nested list 24px in", () => {
  document.body.innerHTML = `<div class="dohc-notion-editor"><p>Body</p>${taskList(taskList())}</div>`;
  const lists = [...document.querySelectorAll("ul")].map((list) => getComputedStyle(list).paddingLeft);
  const labels = [...document.querySelectorAll("label")].map((label) => getComputedStyle(label).marginLeft);
  expect(lists).toEqual(["23px", "24px"]);
  expect(labels).toEqual(["-23px", "-23px"]);
});

// The table's frame sits on the text column, so its outer cells keep the
// padding every other cell has.
it("gives a table's outer cells the same padding as its inner ones", () => {
  document.body.innerHTML =
    '<div class="dohc-notion-editor"><div class="tableWrapper"><table><tbody><tr><td><p>Ada</p></td><td><p>Lisbon</p></td><td><p>Tram</p></td></tr></tbody></table></div></div>';
  const padding = [...document.querySelectorAll("td")].map((cell) => {
    const style = getComputedStyle(cell);
    return [style.paddingLeft, style.paddingRight];
  });
  expect(padding).toEqual([["10px", "10px"], ["10px", "10px"], ["10px", "10px"]]);
});
