import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const archiveVolumeScript = `
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const [name,uid,gid]=process.argv.slice(1);
const path='/backup/'+name;
process.umask(0o077);
const result=spawnSync('tar',['--numeric-owner','--create','--gzip','--file',path,'-C','/source','.'],{stdio:'inherit'});
if(result.error || result.status!==0) process.exit(1);
fs.chmodSync(path,0o600);
if(uid!=='none') fs.chownSync(path,Number(uid),Number(gid));
`;
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function syncPath(path, directory = false) {
  if (directory && process.platform === "win32") return;
  const handle = await open(path, process.platform === "win32" ? "r+" : "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Archive stopped volumes for safekeeping. There is deliberately no archive restore command. */
export async function archiveDeployment(options, config, run) {
  await mkdir(options.directory, { mode: 0o700 });
  const files = [];
  const save = async (name, contents) => {
    const path = join(options.directory, name);
    await writeFile(path, contents, { mode: 0o600, flag: "wx", flush: true });
    files.push({ path: name, sha256: await digest(path) });
  };
  await save("compose-resolved.json", JSON.stringify(config, null, 2) + "\n");
  await save("environment.env", await readFile(options.envFile));
  const images = [...new Set(Object.values(config.services).map(service => service.image).filter(Boolean))];
  await save("images.json", run(["image", "inspect", ...images]));
  const bindSources = [...new Set(Object.values(config.services).flatMap(service =>
    (service.volumes ?? []).filter(volume => volume.type === "bind").map(volume => volume.source)))];
  for (const [index, source] of bindSources.entries()) {
    if (!(await stat(source)).isFile()) throw new Error("Archive supports named data volumes and individual bound config files; a bound directory needs separate backup.");
    const name = `bound-config-${index}`;
    await save(name, await readFile(source));
    files.at(-1).source = source;
  }
  const volumes = Object.entries(config.volumes ?? {});
  // Inspect before docker run: mounting a missing name must never fabricate a replacement volume.
  if (volumes.length) run(["volume", "inspect", ...volumes.map(([, volume]) => volume.name)]);
  for (const [index, [key, volume]] of volumes.entries()) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volume.name)) throw new Error("Unsupported deployment volume name.");
    const name = `volume-${index}.tar.gz`;
    run(["run", "--rm", "--network", "none", "--read-only", "--user", "0:0",
      "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--cap-add", "CHOWN",
      "--security-opt", "no-new-privileges:true",
      "--mount", `type=volume,source=${volume.name},target=/source,readonly`,
      "--mount", `type=bind,source=${options.directory},target=/backup`,
      "--entrypoint", "node", config.services["sync-relay"].image, "-e", archiveVolumeScript,
      name, String(process.getuid?.() ?? "none"), String(process.getgid?.() ?? "none")]);
    await syncPath(join(options.directory, name));
    files.push({ path: name, volumeKey: key, volumeName: volume.name, sha256: await digest(join(options.directory, name)) });
  }
  await save("archive.json", JSON.stringify({
    version: 1, kind: "dohc-deployment-archive", complete: true, project: config.name,
    createdAt: new Date().toISOString(), files,
    limitations: [
      "Private archive: contains workspace contents, authentication data, server secrets and independent continuity.",
      "No automatic restore is supported. Never replace current continuity with an older archived copy.",
      "An archive does not prove this host accepted no later work. Restoring it can resurrect revoked authority.",
      "Use a separate relay snapshot for exact-continuity repair or offline content salvage.",
    ],
  }, null, 2) + "\n");
  await syncPath(options.directory, true);
  await syncPath(dirname(options.directory), true);
}
