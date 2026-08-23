const transcript = document.querySelector("#transcript");
const emptyState = document.querySelector("#empty-state");
const statusRegion = document.querySelector("#status");
const statePill = document.querySelector("#session-state");
const stopButton = document.querySelector("#stop");
const composer = document.querySelector("#composer");
const messageInput = document.querySelector("#message");
const sendButton = document.querySelector("#send");

if (
  !transcript ||
  !emptyState ||
  !statusRegion ||
  !statePill ||
  !stopButton ||
  !composer ||
  !messageInput ||
  !sendButton
) {
  throw new Error("The Codex chat page is missing a required control.");
}

// This page's own per-start credential, handed only to the guest the host
// itself navigated: startWebApp returns the URL with the token in its
// fragment, which reaches this script through location.hash but never
// travels in an HTTP request (a fragment is client-side only), so no other
// local caller that merely fetches "/" ever sees it. sessionStorage is
// scoped to this guest's own partition -- acceptable custody -- and is what
// survives a reload after the fragment is stripped: a reload re-requests
// the already-stripped URL, which carries no token at all on its own.
const TOKEN_STORAGE_KEY = "dohc-chat-token";
const tokenMatch = /(?:^|&)token=([^&]+)/.exec(location.hash.slice(1));
const TOKEN = sessionStorage.getItem(TOKEN_STORAGE_KEY) || (tokenMatch ? decodeURIComponent(tokenMatch[1]) : null);
if (!TOKEN) {
  throw new Error("The chat page did not receive a session token.");
}
sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
history.replaceState(null, "", location.pathname + location.search);

const textItems = new Map();
const activityItems = new Map();
const permissions = new Map();
// Optimistically rendered "You" cards, keyed by the clientId this page sent
// with the POST. When that same message echoes back over /events (the
// submitting page's own connection sees it too), the echo confirms the
// existing card instead of rendering a duplicate.
const pendingMessages = new Map();
// The one stored fact Send's availability derives from: is a turn active?
// Session-state events set it authoritatively. A successful /message accept
// sets it optimistically to bridge the gap before its running event arrives.
// Failed requests leave it untouched because they did not start a turn.
let turnActive = false;
// Bumped by every setSessionState call (any state). A /message accept can
// land asynchronously behind a Stop's cancellation, after the turn it
// started has already completed (or the session has already closed or
// failed) -- captured at send time and compared when that request's
// response lands, so a late accept can no longer resurrect `turnActive`
// once a fresher session-state fact has already superseded it.
let stateVersion = 0;

// `submitting` is a one-call admission guard, not another stored state. It
// blocks duplicate submits only while /message has not settled.
function updateSendAvailability(submitting = false) {
  sendButton.disabled = turnActive || submitting;
}

// `at` is the server's own publish time (every event carries it); replaying
// history must render when it really happened, not the reconnect moment.
// Falls back to now for the client's own optimistic cards, which have no
// server timestamp yet.
function formatTimestamp(at) {
  return new Date(at ?? Date.now()).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function hideEmptyState() {
  emptyState.hidden = true;
}

// Batched to one real scroll per frame: reading scrollHeight forces
// layout, and a streamed reply calls this once per delta -- per-call
// scrolling made long answers quadratic in layout work.
let scrollScheduled = false;
function scrollToLatest() {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    transcript.scrollTop = transcript.scrollHeight;
  });
}

// The transcript itself carries no aria-live: a streamed reply fires one
// text-delta per fragment, and a live region on the whole thing would
// announce every fragment. This region instead speaks only settled
// moments -- state changes (which already cover a turn completing), a new
// permission request, and a non-fatal error.
function announce(text) {
  statusRegion.textContent = text;
}

function messageCard(author, text, className, at) {
  hideEmptyState();
  const card = document.createElement("article");
  card.className = "message " + className;
  const header = document.createElement("div");
  header.className = "message-header";
  const name = document.createElement("strong");
  name.textContent = author;
  const time = document.createElement("span");
  time.className = "timestamp";
  time.textContent = formatTimestamp(at);
  const body = document.createElement("p");
  body.className = "message-body";
  body.textContent = text;
  header.append(name, time);
  card.append(header, body);
  transcript.append(card);
  scrollToLatest();
  return { card, body };
}

