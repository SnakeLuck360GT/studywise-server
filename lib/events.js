// What happens on the site, kept for the admin page: an activity log (who did
// what, when), who was active each day, a daily record of totals (for charts
// over time), and reports people make about published weeks. One SQLite file,
// data/server.sqlite, so the JSON database stays small.

import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS activity_at ON activity (at);
  CREATE INDEX IF NOT EXISTS activity_actor ON activity (actor, at);
  CREATE TABLE IF NOT EXISTS active (day TEXT NOT NULL, user TEXT NOT NULL, PRIMARY KEY (day, user));
  CREATE TABLE IF NOT EXISTS daily (
    day TEXT PRIMARY KEY,
    people INTEGER NOT NULL,
    weeks INTEGER NOT NULL,
    storage INTEGER NOT NULL,
    cloud INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    reporter TEXT NOT NULL,
    week_id TEXT NOT NULL,
    week_name TEXT NOT NULL,
    author TEXT NOT NULL,
    reason TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    resolved_by TEXT,
    resolved_at TEXT
  );
`;

export const REPORT_REASONS = {
  wrong: "Wrong or misleading",
  copyright: "Someone else's work",
  spam: "Spam or junk",
  offensive: "Offensive",
  other: "Something else",
};

export function openEvents(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, "server.sqlite"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  const day = (d = new Date()) => d.toISOString().slice(0, 10);
  const seenToday = new Set();

  /** Something happened: who did it, what, to what, and any detail (an object, kept as JSON). */
  function log(actor, action, target = null, detail = null) {
    db.prepare("INSERT INTO activity (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)").run(new Date().toISOString(), actor ?? null, action, target, detail == null ? null : JSON.stringify(detail));
  }

  /** Someone used the site or the app today (once a day each, remembered in memory). */
  function active(user) {
    const k = `${day()}|${user}`;
    if (seenToday.has(k)) return;
    if (seenToday.size > 5000) seenToday.clear();
    seenToday.add(k);
    db.prepare("INSERT OR IGNORE INTO active (day, user) VALUES (?, ?)").run(day(), user);
  }

  function activity({ actor, action, before, limit = 100 } = {}) {
    const where = [];
    const args = [];
    if (actor) where.push("(actor = ? OR target = ?)") && args.push(actor, actor);
    if (action) where.push("action LIKE ?") && args.push(`${action}%`);
    if (before) where.push("id < ?") && args.push(Number(before));
    const rows = db.prepare(`SELECT * FROM activity ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(500, limit));
    return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  }

  /** Today's totals (people, weeks, storage), recorded once an hour so each day ends with its last. */
  function recordDaily(totals) {
    db.prepare("INSERT OR REPLACE INTO daily (day, people, weeks, storage, cloud) VALUES (?, ?, ?, ?, ?)").run(day(), totals.people, totals.weeks, totals.storage, totals.cloud);
  }

  /** A row per day for the last `days` days: people active, sign-ups, weeks published, downloads, and the totals. */
  function trends(days = 30) {
    const from = day(new Date(Date.now() - (days - 1) * 86400000));
    const count = (action) => new Map(db.prepare("SELECT substr(at, 1, 10) AS d, COUNT(*) AS n FROM activity WHERE action = ? AND at >= ? GROUP BY d").all(action, from).map((r) => [r.d, r.n]));
    const signups = count("signup");
    const published = count("publish");
    const downloads = count("download");
    const activeBy = new Map(db.prepare("SELECT day AS d, COUNT(*) AS n FROM active WHERE day >= ? GROUP BY day").all(from).map((r) => [r.d, r.n]));
    const totals = new Map(db.prepare("SELECT * FROM daily WHERE day >= ?").all(from).map((r) => [r.day, r]));
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = day(new Date(Date.now() - i * 86400000));
      const t = totals.get(d);
      out.push({ day: d, active: activeBy.get(d) ?? 0, signups: signups.get(d) ?? 0, published: published.get(d) ?? 0, downloads: downloads.get(d) ?? 0, storage: t?.storage ?? null, cloud: t?.cloud ?? null, people: t?.people ?? null, weeks: t?.weeks ?? null });
    }
    return out;
  }

  // Reports about published weeks

  function report({ reporter, weekId, weekName, author, reason, note }) {
    // One open report per person per week: reporting again updates it.
    const open = db.prepare("SELECT id FROM reports WHERE reporter = ? AND week_id = ? AND status = 'open'").get(reporter, weekId);
    if (open) {
      db.prepare("UPDATE reports SET reason = ?, note = ?, at = ? WHERE id = ?").run(reason, note, new Date().toISOString(), open.id);
      return open.id;
    }
    const id = randomBytes(8).toString("hex");
    db.prepare("INSERT INTO reports (id, at, reporter, week_id, week_name, author, reason, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, new Date().toISOString(), reporter, weekId, weekName, author, reason, note);
    return id;
  }
  const reports = (status) => db.prepare(`SELECT * FROM reports ${status ? "WHERE status = ?" : ""} ORDER BY at DESC LIMIT 500`).all(...(status ? [status] : []));
  const getReport = (id) => db.prepare("SELECT * FROM reports WHERE id = ?").get(id);
  function resolve(id, status, by) {
    db.prepare("UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?").run(status, by, new Date().toISOString(), id);
  }
  /** A week taken down: its open reports are dealt with. */
  function resolveWeek(weekId, by) {
    db.prepare("UPDATE reports SET status = 'removed', resolved_by = ?, resolved_at = ? WHERE week_id = ? AND status = 'open'").run(by, new Date().toISOString(), weekId);
  }
  const openReports = () => db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").get().n;

  return { log, active, activity, recordDaily, trends, report, reports, getReport, resolve, resolveWeek, openReports, close: () => db.close() };
}
