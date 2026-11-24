// The Studywise course marketplace: the site's pages (public/) and its API
// (/api/*). Run it behind a proxy that does HTTPS (Caddy on a server, or
// anything you like in front of the Docker image).
//
// People sign up on the site and make API keys on their account page. The
// app sends a key with every request: to browse courses, publish a week, add
// someone's week, and ask whether a week it's about to plan has already been
// made from the same slides.

import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HttpError, KEY_PREFIX, hashPassword, hashToken, loginBlocked, newApiKey, newId, newToken,
  parseCookies, recordLoginFailure, validPassword, validUsername, verifyPassword,
} from "./lib/auth.js";
import { config } from "./lib/config.js";
import { openDb } from "./lib/db.js";
import { FINGERPRINT_VERSION, inspectWeek, signatureOf, similarity } from "./lib/studyweek.js";
import { betterName, courseKey, sameCourse } from "./lib/courses.js";

const db = openDb(config.dbFile);
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Below this share of the same material, a match is just the same subject.
const SIMILAR_AT = 0.35;
const MAX_MATCHES = 5;
// A week this much the same as one already published goes in that week's
// course, even when the names don't match ("AI" and "Introduction to AI").
const SAME_COURSE_AT = 0.7;
// A wrong username takes as long as a wrong password.
const DUMMY_HASH = await hashPassword(newToken());

const SECURE = Boolean(config.publicUrl?.startsWith("https://"));
const COOKIE = SECURE ? "__Host-session" : "session";

await mkdir(config.weeksDir, { recursive: true });

// Helpers

function send(res, status, body, type, headers = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(body);
}

const json = (res, status, data, headers) => send(res, status, JSON.stringify(data), "application/json", headers);

function clientIp(req) {
  return (config.trustProxy && req.headers["x-forwarded-for"]?.split(",")[0].trim()) || req.socket.remoteAddress;
}

// JSON bodies only: browsers can't send them cross-site without CORS, which
// is one of the layers that stops other sites acting for a logged-in person.
async function readJson(req, limit = 16 * 1024) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "Expected JSON");
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new HttpError(413, "Request too large");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

async function readBody(req, limit) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > limit) throw new HttpError(413, `Weeks can be at most ${Math.round(limit / 1e6)} MB`);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `Weeks can be at most ${Math.round(limit / 1e6)} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sessionCookie(token, maxAgeMs) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${SECURE ? "; Secure" : ""}`;
}

const weekFile = (id) => path.join(config.weeksDir, `${id}.studyweek`);
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

// Views: what the app and the account page see.

function weekView(w, me) {
  return {
    id: w.id,
    courseId: w.courseId,
    label: w.label,
    number: w.number,
    author: w.owner,
    topics: w.topics,
    topicCount: w.topicCount,
    writtenCount: w.writtenCount,
    cardCount: w.cardCount,
    files: w.files,
    size: w.size,
    plannedWith: w.plannedWith,
    writtenWith: w.writtenWith,
    downloads: w.downloads,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    mine: Boolean(me && w.owner === me.name),
  };
}

// Courses belong to nobody: everyone's weeks for a course with the same name
// go in the same course. Weeks belong to whoever published them.
const courseWeeks = (data, c) =>
  data.weeks
    .filter((w) => w.courseId === c.id)
    .sort((a, b) => a.number - b.number || a.label.localeCompare(b.label, undefined, { numeric: true }) || a.owner.localeCompare(b.owner));

