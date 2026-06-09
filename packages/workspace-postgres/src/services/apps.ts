import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { WorkspacePath, type Actor } from "@dohc/workspace-contracts";
import { type BlobStore } from "../blobStore";
import { readAssetMetadata } from "../repositories/assets";
import { readAtomText, updateAtom } from "../repositories/atoms";
import {
  hasWorkspaceMembership,
  type PgQueryable,
} from "../repositories/workspaces";
import { assertWorkspaceMember } from "../policy/authorize";
import {
  createPostgresDatabaseServices,
  type DatabaseOperation,
} from "./databaseFiles";

type AppManifest = {
  title?: string;
  read?: string[];
  write?: string[];
  collections?: Record<string, unknown>;
  databases?: Record<string, unknown>;
  agent?: unknown;
};

type ResolvedApp = {
  id: string;
  packageRoot: string;
  scopePath: string;
  title: string;
  read: string[];
  write: string[];
  manifest: AppManifest;
  sourceDigest: string;
  trustKey: string;
};

type AtomRow = {
  id: string;
  path: string;
  body: string;
  revision: number;
  updated_at: Date;
};

function error(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { ok: false as const, code, message, ...extra };
}

type ServiceError = ReturnType<typeof error>;

function isServiceError(value: ResolvedApp | ServiceError): value is ServiceError {
  return "ok" in value && value.ok === false;
}

