use super::{resolver::Resolver, sql};
use dohc_engine_storage::StorageError;
use rusqlite::{Connection, params};
use std::sync::{Arc, Mutex};

type Key = (String, String, i64, i64);
#[derive(Default)]
pub(crate) struct Cache {
    entries: Vec<(Key, Arc<Resolver>, usize)>,
    closed: bool,
}
impl Cache {
    pub(crate) fn close(&mut self) {
        self.closed = true;
        self.entries.clear();
    }
}
pub(super) struct Prepared {
    cache: Arc<Mutex<Cache>>,
    key: Key,
    resolver: Option<Arc<Resolver>>,
    paths: Vec<String>,
}
impl Prepared {
    // Map construction and eviction (including map destruction) stay off the actor.
    pub(super) fn build(self) -> Arc<Resolver> {
        if let Some(resolver) = self.resolver {
            return resolver;
        }
        let bytes = self
            .paths
            .iter()
            .map(|p| p.capacity() * 12 + 512)
            .sum::<usize>();
        let resolver = Arc::new(Resolver::new(self.paths));
        let mut cache = self.cache.lock().unwrap();
        if !cache.closed && bytes <= 16 * 1024 * 1024 {
            cache
                .entries
                .retain(|(key, _, _)| key.0 != self.key.0 || key.1 != self.key.1);
            while cache.entries.len() >= 4
                || cache.entries.iter().map(|e| e.2).sum::<usize>() + bytes > 16 * 1024 * 1024
            {
                cache.entries.remove(0);
            }
            cache.entries.push((self.key, resolver.clone(), bytes));
        }
        resolver
    }
}
pub(crate) fn track_revisions(conn: &Connection) -> Result<(), StorageError> {
    // TEMP state is connection-local, transactional, and also works on read-only stores.
    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS link_resolver_revision(workspace_id TEXT,version_id TEXT,revision INTEGER NOT NULL,PRIMARY KEY(workspace_id,version_id));
         CREATE TEMP TRIGGER IF NOT EXISTS resolver_alias_insert AFTER INSERT ON main.path_aliases BEGIN
           INSERT INTO link_resolver_revision VALUES(NEW.workspace_id,NEW.version_id,1) ON CONFLICT(workspace_id,version_id) DO UPDATE SET revision=revision+1; END;
         CREATE TEMP TRIGGER IF NOT EXISTS resolver_alias_delete AFTER DELETE ON main.path_aliases BEGIN
           INSERT INTO link_resolver_revision VALUES(OLD.workspace_id,OLD.version_id,1) ON CONFLICT(workspace_id,version_id) DO UPDATE SET revision=revision+1; END;
         CREATE TEMP TRIGGER IF NOT EXISTS resolver_alias_update AFTER UPDATE ON main.path_aliases WHEN OLD.workspace_id IS NOT NEW.workspace_id OR OLD.version_id IS NOT NEW.version_id OR OLD.path IS NOT NEW.path OR OLD.object_id IS NOT NEW.object_id BEGIN
           INSERT INTO link_resolver_revision VALUES(OLD.workspace_id,OLD.version_id,1) ON CONFLICT(workspace_id,version_id) DO UPDATE SET revision=revision+1;
           INSERT INTO link_resolver_revision VALUES(NEW.workspace_id,NEW.version_id,1) ON CONFLICT(workspace_id,version_id) DO UPDATE SET revision=revision+1; END;"
    ).map_err(sql)
}
pub(crate) fn revision(
    conn: &Connection,
    ws: &str,
    version: &str,
) -> Result<(i64, i64), StorageError> {
    track_revisions(conn)?;
    let revision = conn.query_row("SELECT coalesce((SELECT revision FROM link_resolver_revision WHERE workspace_id=?1 AND version_id=?2),0)", params![ws, version], |r| r.get(0)).map_err(sql)?;
    // Other connections cannot run our TEMP triggers (notably a read-only actor).
    let external = conn
        .pragma_query_value(None, "data_version", |r| r.get(0))
        .map_err(sql)?;
    Ok((revision, external))
}
// Never call inside write_with: rollback could reuse a revision with uncommitted aliases.
pub(super) fn prepare(
    conn: &Connection,
    cache: &Arc<Mutex<Cache>>,
    ws: &str,
    version: &str,
) -> Result<Prepared, StorageError> {
    let (revision, external) = revision(conn, ws, version)?;
    let key = (ws.to_owned(), version.to_owned(), revision, external);
    let resolver = cache
        .lock()
        .unwrap()
        .entries
        .iter()
        .find(|e| e.0 == key)
        .map(|e| e.1.clone());
    let paths = if resolver.is_none() {
        Resolver::paths_for_version(conn, ws, version)?
    } else {
        Vec::new()
    };
    Ok(Prepared {
        cache: cache.clone(),
        key,
        resolver,
        paths,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE path_aliases(workspace_id TEXT,version_id TEXT,path TEXT,object_id TEXT); INSERT INTO path_aliases VALUES('ws','main','a.md','a'),('ws','fork','b.md','b');").unwrap();
        c
    }
    fn get(c: &Connection, cache: &Arc<Mutex<Cache>>, version: &str) -> Arc<Resolver> {
        prepare(c, cache, "ws", version).unwrap().build()
    }
    #[test]
    fn aliases_invalidate_only_the_changed_version_and_roll_back() {
        let c = conn();
        let cache = Arc::default();
        let main = get(&c, &cache, "main");
        let fork = get(&c, &cache, "fork");
        c.execute_batch("UPDATE path_aliases SET path=path;")
            .unwrap();
        assert!(Arc::ptr_eq(&main, &get(&c, &cache, "main")));
        c.execute_batch("UPDATE path_aliases SET path='renamed.md' WHERE version_id='fork';")
            .unwrap();
        assert!(Arc::ptr_eq(&main, &get(&c, &cache, "main")));
        let renamed = get(&c, &cache, "fork");
        assert!(!Arc::ptr_eq(&fork, &renamed));
        assert_eq!(renamed.resolve("s.md", "renamed"), Some("renamed.md"));
        c.execute_batch("BEGIN; DELETE FROM path_aliases; ROLLBACK;")
            .unwrap();
        assert!(Arc::ptr_eq(&main, &get(&c, &cache, "main")));
        c.execute_batch("INSERT INTO path_aliases VALUES('ws','main','x.md','x');")
            .unwrap();
        let inserted = get(&c, &cache, "main");
        assert_eq!(inserted.resolve("s.md", "x"), Some("x.md"));
        c.execute_batch("DELETE FROM path_aliases WHERE path='x.md';")
            .unwrap();
        assert_eq!(get(&c, &cache, "main").resolve("s.md", "x"), None);
    }
    #[test]
    fn readonly_cache_observes_external_writes() {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let path = scratch.path().join("aliases.db");
        let c = Connection::open(&path).unwrap();
        c.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE path_aliases(workspace_id TEXT,version_id TEXT,path TEXT,object_id TEXT); INSERT INTO path_aliases VALUES('ws','main','a.md','a');").unwrap();
        let reader =
            Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let cache = Arc::default();
        let first = get(&reader, &cache, "main");
        c.execute_batch("UPDATE path_aliases SET path='b.md';")
            .unwrap();
        let second = get(&reader, &cache, "main");
        assert!(!Arc::ptr_eq(&first, &second));
        assert_eq!(second.resolve("s.md", "b"), Some("b.md"));
    }
    #[test]
    fn bounded_cache_does_not_repopulate_after_close() {
        let c = conn();
        let cache = Arc::default();
        for version in ["main", "fork", "v3", "v4", "v5"] {
            get(&c, &cache, version);
        }
        assert_eq!(cache.lock().unwrap().entries.len(), 4);
        let pending = prepare(&c, &cache, "ws", "uncached").unwrap();
        cache.lock().unwrap().close();
        pending.build();
        assert!(cache.lock().unwrap().entries.is_empty());
        let huge = "a".repeat(2 * 1024 * 1024);
        let open_cache = Arc::default();
        c.execute(
            "INSERT INTO path_aliases VALUES('ws','huge',?1,'h')",
            [huge],
        )
        .unwrap();
        get(&c, &open_cache, "huge");
        assert!(open_cache.lock().unwrap().entries.is_empty());
    }
}