/** Everyone who has published a week of the course, most weeks first. */
function authorsOf(weeks) {
  const n = new Map();
  for (const w of weeks) n.set(w.owner, (n.get(w.owner) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

function mergeModels(lists) {
  const m = new Map();
  for (const x of lists.flat()) {
    const k = `${x.provider}|${x.model}|${x.effort}`;
    m.set(k, { ...x, count: (m.get(k)?.count ?? 0) + x.count });
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

function courseView(data, c, me) {
  const weeks = courseWeeks(data, c);
  return {
    id: c.id,
    name: c.name,
    module: c.module,
    level: c.level,
    authors: authorsOf(weeks),
    weekCount: weeks.length,
    topicCount: weeks.reduce((n, w) => n + w.topicCount, 0),
    cardCount: weeks.reduce((n, w) => n + w.cardCount, 0),
    models: mergeModels(weeks.map((w) => w.writtenWith)),
    downloads: weeks.reduce((n, w) => n + w.downloads, 0),
    updatedAt: c.updatedAt,
    // You've published a week of it.
    mine: Boolean(me && weeks.some((w) => w.owner === me.name)),
  };
}

function findWeek(data, id) {
  const w = data.weeks.find((x) => x.id === id);
  if (!w) throw new HttpError(404, "That week isn't on the marketplace any more");
  return w;
}

const canChange = (w, me) => w.owner === me.name || me.owner;

// A course with no weeks left goes too.
function dropEmptyCourses(data) {
  data.courses = data.courses.filter((c) => data.weeks.some((w) => w.courseId === c.id));
}

// Who's asking: a session cookie (the site) or an API key (the app).

async function authenticate(req) {
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (!token.startsWith(KEY_PREFIX)) return null;
    const hash = hashToken(token);
    const data = await db.read();
    const key = data.keys.find((k) => k.hash === hash);
    const user = key && data.users.find((u) => u.name === key.user);
    if (!user) return null;
    // Last used, to the hour: enough to spot an old key, without a write per request.
    if (!key.lastUsed || Date.now() - Date.parse(key.lastUsed) > HOUR_MS) {
      await db.update((d) => {
        const k = d.keys.find((x) => x.id === key.id);
        if (k) k.lastUsed = new Date().toISOString();
      });
    }
    return { ...user, via: "key" };
  }
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const hash = hashToken(token);
  const data = await db.read();
  const session = data.sessions.find((s) => s.hash === hash && s.expires > Date.now());
  const user = session && data.users.find((u) => u.name === session.user);
  return user ? { ...user, via: "session", sessionHash: hash } : null;
}

async function requireUser(req) {
  const me = await authenticate(req);
  if (!me) throw new HttpError(401, "Log in, or send an API key");
  return me;
}

async function requireSession(req) {
  const me = await requireUser(req);
  if (me.via !== "session") throw new HttpError(403, "Do this on the site");
  return me;
}

// Accounts

async function signup(req, res) {
  const body = await readJson(req);
  const name = validUsername(body.name);
  const password = validPassword(body.password);
  const hash = await hashPassword(password);
  const ip = clientIp(req);
  const token = newToken();
  await db.update((data) => {
    data.signups = data.signups.filter((s) => s.at > Date.now() - DAY_MS);
    if (data.signups.filter((s) => s.ip === ip).length >= config.signupsPerDay) throw new HttpError(429, "Too many new accounts from here today. Try again tomorrow.");
    if (data.users.some((u) => u.name === name)) throw new HttpError(409, "That username is taken");
    data.signups.push({ ip, at: Date.now() });
    data.users.push({ name, hash, createdAt: new Date().toISOString(), ip });
    data.sessions.push({ hash: hashToken(token), user: name, expires: Date.now() + config.sessionMs });
  });
  json(res, 200, { user: { name } }, { "set-cookie": sessionCookie(token, config.sessionMs) });
}

async function login(req, res) {
  const ip = clientIp(req);
  if (loginBlocked(ip)) throw new HttpError(429, "Too many tries. Wait a few minutes.");
  const body = await readJson(req);
  const name = String(body.name ?? "").trim().toLowerCase();
  const data = await db.read();
  const user = data.users.find((u) => u.name === name);
  const ok = await verifyPassword(String(body.password ?? ""), user?.hash ?? DUMMY_HASH);
  if (!user || !ok) {
    recordLoginFailure(ip);
    throw new HttpError(401, "Wrong username or password");
  }
  const token = newToken();
  await db.update((d) => {
    d.sessions = d.sessions.filter((s) => s.expires > Date.now());
    d.sessions.push({ hash: hashToken(token), user: user.name, expires: Date.now() + config.sessionMs });
  });
  json(res, 200, { user: { name: user.name } }, { "set-cookie": sessionCookie(token, config.sessionMs) });
}

// Publishing

async function publishWeek(req, res, url, me) {
  if (!req.headers["content-type"]?.startsWith("application/zip")) throw new HttpError(415, "Send the week as application/zip");
  const replaceId = url.searchParams.get("replace");
  const since = Date.now() - DAY_MS;
  const before = await db.read();
  if (replaceId) {
    const w = findWeek(before, replaceId);
    if (w.owner !== me.name) throw new HttpError(404, "That week isn't on the marketplace any more");
  }
  if (before.weeks.filter((w) => w.owner === me.name && Date.parse(w.updatedAt) > since).length >= config.uploadsPerDay) {
    throw new HttpError(429, "That's a lot of weeks for one day. Try again tomorrow.");
  }

  const buf = await readBody(req, config.maxUploadBytes);
  const meta = await inspectWeek(buf);
  const newWeekId = newId();
  const temp = path.join(config.weeksDir, `.${newWeekId}.tmp`);
  await writeFile(temp, buf);

  let saved;
  try {
    saved = await db.update(async (data) => {
      const now = new Date().toISOString();
      // The same course under any of its names, whoever started it, or a new one.
      let course = findCourse(data, meta, replaceId);
      if (!course) {
        course = { id: newId(), name: meta.course.name, module: "", level: "", createdAt: now };
        data.courses.push(course);
      }
      // "Software Engineering 1 (COMP23311)" over "Software Engineering 1".
      course.name = betterName(course.name, meta.course.name);
      // The first week to say a module or level sets it.
      course.module ||= meta.course.module;
      course.level ||= meta.course.level;
      course.updatedAt = now;

      // Replacing: the one asked for, or the same week of the same course published again.
      const existing = replaceId
        ? data.weeks.find((w) => w.id === replaceId && w.owner === me.name)
        : data.weeks.find((w) => w.owner === me.name && w.courseId === course.id && norm(w.label) === norm(meta.label));
      if (replaceId && !existing) throw new HttpError(404, "That week isn't on the marketplace any more");
      const week = existing ?? { id: newWeekId, owner: me.name, downloads: 0, createdAt: now };
      Object.assign(week, {
        courseId: course.id,
        label: meta.label,
        number: meta.number,
        topics: meta.topics,
        topicCount: meta.topicCount,
        writtenCount: meta.writtenCount,
        cardCount: meta.cardCount,
        files: meta.files,
        size: buf.length,
        hashes: meta.hashes,
        sig: meta.sig,
        fv: FINGERPRINT_VERSION,
        plannedWith: meta.plannedWith,
        writtenWith: meta.writtenWith,
        updatedAt: now,
      });
      if (!existing) data.weeks.push(week);
      await rename(temp, weekFile(week.id));
      dropEmptyCourses(data);
      return weekView(week, me);
    });
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
  console.log(`${me.name} published ${saved.id} (${meta.course.name} · ${meta.label}, ${Math.round(buf.length / 1e5) / 10} MB)`);
  json(res, 200, { week: saved });
}

// "Has someone already made this week?" The app sends its week's signature
// and file hashes (never the files), and gets back the closest published weeks.
/** How much of a published week's material is the same as this signature and these file hashes. */
function overlap(w, sig, hashes) {
  const textScore = sig && w.fv === FINGERPRINT_VERSION ? similarity(sig, w.sig) : 0;
  const sameFiles = hashes.filter((h) => w.hashes?.includes(h)).length;
  const fileScore = hashes.length ? sameFiles / hashes.length : 0;
  return { score: Math.max(textScore, fileScore), sameFiles };
}

/**
 * The course a week goes in: the one with the same module code or the same
 * title, or failing that the course of a published week made from the same
 * material. Null for a new course.
 */
function findCourse(data, meta, exceptWeekId) {
  const key = courseKey(meta.course.name, meta.course.module);
  const named = data.courses.filter((c) => sameCourse(courseKey(c.name, c.module), key));
  if (named.length) {
    // More than one (two codes, one plain title): the one with the same code, then the biggest.
    const exact = named.find((c) => key.code && courseKey(c.name, c.module).code === key.code);
    return exact ?? named.sort((a, b) => courseWeeks(data, b).length - courseWeeks(data, a).length)[0];
  }
  let best = null;
  for (const w of data.weeks) {
    if (w.id === exceptWeekId) continue;
    const { score } = overlap(w, meta.sig, meta.hashes);
    if (score >= SAME_COURSE_AT && (!best || score > best.score)) best = { score, courseId: w.courseId };
  }
  return best ? data.courses.find((c) => c.id === best.courseId) : null;
}

function similarWeeks(data, body, me) {
  const sig = signatureOf(body);
  const hashes = Array.isArray(body.hashes) ? body.hashes.filter((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)).slice(0, 200) : [];
  const matches = [];
  for (const w of data.weeks) {
    const { score, sameFiles } = overlap(w, sig, hashes);
    if (score < SIMILAR_AT && !sameFiles) continue;
    const course = data.courses.find((c) => c.id === w.courseId);
    matches.push({ week: weekView(w, me), course: { id: course.id, name: course.name }, score, sameFiles });
  }
  return matches.sort((a, b) => b.score - a.score || b.week.writtenCount - a.week.writtenCount).slice(0, MAX_MATCHES);
}

function matchesQuery(data, c, q) {
  if (!q) return true;
  const hay = [c.name, c.module, ...courseWeeks(data, c).flatMap((w) => [w.owner, w.label, ...w.topics.map((t) => t.title)])].join("\n").toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

// Routes

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === "/api/stats" && m === "GET") {
    const data = await db.read();
    return json(res, 200, { courses: data.courses.length, weeks: data.weeks.length, people: data.users.length });
  }
  if (p === "/api/signup" && m === "POST") return signup(req, res);
  if (p === "/api/login" && m === "POST") return login(req, res);

  const me = await requireUser(req);

  if (p === "/api/me" && m === "GET") return json(res, 200, { user: { name: me.name, owner: Boolean(me.owner) } });
  if (p === "/api/app/me" && m === "GET") return json(res, 200, { user: { name: me.name } });

  if (p === "/api/logout" && m === "POST") {
    await requireSession(req);
    await db.update((d) => {
      d.sessions = d.sessions.filter((s) => s.hash !== me.sessionHash);
    });
    return json(res, 200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
  }

  if (p === "/api/password" && m === "POST") {
    await requireSession(req);
    const body = await readJson(req);
    if (!(await verifyPassword(String(body.current ?? ""), me.hash))) throw new HttpError(400, "Your current password is wrong");
    const hash = await hashPassword(validPassword(body.next));
    await db.update((d) => {
      d.users.find((u) => u.name === me.name).hash = hash;
      // Every other session ends.
      d.sessions = d.sessions.filter((s) => s.user !== me.name || s.hash === me.sessionHash);
    });
    return json(res, 200, { ok: true });
  }

  // API keys, made and removed on the site only.
  if (p === "/api/keys" && m === "GET") {
    await requireSession(req);
    const data = await db.read();
    const keys = data.keys.filter((k) => k.user === me.name).map(({ id, label, prefix, createdAt, lastUsed }) => ({ id, label, prefix, createdAt, lastUsed: lastUsed ?? null }));
    return json(res, 200, { keys });
  }
  if (p === "/api/keys" && m === "POST") {
    await requireSession(req);
    const body = await readJson(req);
    const label = String(body.label ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || "Studywise";
    const key = newApiKey();
    const info = await db.update((d) => {
      if (d.keys.filter((k) => k.user === me.name).length >= config.maxKeysPerUser) throw new HttpError(400, `You can have ${config.maxKeysPerUser} keys. Delete one you don't use first.`);
      const k = { id: newId(), user: me.name, label, hash: hashToken(key), prefix: key.slice(0, KEY_PREFIX.length + 6), createdAt: new Date().toISOString() };
      d.keys.push(k);
      return { id: k.id, label, prefix: k.prefix, createdAt: k.createdAt, lastUsed: null };
    });
    return json(res, 200, { key, info });
  }
  const keyMatch = p.match(/^\/api\/keys\/([0-9a-f]{16})$/);
  if (keyMatch && m === "DELETE") {
    await requireSession(req);
    await db.update((d) => {
      d.keys = d.keys.filter((k) => !(k.id === keyMatch[1] && k.user === me.name));
    });
    return json(res, 200, { ok: true });
  }

  // Browsing.
  if (p === "/api/courses" && m === "GET") {
    const data = await db.read();
    const q = norm(url.searchParams.get("q")).slice(0, 200);
    const sort = url.searchParams.get("sort") === "popular" ? "popular" : "recent";
    const courses = data.courses.filter((c) => matchesQuery(data, c, q)).map((c) => courseView(data, c, me));
    courses.sort(sort === "popular" ? (a, b) => b.downloads - a.downloads || b.updatedAt.localeCompare(a.updatedAt) : (a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return json(res, 200, { courses: courses.slice(0, 300) });
  }
  const courseMatch = p.match(/^\/api\/courses\/([0-9a-f]{16})$/);
  if (courseMatch && m === "GET") {
    const data = await db.read();
    const c = data.courses.find((x) => x.id === courseMatch[1]);
    if (!c) throw new HttpError(404, "That course isn't on the marketplace any more");
    return json(res, 200, { course: { ...courseView(data, c, me), weeks: courseWeeks(data, c).map((w) => weekView(w, me)) } });
  }

  if (p === "/api/mine" && m === "GET") {
    const data = await db.read();
    const weeks = data.weeks
      .filter((w) => w.owner === me.name)
      .map((w) => ({ ...weekView(w, me), courseName: data.courses.find((c) => c.id === w.courseId)?.name ?? "" }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return json(res, 200, { weeks });
  }

  // Everything published, for the site owner to take down anything that shouldn't be there.
  if (p === "/api/admin/weeks" && m === "GET") {
    if (!me.owner) throw new HttpError(403, "Only the site owner can see this");
    const data = await db.read();
    const weeks = data.weeks
      .map((w) => ({ ...weekView(w, me), courseName: data.courses.find((c) => c.id === w.courseId)?.name ?? "" }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return json(res, 200, { weeks });
  }

  if (p === "/api/weeks" && m === "POST") return publishWeek(req, res, url, me);

  if (p === "/api/similar" && m === "POST") {
    const body = await readJson(req, 64 * 1024);
    return json(res, 200, { matches: similarWeeks(await db.read(), body, me) });
  }

  const weekMatch = p.match(/^\/api\/weeks\/([0-9a-f]{16})(\/file)?$/);
  if (weekMatch && m === "GET" && weekMatch[2]) {
    const data = await db.read();
    const w = findWeek(data, weekMatch[1]);
    const file = weekFile(w.id);
    const { size } = await stat(file);
    if (w.owner !== me.name) {
      await db.update((d) => {
        const x = d.weeks.find((y) => y.id === w.id);
        if (x) x.downloads++;
      });
    }
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": size,
      "content-disposition": `attachment; filename="${w.id}.studyweek"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    createReadStream(file).pipe(res);
    return;
  }
  if (weekMatch && !weekMatch[2] && m === "DELETE") {
    await db.update((d) => {
      const w = findWeek(d, weekMatch[1]);
      if (!canChange(w, me)) throw new HttpError(403, "That isn't your week");
      d.weeks = d.weeks.filter((x) => x.id !== w.id);
      dropEmptyCourses(d);
    });
    await rm(weekFile(weekMatch[1]), { force: true });
    return json(res, 200, { ok: true });
  }

  throw new HttpError(404, "Not found");
}

// Pages: /account serves account.html, and so on.
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const PAGE_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  // Browsers recheck pages and scripts on each visit, so an update shows up straight away.
  "cache-control": "no-cache",
};

async function page(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Not allowed");
  const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = /^[a-z0-9-]+\.[a-z]+$/.test(name) ? name : /^[a-z0-9-]+$/.test(name) ? `${name}.html` : null;
  const type = file && TYPES[path.extname(file)];
  const body = type && (await readFile(path.join(PUBLIC, file)).catch(() => null));
  if (body) return send(res, 200, req.method === "HEAD" ? "" : body, type, PAGE_HEADERS);
  const notFound = await readFile(path.join(PUBLIC, "404.html")).catch(() => "Not found");
  send(res, 404, notFound, "text/html; charset=utf-8", PAGE_HEADERS);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (!url.pathname.startsWith("/api/")) return await page(req, res, url);
    await api(req, res, url);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) json(res, status, { error: status === 500 ? "Something went wrong on the server" : err.message });
    else res.destroy();
    // Stop reading a body we've refused (too big, wrong type).
    if (!req.complete) req.resume();
  }
});
// Courses used to belong to whoever published to them first, and only exact
// names matched. Now they're shared, under any of their names: merge courses
// that are the same (see lib/courses.js), and drop the owner.
await db.update((data) => {
  const kept = [];
  for (const c of [...data.courses].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    delete c.owner;
    const keep = kept.find((k) => sameCourse(courseKey(k.name, k.module), courseKey(c.name, c.module)));
    if (!keep) {
      kept.push(c);
      continue;
    }
    for (const w of data.weeks) if (w.courseId === c.id) w.courseId = keep.id;
    keep.name = betterName(keep.name, c.name);
    keep.module ||= c.module;
    keep.level ||= c.level;
    if (c.updatedAt > keep.updatedAt) keep.updatedAt = c.updatedAt;
  }
  data.courses = kept;
});

server.requestTimeout = 15 * 60 * 1000;
server.listen(config.port, config.host, () => console.log(`studywise-server on ${config.host}:${config.port}`));