function setSessionState(state, reason, options = {}) {
  stateVersion += 1;
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
  turnActive = state === "running";
  updateSendAvailability();
  // The initial connection snapshot applies to the pill only: the log
  // replay right behind it (or a live event still to come) is what
  // actually narrates the transcript. Announcing or rendering a card here
  // too would duplicate whatever that replay is about to show.
  if (options.silent) return;
  announce(label);
  // A closed state reaching here (not the silent initial snapshot) is
  // always a real transition away from a session that existed -- an idle
  // CLI process can exit with no reason at all, and without a boundary
  // card here the next message would silently start a fresh, context-free
  // session under what still looks like one continuous transcript.
  if (state === "closed") {
    recoveryCard(reason || "This session ended.", options.replay);
  }
}

// A live error card is an alert: role="alert" is what a screen reader
// actually hears -- the status region above only ever speaks the state
// label ("Error"), so without it the explanation and next step render
// silently. A replayed card (a reconnect rebuilding history the reader
// already heard) has no live-region semantics.
// nextAction names what the user can do now, and it must be true for the
// state the card reports: "start a new session" only when the session
// actually ended, "try again" when only the turn failed.
function errorCard(message, nextAction, replay) {
  hideEmptyState();
  const card = document.createElement("section");
  card.className = "error-card";
  if (!replay) card.setAttribute("role", "alert");
  if (nextAction) {
    const heading = document.createElement("strong");
    heading.textContent = message;
    const next = document.createElement("p");
    next.className = "next-action";
    next.textContent = nextAction;
    card.append(heading, next);
  } else {
    const text = document.createElement("p");
    text.textContent = message;
    card.append(text);
  }
  transcript.append(card);
  scrollToLatest();
}

// The session actually ended: sending a message means starting over.
function recoveryCard(message, replay) {
  errorCard(message, "Send a message to start a new session.", replay);
}

function renderText(event) {
  const key = event.stream + ":" + event.itemId;
  let tail = textItems.get(key);
  if (!tail) {
    const { body } = messageCard(
      event.stream === "reasoning" ? "Reasoning" : "Codex",
      "",
      event.stream === "reasoning" ? "agent reasoning" : "agent",
      event.at,
    );
    // One Text node per streamed message, grown in place: `textContent +=`
    // re-serialized and replaced the whole accumulated reply on every
    // delta (quadratic over a long answer), and appending a node per delta
    // left thousands of Text children behind.
    tail = document.createTextNode("");
    body.append(tail);
    textItems.set(key, tail);
  }
  tail.appendData(event.text);
  scrollToLatest();
}

/** Decides what an activity card should show after `item`, given what it
 * already shows (or null for a brand new card). Exported and pure so a
 * test can pin the merge rule without booting the page: a completion
 * event can arrive sparse (a generic "finished"/"failed" title, no detail
 * or locations) once the harness has moved past the richer detail its own
 * start event carried, and overwriting with that would destroy real
 * information the user was just shown. */
export function mergedActivity(existing, item) {
  const details = [item.detail, ...(item.locations || [])].filter(Boolean);
  if (existing && details.length === 0) {
    return { title: existing.title, detail: existing.detail };
  }
  return { title: item.title, detail: details.join("\n") };
}

function renderActivity(event) {
  hideEmptyState();
  let card = activityItems.get(event.item.id);
  const existing = card
    ? {
        title: card.querySelector(".activity-title").textContent,
        detail: card.querySelector(".activity-detail").textContent,
      }
    : null;
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
    // The border color alone (see chat.css's [data-status="failed"] rule)
    // is invisible to a screen reader and unreliable for color-blind
    // readers -- this text mirror is what actually says "Failed".
    const status = document.createElement("span");
    status.className = "activity-status";
    const detail = document.createElement("p");
    detail.className = "activity-detail";
    header.append(title, id, status);
    card.append(header, detail);
    transcript.append(card);
    activityItems.set(event.item.id, card);
  }
  card.dataset.status = event.item.status;
  const merged = mergedActivity(existing, event.item);
  card.querySelector(".activity-title").textContent = merged.title;
  card.querySelector(".activity-detail").textContent = merged.detail;
  card.querySelector(".activity-status").textContent =
    event.item.status === "failed" ? "Failed" : "";
  scrollToLatest();
}

function renderUserMessage(event) {
  const pending = pendingMessages.get(event.clientId);
  if (pending) {
    pendingMessages.delete(event.clientId);
    pending.dataset.pending = "false";
    // A reconnect's own reset can have detached this card while its
    // /message fetch was still in flight (resetTranscript keeps the map
    // entry for exactly this reason). Put it back where it belongs now
    // that the server confirms it was really accepted.
    if (!pending.isConnected) {
      hideEmptyState();
      transcript.append(pending);
      scrollToLatest();
    }
    return;
  }
  // No local optimistic card: this arrived on reconnect, or from a message
  // sent before this page attached.
  messageCard("You", event.text, "user", event.at);
}

