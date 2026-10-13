// Prints one JSON line per process in the container: resident and peak memory,
// CPU seconds, and command. Piped into `docker exec -i <container> node -`.
const fs = require("node:fs");
const ticks = 100;
const rows = [];
for (const pid of fs.readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const field = name => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(status)?.[1] ?? NaN);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    if (command.startsWith("node -")) continue;
    rows.push({
      pid: Number(pid),
      rssMiB: +(field("VmRSS") / 1024).toFixed(1),
      peakMiB: +(field("VmHWM") / 1024).toFixed(1),
      threads: field("Threads"),
      cpuSeconds: +((Number(stat[11]) + Number(stat[12])) / ticks).toFixed(2),
      command: command.slice(0, 80),
    });
  } catch {}
}
console.log(JSON.stringify({at: new Date().toISOString(), processes: rows}));
