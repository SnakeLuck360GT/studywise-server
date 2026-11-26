// Cloud sync and backup: each account's whole Studywise library, kept here so
// every device (computers and phones) syncs through this server instead of
// with each other, and nothing is lost if a device is.
//
// The app already records every change to its library as a row change (table,
// key, time, which device, the row). This server keeps, per account, the
// latest version of every row in a small SQLite file, each with a sequence
// number. A device pushes its changes, then pulls everything with a higher
// sequence number than it last saw. When two devices changed the same row, the
// later change wins (ties: the higher device id), exactly as on the devices
// (wins() in the app's src/main/sync/engine.ts). Deleted rows stay as
// tombstones, so a device that's been away learns about deletions too.
//
// Files the rows need (lecture slides and transcripts, pasted images) are kept
// beside it. Once a day, an account that changed gets a snapshot, kept 14 days,
// which an admin can restore.
//
//   data/cloud/<user>/sync.sqlite      rows, devices
//   data/cloud/<user>/files/course/<id>
//   data/cloud/<user>/files/attach/<name>
//   data/cloud/<user>/snapshots/<YYYY-MM-DD>.sqlite

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HttpError } from "./auth.js";

export const PAGE = 400;
export const SNAPSHOT_DAYS = 14;
export const DEFAULT_QUOTA = 5 * 1000 * 1000 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS rows (
    tbl TEXT NOT NULL,
    pk TEXT NOT NULL,
    at TEXT NOT NULL,
    origin TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    row TEXT,
    seq INTEGER NOT NULL,
    PRIMARY KEY (tbl, pk)
  );
  CREATE INDEX IF NOT EXISTS rows_seq ON rows (seq);
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_sync TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const safeName = (s) => /^[A-Za-z0-9._-]{1,200}$/.test(s) && !s.startsWith(".");

