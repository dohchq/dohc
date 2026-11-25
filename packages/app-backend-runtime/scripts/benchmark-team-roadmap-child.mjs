import { DatabaseSync, StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

let current;
const clock = () => performance.now();

function timeSync(owner, name, bucket) {
  const original = owner[name];
  owner[name] = function (...args) {
    if (!current) return original.apply(this, args);
    const start = clock();
    try {
      return original.apply(this, args);
    } finally {
      current[bucket] += clock() - start;
    }
  };
}

for (const name of ["exec", "prepare", "applyChangeset"])
  timeSync(DatabaseSync.prototype, name, "sqlite");
for (const name of ["run", "get", "all"]) timeSync(StatementSync.prototype, name, "sqlite");
const iterate = StatementSync.prototype.iterate;
StatementSync.prototype.iterate = function (...args) {
  const iterator = iterate.apply(this, args);
  if (!current) return iterator;
  const next = iterator.next;
  iterator.next = function (...nextArgs) {
    const start = clock();
    try {
      return next.apply(this, nextArgs);
    } finally {
      if (current) current.sqlite += clock() - start;
    }
  };
  return iterator;
};
const createSession = DatabaseSync.prototype.createSession;
DatabaseSync.prototype.createSession = function (...args) {
  const session = createSession.apply(this, args);
  timeSync(session, "changeset", "sqlite");
  return session;
};

const Memory = WebAssembly.Memory;
WebAssembly.Memory = function (...args) {
  const start = clock();
  try {
    return new Memory(...args);
  } finally {
    if (current) current.boot += clock() - start;
  }
};
WebAssembly.Memory.prototype = Memory.prototype;
for (const name of ["instantiate", "compile"]) {
  const original = WebAssembly[name];
  WebAssembly[name] = function (...args) {
    const start = clock();
    const owner = current;
    return original.apply(this, args).finally(() => {
      if (owner) owner.boot += clock() - start;
    });
  };
}

const on = process.on;
process.on = function (event, listener) {
  if (event !== "message") return on.call(this, event, listener);
  return on.call(this, event, (message) => {
    current = { id: message?.id, kind: message?.command?.kind, start: clock(), sqlite: 0, boot: 0 };
    listener(message);
  });
};
const send = process.send.bind(process);
process.send = (message, ...rest) => {
  if (current && message?.id === current.id && typeof message.ok === "boolean") {
    const { id, kind, start, sqlite, boot } = current;
    current = undefined;
    send({
      teamRoadmapTiming: { id, kind, totalMs: clock() - start, sqliteMs: sqlite, bootMs: boot },
    });
  }
  return send(message, ...rest);
};

await import(pathToFileURL(process.argv[2]).href);
