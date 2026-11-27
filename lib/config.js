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
  // Slides and planned weeks people upload for a requested week (lib/requests.js), a folder per request.
  requestsDir: path.join(dataDir, "requests"),
  // Each file someone uploads for a request, and all of one request's files together.
  maxRequestFileBytes: Number(process.env.MAX_REQUEST_FILE_MB || 100) * 1000 * 1000,
  maxRequestBytes: Number(process.env.MAX_REQUEST_MB || 400) * 1000 * 1000,
  // Cloud sync and backup: each account's library, files and snapshots (lib/cloud.js).
  cloudDir: path.join(dataDir, "cloud"),
  // Room per account unless an admin gives someone more or less.
  cloudQuotaBytes: Number(process.env.CLOUD_QUOTA_GB || 5) * 1000 * 1000 * 1000,
};
