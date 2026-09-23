import { connect } from "./client.ts";
import "./frontend.css";
const api = connect(), root = document.getElementById("root")!;
root.innerHTML = `<main><h1>Stock board</h1><p>A separate app reading the same inventory.</p><button>Refresh stock</button><div class="cards" id="stock"></div><p role="status"></p></main>`;
const button = root.querySelector("button")!, status = root.querySelector<HTMLElement>('[role="status"]')!;
async function refresh() {
  button.disabled = true;
  try {
    const items = await api.invoke("listItems"), cards = root.querySelector("#stock")!; cards.replaceChildren();
    for (const item of items) {
      const article = document.createElement("article"), heading = document.createElement("h2"), count = document.createElement("p");
      heading.textContent = item.name; count.textContent = `${item.remaining} available`;
      article.dataset.itemId = item.id; article.append(heading,count); cards.append(article);
    }
    status.textContent = "Stock updated";
  } catch (error) { status.textContent = (error as Error).message; }
  finally { button.disabled = false; }
}
button.addEventListener("click", () => void refresh()); void refresh();
