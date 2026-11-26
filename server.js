// The Studywise course marketplace: the site's pages (public/) and its API
// (/api/*). Run it behind a proxy that does HTTPS (Caddy on a server, or
// anything you like in front of the Docker image).
//
// People sign up on the site and make API keys on their account page. The
// app sends a key with every request: to browse courses, publish a week, add
// someone's week, and ask whether a week it's about to plan has already been
// made from the same slides.

import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HttpError, KEY_PREFIX, generatePassword, hashPassword, hashToken, loginBlocked, newApiKey, newId, newToken,
  parseCookies, recordLoginFailure, validPassword, validUsername, verifyPassword,
} from "./lib/auth.js";
import { config } from "./lib/config.js";
import { openDb } from "./lib/db.js";
import { FINGERPRINT_VERSION, inspectWeek, signatureOf, similarity } from "./lib/studyweek.js";
import { betterName, courseKey, likelySameCourse, sameCourse, weekNumber } from "./lib/courses.js";
import { openCloud } from "./lib/cloud.js";
import { REPORT_REASONS, openEvents } from "./lib/events.js";

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
const cloud = openCloud(config.cloudDir);
const events = openEvents(config.dataDir);
const quotaOf = (u) => (typeof u?.cloudQuota === "number" ? u.cloudQuota : config.cloudQuotaBytes);

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
    // Everyone whose work is in it: one person, or several for a merged week.
    authors: authorsOfWeek(w),
    merged: Boolean(w.mergedFrom?.length),
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

/** Whose work a week holds: whoever published it, or everyone whose copies were merged into it. */
const authorsOfWeek = (w) => (w.authors?.length ? w.authors : [w.owner]);

/** Everyone who has published a week of the course, most weeks first. */
function authorsOf(weeks) {
  const n = new Map();
  for (const w of weeks) for (const a of authorsOfWeek(w)) n.set(a, (n.get(a) ?? 0) + 1);
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
  if (me.suspended) throw new HttpError(403, "This account is suspended. Ask the site's admin if you think that's a mistake.");
  events.active(me.name);
  return me;
}

/** Who can sign up: anyone, people with an invite code, or nobody. */
const signupMode = (data) => data.settings?.signups ?? "open";

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
    const mode = signupMode(data);
    if (mode === "closed") throw new HttpError(403, "Sign-ups are closed on this site.");
    if (mode === "invite") {
      const code = String(body.invite ?? "").trim().toLowerCase();
      const inv = (data.invites ?? []).find((i) => i.code === code && !i.usedBy && (!i.expires || i.expires > new Date().toISOString()));
      if (!inv) throw new HttpError(403, code ? "That invite code doesn't work (it may have been used or expired)." : "You need an invite code to sign up here.");
      inv.usedBy = name;
      inv.usedAt = new Date().toISOString();
    }
    data.signups.push({ ip, at: Date.now() });
    data.users.push({ name, hash, createdAt: new Date().toISOString(), ip });
    data.sessions.push({ hash: hashToken(token), user: name, expires: Date.now() + config.sessionMs });
  });
  events.log(name, "signup");
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
  if (user.suspended) throw new HttpError(403, "This account is suspended. Ask the site's admin if you think that's a mistake.");
  const token = newToken();
  await db.update((d) => {
    d.sessions = d.sessions.filter((s) => s.expires > Date.now());
    d.sessions.push({ hash: hashToken(token), user: user.name, expires: Date.now() + config.sessionMs });
    // For the admin page: when each person last logged in.
    const u = d.users.find((x) => x.name === user.name);
    if (u) u.lastLogin = new Date().toISOString();
  });
  events.log(user.name, "login");
  json(res, 200, { user: { name: user.name } }, { "set-cookie": sessionCookie(token, config.sessionMs) });
}

// Publishing

