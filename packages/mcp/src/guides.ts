import text from "./guides.main.json";

export const GUIDES = {
  skill: {
    source: "SKILL.md",
    description:
      "Start here: which dohc tools to use for documents, Collections, apps, automations, and Versions.",
  },
  collections: {
    source: "references/collections-and-datasets.md",
    description: "collection.yaml, dataset.json, custom operations, and every dohc_dataset action.",
  },
  apps: {
    source: "references/apps-and-publishing.md",
    description:
      "app.publish.json, @dohc/app-kit, dohc-app-channel, verifyFrontend, and publishing with dohc_publish_app.",
  },
  automations: {
    source: "references/automations.md",
    description: "automations.yaml triggers, steps, formulas, and message templates.",
  },
} as const;

export const GUIDE_TEXT: Record<keyof typeof GUIDES, string> = text;
