const engineHost = document.querySelector<HTMLElement>("[data-engine-host]");
if (engineHost) {
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void import("./v8-scene")
        .then(({ mountV8 }) => mountV8(engineHost))
        .catch((error) => {
          console.error("Unable to load the engine model", error);
        });
    },
    { rootMargin: "200px" },
  );
  observer.observe(engineHost);
  if (import.meta.hot) import.meta.hot.dispose(() => observer.disconnect());
}