async function publishWeek(req, res, url, me) {
  if (!req.headers["content-type"]?.startsWith("application/zip")) throw new HttpError(415, "Send the week as application/zip");
  const replaceId = url.searchParams.get("replace");
  const since = Date.now() - DAY_MS;
  const before = await db.read();
  if (replaceId) {
    // Merged into another week since: the app merges its copy into that one (POST /api/weeks/merge) instead.
    const into = mergedTarget(before, replaceId);
    if (into) throw mergedError(into);
    const w = findWeek(before, replaceId);
    // A merged week holds several people's work: it only changes by merging more into it.
    if (w.mergedFrom?.length && authorsOfWeek(w).includes(me.name)) throw mergedError(w.id);
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
      if (!existing) {
        // Your copy of this week was merged with other people's: add to that one rather than starting another copy.
        const merged = data.weeks.find((w) => w.mergedFrom?.length && w.courseId === course.id && norm(w.label) === norm(meta.label) && authorsOfWeek(w).includes(me.name));
        if (merged) throw mergedError(merged.id);
      }
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
  events.log(me.name, "publish", saved.id, { week: `${meta.course.name} · ${meta.label}`, bytes: buf.length, replaced: Boolean(replaceId) });
  json(res, 200, { week: saved });
}

// Merging: several copies of the same week (or more work into a merged week)
// become one week, for everyone. The app does the merging (it has the topics
// and knows what repeats); the server checks nothing was lost and swaps the
// copies for the merged week.

/** Where a merged-away week went (following merges of merges), if that week is still here. */
function mergedTarget(data, id) {
  let at = id;
  for (let i = 0; i < 50 && data.mergedInto?.[at]; i++) at = data.mergedInto[at];
  return at !== id && data.weeks.some((w) => w.id === at) ? at : null;
}

const mergedError = (into) => new HttpError(409, "This week has been merged with other people's copies of it. Your app adds yours to the merged week.", { mergedInto: into });

async function mergeWeeks(req, res, url, me) {
  if (!req.headers["content-type"]?.startsWith("application/zip")) throw new HttpError(415, "Send the merged week as application/zip");
  const ids = [...new Set(String(url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (!ids.length || ids.length > 30 || ids.some((id) => !/^[0-9a-f]{16}$/.test(id))) throw new HttpError(400, "Say which weeks the merge replaces");
  const since = Date.now() - DAY_MS;
  const before = await db.read();
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
      const sources = ids.map((id) => findWeek(data, id));
      const courseId = sources[0].courseId;
      if (sources.some((s) => s.courseId !== courseId)) throw new HttpError(400, "Those weeks are in different courses, so they can't be merged");
      // Nothing may be lost: the merge has at least as much as each copy, and every one of their files.
      const files = new Set(meta.hashes ?? []);
      for (const s of sources) {
        const short = meta.topicCount < s.topicCount || meta.writtenCount < s.writtenCount || meta.cardCount < s.cardCount || (s.hashes ?? []).some((h) => !files.has(h));
        if (short) throw new HttpError(400, `The merged week has less in it than ${s.owner}'s copy (topics, written topics, flashcards or files), so it wasn't saved`);
      }
      // Merging more into a merged week keeps it (same id, so links to it still work); otherwise a new week replaces the copies.
      const keep = sources.length === 1 ? sources[0] : null;
      const week = keep ?? { id: newWeekId, owner: me.name, downloads: 0, createdAt: sources.map((s) => s.createdAt).sort()[0] ?? now };
      const replaced = sources.filter((s) => s !== keep);
      Object.assign(week, {
        courseId,
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
        // Credit stays with whoever wrote it, whoever does the merging.
        authors: [...new Set(sources.flatMap(authorsOfWeek))],
        mergedFrom: [...new Set([...(keep?.mergedFrom ?? []), ...replaced.flatMap((s) => [s.id, ...(s.mergedFrom ?? [])])])],
        downloads: keep ? keep.downloads : replaced.reduce((n, s) => n + (s.downloads ?? 0), 0),
        updatedAt: now,
      });
      const gone = new Set(replaced.map((s) => s.id));
      if (!keep) {
        data.weeks = data.weeks.filter((w) => !gone.has(w.id));
        data.weeks.push(week);
      }
      // Remember where each copy went, so its author publishing it again merges in instead of adding another copy.
      data.mergedInto ??= {};
      for (const id of gone) data.mergedInto[id] = week.id;
      for (const [from, to] of Object.entries(data.mergedInto)) if (gone.has(to)) data.mergedInto[from] = week.id;
      const course = data.courses.find((c) => c.id === courseId);
      if (course) course.updatedAt = now;
      await rename(temp, weekFile(week.id));
      dropEmptyCourses(data);
      return { view: weekView(week, me), gone: [...gone] };
    });
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
  for (const id of saved.gone) await rm(weekFile(id), { force: true });
  console.log(`${me.name} merged ${ids.join(", ")} into ${saved.view.id} (${meta.course.name} · ${meta.label})`);
  events.log(me.name, "merge", saved.view.id, { week: `${meta.course.name} · ${meta.label}`, from: ids });
  json(res, 200, { week: saved.view, replaced: saved.gone });
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

// "Has someone already made this week?" The app sends its week's signature and
// file hashes (never the files), and its course name and week label. A
// published week matches when its material is mostly the same, or when it's
// the same week number of what looks like the same course (even before any
// slides are added).
function similarWeeks(data, body, me) {
  const sig = signatureOf(body);
  const hashes = Array.isArray(body.hashes) ? body.hashes.filter((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)).slice(0, 200) : [];
  const mine = { name: String(body.course ?? "").slice(0, 200), module: String(body.module ?? "").slice(0, 200) };
  const wanted = weekNumber(String(body.week ?? "").slice(0, 200));
  const matches = [];
  for (const w of data.weeks) {
    const { score, sameFiles } = overlap(w, sig, hashes);
    const course = data.courses.find((c) => c.id === w.courseId);
    const sameWeek = wanted !== null && Boolean(mine.name) && weekNumber(w.label) === wanted && likelySameCourse(mine, course);
    if (score < SIMILAR_AT && !sameFiles && !sameWeek) continue;
    matches.push({ week: weekView(w, me), course: { id: course.id, name: course.name }, score, sameFiles, sameWeek });
  }
  // Same material first, then the same week of the same course; more written first.
  const rank = (m) => (m.score >= SIMILAR_AT || m.sameFiles ? 2 + m.score : 0) + (m.sameWeek ? 1 : 0);
  return matches.sort((a, b) => rank(b) - rank(a) || b.week.writtenCount - a.week.writtenCount).slice(0, MAX_MATCHES);
}

function matchesQuery(data, c, q) {
  if (!q) return true;
  const hay = [c.name, c.module, ...courseWeeks(data, c).flatMap((w) => [w.owner, w.label, ...w.topics.map((t) => t.title)])].join("\n").toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

// Cloud sync and backup (lib/cloud.js): the app sends its key, and its device
// in each push and pull. Files go as base64 in JSON, which every HTTP layer
// (the phone's included) sends the same way.

const CLOUD_JSON_LIMIT = 80 * 1000 * 1000;

function deviceOf(body) {
  const d = body?.device;
  return d && typeof d.id === "string" ? { id: d.id, name: String(d.name ?? ""), kind: d.kind } : null;
}

async function cloudRoutes(req, res, url, p, m, me) {
  const user = me.name;
  if (p === "/api/cloud" && m === "GET") return json(res, 200, { ...cloud.status(user), quota: quotaOf(me) });
  if (p === "/api/cloud" && m === "DELETE") {
    cloud.remove(user);
    console.log(`${user} deleted their cloud copy`);
    events.log(user, "cloud-delete", user);
    return json(res, 200, { ok: true });
  }
  if (p === "/api/cloud/push" && m === "POST") {
    const body = await readJson(req, CLOUD_JSON_LIMIT);
    return json(res, 200, cloud.push(user, { changes: body.changes, device: deviceOf(body) }, quotaOf(me)));
  }
  if (p === "/api/cloud/pull" && m === "POST") {
    const body = await readJson(req, 64 * 1024);
    return json(res, 200, cloud.pull(user, { since: body.since, device: deviceOf(body) }));
  }
  if (p === "/api/cloud/have" && m === "POST") {
    const body = await readJson(req, 4 * 1000 * 1000);
    return json(res, 200, cloud.haveFiles(user, { attachments: Array.isArray(body.attachments) ? body.attachments : [], courseFiles: Array.isArray(body.courseFiles) ? body.courseFiles : [] }));
  }
  const kindName = p === "/api/cloud/course-file" ? ["course", url.searchParams.get("id") ?? ""] : p === "/api/cloud/file" ? ["attach", cloud.attachName(url.searchParams.get("u"))] : null;
  if (kindName && m === "GET") {
    const bytes = cloud.readFile(user, ...kindName);
    if (!bytes) throw new HttpError(404, "That file isn't in the cloud yet");
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(bytes);
    return;
  }
  if (kindName && m === "PUT") {
    const body = await readJson(req, CLOUD_JSON_LIMIT);
    if (typeof body.data !== "string") throw new HttpError(400, "Expected the file as base64");
    cloud.writeFile(user, ...kindName, Buffer.from(body.data, "base64"), quotaOf(me));
    return json(res, 200, { ok: true });
  }
  throw new HttpError(404, "Not found");
}

// Admin: everything on the site, what it takes up on disk, and the tools to
// look after it. Only accounts marked as owners (sudo studywise-server-admin
// make-owner <name>) get in, and only from the site, never with an API key.

async function requireAdmin(req) {
  const me = await requireSession(req);
  if (!me.owner) throw new HttpError(403, "Only admins can do this");
  return me;
}

/** Every file in the weeks folder and its size. Unfinished uploads (.ID.tmp) younger than an hour are left out. */
async function filesOnDisk() {
  const files = new Map();
  for (const f of await readdir(config.weeksDir).catch(() => [])) {
    const s = await stat(path.join(config.weeksDir, f)).catch(() => null);
    if (!s?.isFile()) continue;
    if (f.endsWith(".tmp") && Date.now() - s.mtimeMs < HOUR_MS) continue;
    files.set(f, s.size);
  }
  return files;
}

async function adminOverview() {
  const data = await db.read();
  const files = await filesOnDisk();
  const sizeOf = (w) => files.get(`${w.id}.studyweek`) ?? 0;
  const known = new Set(data.weeks.map((w) => `${w.id}.studyweek`));
  const leftovers = [...files].filter(([f]) => !known.has(f));
  const dbBytes = (await stat(config.dbFile).catch(() => null))?.size ?? 0;
  const fsInfo = await statfs(config.dataDir).catch(() => null);
  const now = Date.now();
  const recent = (iso) => iso && now - Date.parse(iso) < 7 * DAY_MS;
  const courseName = (id) => data.courses.find((c) => c.id === id)?.name ?? "";
  const cloudOf = (u) => {
    if (!cloud.has(u.name)) return { on: false, usage: { data: 0, files: 0, snapshots: 0, total: 0 }, quota: quotaOf(u), devices: 0, lastChange: null };
    const st = cloud.status(u.name);
    return { on: true, usage: st.usage, quota: quotaOf(u), devices: st.devices.length, lastChange: st.lastChange, rows: st.rows };
  };

  const weeks = data.weeks
    .map((w) => ({ ...weekView(w, null), courseName: courseName(w.courseId), bytes: sizeOf(w), missing: !files.has(`${w.id}.studyweek`) }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const users = data.users.map((u) => {
    const mine = data.weeks.filter((w) => w.owner === u.name);
    const keys = data.keys.filter((k) => k.user === u.name);
    const keyUse = keys.map((k) => k.lastUsed).filter(Boolean).sort().at(-1) ?? null;
    return {
      name: u.name,
      owner: Boolean(u.owner),
      createdAt: u.createdAt,
      lastLogin: u.lastLogin ?? null,
      lastKeyUse: keyUse,
      keys: keys.length,
      sessions: data.sessions.filter((s) => s.user === u.name && s.expires > now).length,
      weeks: mine.length,
      bytes: mine.reduce((n, w) => n + sizeOf(w), 0),
      downloads: mine.reduce((n, w) => n + (w.downloads ?? 0), 0),
      cloud: cloudOf(u),
      suspended: Boolean(u.suspended),
    };
  });
  const courses = data.courses.map((c) => {
    const ws = courseWeeks(data, c);
    return {
      id: c.id,
      name: c.name,
      module: c.module,
      level: c.level,
      authors: authorsOf(ws),
      weeks: ws.length,
      topics: ws.reduce((n, w) => n + w.topicCount, 0),
      cards: ws.reduce((n, w) => n + w.cardCount, 0),
      downloads: ws.reduce((n, w) => n + (w.downloads ?? 0), 0),
      bytes: ws.reduce((n, w) => n + sizeOf(w), 0),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  });
  const weeksBytes = weeks.reduce((n, w) => n + w.bytes, 0);
  const cloudUsers = users.filter((u) => u.cloud.on);
  return {
    totals: {
      people: users.length,
      admins: users.filter((u) => u.owner).length,
      courses: courses.length,
      weeks: weeks.length,
      topics: weeks.reduce((n, w) => n + w.topicCount, 0),
      written: weeks.reduce((n, w) => n + w.writtenCount, 0),
      cards: weeks.reduce((n, w) => n + w.cardCount, 0),
      downloads: weeks.reduce((n, w) => n + (w.downloads ?? 0), 0),
      keys: data.keys.length,
      newPeople: users.filter((u) => recent(u.createdAt)).length,
      newWeeks: data.weeks.filter((w) => recent(w.createdAt)).length,
      updatedWeeks: data.weeks.filter((w) => recent(w.updatedAt)).length,
      openReports: events.openReports(),
      signups: signupMode(data),
      activeToday: events.trends(7).at(-1).active,
    },
    storage: {
      weeks: weeksBytes,
      // Cloud sync and backup: people's libraries and files, and the daily snapshots of them.
      cloud: cloudUsers.reduce((n, u) => n + u.cloud.usage.data + u.cloud.usage.files, 0),
      snapshots: cloudUsers.reduce((n, u) => n + u.cloud.usage.snapshots, 0),
      cloudPeople: cloudUsers.length,
      leftovers: { count: leftovers.length, bytes: leftovers.reduce((n, [, b]) => n + b, 0) },
      db: dbBytes,
      // The disk the data folder is on: its size, and what's still free.
      disk: fsInfo ? { total: fsInfo.blocks * fsInfo.bsize, free: fsInfo.bavail * fsInfo.bsize } : null,
    },
    users: users.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)),
    courses: courses.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    weeks,
  };
}

/** Reads a JSON body once and keeps it on the request, for handlers that look before they choose. */
async function peekJson(req) {
  req.parsedBody ??= await readJson(req);
  return req.parsedBody;
}
function userMatchIsSuspend(body, name, me) {
  if (typeof body.suspended !== "boolean") return false;
  if (name === me.name) throw new HttpError(400, "You can't suspend yourself");
  return true;
}

async function adminRoutes(req, res, p, m) {
  const me = await requireAdmin(req);
  if (p === "/api/admin/overview" && m === "GET") return json(res, 200, await adminOverview());

  const cloudMatch = p.match(/^\/api\/admin\/users\/([a-z0-9_-]{2,32})\/cloud(\/restore)?$/);
  if (cloudMatch) {
    const [, name, restore] = cloudMatch;
    const data = await db.read();
    const u = data.users.find((x) => x.name === name);
    if (!u) throw new HttpError(404, "No such account");
    if (!restore && m === "GET") return json(res, 200, { ...cloud.status(name), quota: quotaOf(u) });
    if (!restore && m === "PATCH") {
      const body = await readJson(req);
      const gb = Number(body.quotaGb);
      if (!Number.isFinite(gb) || gb < 0 || gb > 10000) throw new HttpError(400, "Give the limit in GB");
      await db.update((d) => {
        d.users.find((x) => x.name === name).cloudQuota = Math.round(gb * 1e9);
      });
      console.log(`${me.name} set ${name}'s cloud limit to ${gb} GB`);
      events.log(me.name, "cloud-limit", name, { gb });
      return json(res, 200, { ok: true });
    }
    if (restore && m === "POST") {
      const body = await readJson(req);
      const r = cloud.restore(name, String(body.day ?? ""));
      console.log(`${me.name} restored ${name}'s cloud copy to ${body.day} (${r.changed} rows)`);
      events.log(me.name, "cloud-restore", name, { day: body.day, changed: r.changed });
      return json(res, 200, r);
    }
    if (!restore && m === "DELETE") {
      cloud.remove(name);
      console.log(`${me.name} deleted ${name}'s cloud copy`);
      events.log(me.name, "cloud-delete", name, null);
      return json(res, 200, { ok: true });
    }
  }

  const userMatch = p.match(/^\/api\/admin\/users\/([a-z0-9_-]{2,32})(\/password|\/logout)?$/);
  if (userMatch) {
    const [, name, action] = userMatch;
    if (!action && m === "PATCH" && userMatchIsSuspend(await peekJson(req), name, me)) {
      const body = req.parsedBody;
      await db.update((d) => {
        const u = d.users.find((x) => x.name === name);
        if (!u) throw new HttpError(404, "No such account");
        u.suspended = body.suspended ? { at: new Date().toISOString(), by: me.name, reason: String(body.reason ?? "").slice(0, 300) } : undefined;
        // Suspended: logged out of the site everywhere (their keys stop working while it lasts).
        if (body.suspended) d.sessions = d.sessions.filter((s) => s.user !== name);
      });
      events.log(me.name, body.suspended ? "suspend" : "unsuspend", name, body.suspended && body.reason ? { reason: String(body.reason).slice(0, 300) } : null);
      return json(res, 200, { ok: true });
    }
    if (!action && m === "PATCH") {
      const body = req.parsedBody ?? (await readJson(req));
      if (typeof body.owner !== "boolean") throw new HttpError(400, "Say whether they're an admin");
      if (name === me.name && !body.owner) throw new HttpError(400, "You can't take away your own admin");
      await db.update((d) => {
        const u = d.users.find((x) => x.name === name);
        if (!u) throw new HttpError(404, "No such account");
        u.owner = body.owner || undefined;
      });
      console.log(`${me.name} ${body.owner ? "made" : "removed"} ${name} ${body.owner ? "an admin" : "as admin"}`);
      events.log(me.name, `admin-${body.owner ? "add" : "remove"}`, name, null);
      return json(res, 200, { ok: true });
    }
    if (!action && m === "GET") {
      const data = await db.read();
      const u = data.users.find((x) => x.name === name);
      if (!u) throw new HttpError(404, "No such account");
      const now = Date.now();
      const weeks = data.weeks
        .filter((w) => authorsOfWeek(w).includes(name))
        .map((w) => ({ ...weekView(w, null), courseName: data.courses.find((c) => c.id === w.courseId)?.name ?? "" }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return json(res, 200, {
        user: { name: u.name, owner: Boolean(u.owner), suspended: u.suspended ?? null, createdAt: u.createdAt, lastLogin: u.lastLogin ?? null, onLeaderboard: !u.hideFromLeaderboard, sessions: data.sessions.filter((s) => s.user === name && s.expires > now).length, invitedWith: (data.invites ?? []).find((i) => i.usedBy === name)?.code ?? null },
        keys: data.keys.filter((k) => k.user === name).map(({ id, label, prefix, createdAt, lastUsed }) => ({ id, label, prefix, createdAt, lastUsed: lastUsed ?? null })),
        weeks,
        cloud: { ...cloud.status(name), quota: quotaOf(u) },
        study: cloud.stats(name),
        activity: events.activity({ actor: name, limit: 200 }),
        reports: { about: events.reports().filter((r) => r.author === name), by: events.reports().filter((r) => r.reporter === name) },
      });
    }
    if (action === "/password" && m === "POST") {
      const password = generatePassword();
      const hash = await hashPassword(password);
      await db.update((d) => {
        const u = d.users.find((x) => x.name === name);
        if (!u) throw new HttpError(404, "No such account");
        u.hash = hash;
        d.sessions = d.sessions.filter((s) => s.user !== name || s.hash === me.sessionHash);
      });
      console.log(`${me.name} reset the password of ${name}`);
      events.log(me.name, "password-reset", name, null);
      return json(res, 200, { password });
    }
    if (action === "/logout" && m === "POST") {
      await db.update((d) => {
        if (!d.users.some((x) => x.name === name)) throw new HttpError(404, "No such account");
        d.sessions = d.sessions.filter((s) => s.user !== name || s.hash === me.sessionHash);
      });
      return json(res, 200, { ok: true });
    }
    if (!action && m === "DELETE") {
      if (name === me.name) throw new HttpError(400, "You can't delete your own account here");
      const gone = await db.update((d) => {
        if (!d.users.some((u) => u.name === name)) throw new HttpError(404, "No such account");
        const ids = d.weeks.filter((w) => w.owner === name).map((w) => w.id);
        d.users = d.users.filter((u) => u.name !== name);
        d.sessions = d.sessions.filter((s) => s.user !== name);
        d.keys = d.keys.filter((k) => k.user !== name);
        d.weeks = d.weeks.filter((w) => w.owner !== name);
        dropEmptyCourses(d);
        return ids;
      });
      for (const id of gone) await rm(weekFile(id), { force: true });
      cloud.remove(name);
      console.log(`${me.name} deleted ${name} and ${gone.length} weeks`);
      events.log(me.name, "account-delete", name, { weeks: gone.length });
      return json(res, 200, { ok: true, weeks: gone.length });
    }
  }

  const keyMatch = p.match(/^\/api\/admin\/users\/([a-z0-9_-]{2,32})\/keys\/([0-9a-f]{16})$/);
  if (keyMatch && m === "DELETE") {
    await db.update((d) => {
      d.keys = d.keys.filter((k) => !(k.id === keyMatch[2] && k.user === keyMatch[1]));
    });
    events.log(me.name, "key-revoke", keyMatch[1], { key: keyMatch[2] });
    return json(res, 200, { ok: true });
  }

  if (p === "/api/admin/activity" && m === "GET") {
    const q = new URL(req.url, "http://x").searchParams;
    return json(res, 200, { activity: events.activity({ actor: q.get("who") || undefined, action: q.get("what") || undefined, before: q.get("before") || undefined, limit: 100 }) });
  }
  if (p === "/api/admin/trends" && m === "GET") {
    await recordToday();
    const days = Math.max(7, Math.min(365, Number(new URL(req.url, "http://x").searchParams.get("days")) || 30));
    return json(res, 200, { days: events.trends(days) });
  }

  if (p === "/api/admin/reports" && m === "GET") {
    const status = new URL(req.url, "http://x").searchParams.get("status");
    return json(res, 200, { reports: events.reports(["open", "dismissed", "removed"].includes(status) ? status : null), reasons: REPORT_REASONS });
  }
  const reportMatch = p.match(/^\/api\/admin\/reports\/([0-9a-f]{16})$/);
  if (reportMatch && m === "POST") {
    const body = await readJson(req);
    const r = events.getReport(reportMatch[1]);
    if (!r) throw new HttpError(404, "No such report");
    if (body.action === "remove") {
      const gone = await db.update((d) => {
        const had = d.weeks.some((w) => w.id === r.week_id);
        d.weeks = d.weeks.filter((w) => w.id !== r.week_id);
        dropEmptyCourses(d);
        return had;
      });
      if (gone) await rm(weekFile(r.week_id), { force: true });
      events.resolveWeek(r.week_id, me.name);
      events.resolve(r.id, "removed", me.name);
      events.log(me.name, "take-down", r.week_id, { week: r.week_name, author: r.author, byAdmin: true, report: r.id });
    } else {
      events.resolve(r.id, "dismissed", me.name);
      events.log(me.name, "report-dismiss", r.week_id, { week: r.week_name, report: r.id });
    }
    return json(res, 200, { ok: true });
  }

  // Who can sign up, invite codes, and the announcement.
  if (p === "/api/admin/settings" && m === "GET") {
    const data = await db.read();
    return json(res, 200, { signups: signupMode(data), invites: (data.invites ?? []).slice().reverse(), announcement: data.announcement ?? null });
  }
  if (p === "/api/admin/settings" && m === "PATCH") {
    const body = await readJson(req);
    if (!["open", "invite", "closed"].includes(body.signups)) throw new HttpError(400, "Sign-ups are open, invite or closed");
    await db.update((d) => {
      d.settings = { ...(d.settings ?? {}), signups: body.signups };
    });
    events.log(me.name, "signups", null, { mode: body.signups });
    return json(res, 200, { ok: true });
  }
  if (p === "/api/admin/invites" && m === "POST") {
    const body = await readJson(req);
    const days = Number(body.days) || 0;
    const invite = { code: randomBytes(5).toString("hex"), createdBy: me.name, createdAt: new Date().toISOString(), expires: days > 0 ? new Date(Date.now() + days * DAY_MS).toISOString() : null, note: String(body.note ?? "").slice(0, 100) };
    await db.update((d) => {
      (d.invites ??= []).push(invite);
    });
    events.log(me.name, "invite", invite.code, invite.note ? { note: invite.note } : null);
    return json(res, 200, { invite });
  }
  const inviteMatch = p.match(/^\/api\/admin\/invites\/([0-9a-f]{10})$/);
  if (inviteMatch && m === "DELETE") {
    await db.update((d) => {
      d.invites = (d.invites ?? []).filter((i) => i.code !== inviteMatch[1]);
    });
    return json(res, 200, { ok: true });
  }
  if (p === "/api/admin/announcement" && m === "PUT") {
    const body = await readJson(req);
    const text = String(body.text ?? "").trim().slice(0, 500);
    if (!text) throw new HttpError(400, "Write the message");
    const days = Number(body.days) || 0;
    const link = String(body.link ?? "").trim().slice(0, 300);
    if (link && !/^https?:\/\//.test(link)) throw new HttpError(400, "The link has to start with https://");
    const a = { id: randomBytes(4).toString("hex"), text, level: body.level === "warn" ? "warn" : "info", link: link || null, at: new Date().toISOString(), until: days > 0 ? new Date(Date.now() + days * DAY_MS).toISOString() : null, by: me.name };
    await db.update((d) => {
      d.announcement = a;
    });
    events.log(me.name, "announce", null, { text });
    return json(res, 200, { announcement: a });
  }
  if (p === "/api/admin/announcement" && m === "DELETE") {
    await db.update((d) => {
      delete d.announcement;
    });
    events.log(me.name, "announce-clear");
    return json(res, 200, { ok: true });
  }

  const courseMatch = p.match(/^\/api\/admin\/courses\/([0-9a-f]{16})$/);
  if (courseMatch && m === "PATCH") {
    const body = await readJson(req);
    const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
    await db.update((d) => {
      const c = d.courses.find((x) => x.id === courseMatch[1]);
      if (!c) throw new HttpError(404, "That course isn't here any more");
      if (body.name !== undefined) c.name = clean(body.name, 200) || c.name;
      if (body.module !== undefined) c.module = clean(body.module, 200);
      if (body.level !== undefined) c.level = clean(body.level, 200);
    });
    events.log(me.name, "course-rename", courseMatch[1], { name: body.name });
    return json(res, 200, { ok: true });
  }
  if (courseMatch && m === "DELETE") {
    const gone = await db.update((d) => {
      if (!d.courses.some((c) => c.id === courseMatch[1])) throw new HttpError(404, "That course isn't here any more");
      const ids = d.weeks.filter((w) => w.courseId === courseMatch[1]).map((w) => w.id);
      d.weeks = d.weeks.filter((w) => w.courseId !== courseMatch[1]);
      d.courses = d.courses.filter((c) => c.id !== courseMatch[1]);
      return ids;
    });
    for (const id of gone) await rm(weekFile(id), { force: true });
    console.log(`${me.name} deleted course ${courseMatch[1]} and ${gone.length} weeks`);
      events.log(me.name, "course-delete", courseMatch[1], { weeks: gone.length });
    return json(res, 200, { ok: true, weeks: gone.length });
  }

  // Files on disk that no published week uses (an upload that stopped halfway, say).
  if (p === "/api/admin/cleanup" && m === "POST") {
    const data = await db.read();
    const known = new Set(data.weeks.map((w) => `${w.id}.studyweek`));
    let count = 0;
    let bytes = 0;
    for (const [f, size] of await filesOnDisk()) {
      if (known.has(f)) continue;
      await rm(path.join(config.weeksDir, f), { force: true });
      count++;
      bytes += size;
    }
    events.log(me.name, "cleanup", null, { count, bytes });
    return json(res, 200, { count, bytes });
  }

  throw new HttpError(404, "Not found");
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
  if (p === "/api/signup-mode" && m === "GET") return json(res, 200, { mode: signupMode(await db.read()) });
  // The admin's message for everyone, shown on the site and in the app. Public, so the app can show it before you connect.
  if (p === "/api/announcement" && m === "GET") {
    const a = (await db.read()).announcement;
    return json(res, 200, { announcement: a && (!a.until || a.until > new Date().toISOString()) ? a : null });
  }
  if (p === "/api/login" && m === "POST") return login(req, res);

  const me = await requireUser(req);

  if (p === "/api/me" && m === "GET") return json(res, 200, { user: { name: me.name, owner: Boolean(me.owner), onLeaderboard: !me.hideFromLeaderboard } });
  if (p.startsWith("/api/admin/") && p !== "/api/admin/weeks") return adminRoutes(req, res, p, m);
  if (p === "/api/cloud" || p.startsWith("/api/cloud/")) return cloudRoutes(req, res, url, p, m, me);

  // The leaderboard: everyone's sharing and (for people syncing through the cloud) studying, for people logged in.
  if (p === "/api/leaderboard" && m === "GET") {
    const data = await db.read();
    const people = data.users
      .filter((u) => !u.hideFromLeaderboard || u.name === me.name)
      .map((u) => {
        const theirs = data.weeks.filter((w) => authorsOfWeek(w).includes(u.name));
        return {
          name: u.name,
          me: u.name === me.name,
          hidden: Boolean(u.hideFromLeaderboard),
          joined: u.createdAt,
          weeks: theirs.length,
          topicsShared: theirs.reduce((n, w) => n + w.writtenCount, 0),
          cardsShared: theirs.reduce((n, w) => n + w.cardCount, 0),
          downloads: theirs.reduce((n, w) => n + (w.downloads ?? 0), 0),
          study: cloud.stats(u.name),
        };
      });
    return json(res, 200, { people });
  }
  if (p === "/api/leaderboard/me" && m === "POST") {
    await requireSession(req);
    const body = await readJson(req);
    await db.update((d) => {
      d.users.find((u) => u.name === me.name).hideFromLeaderboard = body.visible === false || undefined;
    });
    return json(res, 200, { ok: true });
  }
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
  if (p === "/api/weeks/merge" && m === "POST") return mergeWeeks(req, res, url, me);

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
    // Downloads count when someone adds it in the app, not when its author or an admin on the site looks at it.
    if (w.owner !== me.name && !(me.owner && me.via === "session")) {
      await db.update((d) => {
        const x = d.weeks.find((y) => y.id === w.id);
        if (x) x.downloads++;
      });
      events.log(me.name, "download", w.id, { week: `${data.courses.find((c) => c.id === w.courseId)?.name ?? ""} · ${w.label}`, author: w.owner });
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
    const gone = await db.update((d) => {
      const w = findWeek(d, weekMatch[1]);
      if (!canChange(w, me)) throw new HttpError(403, "That isn't your week");
      d.weeks = d.weeks.filter((x) => x.id !== w.id);
      const name = `${d.courses.find((c) => c.id === w.courseId)?.name ?? ""} · ${w.label}`;
      dropEmptyCourses(d);
      return { name, author: w.owner };
    });
    await rm(weekFile(weekMatch[1]), { force: true });
    events.log(me.name, "take-down", weekMatch[1], { week: gone.name, author: gone.author, byAdmin: gone.author !== me.name });
    events.resolveWeek(weekMatch[1], me.name);
    return json(res, 200, { ok: true });
  }

  // Reporting a published week (from the app or the site): it goes in the admins' queue.
  const reportMatch = p.match(/^\/api\/weeks\/([0-9a-f]{16})\/report$/);
  if (reportMatch && m === "POST") {
    const body = await readJson(req);
    const reason = String(body.reason ?? "");
    if (!REPORT_REASONS[reason]) throw new HttpError(400, "Pick a reason");
    const data = await db.read();
    const w = findWeek(data, reportMatch[1]);
    if (w.owner === me.name) throw new HttpError(400, "That's your own week: take it down from its ⋯ menu instead.");
    const weekName = `${data.courses.find((c) => c.id === w.courseId)?.name ?? ""} · ${w.label}`;
    events.report({ reporter: me.name, weekId: w.id, weekName, author: w.owner, reason, note: String(body.note ?? "").slice(0, 1000) });
    events.log(me.name, "report", w.id, { week: weekName, reason });
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
    if (!res.headersSent) json(res, status, { error: status === 500 ? "Something went wrong on the server" : err.message, ...(status !== 500 && err.extra ? err.extra : {}) });
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

// Daily snapshots of every cloud account that changed, kept two weeks (checked hourly).
async function recordToday() {
  const o = await adminOverview();
  events.recordDaily({ people: o.totals.people, weeks: o.totals.weeks, storage: o.storage.weeks + o.storage.db + o.storage.leftovers.bytes + o.storage.cloud + o.storage.snapshots, cloud: o.storage.cloud });
}

const snapshot = () => {
  // Today's totals, for the charts on the admin page.
  recordToday().catch((err) => console.error("Daily totals failed:", err));
  try {
    const n = cloud.snapshotAll();
    if (n) console.log(`Snapshotted ${n} cloud account${n === 1 ? "" : "s"}`);
  } catch (err) {
    console.error("Snapshots failed:", err);
  }
};
setTimeout(snapshot, 5 * 1000).unref();
setInterval(snapshot, HOUR_MS).unref();

server.requestTimeout = 15 * 60 * 1000;
server.listen(config.port, config.host, () => console.log(`studywise-server on ${config.host}:${config.port}`));