async function assertAuthorized(db: PgQueryable, actor: Actor) {
  await assertWorkspaceMember({
    actor,
    workspaceId: actor.workspaceId,
    hasMembership: (userId, workspaceId) =>
      hasWorkspaceMembership(db, userId, workspaceId),
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function sha256Text(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function parsePackageRoot(packageRoot: string) {
  const marker = "/.apps/";
  const index = packageRoot.indexOf(marker);
  if (index < 0) return null;
  const scopePath = packageRoot.slice(0, index);
  const appName = packageRoot.slice(index + marker.length);
  if (!scopePath || !appName || appName.includes("/")) return null;
  return { scopePath, appName };
}

function normalizeScopes(scopePath: string, scopes: unknown): string[] {
  if (!Array.isArray(scopes)) return [];
  return scopes
    .filter((scope): scope is string => typeof scope === "string")
    .map((scope) => resolveScopeRelativePath(scopePath, scope))
    .filter((scope): scope is string => Boolean(scope))
    .sort();
}

function resolveScopeRelativePath(scopePath: string, requested: string) {
  const clean = requested.trim().replace(/^\/+|\/+$/g, "");
  if (!clean || clean === ".") return scopePath;
  if (clean.includes("\\") || clean.split("/").some((part) => part === "..")) {
    return null;
  }
  return clean.startsWith(`${scopePath}/`) || clean === scopePath
    ? clean
    : `${scopePath}/${clean}`;
}

function scopeHasGlob(value: string): boolean {
  return /[?*\[]/.test(value);
}

function globMatchesPath(glob: string, path: string): boolean {
  if (!scopeHasGlob(glob)) return path === glob;
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${source}$`).test(path);
}

function pathInScope(path: string, scope: string): boolean {
  if (scopeHasGlob(scope)) return globMatchesPath(scope, path);
  return path === scope || path.startsWith(`${scope}/`);
}

function parseManifest(body: string): AppManifest {
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as AppManifest)
      : {};
  } catch {
    return {};
  }
}

async function appSourceRows(
  db: PgQueryable,
  actor: Actor,
  packageRoot: string,
) {
  const result = await db.query<AtomRow>(
    `
      select id, path, body, revision, updated_at
      from atoms
      where workspace_id = $1
        and deleted_at is null
        and (
          path = $2
          or path like $3
        )
      order by path asc
    `,
    [
      actor.workspaceId,
      `${packageRoot}/app.json`,
      `${packageRoot}/src/%`,
    ],
  );
  return result.rows;
}

async function resolveApp(
  db: PgQueryable,
  actor: Actor,
  packageRoot: string,
): Promise<ResolvedApp | ReturnType<typeof error>> {
  await assertAuthorized(db, actor);
  const parsedRoot = parsePackageRoot(packageRoot);
  if (!parsedRoot) return error("app-not-found", "App not found.");
  const rows = await appSourceRows(db, actor, packageRoot);
  const manifestRow = rows.find((row) => row.path === `${packageRoot}/app.json`);
  if (!manifestRow) return error("app-not-found", "App not found.");
  const manifest = parseManifest(manifestRow.body);
  const title =
    typeof manifest.title === "string" && manifest.title.trim()
      ? manifest.title.trim()
      : parsedRoot.appName;
  const read = normalizeScopes(parsedRoot.scopePath, manifest.read);
  const write = normalizeScopes(parsedRoot.scopePath, manifest.write);
  const sourceDigest = sha256Text(
    rows.map((row) => `${row.path}\0${row.body}`).join("\0"),
  );
  const trustKey = stableJson({
    write,
    databases: manifest.databases ?? {},
    collections: manifest.collections ?? {},
    agent: manifest.agent ?? null,
  });
  const packageId = await upsertAppPackage(db, actor, {
    packageRoot,
    manifest,
    sourceDigest,
    trustKey,
  });
  return {
    id: packageId,
    packageRoot,
    scopePath: parsedRoot.scopePath,
    title,
    read,
    write,
    manifest,
    sourceDigest,
    trustKey,
  };
}

async function upsertAppPackage(
  db: PgQueryable,
  actor: Actor,
  input: {
    packageRoot: string;
    manifest: AppManifest;
    sourceDigest: string;
    trustKey: string;
  },
) {
  const existing = await db.query<{ id: string }>(
    `
      select id
      from app_packages
      where workspace_id = $1
        and package_root = $2
        and deleted_at is null
      limit 1
    `,
    [actor.workspaceId, input.packageRoot],
  );
  const id = existing.rows[0]?.id ?? randomUUID();
  if (existing.rows[0]) {
    await db.query(
      `
        update app_packages
        set manifest = $3,
            source_digest = $4,
            write_key = $5,
            updated_at = now()
        where id = $1
          and workspace_id = $2
      `,
      [id, actor.workspaceId, JSON.stringify(input.manifest), input.sourceDigest, input.trustKey],
    );
  } else {
    await db.query(
      `
        insert into app_packages (
          id,
          workspace_id,
          package_root,
          manifest,
          source_digest,
          write_key
        )
        values ($1, $2, $3, $4, $5, $6)
      `,
      [id, actor.workspaceId, input.packageRoot, JSON.stringify(input.manifest), input.sourceDigest, input.trustKey],
    );
  }
  return id;
}

async function isTrusted(db: PgQueryable, actor: Actor, app: ResolvedApp) {
  const result = await db.query(
    `
      select 1
      from app_trust_grants
      where workspace_id = $1
        and app_package_id = $2
        and user_id = $3
        and manifest_write_key = $4
        and deleted_at is null
      limit 1
    `,
    [actor.workspaceId, app.id, actor.userId, app.trustKey],
  );
  return (result.rowCount ?? 0) > 0;
}

function resolveReadPath(app: ResolvedApp, requested: string) {
  const resolved = resolveScopeRelativePath(app.scopePath, requested);
  if (!resolved) return null;
  return app.read.some((scope) => pathInScope(resolved, scope)) ? resolved : null;
}

function resolveWritePath(app: ResolvedApp, requested: string) {
  const resolved = resolveScopeRelativePath(app.scopePath, requested);
  if (!resolved) return null;
  return app.write.some((scope) => pathInScope(resolved, scope)) ? resolved : null;
}

export function createPostgresAppsService(
  pool: pg.Pool,
  options: { blobStore?: BlobStore } = {},
) {
  const databases = createPostgresDatabaseServices(pool, options);

  return {
    async discoverPackage(actor: Actor, packageRoot: string) {
      const app = await resolveApp(pool, actor, packageRoot);
      if (isServiceError(app)) return app;
      const trusted = await isTrusted(pool, actor, app);
      return {
        ok: true as const,
        packageRoot: app.packageRoot,
        title: app.title,
        sourceDigest: app.sourceDigest,
        trustKey: app.trustKey,
        trusted,
        writeTargets: app.write,
      };
    },

    async grantTrust(actor: Actor, packageRoot: string) {
      const app = await resolveApp(pool, actor, packageRoot);
      if (isServiceError(app)) return app;
      const existing = await pool.query<{ id: string }>(
        `
          select id
          from app_trust_grants
          where workspace_id = $1
            and app_package_id = $2
            and user_id = $3
            and manifest_write_key = $4
            and deleted_at is null
          limit 1
        `,
        [actor.workspaceId, app.id, actor.userId, app.trustKey],
      );
      if (!existing.rows[0]) {
        await pool.query(
          `
            insert into app_trust_grants (
              id,
              workspace_id,
              app_package_id,
              user_id,
              manifest_write_key,
              scopes
            )
            values ($1, $2, $3, $4, $5, $6)
          `,
          [randomUUID(), actor.workspaceId, app.id, actor.userId, app.trustKey, JSON.stringify(app.write)],
        );
      }
      return { ok: true as const, trustKey: app.trustKey };
    },

    async readDoc(
      actor: Actor,
      input: { packageRoot: string; path: string },
    ) {
      const app = await resolveApp(pool, actor, input.packageRoot);
      if (isServiceError(app)) return app;
      const path = resolveReadPath(app, input.path);
      if (!path) return error("source-read-not-granted", "This app cannot read that source.");
      try {
        const text = await readAtomText(pool, actor, path);
        return { ok: true as const, path, body: text.body, revision: text.revision };
      } catch {
        return error("not-found", "Source atom not found.");
      }
    },

    async appendDoc(
      actor: Actor,
      input: {
        packageRoot: string;
        path: string;
        markdown: string;
        operationId: string;
      },
    ) {
      const app = await resolveApp(pool, actor, input.packageRoot);
      if (isServiceError(app)) return app;
      const path = resolveWritePath(app, input.path);
      if (!path) return error("source-write-not-granted", "This app cannot write that source.");
      if (!(await isTrusted(pool, actor, app))) {
        return error("app-trust-required", "This user has not trusted the current app manifest.");
      }
      const text = await readAtomText(pool, actor, path);
      const updated = await updateAtom(pool, actor, {
        path,
        expectedRevision: text.revision,
        body: `${text.body}${input.markdown}`,
      });
      return { ok: true as const, path, revision: String(updated.revision) };
    },

    async resolveAsset(
      actor: Actor,
      input: { packageRoot: string; path: string },
    ) {
      const app = await resolveApp(pool, actor, input.packageRoot);
      if (isServiceError(app)) return app;
      const path = resolveReadPath(app, input.path);
      if (!path) return error("source-read-not-granted", "This app cannot read that source.");
      try {
        const asset = await readAssetMetadata(pool, actor, path);
        return {
          ok: true as const,
          path: asset.path,
          mediaType: asset.media_type,
          size: asset.size,
          sha256: asset.sha256,
          revision: String(asset.revision),
        };
      } catch {
        return error("not-found", "Source asset not found.");
      }
    },

    async databaseTables(
      actor: Actor,
      input: { packageRoot: string; path: string },
    ) {
      const app = await resolveApp(pool, actor, input.packageRoot);
      if (isServiceError(app)) return app;
      const path = resolveReadPath(app, input.path);
      if (!path) return error("source-read-not-granted", "This app cannot read that database.");
      return databases.tables(actor, path);
    },

    async databaseQuery(
      actor: Actor,
      input: {
        packageRoot: string;
        path: string;
        sql: string;
        params?: unknown[];
      },
    ) {
      const app = await resolveApp(pool, actor, input.packageRoot);
      if (isServiceError(app)) return app;
      const path = resolveReadPath(app, input.path);
      if (!path) return error("source-read-not-granted", "This app cannot read that database.");
      return databases.query(actor, {
        path,
        sql: input.sql,
        ...(input.params === undefined ? {} : { params: input.params }),
      });
    },

    async databaseApply(
      actor: Actor,
      input: {
        packageRoot: string;
        path: string;
        operationId: string;
        expectedVersion?: number;
        op: DatabaseOperation;
        table: string;
        rowId?: string;
        payload: unknown;
      },
    ) {
      const app = await resolveApp(pool, actor, input.packageRoot);
      if (isServiceError(app)) return app;
      const path = resolveWritePath(app, input.path);
      if (!path) return error("source-write-not-granted", "This app cannot write that database.");
      if (!(await isTrusted(pool, actor, app))) {
        return error("app-trust-required", "This user has not trusted the current app manifest.");
      }
      return databases.apply(actor, {
        path,
        operationId: input.operationId,
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
        op: input.op,
        table: input.table,
        ...(input.rowId === undefined ? {} : { rowId: input.rowId }),
        payload: input.payload,
      });
    },
  };
}
