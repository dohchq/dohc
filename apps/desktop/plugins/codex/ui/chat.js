const transcript = document.querySelector("#transcript");
const emptyState = document.querySelector("#empty-state");
const statePill = document.querySelector("#session-state");
const stopButton = document.querySelector("#stop");
const composer = document.querySelector("#composer");
const messageInput = document.querySelector("#message");
const sendButton = document.querySelector("#send");

if (
  !transcript ||
  !emptyState ||
  !statePill ||
  !stopButton ||
  !composer ||
  !messageInput ||
  !sendButton
) {
  throw new Error("The Codex chat page is missing a required control.");
}

const textItems = new Map();
const activityItems = new Map();
const permissions = new Map();

function timestamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function hideEmptyState() {
  emptyState.hidden = true;
}

function scrollToLatest() {
  transcript.scrollTop = transcript.scrollHeight;
}

function messageCard(author, text, className) {
  hideEmptyState();
  const card = document.createElement("article");
  card.className = "message " + className;
  const header = document.createElement("div");
  header.className = "message-header";
  const name = document.createElement("strong");
  name.textContent = author;
  const time = document.createElement("span");
  time.className = "timestamp";
  time.textContent = timestamp();
  const body = document.createElement("p");
  body.className = "message-body";
  body.textContent = text;
  header.append(name, time);
  card.append(header, body);
  transcript.append(card);
  scrollToLatest();
  return body;
}

function setSessionState(state, reason) {
  const labels = {
    starting: "Starting",
    ready: "Ready",
    running: "Running",
    error: "Error",
    closed: reason === "Stopped." ? "Stopped." : "Closed",
  };
  statePill.textContent = labels[state] || state;
  statePill.dataset.state = state;
  stopButton.disabled = state === "closed" || state === "error";
  if (state === "closed" && reason === "Stopped.") {
    recoveryCard("Stopped.");
  }
}

function recoveryCard(message) {
  hideEmptyState();
  const card = document.createElement("section");
  card.className = "error-card";
  const heading = document.createElement("strong");
  heading.textContent = message;
  const next = document.createElement("p");
  next.className = "next-action";
  next.textContent = "Start a new message to begin a new session.";
  card.append(heading, next);
  transcript.append(card);
  scrollToLatest();
}

function renderText(event) {
  const key = event.stream + ":" + event.itemId;
  let body = textItems.get(key);
  if (!body) {
    body = messageCard(
      event.stream === "reasoning" ? "Reasoning" : "Codex",
      "",
      event.stream === "reasoning" ? "agent reasoning" : "agent",
    );
    textItems.set(key, body);
  }
  body.textContent += event.text;
  scrollToLatest();
}

function renderActivity(event) {
  hideEmptyState();
  let card = activityItems.get(event.item.id);
  if (!card) {
    card = document.createElement("section");
    card.className = "activity";
    const header = document.createElement("div");
    header.className = "activity-header";
    const title = document.createElement("strong");
    title.className = "activity-title";
    const id = document.createElement("span");
    id.className = "item-id";
    id.textContent = event.item.id;
    const detail = document.createElement("p");
    detail.className = "activity-detail";
    header.append(title, id);
    card.append(header, detail);
    transcript.append(card);
    activityItems.set(event.item.id, card);
  }
  card.dataset.status = event.item.status;
  card.querySelector(".activity-title").textContent = event.item.title;
  const details = [event.item.detail, ...(event.item.locations || [])].filter(Boolean);
  card.querySelector(".activity-detail").textContent = details.join("\n");
  scrollToLatest();
}

function renderPlan(event) {
  hideEmptyState();
  const card = document.createElement("section");
  card.className = "activity";
  const title = document.createElement("strong");
  title.textContent = "Plan";
  const list = document.createElement("ol");
  list.className = "plan";
  for (const step of event.steps) {
    const item = document.createElement("li");
    item.dataset.status = step.status;
    item.textContent = step.step;
    list.append(item);
  }
  card.append(title, list);
  transcript.append(card);
  scrollToLatest();
}

function resolvePermission(requestId, label) {
  const card = permissions.get(requestId);
  if (!card) return;
  permissions.delete(requestId);
  for (const button of card.querySelectorAll("button")) button.disabled = true;
  const status = document.createElement("span");
  status.className = "timestamp";
  status.textContent = label;
  card.querySelector(".permission-actions").append(status);
}

async function answerPermission(requestId, decision, label) {
  const response = await fetch("/permission/" + encodeURIComponent(requestId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  if (response.ok) resolvePermission(requestId, label);
}

function renderPermission(event) {
  hideEmptyState();
  const card = document.createElement("section");
  card.className = "permission";
  const title = document.createElement("h2");
  title.textContent = event.title;
  card.append(title);
  if (event.detail) {
    const detail = document.createElement("p");
    detail.textContent = event.detail;
    card.append(detail);
  }
  const actions = document.createElement("div");
  actions.className = "permission-actions";
  for (const option of event.options) {
    const button = document.createElement("button");
    button.className = "permission-button";
    button.type = "button";
    button.textContent = option.name;
    button.addEventListener("click", () => {
      void answerPermission(event.requestId, option.kind, option.name);
    });
    actions.append(button);
  }
  const cancel = document.createElement("button");
  cancel.className = "permission-button";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    void answerPermission(event.requestId, "cancel", "Cancelled");
  });
  actions.append(cancel);
  card.append(actions);
  transcript.append(card);
  permissions.set(event.requestId, card);
  scrollToLatest();
}

function renderEvent(event) {
  switch (event.kind) {
    case "session-state":
      setSessionState(event.state, event.reason);
      break;
    case "text-delta":
      renderText(event);
      break;
    case "item":
      renderActivity(event);
      break;
    case "plan":
      renderPlan(event);
      break;
    case "permission-request":
      renderPermission(event);
      break;
    case "permission-resolved":
      resolvePermission(event.requestId, "Resolved");
      break;
    case "token-usage":
      statePill.title = event.max
        ? event.used + " of " + event.max + " tokens used"
        : event.used + " tokens used";
      break;
    case "turn-completed":
      setSessionState("ready");
      if (event.status === "failed" && event.errorMessage) recoveryCard(event.errorMessage);
      break;
    case "auth":
      if (event.detail) messageCard("Codex", event.detail, "agent");
      break;
    case "error":
      if (event.fatal) {
        setSessionState("error");
        recoveryCard(event.message);
      } else {
        messageCard("Codex", event.message, "agent");
      }
      break;
  }
}

function resetTranscript() {
  for (const child of [...transcript.children]) {
    if (child !== emptyState) child.remove();
  }
  emptyState.hidden = false;
  textItems.clear();
  activityItems.clear();
  permissions.clear();
}

const events = new EventSource("/events");
events.addEventListener("open", resetTranscript);
events.addEventListener("message", (message) => {
  renderEvent(JSON.parse(message.data));
});
events.addEventListener("error", () => {
  statePill.textContent = "Reconnecting";
  statePill.dataset.state = "starting";
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  messageCard("You", text, "user");
  messageInput.value = "";
  sendButton.disabled = true;
  statePill.textContent = "Starting";
  statePill.dataset.state = "starting";
  try {
    await fetch("/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } finally {
    sendButton.disabled = false;
    messageInput.focus();
  }
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  await fetch("/stop", { method: "POST" });
});