export function openCloud(rootDir) {
  const dbs = new Map();
  const dirOf = (user) => path.join(rootDir, user);

  function db(user) {
    let d = dbs.get(user);
    if (d) return d;
    mkdirSync(dirOf(user), { recursive: true });
    d = new DatabaseSync(path.join(dirOf(user), "sync.sqlite"));
    d.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    d.exec(SCHEMA);
    dbs.set(user, d);
    return d;
  }
  const has = (user) => existsSync(path.join(dirOf(user), "sync.sqlite"));
  const close = (user) => {
    dbs.get(user)?.close();
    dbs.delete(user);
  };
  const metaGet = (d, key) => d.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
  const metaSet = (d, key, value) => d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, String(value));
  const maxSeq = (d) => d.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM rows").get().n;

  function dirBytes(dir) {
    if (!existsSync(dir)) return 0;
    let n = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      n += e.isDirectory() ? dirBytes(p) : statSync(p).size;
    }
    return n;
  }

  /** What an account takes up here: its synced library and files, and its snapshots. */
  function usage(user) {
    const dir = dirOf(user);
    if (!existsSync(dir)) return { data: 0, files: 0, snapshots: 0, total: 0 };
    const snapshots = dirBytes(path.join(dir, "snapshots"));
    const files = dirBytes(path.join(dir, "files"));
    const data = dirBytes(dir) - snapshots - files;
    return { data, files, snapshots, total: data + files + snapshots };
  }

  /** Over the limit: refuse more (deleting things on a device and syncing still works). */
  function checkRoom(user, quota, adding) {
    // Snapshots don't count: they're the server's safety net, not the person's.
    const u = usage(user);
    if (u.data + u.files + adding > quota) {
      throw new HttpError(413, `Your cloud storage is full (${(quota / 1e9).toFixed(1)} GB). Delete some courses or files, or ask the site's admin for more room.`);
    }
  }

  function seen(d, device) {
    if (!device?.id) return;
    const now = new Date().toISOString();
    d.prepare(
      "INSERT INTO devices (id, name, kind, first_seen, last_sync) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, last_sync = excluded.last_sync",
    ).run(String(device.id).slice(0, 100), String(device.name ?? "Device").slice(0, 100), device.kind === "phone" ? "phone" : "computer", now, now);
  }

  /** The same rule the devices use: the later change wins; on a tie, the higher device id. */
  function wins(c, cur) {
    if (!cur) return true;
    if (c.at !== cur.at) return c.at > cur.at;
    return c.origin > cur.origin;
  }

  function push(user, { changes, device }, quota) {
    if (!Array.isArray(changes)) throw new HttpError(400, "Expected changes");
    const d = db(user);
    seen(d, device);
    if (!changes.length) return { applied: 0, skipped: 0 };
    const incoming = changes.reduce((n, c) => n + (c.row ? JSON.stringify(c.row).length : 0), 0);
    checkRoom(user, quota, incoming);
    const get = d.prepare("SELECT at, origin FROM rows WHERE tbl = ? AND pk = ?");
    const put = d.prepare("INSERT OR REPLACE INTO rows (tbl, pk, at, origin, deleted, row, seq) VALUES (?, ?, ?, ?, ?, ?, ?)");
    let seq = maxSeq(d);
    let applied = 0;
    let skipped = 0;
    d.exec("BEGIN");
    try {
      for (const c of changes) {
        if (typeof c?.tbl !== "string" || typeof c.pk !== "string" || typeof c.at !== "string" || typeof c.origin !== "string") throw new HttpError(400, "A change is missing its table, key, time or device");
        if (!wins(c, get.get(c.tbl, c.pk))) {
          skipped++;
          continue;
        }
        const gone = Boolean(c.deleted) || !c.row;
        put.run(c.tbl, c.pk, c.at, c.origin, gone ? 1 : 0, gone ? null : JSON.stringify(c.row), ++seq);
        applied++;
      }
      metaSet(d, "changed", new Date().toISOString());
      d.exec("COMMIT");
    } catch (err) {
      d.exec("ROLLBACK");
      throw err;
    }
    return { applied, skipped };
  }

  /** Rows changed after `since`, oldest first; a device's own changes aren't sent back to it. */
  function pull(user, { since, device }) {
    const d = db(user);
    seen(d, device);
    const from = Number.isFinite(Number(since)) ? Number(since) : 0;
    const rows = d.prepare("SELECT tbl, pk, at, origin, deleted, row, seq FROM rows WHERE seq > ? ORDER BY seq LIMIT ?").all(from, PAGE + 1);
    const more = rows.length > PAGE;
    const page = rows.slice(0, PAGE);
    const me = device?.id;
    const changes = page
      .filter((r) => r.origin !== me)
      .map((r) => ({ tbl: r.tbl, pk: r.pk, at: r.at, origin: r.origin, deleted: Boolean(r.deleted), ...(r.deleted ? {} : { row: JSON.parse(r.row) }) }));
    return { changes, next: page.length ? page[page.length - 1].seq : from, more };
  }

  // Files

  const filePath = (user, kind, name) => {
    if (!safeName(name)) throw new HttpError(400, "That file name isn't allowed");
    return path.join(dirOf(user), "files", kind, name);
  };
  /** studywise-file://attachments/<name> → its name. */
  const attachName = (url) => {
    const m = /^studywise-file:\/\/attachments\/([^/?#]+)$/.exec(String(url ?? ""));
    if (!m) throw new HttpError(400, "Only pasted images (studywise-file://attachments/…) are kept here");
    return decodeURIComponent(m[1]);
  };

  function haveFiles(user, { attachments = [], courseFiles = [] }) {
    const missing = (kind, names) => names.filter((n) => typeof n === "string" && safeName(n) && !existsSync(filePath(user, kind, n)));
    return { attachments: missing("attach", attachments.slice(0, 20000)), courseFiles: missing("course", courseFiles.slice(0, 20000)) };
  }
  function readFile(user, kind, name) {
    const p = filePath(user, kind, name);
    return existsSync(p) ? readFileSync(p) : null;
  }
  function writeFile(user, kind, name, bytes, quota) {
    checkRoom(user, quota, bytes.length);
    const p = filePath(user, kind, name);
    mkdirSync(path.dirname(p), { recursive: true });
    const temp = `${p}.${process.pid}.tmp`;
    writeFileSync(temp, bytes);
    renameSync(temp, p);
  }

  // Status, snapshots, removal

  function status(user) {
    if (!has(user)) return { on: false, rows: 0, devices: [], lastChange: null, usage: usage(user), snapshots: [] };
    const d = db(user);
    return {
      on: true,
      rows: d.prepare("SELECT COUNT(*) AS n FROM rows WHERE deleted = 0").get().n,
      devices: d.prepare("SELECT id, name, kind, first_seen AS firstSeen, last_sync AS lastSync FROM devices ORDER BY last_sync DESC").all(),
      lastChange: metaGet(d, "changed") ?? null,
      usage: usage(user),
      snapshots: snapshots(user),
    };
  }

  function snapshots(user) {
    const dir = path.join(dirOf(user), "snapshots");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.sqlite$/.test(f))
      .map((f) => ({ day: f.slice(0, 10), bytes: statSync(path.join(dir, f)).size }))
      .sort((a, b) => b.day.localeCompare(a.day));
  }

  /** Today's snapshot of every account that changed since its last one, and old ones cleared out. */
  function snapshotAll(now = new Date()) {
    if (!existsSync(rootDir)) return 0;
    const day = now.toISOString().slice(0, 10);
    let made = 0;
    for (const user of readdirSync(rootDir)) {
      if (!has(user)) continue;
      const d = db(user);
      const dir = path.join(dirOf(user), "snapshots");
      mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `${day}.sqlite`);
      const changed = metaGet(d, "changed");
      const last = snapshots(user)[0]?.day;
      if (!existsSync(target) && changed && (!last || changed.slice(0, 10) >= last)) {
        d.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
        made++;
      }
      const oldest = new Date(now.getTime() - SNAPSHOT_DAYS * 86400000).toISOString().slice(0, 10);
      for (const s of snapshots(user)) if (s.day < oldest) rmSync(path.join(dir, `${s.day}.sqlite`), { force: true });
    }
    return made;
  }

  /**
   * Puts an account back to how it was on a day. Every row that differs gets
   * today's time, so the next sync makes every device match: rows changed
   * since go back, rows added since are deleted, rows deleted since return.
   */
  function restore(user, day) {
    const file = path.join(dirOf(user), "snapshots", `${day}.sqlite`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !existsSync(file)) throw new HttpError(404, "No snapshot from that day");
    const d = db(user);
    const snap = new DatabaseSync(file, { readOnly: true });
    const then = new Map(snap.prepare("SELECT tbl, pk, deleted, row FROM rows").all().map((r) => [`${r.tbl}\u0000${r.pk}`, r]));
    snap.close();
    const now = new Date().toISOString();
    const put = d.prepare("INSERT OR REPLACE INTO rows (tbl, pk, at, origin, deleted, row, seq) VALUES (?, ?, ?, 'cloud', ?, ?, ?)");
    let seq = maxSeq(d);
    let changed = 0;
    d.exec("BEGIN");
    try {
      for (const r of d.prepare("SELECT tbl, pk, deleted, row FROM rows").all()) {
        const k = `${r.tbl}\u0000${r.pk}`;
        const old = then.get(k);
        then.delete(k);
        if (old ? old.deleted === r.deleted && old.row === r.row : r.deleted) continue;
        put.run(r.tbl, r.pk, now, old ? old.deleted : 1, old && !old.deleted ? old.row : null, ++seq);
        changed++;
      }
      for (const old of then.values()) {
        if (old.deleted) continue;
        put.run(old.tbl, old.pk, now, 0, old.row, ++seq);
        changed++;
      }
      metaSet(d, "changed", now);
      d.exec("COMMIT");
    } catch (err) {
      d.exec("ROLLBACK");
      throw err;
    }
    return { changed };
  }

  // Study stats for the leaderboard, worked out from the synced library (and
  // kept until the account changes again).
  const statsCache = new Map();
  function stats(user, now = new Date()) {
    if (!has(user)) return null;
    const d = db(user);
    const changed = metaGet(d, "changed") ?? "";
    const today = now.toISOString().slice(0, 10);
    const hit = statsCache.get(user);
    if (hit && hit.changed === changed && hit.today === today) return hit.stats;
    const weekAgo = new Date(now.getTime() - 6 * 86400000).toISOString().slice(0, 10);
    const one = (sql, ...args) => Object.values(d.prepare(sql).get(...args) ?? {})[0] ?? 0;
    const live = "deleted = 0 AND tbl = ?";
    // Time studied: a row per day per device.
    const days = new Map();
    for (const r of d.prepare(`SELECT json_extract(row, '$.day') AS day, json_extract(row, '$.seconds') AS s FROM rows WHERE ${live}`).all("study_time")) days.set(r.day, (days.get(r.day) ?? 0) + (r.s ?? 0));
    const reviewDays = new Set(d.prepare(`SELECT DISTINCT substr(json_extract(row, '$.at'), 1, 10) AS day FROM rows WHERE ${live}`).all("review_log").map((r) => r.day));
    // A streak counts today if you've studied, else carries on from yesterday.
    const active = (day) => (days.get(day) ?? 0) > 0 || reviewDays.has(day);
    let streak = 0;
    let cursor = new Date(`${today}T12:00:00Z`);
    if (!active(today)) cursor = new Date(cursor.getTime() - 86400000);
    while (active(cursor.toISOString().slice(0, 10))) {
      streak++;
      cursor = new Date(cursor.getTime() - 86400000);
    }
    const progress = "json_extract(json_extract(row, '$.progress'), ?)";
    const result = {
      seconds: [...days.values()].reduce((n, x) => n + x, 0),
      secondsWeek: [...days].filter(([day]) => day >= weekAgo).reduce((n, [, x]) => n + x, 0),
      reviews: one(`SELECT COUNT(*) FROM rows WHERE ${live}`, "review_log"),
      reviewsWeek: one(`SELECT COUNT(*) FROM rows WHERE ${live} AND substr(json_extract(row, '$.at'), 1, 10) >= ?`, "review_log", weekAgo),
      streak,
      topicsDone: one(`SELECT COUNT(*) FROM rows WHERE ${live} AND ${progress} = 1`, "topics", "$.done"),
      answered: one(`SELECT COALESCE(SUM(${progress}), 0) FROM rows WHERE ${live}`, "$.answered", "topics"),
      correct: one(`SELECT COALESCE(SUM(${progress}), 0) FROM rows WHERE ${live}`, "$.correct", "topics"),
      courses: one(`SELECT COUNT(*) FROM rows WHERE ${live}`, "courses"),
      cards: one(`SELECT COUNT(*) FROM rows WHERE ${live}`, "cards"),
      notes: one(`SELECT COUNT(*) FROM rows WHERE ${live}`, "notes"),
      lastActive: [...days.keys(), ...reviewDays].sort().at(-1) ?? null,
    };
    statsCache.set(user, { changed, today, stats: result });
    return result;
  }

  /** Everything this account keeps here, gone (the devices keep their own copies). */
  function remove(user) {
    statsCache.delete(user);
    close(user);
    rmSync(dirOf(user), { recursive: true, force: true });
  }

  /** Every account with something here, for the admin page. */
  function accounts() {
    if (!existsSync(rootDir)) return [];
    return readdirSync(rootDir).filter((u) => existsSync(dirOf(u)));
  }

  function closeAll() {
    for (const u of [...dbs.keys()]) close(u);
  }

  return { push, pull, haveFiles, readFile, writeFile, attachName, status, usage, snapshots, snapshotAll, restore, remove, accounts, closeAll, has, stats };
}
