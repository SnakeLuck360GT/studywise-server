import path from "node:path";

const dataDir = path.resolve(process.env.DATA_DIR || "data");

export const config = {
  port: Number(process.env.PORT || 3005),
  // 0.0.0.0 in Docker; on a server behind Caddy, only this machine.
  host: process.env.HOST || "127.0.0.1",
  dataDir,
  // Behind a proxy (Caddy, nginx, Traefik) the visitor's address is in
  // X-Forwarded-For. Set TRUST_PROXY=0 when nothing is in front, so it can't be faked.
  trustProxy: process.env.TRUST_PROXY !== "0",
  // Published weeks, one .studyweek file each. Only the app downloads them,
  // through the API, so Caddy never serves this folder.
  weeksDir: path.join(dataDir, "weeks"),
  // Accounts, keys and the summary of every published week.
  dbFile: path.resolve(process.env.DB_FILE || path.join(dataDir, "db.json")),
  // The site, e.g. https://courses.example.com
  publicUrl: process.env.PUBLIC_URL?.replace(/\/$/, ""),
  sessionMs: 30 * 24 * 60 * 60 * 1000,
  // A week with its slides and transcripts. Caddy has the same limit.
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 300) * 1000 * 1000,
  // Per person, per day.
  uploadsPerDay: Number(process.env.UPLOADS_PER_DAY || 60),
  // New accounts per address per day.
  signupsPerDay: Number(process.env.SIGNUPS_PER_DAY || 5),
  maxKeysPerUser: 10,
};
