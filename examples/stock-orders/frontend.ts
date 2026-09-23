import { connect } from "./client.ts";
import "./frontend.css";
const api = connect(), root = document.getElementById("root")!;
root.innerHTML = `<main><p class="notice">Example store — use synthetic details and a sample receipt. Do not send money.</p><h1>Club stock orders</h1><form><label>Your name<input name="customer" required maxlength="150"></label><div id="items" class="cards"></div><label>Receipt (optional)<input name="receipt" type="file" accept="image/png,image/jpeg,application/pdf"></label><p>Prices and stock are checked together when you order.</p><button disabled>Place order</button></form><p id="status" role="status"></p><button id="discard" type="button" hidden>Discard pending order</button><button id="another" type="button" hidden>Place another order</button></main>`;
const form = root.querySelector("form")!, button = root.querySelector("button")!, status = root.querySelector<HTMLElement>("#status")!;
const discard = root.querySelector<HTMLButtonElement>("#discard")!, another = root.querySelector<HTMLButtonElement>("#another")!;
let ready = false, busy = false, discardConfirmed = false, attempt: { key: string; input: any; token?: string; file?: File; fileId?: string } | null = null;
function freeze() { for (const input of form.querySelectorAll("input")) input.disabled = busy || !!attempt; button.disabled = busy || !ready; discard.disabled = busy; another.disabled = busy; }
async function load() {
  try {
    const items = await api.invoke("listItems");
    const cards = root.querySelector("#items")!; cards.replaceChildren();
    for (const item of items) {
      const label = document.createElement("label"), name = document.createElement("strong"), detail = document.createElement("span"), quantity = document.createElement("input");
      name.textContent = item.name; detail.textContent = `${item.remaining} available · ${(item.priceCents / 100).toFixed(2)} each`;
      quantity.type = "number"; quantity.name = item.id; quantity.min = "0"; quantity.max = "1000"; quantity.value = "0"; quantity.setAttribute("aria-label", `Quantity: ${item.name}`);
      label.append(name, detail, quantity); cards.append(label);
    }
    const saved = (await api.attempt({action:"get"})).attempt;
    if (saved) {
      attempt = {key:saved.idempotencyKey,input:saved.input,token:saved.token};
      form.querySelector<HTMLInputElement>('[name="customer"]')!.value = saved.input.customerName;
      for (const input of form.querySelectorAll<HTMLInputElement>('input[type="number"]')) input.value = String(saved.input.items.find((item: {itemId:string}) => item.itemId === input.name)?.quantity ?? 0);
      status.textContent = "A saved order is ready. Review the details, then retry to check its result."; button.textContent = "Retry same order";
      discard.hidden = false;
    }
    ready = true; freeze();
  } catch (error) { status.textContent = `${(error as Error).message} Reload to check your saved order before ordering.`; }
}
form.addEventListener("submit", async event => {
  event.preventDefault(); if (!ready || busy) return;
  if (!attempt) {
    const quantities = [...form.querySelectorAll<HTMLInputElement>('input[type="number"]')].filter(input => Number(input.value) > 0).map(input => ({itemId:input.name,quantity:Number(input.value)}));
    if (!quantities.length) { status.textContent = "Choose at least one item."; return; }
    const file = form.querySelector<HTMLInputElement>('input[type="file"]')!.files?.[0];
    if (file && (file.size < 1 || file.size > 5*1024*1024)) { status.textContent = "Choose a nonempty receipt up to 5 MB."; return; }
    attempt = {key:crypto.randomUUID(),input:{customerName:form.querySelector<HTMLInputElement>('[name="customer"]')!.value,items:quantities},file};
  }
  busy = true; discardConfirmed = false; discard.textContent = "Discard pending order"; freeze(); status.textContent = "Saving order…";
  try {
    if (!attempt.token) {
      if (attempt.file && !attempt.fileId) attempt.fileId = (await api.upload(attempt.file, `${attempt.key}:file`)).fileId;
      if (attempt.fileId) attempt.input.receiptFileId = attempt.fileId;
      const saved = (await api.attempt({action:"save",idempotencyKey:attempt.key,input:attempt.input})).attempt;
      if (!saved) throw new Error("The order could not be saved for retry.");
      if (saved.idempotencyKey !== attempt.key) { ready = false; throw new Error("Another order was already saved. Reload to review it before retrying."); }
      attempt.token = saved.token;
    }
    const result = await api.invoke("placeOrder",attempt.input,attempt.key);
    status.textContent = `Order saved · ${result.id} · ${(result.totalCents/100).toFixed(2)} · ${result.status}`;
    form.hidden = true;
    another.hidden = false; discard.hidden = true;
  } catch (error) { status.textContent = (error as Error).message; button.textContent = "Retry same order"; discard.hidden = false; }
  finally { busy = false; freeze(); }
});
const identity = (input: any) => JSON.stringify([input.customerName, input.items.map((item: {itemId:string;quantity:number}) => [item.itemId,item.quantity]), input.receiptFileId ?? null]);
async function resetOrder() {
  if (busy || !attempt) return;
  busy = true; freeze();
  try {
    const saved = (await api.attempt({action:"get"})).attempt;
    if (saved) {
      if (saved.idempotencyKey !== attempt.key || identity(saved.input) !== identity(attempt.input) || attempt.token && saved.token !== attempt.token) throw new Error("The saved order changed. Reload to review it before clearing it.");
      const cleared = await api.attempt({action:"clear",token:saved.token});
      if (cleared.attempt !== null) throw new Error("The saved order was not cleared. Try again.");
    }
    attempt = null; ready = false; discardConfirmed = false; discard.textContent = "Discard pending order";
    discard.hidden = true; another.hidden = true; form.hidden = false; form.reset(); button.textContent = "Place order"; status.textContent = "";
    await load();
  } catch (error) { status.textContent = `${(error as Error).message} Your saved order has not been replaced.`; }
  finally { busy = false; freeze(); }
}
discard.addEventListener("click", () => {
  if (busy) return;
  if (!discardConfirmed) {
    discardConfirmed = true; discard.textContent = "Discard this order";
    status.textContent = "Discard this pending order? It may already be saved. Check with the organizer before placing the same order again.";
  } else void resetOrder();
});
another.addEventListener("click", () => void resetOrder());
void load();
