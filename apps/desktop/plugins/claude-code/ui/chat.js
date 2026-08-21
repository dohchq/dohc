const transcript = document.querySelector("#transcript");
const emptyState = document.querySelector("#empty-state");
const statusRegion = document.querySelector("#status");
const statePill = document.querySelector("#session-state");
const stopButton = document.querySelector("#stop");
const composer = document.querySelector("#composer");
const messageInput = document.querySelector("#message");
const sendButton = document.querySelector("#send");
const tokenMeta = document.querySelector('meta[name="chat-token"]');

if (
  !transcript ||
  !emptyState ||
  !statusRegion ||
  !statePill ||
  !stopButton ||
  !composer ||
  !messageInput ||
  !sendButton ||
  !tokenMeta
) {
  throw new Error("The Claude Code chat page is missing a required control.");
}

// This page's own per-start credential (injected by the server into the
// page it served itself). Every mutating request carries it; a hostile
// cross-origin page has no way to read it back out of this same-origin
// document.
const TOKEN = tokenMeta.content;

const textItems = new Map();
const activityItems = new Map();
const permissions = new Map();
// Optimistically rendered "You" cards, keyed by the clientId this page sent
// with the POST. When that same message echoes back over /events (the
// submitting page's own connection sees it too), the echo confirms the
// existing card instead of rendering a duplicate.
const pendingMessages = new Map();

function timestamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function hideEmptyState() {
  emptyState.hidden = true;
}

function scrollToLatest() {
  transcript.scrollTop = transcript.scrollHeight;
}

// The transcript itself carries no aria-live: a streamed reply fires one
// text-delta per fragment, and a live region on the whole thing would
// announce every fragment. This region instead speaks only settled
// moments -- state changes (which already cover a turn completing), a new
// permission request, and a non-fatal error.
function announce(text) {
  statusRegion.textContent = text;
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
  return { card, body };
}

function setSessionState(state, reason) {
  const labels = {
    starting: "Starting",
    ready: "Ready",
    running: "Running",
    error: "Error",
    closed: "Closed",
  };
  const label = labels[state] || state;
  statePill.textContent = label;
  statePill.dataset.state = state;
  stopButton.disabled = state === "closed" || state === "error";
  // Send re-enables only once the turn settles (back to Ready) or the
  // session ends -- not on the message's own 202, which lands well before
  // the driver's turn actually finishes.
  sendButton.disabled = state === "running";
  announce(label);
  if (state === "closed" && reason) {
    recoveryCard(reason);
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
  next.textContent = "Send a message to start a new session.";
  card.append(heading, next);
  transcript.append(card);
  scrollToLatest();
}

function transientError(message) {
  hideEmptyState();
  const card = document.createElement("section");
  card.className = "error-card";
  const text = document.createElement("p");
  text.textContent = message;
  card.append(text);
  transcript.append(card);
  scrollToLatest();
}

function renderText(event) {
  const key = event.stream + ":" + event.itemId;
  let body = textItems.get(key);
  if (!body) {
    ({ body } = messageCard(
      event.stream === "reasoning" ? "Reasoning" : "Claude Code",
      "",
      event.stream === "reasoning" ? "agent reasoning" : "agent",
    ));
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

function renderUserMessage(event) {
  const pending = pendingMessages.get(event.clientId);
  if (pending) {
    pendingMessages.delete(event.clientId);
    pending.dataset.pending = "false";
    return;
  }
  // No local optimistic card: this arrived on reconnect, or from a message
  // sent before this page attached.
  messageCard("You", event.text, "user");
}

function resolvePermission(requestId, label) {
  const card = permissions.get(requestId);
  if (!card) return;
  permissions.delete(requestId);
  for (const button of card.querySelectorAll("button")) button.disabled = true;
  const statusLabel = document.createElement("span");
  statusLabel.className = "timestamp";
  statusLabel.textContent = label;
  card.querySelector(".permission-actions").append(statusLabel);
}

function showPermissionError(requestId, message) {
  const card = permissions.get(requestId);
  if (!card) return;
  let note = card.querySelector(".permission-error");
  if (!note) {
    note = document.createElement("p");
    note.className = "permission-error";
    card.append(note);
  }
  note.textContent = message;
}

async function answerPermission(requestId, decision, label) {
  try {
    const response = await fetch("/permission/" + encodeURIComponent(requestId), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
      body: JSON.stringify({ decision }),
    });
    if (response.ok) {
      resolvePermission(requestId, label);
    } else {
      showPermissionError(requestId, "dohc could not send this decision. Try again.");
    }
  } catch {
    showPermissionError(requestId, "dohc could not send this decision. Try again.");
  }
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
  announce("Permission needed: " + event.title);
}

function renderEvent(event) {
  switch (event.kind) {
    case "session-state":
      setSessionState(event.state, event.reason);
      break;
    case "user-message":
      renderUserMessage(event);
      break;
    case "text-delta":
      renderText(event);
      break;
    case "item":
      renderActivity(event);
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
      if (event.detail) messageCard("Claude Code", event.detail, "agent");
      break;
    case "error":
      if (event.fatal) {
        setSessionState("error");
        recoveryCard(event.message);
      } else {
        messageCard("Claude Code", event.message, "agent");
        announce(event.message);
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
  pendingMessages.clear();
}

const events = new EventSource("/events?token=" + encodeURIComponent(TOKEN));
events.addEventListener("open", resetTranscript);
events.addEventListener("message", (message) => {
  renderEvent(JSON.parse(message.data));
});
events.addEventListener("error", () => {
  statePill.textContent = "Reconnecting";
  statePill.dataset.state = "starting";
});

function markMessageFailed(clientId, card, message) {
  pendingMessages.delete(clientId);
  card.dataset.failed = "true";
  const note = document.createElement("p");
  note.className = "send-failed";
  note.textContent = message;
  card.append(note);
  sendButton.disabled = false;
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || sendButton.disabled) return;
  const clientId = crypto.randomUUID();
  const { card } = messageCard("You", text, "user");
  card.dataset.pending = "true";
  pendingMessages.set(clientId, card);
  messageInput.value = "";
  sendButton.disabled = true;
  try {
    const response = await fetch("/message", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
      body: JSON.stringify({ text, clientId }),
    });
    if (!response.ok) {
      markMessageFailed(
        clientId,
        card,
        response.status === 409
          ? "Wait for the current response to finish."
          : "This message was not sent. Send it again.",
      );
    }
    // A successful 202 leaves Send disabled: the session-state:running
    // event that follows drives it, and re-enables Send once the turn
    // actually settles rather than as soon as the request lands.
  } catch {
    markMessageFailed(clientId, card, "This message was not sent. Send it again.");
  } finally {
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
  try {
    const response = await fetch("/stop", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
    });
    if (!response.ok) {
      stopButton.disabled = false;
      transientError("dohc could not stop this session.");
    }
  } catch {
    stopButton.disabled = false;
    transientError("dohc could not stop this session.");
  }
});
