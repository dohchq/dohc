import { spawnSync } from "node:child_process";

const result = spawnSync(
  "docker",
  ["compose", "-f", "docker-compose.dev.yml", "up", "-d", "postgres", "minio"],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