const PERMISSION_DECISION_LABELS = {
  allow_once: "Allowed",
  allow_always: "Allowed for session",
  reject_once: "Rejected",
  reject_always: "Rejected for session",
  cancel: "Cancelled",
};

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

/** The affected paths a permission request names, in render order. Pure
 * and exported for the same reason as mergedActivity above -- this is the
 * permission surface's whole point (which file is this decision about),
 * so the rule for what gets shown is worth pinning on its own. */
export function permissionLocations(event) {
  return (event.locations || []).filter(Boolean);
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
  const locations = permissionLocations(event);
  if (locations.length > 0) {
    const list = document.createElement("ul");
    list.className = "permission-locations";
    for (const location of locations) {
      const item = document.createElement("li");
      item.textContent = location;
      list.append(item);
    }
    card.append(list);
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
  if (event.snapshot) {
    // The current-state snapshot every new connection gets first, marked
    // by the server. Applies to the pill only -- see the silent branch in
    // setSessionState for why.
    setSessionState(event.state, event.reason, { silent: true });
    return;
  }
  switch (event.kind) {
    case "session-state":
      setSessionState(event.state, event.reason, { replay: event.replay });
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
      resolvePermission(event.requestId, PERMISSION_DECISION_LABELS[event.decision] || "Resolved");
      break;
    case "token-usage":
      statePill.title = event.max
        ? event.used + " of " + event.max + " tokens used"
        : event.used + " tokens used";
      break;
    case "turn-completed":
      setSessionState("ready");
      // The session itself is still alive (the pill just went back to
      // Ready), so the next action is a retry -- "start a new session"
      // would be false here.
      if (event.status === "failed") {
        errorCard(
          event.errorMessage || "This response failed.",
          "Send a message to try again.",
          event.replay,
        );
      }
      break;
    case "history-trimmed": {
      // The server's log could not keep this replay whole (one turn
      // outgrew the whole buffer): say so instead of starting mid-turn as
      // if nothing were missing.
      hideEmptyState();
      const notice = document.createElement("p");
      notice.className = "notice";
      notice.textContent = "Only recent messages are shown. Earlier ones were trimmed to save memory.";
      transcript.append(notice);
      scrollToLatest();
      break;
    }
    case "auth":
      if (event.detail) messageCard("Codex", event.detail, "agent", event.at);
      break;
    case "error":
      if (event.fatal) {
        setSessionState("error", undefined, { silent: event.replay });
        recoveryCard(event.message, event.replay);
      } else {
        messageCard("Codex", event.message, "agent", event.at);
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
  // pendingMessages is deliberately NOT cleared here: a /message fetch can
  // still be in flight when a reconnect fires this reset. Clearing the map
  // would strand it -- the eventual confirm (via the replayed user-message
  // event, in renderUserMessage) or failure handler (markMessageFailed)
  // would find nothing to update, and the user's message and its outcome
  // would silently disappear. Both paths re-attach the card if this reset
  // just detached it.
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
  // Same reattachment as the confirm path in renderUserMessage: a reset
  // can have detached this card while the fetch that just failed was
  // still in flight.
  if (!card.isConnected) {
    hideEmptyState();
    transcript.append(card);
  }
  // This attempt did not start a turn from this client's point of view. A
  // 409 started nothing, and any other failure means the attempt failed.
  // Re-deriving from the untouched turn fact preserves an earlier session
  // event, a newer active turn, or the existing idle state.
  updateSendAvailability();
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
  updateSendAvailability(true);
  const stateVersionAtSend = stateVersion;
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
    } else {
      // Only mark the turn active if no session-state fact -- this turn
      // completing, the session closing, a fatal error, or even a fresher
      // running confirmation -- has landed since this request was sent. A
      // late accept behind a Stop's cancellation must only annotate its own
      // card; it never gets to resurrect Send once something fresher already
      // settled it.
      if (stateVersion === stateVersionAtSend) turnActive = true;
      updateSendAvailability();
    }
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
      errorCard("dohc could not stop this session.");
      return;
    }
    // Stop now cancels the current turn rather than ending the session --
    // if nothing was running, cancel() is a safe no-op with no event of
    // its own to ever re-enable this button otherwise. A turn actually
    // interrupted still settles asynchronously (its own turn-completed
    // event drives the pill and Send back to ready); re-enabling Stop a
    // little early alongside that is harmless.
    stopButton.disabled = false;
  } catch {
    stopButton.disabled = false;
    errorCard("dohc could not stop this session.");
  }
});
