const protocol = "dohc:sdk:v1";
const hostOrigin = new URL(window.location.href).searchParams.get(
  "dohcHostOrigin",
);
const responseOrigin = hostOrigin === "file://" ? "null" : hostOrigin;
const postOrigin = hostOrigin === "file://" ? "*" : hostOrigin;
let nextRequestId = 1;

function request(method, params) {
  if (!hostOrigin || !postOrigin) {
    return Promise.reject(new Error("The panel has no dohc host origin."));
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

const openPreview = document.querySelector(
  "[data-testid=hello-view-open-preview]",
);
const errorOutput = document.querySelector("[data-testid=hello-view-error]");

openPreview.addEventListener("click", async () => {
  openPreview.disabled = true;
  errorOutput.hidden = true;
  try {
    await request("ui.openWebApp", {
      webAppId: "preview",
      instanceKey: "demo",
    });
  } catch (error) {
    errorOutput.hidden = false;
    errorOutput.textContent =
      error instanceof Error ? error.message : String(error);
  } finally {
    openPreview.disabled = false;
  }
});
