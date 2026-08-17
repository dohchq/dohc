// The panel behind this plugin's activity-bar view. It proves a view-placed
// panel gets the same SDK authority a tab-placed one does: it writes a file
// into the workspace and reports what came back.
//
// The request helper is the same hand-rolled shim panel/index.js uses — this
// fixture ships as plain files with no bundler, so it spells out what
// @dohc/sdk would otherwise provide.
const protocol = "dohc:sdk:v1";
const hostOrigin = new URL(window.location.href).searchParams.get(
  "dohcHostOrigin",
);
const responseOrigin = hostOrigin === "file://" ? "null" : hostOrigin;
const postOrigin = hostOrigin === "file://" ? "*" : hostOrigin;
let nextRequestId = 1;

function request(method, params) {
  if (!hostOrigin || !postOrigin) {
    return Promise.reject(new Error("The view has no dohc host origin."));
  }
  const id = `hello-view-${nextRequestId++}`;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error(`The dohc host did not answer ${method}.`));
    }, 10_000);

    function onMessage(event) {
      if (event.source !== window.parent || event.origin !== responseOrigin) {
        return;
      }
      const response = event.data;
      if (
        !response ||
        response.protocol !== protocol ||
        response.id !== id ||
        typeof response.ok !== "boolean"
      ) {
        return;
      }
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (response.ok) resolve(response.result);
      else {
        reject(
          new Error(
            response.error?.message ?? "The dohc host rejected the request.",
          ),
        );
      }
    }

    window.addEventListener("message", onMessage);
    window.parent.postMessage({ protocol, id, method, params }, postOrigin);
  });
}

const resultOutput = document.querySelector("[data-testid=view-sdk-result]");
const errorOutput = document.querySelector("[data-testid=view-sdk-error]");

try {
  const write = await request("files.write", {
    path: "hello-plugin-view-output.txt",
    text: "Hello from the plugin view\n",
  });
  resultOutput.textContent = JSON.stringify(write);
} catch (error) {
  errorOutput.hidden = false;
  errorOutput.textContent =
    error instanceof Error ? error.message : String(error);
}
