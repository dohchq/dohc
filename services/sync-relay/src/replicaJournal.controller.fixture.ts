import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";

const [root, binary] = process.argv.slice(2);
const relay = spawn(process.execPath, ["--import", "tsx/esm", fileURLToPath(new URL("./replicaJournal.integration.fixture.ts", import.meta.url)), root, binary, "service"],
  // Detach the relay so the controller's Windows job does not clean it up.
  {detached: true, windowsHide: true, stdio: ["pipe", "pipe", "ignore"]});
let id = 0;
const pending = new Map<number, {resolve(value: any): void; reject(error: Error): void}>();
function call(name: string, input = {}) {
  const requestId = ++id;
  return new Promise<any>((resolve, reject) => {
    pending.set(requestId, {resolve, reject}); relay.stdin.write(JSON.stringify({id: requestId, name, input}) + "\n");
  });
}
createInterface({input: relay.stdout}).on("line", line => {
  const reply = JSON.parse(line);
  if (reply.ready) void (async () => {
    const processes = await call("init", {sizes: [1024]});
    await call("hold", {beforeRead: true}); await call("edit", {deliveryId: "controller-death"}); await call("held");
    process.send!({processes});
  })().catch(error => {console.error(error); relay.stdin.end(); process.exitCode = 1;});
  else {
    const request = pending.get(reply.id); pending.delete(reply.id);
    if (reply.error) request?.reject(new Error(reply.stack)); else request?.resolve(reply.result);
  }
});
relay.on("close", () => process.exit(1));
