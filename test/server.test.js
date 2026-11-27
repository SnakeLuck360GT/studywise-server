// Runs the server on a spare port with a throwaway data folder, and drives it
// like the site and the app do.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import JSZip from "jszip";
import { inspectWeek } from "../lib/studyweek.js";
import { courseCode, courseKey, courseTitle, likelySameCourse, sameCourse, weekNumber } from "../lib/courses.js";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const sig = (seed) => Array.from({ length: 128 }, (_, i) => (i * 2654435761 + seed) >>> 0);

function weekJson(over = {}) {
  const content = { title: "Photoelectric effect", goal: "Explain it", sections: [{ heading: "Work function", notes: "…", figure: { fileId: "f1", page: 2 } }], check: [] };
  return {
    app: "studywise-courses",
    kind: "week",
    format: 1,
    exportedAt: new Date().toISOString(),
    course: { name: "Quantum 101", module: "PHYS101", level: "first year" },
    week: { id: "w1", course_id: "c1", label: "Week 1", position: 0, status: "ready", planned_with: JSON.stringify({ model: "sonnet", effort: null, provider: "claude" }) },
    files: [{ id: "f1", name: "lecture.pdf", path: "files/lecture.pdf" }],
    topics: [
      { id: "t1", key: "w1t1", position: 0, status: "ready", plan: JSON.stringify({ title: "Photoelectric effect", sections: ["Work function"] }), content: JSON.stringify(content), level: "standard", versions: "{}", written_with: JSON.stringify({ standard: { model: "opus", effort: "high", provider: "claude" } }) },
      { id: "t2", key: "w1t2", position: 1, status: "planned", plan: JSON.stringify({ title: "Compton scattering", sections: ["Setup", "Shift"] }), content: null, versions: "{}", written_with: "{}" },
    ],
    cards: [{ id: "k1", front: "What is the work function?", back: "The minimum energy to free an electron" }],
    fingerprint: { v: 1, sig: sig(1), hashes: [] },
    ...over,
  };
}

async function weekZip({ json = weekJson(), files = { "files/files/lecture.pdf": PDF } } = {}) {
  const zip = new JSZip();
  zip.file("week.json", JSON.stringify(json));
  for (const [p, b] of Object.entries(files)) zip.file(p, b);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("course names", () => {
  it("reads module codes, and not years", () => {
    assert.equal(courseCode("Software Engineering 1 (COMP23311)"), "COMP23311");
    assert.equal(courseCode("PHYS 1001 Mechanics"), "PHYS1001");
    assert.equal(courseCode("comp23311 notes"), "COMP23311");
    assert.equal(courseCode("History 1900 to 2000"), null);
    assert.equal(courseCode("Software Engineering 1"), null);
  });

  it("matches the same course under different names", () => {
    const same = (a, b) => sameCourse(courseKey(a), courseKey(b));
    assert.ok(same("Software Engineering 1 (COMP23311)", "Software Engineering 1"));
    assert.ok(same("Introduction to AI (COMP24011)", "Intro to AI"));
    assert.ok(same("Programming Languages & Paradigms (COMP26020)", "programming languages and paradigms"));
    assert.ok(same("COMP23111", "Databases (COMP23111)"));
    assert.ok(!same("Database Systems (COMP23111)", "Database Systems (CS3200)"));
    assert.ok(!same("Software Engineering 1", "Software Engineering 2"));
    assert.equal(courseTitle("The Theory of Computation"), "theory of computation");
  });

  it("suggests weeks from courses that look the same, but not different numbers or codes", () => {
    const like = (a, b) => likelySameCourse({ name: a }, { name: b });
    assert.ok(like("Databases", "Database Systems"));
    assert.ok(like("Intro to AI", "AI"));
    assert.ok(like("Software Engineering 1", "Software Engineering 1 (COMP23311)"));
    assert.ok(!like("Database Systems", "Distributed Systems"));
    assert.ok(!like("Software Engineering 1", "Software Engineering 2"));
    assert.ok(!like("Database Systems (COMP23111)", "Database Systems (CS3200)"));
    assert.equal(weekNumber("Week 9: Testing"), 9);
    assert.equal(weekNumber("Revision"), null);
  });
});

describe("upload checks", () => {
  it("reads a real week", async () => {
    const m = await inspectWeek(await weekZip());
    assert.equal(m.course.name, "Quantum 101");
    assert.equal(m.writtenCount, 1);
    assert.equal(m.topicCount, 2);
    assert.deepEqual(m.topics[1].sections, ["Setup", "Shift"]);
    assert.deepEqual(m.writtenWith, [{ model: "opus", effort: "high", provider: "claude", count: 1 }]);
    assert.equal(m.plannedWith.model, "sonnet");
    assert.equal(m.hashes.length, 1);
  });

  const refuses = async (buf, re) => assert.rejects(inspectWeek(buf), (e) => e.status === 400 && re.test(e.message));

  it("refuses anything that isn't a Studywise week", async () => {
    await refuses(Buffer.from("hello"), /isn't a .studyweek/);
    await refuses(await weekZip({ json: { ...weekJson(), app: "other" } }), /wasn't made by Studywise/);
    await refuses(await weekZip({ json: { ...weekJson(), topics: weekJson().topics.map((t) => ({ ...t, status: "planned", content: null })) } }), /none of its topics are written/);
  });

  it("refuses files that aren't what they say", async () => {
    await refuses(await weekZip({ files: { "files/files/lecture.pdf": Buffer.from("MZ\x90\x00 not a pdf") } }), /isn't really a .pdf/);
    const exe = { ...weekJson(), files: [{ id: "f1", name: "tool.exe", path: "files/tool.exe" }] };
    await refuses(await weekZip({ json: exe, files: { "files/files/tool.exe": Buffer.from("MZ") } }), /.exe files can't be in a week/);
  });

  it("refuses extra or missing files and odd paths", async () => {
    await refuses(await weekZip({ files: { "files/files/lecture.pdf": PDF, "evil.sh": Buffer.from("rm -rf") } }), /something extra/);
    await refuses(await weekZip({ files: {} }), /listed but not in the file/);
    const up = { ...weekJson(), files: [{ id: "f1", name: "x.pdf", path: "../x.pdf" }] };
    await refuses(await weekZip({ json: up }), /damaged/);
  });
});

describe("site and app", () => {
  const port = 3900 + Math.floor(Math.random() * 90);
  const base = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(path.join(tmpdir(), "swm-"));
  let server;
  before(async () => {
    server = spawn(process.execPath, ["server.js"], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, PORT: String(port), DATA_DIR: dir, TRUST_PROXY: "0", SIGNUPS_PER_DAY: "100" }, stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((ok) => server.stdout.once("data", ok));
  });
  after(() => {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = async (p, { method = "GET", body, cookie, key, type } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (key) headers.authorization = `Bearer ${key}`;
    if (body !== undefined) headers["content-type"] = type ?? "application/json";
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : type ? body : JSON.stringify(body) });
    const isJson = res.headers.get("content-type")?.startsWith("application/json");
    return { status: res.status, data: isJson ? await res.json() : Buffer.from(await res.arrayBuffer()), res };
  };

  async function account(name) {
    const r = await call("/api/signup", { method: "POST", body: { name, password: "correct horse" } });
    assert.equal(r.status, 200);
    const cookie = r.res.headers.get("set-cookie").split(";")[0];
    const k = await call("/api/keys", { method: "POST", body: { label: "Mac" }, cookie });
    assert.match(k.data.key, /^swm_/);
    return { cookie, key: k.data.key };
  }

  it("serves the pages", async () => {
    const r = await fetch(`${base}/account`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal((await fetch(`${base}/../server.js`)).status, 404);
    assert.equal((await fetch(`${base}/lib/config.js`)).status, 404);
  });

  it("needs a key or a login", async () => {
    assert.equal((await call("/api/courses")).status, 401);
    assert.equal((await call("/api/courses", { key: "swm_nope" })).status, 401);
  });

  it("publishes, lists, finds similar, downloads and deletes", async () => {
    const alex = await account("alex");
    const sam = await account("sam");
    // Keys are made on the site only.
    assert.equal((await call("/api/keys", { method: "POST", body: {}, key: alex.key })).status, 403);

    const pub = await call("/api/weeks", { method: "POST", body: await weekZip(), key: alex.key, type: "application/zip" });
    assert.equal(pub.status, 200, JSON.stringify(pub.data));
    const weekId = pub.data.week.id;

    // Not a Studywise file: refused.
    const bad = await call("/api/weeks", { method: "POST", body: Buffer.from("PK\x03\x04junk"), key: alex.key, type: "application/zip" });
    assert.equal(bad.status, 400);

    // Publishing the same week again replaces it.
    const again = await call("/api/weeks", { method: "POST", body: await weekZip(), key: alex.key, type: "application/zip" });
    assert.equal(again.data.week.id, weekId);

    const list = await call("/api/courses?q=quantum", { key: sam.key });
    assert.equal(list.data.courses.length, 1);
    const c = list.data.courses[0];
    assert.deepEqual(c.authors, ["alex"]);
    assert.equal(c.models[0].model, "opus");
    const full = await call(`/api/courses/${c.id}`, { key: sam.key });
    assert.equal(full.data.course.weeks[0].topics[0].title, "Photoelectric effect");
    assert.equal(full.data.course.weeks[0].plannedWith.model, "sonnet");
    assert.equal((await call("/api/courses?q=biology", { key: sam.key })).data.courses.length, 0);

    // Similar: the same signature matches, a different one doesn't.
    const same = await call("/api/similar", { method: "POST", body: { v: 1, sig: sig(1), hashes: [] }, key: sam.key });
    assert.equal(same.data.matches.length, 1);
    assert.equal(same.data.matches[0].score, 1);
    const other = await call("/api/similar", { method: "POST", body: { v: 1, sig: sig(999), hashes: [] }, key: sam.key });
    assert.equal(other.data.matches.length, 0);
    // The same slides, by their bytes.
    const { createHash } = await import("node:crypto");
    const byFile = await call("/api/similar", { method: "POST", body: { v: 1, sig: null, hashes: [createHash("sha256").update(PDF).digest("hex")] }, key: sam.key });
    assert.equal(byFile.data.matches[0].sameFiles, 1);

    const dl = await call(`/api/weeks/${weekId}/file`, { key: sam.key });
    assert.equal(dl.status, 200);
    assert.ok((await JSZip.loadAsync(dl.data)).file("week.json"));
    assert.equal((await call(`/api/courses/${c.id}`, { key: sam.key })).data.course.downloads, 1);

    // Only the author (or the site owner) can take it down.
    assert.equal((await call(`/api/weeks/${weekId}`, { method: "DELETE", key: sam.key })).status, 403);
    assert.equal((await call(`/api/weeks/${weekId}`, { method: "DELETE", key: alex.key })).status, 200);
    assert.equal((await call("/api/courses", { key: sam.key })).data.courses.length, 0);
  });

  it("shares a course between everyone who publishes to its name; weeks stay theirs", async () => {
    const kim = await account("kim");
    const lee = await account("lee");
    const named = (name, label) => weekZip({ json: { ...weekJson(), course: { name, module: "", level: "" }, week: { ...weekJson().week, label } } });
    const post = async (key, buf) => (await call("/api/weeks", { method: "POST", body: await buf, key, type: "application/zip" })).data.week;
    const k1 = await post(kim.key, named("Thermo 2", "Week 1"));
    const l1 = await post(lee.key, named("thermo  2", "Week 1"));
    const l2 = await post(lee.key, named("Thermo 2", "Week 2"));
    assert.equal(new Set([k1.courseId, l1.courseId, l2.courseId]).size, 1);
    assert.notEqual(k1.id, l1.id);
    // Lee publishing their Week 1 again replaces only Lee's.
    assert.equal((await post(lee.key, named("Thermo 2", "Week 1"))).id, l1.id);
    const { course } = (await call(`/api/courses/${k1.courseId}`, { key: kim.key })).data;
    assert.deepEqual(course.authors, ["lee", "kim"]);
    assert.equal(course.mine, true);
    assert.deepEqual(course.weeks.map((w) => `${w.label}:${w.author}:${w.mine}`), ["Week 1:kim:true", "Week 1:lee:false", "Week 2:lee:false"]);
    // Kim can't take Lee's week down; when everyone's weeks are gone, so is the course.
    assert.equal((await call(`/api/weeks/${l1.id}`, { method: "DELETE", key: kim.key })).status, 403);
    for (const [w, k] of [[k1, kim], [l1, lee], [l2, lee]]) await call(`/api/weeks/${w.id}`, { method: "DELETE", key: k.key });
    assert.equal((await call(`/api/courses/${k1.courseId}`, { key: kim.key })).status, 404);
  });

  it("puts the same course under different names together, and keeps the name with the code", async () => {
    const a = await account("ana");
    const b = await account("ben");
    // No files, so the only content match is the signature.
    const zip = (name, label, seed) => weekZip({ json: { ...weekJson(), files: [], course: { name, module: "", level: "" }, week: { ...weekJson().week, label }, fingerprint: { v: 1, sig: sig(seed), hashes: [] } }, files: {} });
    const post = async (key, buf) => (await call("/api/weeks", { method: "POST", body: await buf, key, type: "application/zip" })).data.week;
    const w1 = await post(a.key, zip("Software Engineering 1", "Week 1", 101));
    const w2 = await post(b.key, zip("Software Engineering 1 (COMP23311)", "Week 2", 102));
    assert.equal(w2.courseId, w1.courseId);
    let { course } = (await call(`/api/courses/${w1.courseId}`, { key: a.key })).data;
    assert.equal(course.name, "Software Engineering 1 (COMP23311)");
    // A different code is a different course, whatever the title.
    const w3 = await post(b.key, zip("Software Engineering 1 (CS1001)", "Week 1", 103));
    assert.notEqual(w3.courseId, w1.courseId);
    // A name that doesn't match, from the same material as a published week: that week's course.
    const w4 = await post(b.key, zip("SE one", "Week 1 again", 101));
    assert.equal(w4.courseId, w1.courseId);
    for (const [w, k] of [[w1, a], [w2, b], [w3, b], [w4, b]]) await call(`/api/weeks/${w.id}`, { method: "DELETE", key: k.key });
  });

  it("finds the same week of a similarly named course, with no slides to compare", async () => {
    const a = await account("cat");
    const b = await account("dan");
    const zip = (name, label, seed) => weekZip({ json: { ...weekJson(), files: [], course: { name, module: "", level: "" }, week: { ...weekJson().week, label }, fingerprint: { v: 1, sig: sig(seed), hashes: [] } }, files: {} });
    const post = async (buf) => (await call("/api/weeks", { method: "POST", body: await buf, key: a.key, type: "application/zip" })).data.week;
    const w9 = await post(zip("Database Systems (COMP23111)", "Week 9", 201));
    const w8 = await post(zip("Database Systems (COMP23111)", "Week 8", 202));
    const ask = async (course, week) => (await call("/api/similar", { method: "POST", body: { v: 1, sig: null, hashes: [], course, week }, key: b.key })).data.matches;
    const m = await ask("Databases", "Week 9");
    assert.deepEqual(m.map((x) => [x.week.id, x.sameWeek]), [[w9.id, true]]);
    assert.equal((await ask("Databases", "Week 10")).length, 0);
    assert.equal((await ask("Distributed Systems", "Week 9")).length, 0);
    assert.equal((await ask("Database Systems (CS3200)", "Week 9")).length, 0);
    for (const w of [w9, w8]) await call(`/api/weeks/${w.id}`, { method: "DELETE", key: a.key });
  });

  it("merges copies of a week into one for everyone, only when nothing is lost", async () => {
    const mia = await account("mia");
    const noa = await account("noa");
    const oli = await account("oli");
    const base = weekJson();
    const extraTopic = { id: "t3", key: "w1t3", position: 2, status: "ready", plan: JSON.stringify({ title: "Wave-particle duality", sections: ["Both at once"] }), content: JSON.stringify({ title: "Wave-particle duality", goal: "", sections: [{ heading: "Both at once", notes: "…", figure: null }], check: [] }), level: "standard", versions: "{}", written_with: "{}" };
    const extraCard = { id: "k2", front: "What is a photon?", back: "A packet of light" };
    const week3 = (json) => weekZip({ json: { ...json, course: { name: "Optics 7", module: "", level: "" }, week: { ...json.week, label: "Week 3" } } });
    const post = async (key, buf, q = "") => call(`/api/weeks${q}`, { method: "POST", body: await buf, key, type: "application/zip" });
    const merge = async (key, ids, buf) => call(`/api/weeks/merge?ids=${ids.join(",")}`, { method: "POST", body: await buf, key, type: "application/zip" });

    const a = (await post(mia.key, week3(base))).data.week;
    const b = (await post(noa.key, week3({ ...base, topics: [...base.topics, extraTopic], cards: [...base.cards, extraCard] }))).data.week;
    assert.equal(a.courseId, b.courseId);
    await call(`/api/weeks/${a.id}/file`, { key: noa.key });

    // Less than Noa's copy (no third topic, no second card): refused.
    const short = await merge(oli.key, [a.id, b.id], week3(base));
    assert.equal(short.status, 400);
    assert.match(short.data.error, /less in it than noa's copy/);

    // Everything from both: one week for everyone, credited to both authors.
    const full = week3({ ...base, topics: [...base.topics, extraTopic], cards: [...base.cards, extraCard] });
    const m = await merge(oli.key, [a.id, b.id], full);
    assert.equal(m.status, 200, JSON.stringify(m.data));
    assert.deepEqual(m.data.week.authors, ["mia", "noa"]);
    assert.equal(m.data.week.merged, true);
    assert.equal(m.data.week.downloads, 1);
    assert.deepEqual(new Set(m.data.replaced), new Set([a.id, b.id]));
    const { course } = (await call(`/api/courses/${a.courseId}`, { key: mia.key })).data;
    assert.deepEqual(course.weeks.map((w) => w.id), [m.data.week.id]);
    assert.equal((await call(`/api/weeks/${a.id}/file`, { key: mia.key })).status, 404);

    // Noa publishing their copy again is told where it went (by name or by the old id), instead of making a new copy.
    const again = await post(noa.key, week3(base));
    assert.equal(again.status, 409);
    assert.equal(again.data.mergedInto, m.data.week.id);
    assert.equal((await post(noa.key, week3(base), `?replace=${b.id}`)).data.mergedInto, m.data.week.id);
    // Merging more into it keeps the same week.
    const more = await merge(noa.key, [m.data.week.id], full);
    assert.equal(more.data.week.id, m.data.week.id);

    // Only whoever merged it (or the site owner) can take it down.
    assert.equal((await call(`/api/weeks/${m.data.week.id}`, { method: "DELETE", key: mia.key })).status, 403);
    assert.equal((await call(`/api/weeks/${m.data.week.id}`, { method: "DELETE", key: oli.key })).status, 200);
  });

  it("deleting a key stops it working", async () => {
    const pat = await account("pat");
    const { keys } = (await call("/api/keys", { cookie: pat.cookie })).data;
    await call(`/api/keys/${keys[0].id}`, { method: "DELETE", cookie: pat.cookie });
    assert.equal((await call("/api/app/me", { key: pat.key })).status, 401);
  });

  it("lets an admin see everything, what it takes up, and look after it", async () => {
    const kim = await account("adminkim");
    const lee = await account("authorlee");
    const pub = await call("/api/weeks", { method: "POST", body: await weekZip({ json: weekJson({ course: { name: "Admin Test", module: "ADM9", level: "" }, fingerprint: { v: 1, sig: sig(77), hashes: [] } }) }), key: lee.key, type: "application/zip" });
    assert.equal(pub.status, 200, JSON.stringify(pub.data));
    const weekId = pub.data.week.id;

    // Not an admin yet: no way in.
    assert.equal((await call("/api/admin/overview", { cookie: kim.cookie })).status, 403);
    execFileSync(process.execPath, ["manage.js", "make-owner", "adminkim"], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, DATA_DIR: dir } });
    // Admin from the site only, never with an API key.
    assert.equal((await call("/api/admin/overview", { key: kim.key })).status, 403);

    const overview = async () => (await call("/api/admin/overview", { cookie: kim.cookie })).data;
    let o = await overview();
    const week = o.weeks.find((w) => w.id === weekId);
    assert.ok(week.bytes > 0 && !week.missing);
    assert.equal(o.users.find((u) => u.name === "authorlee").bytes, week.bytes);
    assert.equal(o.users.find((u) => u.name === "adminkim").owner, true);
    assert.ok(o.courses.find((c) => c.id === week.courseId).bytes >= week.bytes);
    assert.ok(o.storage.weeks >= week.bytes && o.storage.db > 0 && o.storage.disk.total > 0);
    assert.equal(o.totals.people, o.users.length);

    // An admin downloading a week from the site doesn't count as a download.
    assert.equal((await call(`/api/weeks/${weekId}/file`, { cookie: kim.cookie })).status, 200);
    assert.equal((await overview()).weeks.find((w) => w.id === weekId).downloads, 0);

    // Files no week uses show up, and clean up.
    writeFileSync(path.join(dir, "weeks", "0123456789abcdef.studyweek"), "x".repeat(10));
    assert.deepEqual((await overview()).storage.leftovers, { count: 1, bytes: 10 });
    assert.deepEqual((await call("/api/admin/cleanup", { method: "POST", body: {}, cookie: kim.cookie })).data, { count: 1, bytes: 10 });

    // Rename a course.
    await call(`/api/admin/courses/${week.courseId}`, { method: "PATCH", body: { name: "Admin Testing", module: "ADM10" }, cookie: kim.cookie });
    assert.equal((await overview()).courses.find((c) => c.id === week.courseId).module, "ADM10");

    // A new password for someone: the old one stops working, the new one logs in.
    const { password } = (await call("/api/admin/users/authorlee/password", { method: "POST", body: {}, cookie: kim.cookie })).data;
    assert.equal((await call("/api/login", { method: "POST", body: { name: "authorlee", password: "correct horse" } })).status, 401);
    assert.equal((await call("/api/login", { method: "POST", body: { name: "authorlee", password } })).status, 200);
    assert.ok((await overview()).users.find((u) => u.name === "authorlee").lastLogin);

    // Admins can make and remove admins, but not remove themselves.
    await call("/api/admin/users/authorlee", { method: "PATCH", body: { owner: true }, cookie: kim.cookie });
    assert.equal((await overview()).users.find((u) => u.name === "authorlee").owner, true);
    await call("/api/admin/users/authorlee", { method: "PATCH", body: { owner: false }, cookie: kim.cookie });
    assert.equal((await call("/api/admin/users/adminkim", { method: "PATCH", body: { owner: false }, cookie: kim.cookie })).status, 400);
    assert.equal((await call("/api/admin/users/adminkim", { method: "DELETE", cookie: kim.cookie })).status, 400);

    // Deleting someone takes their weeks (and the files) with them.
    assert.equal((await call("/api/admin/users/authorlee", { method: "DELETE", cookie: kim.cookie })).data.weeks, 1);
    o = await overview();
    assert.ok(!o.users.some((u) => u.name === "authorlee") && !o.weeks.some((w) => w.id === weekId));
    assert.equal((await call("/api/app/me", { key: lee.key })).status, 401);
  });
  it("syncs a library through the cloud between devices, with files, a limit and snapshots", async () => {
    const owner = await account("cloudboss");
    const uma = await account("cloudyuma");
    execFileSync(process.execPath, ["manage.js", "make-owner", "cloudboss"], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, DATA_DIR: dir } });
    const mac = { id: "dev-mac", name: "MacBook", kind: "computer" };
    const phone = { id: "dev-phone", name: "Pixel", kind: "phone" };
    const push = (changes, device = mac) => call("/api/cloud/push", { method: "POST", body: { changes, done: true, device }, key: uma.key });
    const pull = async (since, device) => (await call("/api/cloud/pull", { method: "POST", body: { since, device }, key: uma.key })).data;
    const ch = (pk, at, origin, row) => ({ tbl: "notes", pk, at, origin, deleted: !row, ...(row ? { row } : {}) });

    assert.equal((await call("/api/cloud", { key: uma.key })).data.on, false);
    assert.equal((await push([ch("n1", "2026-01-01T00:00:00.000Z", "dev-mac", { id: "n1", title: "Mac's" }), ch("n2", "2026-01-01T00:00:00.000Z", "dev-mac", { id: "n2", title: "Two" })])).data.applied, 2);

    // The phone gets the Mac's rows; the Mac doesn't get its own back.
    let page = await pull(0, phone);
    assert.deepEqual(page.changes.map((c) => c.row.title), ["Mac's", "Two"]);
    assert.equal((await pull(0, mac)).changes.length, 0);

    // The later change wins; an older one is ignored; a deletion travels as a tombstone.
    await push([ch("n1", "2026-01-02T00:00:00.000Z", "dev-phone", { id: "n1", title: "Phone's" })], phone);
    assert.equal((await push([ch("n1", "2026-01-01T12:00:00.000Z", "dev-mac", { id: "n1", title: "Stale" })])).data.skipped, 1);
    await push([ch("n2", "2026-01-03T00:00:00.000Z", "dev-phone", null)], phone);
    page = await pull(page.next, mac);
    assert.deepEqual(page.changes.map((c) => [c.pk, c.deleted, c.row?.title]), [["n1", false, "Phone's"], ["n2", true, undefined]]);

    // Files: what's missing, then up and down.
    const have = await call("/api/cloud/have", { method: "POST", body: { attachments: ["a.png"], courseFiles: ["f1"] }, key: uma.key });
    assert.deepEqual(have.data, { attachments: ["a.png"], courseFiles: ["f1"] });
    assert.equal((await call("/api/cloud/course-file?id=f1", { method: "PUT", body: { data: Buffer.from("slides").toString("base64") }, key: uma.key })).status, 200);
    assert.equal((await call(`/api/cloud/file?u=${encodeURIComponent("studywise-file://attachments/a.png")}`, { method: "PUT", body: { data: Buffer.from("png").toString("base64") }, key: uma.key })).status, 200);
    assert.equal((await call("/api/cloud/course-file?id=f1", { key: uma.key })).data.toString(), "slides");
    assert.equal((await call("/api/cloud/course-file?id=../../db.json", { key: uma.key })).status, 400);
    assert.deepEqual((await call("/api/cloud/have", { method: "POST", body: { attachments: ["a.png"], courseFiles: ["f1"] }, key: uma.key })).data, { attachments: [], courseFiles: [] });

    // Someone else's cloud is theirs alone.
    assert.equal((await call("/api/cloud/pull", { method: "POST", body: { since: 0, device: mac }, key: owner.key })).data.changes.length, 0);

    // Status shows the devices and what it takes up.
    const st = (await call("/api/cloud", { key: uma.key })).data;
    assert.equal(st.on, true);
    assert.deepEqual(st.devices.map((d) => d.name).sort(), ["MacBook", "Pixel"]);
    assert.ok(st.usage.files >= 9 && st.quota > 0);

    // The admin can shrink the limit, and a push past it is refused.
    await call("/api/admin/users/cloudyuma/cloud", { method: "PATCH", body: { quotaGb: 0.000001 }, cookie: owner.cookie });
    assert.equal((await push([ch("n3", "2026-01-04T00:00:00.000Z", "dev-mac", { id: "n3", title: "x".repeat(2000) })])).status, 413);
    await call("/api/admin/users/cloudyuma/cloud", { method: "PATCH", body: { quotaGb: 5 }, cookie: owner.cookie });
    const o = (await call("/api/admin/overview", { cookie: owner.cookie })).data;
    assert.equal(o.users.find((u) => u.name === "cloudyuma").cloud.on, true);
    assert.ok(o.storage.cloud > 0);
  });

  it("ranks everyone on the leaderboard, with study stats for people syncing through the cloud", async () => {
    const ana = await account("boardana");
    const ben = await account("boardben");
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const now = new Date().toISOString();
    const row = (tbl, pk, r) => ({ tbl, pk, at: now, origin: "dev-ana", deleted: false, row: r });
    await call("/api/cloud/push", {
      method: "POST",
      key: ana.key,
      body: {
        device: { id: "dev-ana", name: "Mac", kind: "computer" },
        changes: [
          row("study_time", `${today}\u001fdev-ana`, { day: today, device: "dev-ana", seconds: 1800 }),
          row("study_time", `${yesterday}\u001fdev-ana`, { day: yesterday, device: "dev-ana", seconds: 600 }),
          row("review_log", "c1\u001fx\u001fflashcard", { card_id: "c1", deck_id: "d", rating: 3, source: "flashcard", at: now }),
          row("topics", "t1", { id: "t1", progress: JSON.stringify({ done: true, answered: 10, correct: 8 }) }),
          row("topics", "t2", { id: "t2", progress: JSON.stringify({ done: false, answered: 5, correct: 5 }) }),
        ],
      },
    });
    let board = (await call("/api/leaderboard", { cookie: ben.cookie })).data.people;
    const a = board.find((p) => p.name === "boardana");
    assert.deepEqual([a.study.seconds, a.study.secondsWeek, a.study.reviews, a.study.streak, a.study.topicsDone, a.study.answered, a.study.correct], [2400, 2400, 1, 2, 1, 15, 13]);
    assert.equal(board.find((p) => p.name === "boardben").study, null);
    assert.equal(board.find((p) => p.name === "boardben").me, true);
    // Hidden: gone for everyone else, still there (marked) for them.
    await call("/api/leaderboard/me", { method: "POST", body: { visible: false }, cookie: ana.cookie });
    board = (await call("/api/leaderboard", { cookie: ben.cookie })).data.people;
    assert.ok(!board.some((p) => p.name === "boardana"));
    assert.equal((await call("/api/leaderboard", { cookie: ana.cookie })).data.people.find((p) => p.me).hidden, true);
    assert.equal((await call("/api/leaderboard")).status, 401);
  });

  it("lets an admin control sign-ups, suspend people, handle reports, and see activity and trends", async () => {
    const boss = await account("modboss");
    const pub = await account("modauthor");
    const rep = await account("modreporter");
    execFileSync(process.execPath, ["manage.js", "make-owner", "modboss"], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, DATA_DIR: dir } });
    const admin = (p, opts = {}) => call(p, { cookie: boss.cookie, ...opts });

    // Invite-only: no code, no account; a code works once.
    await admin("/api/admin/settings", { method: "PATCH", body: { signups: "invite" } });
    assert.equal((await call("/api/signup-mode")).data.mode, "invite");
    assert.equal((await call("/api/signup", { method: "POST", body: { name: "nocode", password: "correct horse" } })).status, 403);
    const { invite } = (await admin("/api/admin/invites", { method: "POST", body: { days: 7, note: "for Sam" } })).data;
    assert.equal((await call("/api/signup", { method: "POST", body: { name: "invited", password: "correct horse", invite: invite.code } })).status, 200);
    assert.equal((await call("/api/signup", { method: "POST", body: { name: "invited2", password: "correct horse", invite: invite.code } })).status, 403);
    await admin("/api/admin/settings", { method: "PATCH", body: { signups: "closed" } });
    assert.equal((await call("/api/signup", { method: "POST", body: { name: "closedout", password: "correct horse" } })).status, 403);
    await admin("/api/admin/settings", { method: "PATCH", body: { signups: "open" } });

    // A report goes in the queue; taking the week down from it removes the week.
    const week = (await call("/api/weeks", { method: "POST", body: await weekZip({ json: weekJson({ course: { name: "Moderation 101", module: "MOD1", level: "" }, fingerprint: { v: 1, sig: sig(555), hashes: [] } }) }), key: pub.key, type: "application/zip" })).data.week;
    assert.equal((await call(`/api/weeks/${week.id}/report`, { method: "POST", body: { reason: "nope" }, key: rep.key })).status, 400);
    assert.equal((await call(`/api/weeks/${week.id}/report`, { method: "POST", body: { reason: "copyright", note: "Copied from my notes" }, key: rep.key })).status, 200);
    let reports = (await admin("/api/admin/reports?status=open")).data.reports;
    const r = reports.find((x) => x.week_id === week.id);
    assert.equal(r.reporter, "modreporter");
    assert.equal((await admin("/api/admin/overview")).data.totals.openReports >= 1, true);
    await admin(`/api/admin/reports/${r.id}`, { method: "POST", body: { action: "remove" } });
    assert.equal((await call(`/api/weeks/${week.id}/file`, { key: rep.key })).status, 404);
    assert.equal((await admin("/api/admin/reports?status=removed")).data.reports.some((x) => x.id === r.id), true);

    // Suspended: the key and the login stop working, until it's lifted. Admins can't suspend themselves.
    await admin("/api/admin/users/modauthor", { method: "PATCH", body: { suspended: true, reason: "spam" } });
    assert.equal((await call("/api/app/me", { key: pub.key })).status, 403);
    assert.equal((await call("/api/login", { method: "POST", body: { name: "modauthor", password: "correct horse" } })).status, 403);
    assert.equal((await admin("/api/admin/users/modboss", { method: "PATCH", body: { suspended: true } })).status, 400);
    await admin("/api/admin/users/modauthor", { method: "PATCH", body: { suspended: false } });
    assert.equal((await call("/api/app/me", { key: pub.key })).status, 200);

    // Their page: keys (one revoked), weeks, activity.
    const person = (await admin("/api/admin/users/modauthor")).data;
    assert.equal(person.keys.length, 1);
    assert.ok(person.activity.some((a) => a.action === "publish") && person.activity.some((a) => a.action === "suspend"));
    await admin(`/api/admin/users/modauthor/keys/${person.keys[0].id}`, { method: "DELETE" });
    assert.equal((await call("/api/app/me", { key: pub.key })).status, 401);

    // The activity log and the day-by-day trends.
    const log = (await admin("/api/admin/activity?what=take-down")).data.activity;
    assert.ok(log.some((a) => a.target === week.id && a.detail.byAdmin));
    const days = (await admin("/api/admin/trends?days=14")).data.days;
    assert.equal(days.length, 14);
    assert.ok(days.at(-1).signups >= 4 && days.at(-1).published >= 1 && days.at(-1).active >= 1);

    // An announcement for everyone, until it's cleared.
    await admin("/api/admin/announcement", { method: "PUT", body: { text: "Maintenance tonight", level: "warn", days: 1 } });
    assert.equal((await call("/api/announcement")).data.announcement.text, "Maintenance tonight");
    await admin("/api/admin/announcement", { method: "DELETE" });
    assert.equal((await call("/api/announcement")).data.announcement, null);
    // Not for non-admins.
    assert.equal((await call("/api/admin/settings", { cookie: rep.cookie })).status, 403);
  });

  it("restores a cloud account to a snapshot, so every device goes back too", async () => {
    const { openCloud } = await import("../lib/cloud.js");
    const root = mkdtempSync(path.join(tmpdir(), "swc-"));
    const c = openCloud(root);
    const ch = (pk, at, row) => ({ tbl: "notes", pk, at, origin: "dev-a", deleted: !row, ...(row ? { row } : {}) });
    c.push("kim", { changes: [ch("keep", "2026-01-01T00:00:00.000Z", { t: "keep" }), ch("edit", "2026-01-01T00:00:00.000Z", { t: "before" }), ch("gone", "2026-01-01T00:00:00.000Z", { t: "deleted later" })] }, 1e9);
    assert.equal(c.snapshotAll(new Date("2026-01-01T23:00:00Z")), 1);
    c.push("kim", { changes: [ch("edit", "2026-01-02T00:00:00.000Z", { t: "after" }), ch("gone", "2026-01-02T00:00:00.000Z", null), ch("new", "2026-01-02T00:00:00.000Z", { t: "added later" })] }, 1e9);
    const since = c.pull("kim", { since: 0, device: { id: "dev-b" } }).next;
    assert.deepEqual(c.restore("kim", "2026-01-01"), { changed: 3 });
    const back = c.pull("kim", { since, device: { id: "dev-b" } }).changes;
    assert.deepEqual(back.map((x) => [x.pk, x.deleted, x.row?.t]).sort(), [["edit", false, "before"], ["gone", false, "deleted later"], ["new", true, undefined]]);
    // Restored rows carry today's time, so they beat what the devices have.
    assert.ok(back.every((x) => x.at > "2026-01-02T00:00:00.000Z" && x.origin === "cloud"));
    // Old snapshots go after two weeks.
    c.snapshotAll(new Date("2026-01-20T12:00:00Z"));
    assert.deepEqual(c.snapshots("kim").map((s) => s.day), ["2026-01-20"]);
    c.closeAll();
    rmSync(root, { recursive: true, force: true });
  });

  it("takes requests for weeks, hands them out as one task a day, and finishes them when the week is published", async () => {
    const pia = await account("pia");
    const quin = await account("quin");
    const rae = await account("rae");
    const ask = (who, body) => call("/api/requests", { method: "POST", body, key: who.key });
    const today = async (who) => (await call("/api/tasks/today", { key: who.key })).data;

    // 12-week modules, week 6 is reading week.
    assert.match((await ask(pia, { course: { name: "Thermo 201 (PHYS201)" }, number: 6 })).data.error, /reading week/);
    assert.equal((await ask(pia, { course: { name: "Thermo 201 (PHYS201)" }, number: 13 })).status, 400);
    const first = await ask(pia, { course: { name: "Thermo 201 (PHYS201)", level: "second year" }, number: 3 });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const id = first.data.request.id;
    assert.deepEqual([first.data.request.votes, first.data.request.ready, first.data.request.status], [1, false, "open"]);
    // The same week under another name is the same request: a vote.
    const again = await ask(quin, { course: { name: "thermo 201" }, number: 3 });
    assert.deepEqual([again.data.request.id, again.data.request.votes, again.data.request.voted], [id, 2, true]);

    // Nothing to make it from yet, so nobody gets it.
    assert.equal((await today(quin)).task, null);
    const up = await call(`/api/requests/${id}/files?name=lecture3.pdf`, { method: "POST", body: PDF, key: pia.key, type: "application/octet-stream" });
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assert.equal(up.data.request.ready, true);
    assert.match((await call(`/api/requests/${id}/files?name=tool.exe`, { method: "POST", body: Buffer.from("MZ"), key: pia.key, type: "application/octet-stream" })).data.error, /can't be in a week/);
    assert.equal((await call(`/api/requests/${id}/files?name=x.pdf`, { method: "POST", body: PDF, key: pia.key, type: "text/plain" })).status, 415);

    // Not to whoever asked for help; to someone else; and only one person at a time.
    assert.equal((await today(pia)).task, null);
    const task = (await today(quin)).task;
    assert.deepEqual([task.status, task.request.id], ["assigned", id]);
    assert.equal((await today(rae)).task, null);
    const list = (await call("/api/requests", { key: rae.key })).data.requests;
    assert.equal(list.find((r) => r.id === id).inProgress, true);

    // The slides download for whoever makes it.
    const file = await call(`/api/requests/${id}/files/${up.data.request.files[0].id}`, { key: quin.key });
    assert.deepEqual(file.data, PDF);

    assert.equal((await call(`/api/tasks/${task.id}/start`, { method: "POST", key: quin.key })).data.task.status, "started");
    assert.match((await call(`/api/tasks/${task.id}/done`, { method: "POST", body: {}, key: quin.key })).data.error, /isn't on the marketplace yet/);
    // Fully written (a week made partway leaves the request open for the rest).
    const json = weekJson({ course: { name: "Thermo 201 (PHYS201)", module: "", level: "" }, week: { ...weekJson().week, label: "Week 3" }, topics: [weekJson().topics[0]], fingerprint: { v: 1, sig: sig(77), hashes: [] } });
    const pub = await call("/api/weeks", { method: "POST", body: await weekZip({ json }), key: quin.key, type: "application/zip" });
    assert.equal(pub.status, 200, JSON.stringify(pub.data));
    const done = await call(`/api/tasks/${task.id}/done`, { method: "POST", body: { weekId: pub.data.week.id }, key: quin.key });
    assert.equal(done.data.task.status, "done", JSON.stringify(done.data));
    // One a day: the same task comes back, not another.
    assert.equal((await today(quin)).task.id, task.id);
    const mine = (await call("/api/requests/mine", { key: pia.key })).data.requests;
    assert.deepEqual(mine.map((r) => [r.id, r.status, r.weekId, r.doneBy]), [[id, "done", pub.data.week.id, ["quin"]]]);
    // It's on the marketplace now, so there's nothing to ask for.
    assert.equal((await ask(rae, { course: { name: "Thermo 201 (PHYS201)" }, number: 3 })).status, 409);

    // A published week with topics left to write: anyone can ask for the rest, but its owner isn't given it.
    const optics = weekJson({ course: { name: "Optics 301", module: "", level: "" }, week: { ...weekJson().week, label: "Week 2" }, fingerprint: { v: 1, sig: sig(91), hashes: [] } });
    const half = await call("/api/weeks", { method: "POST", body: await weekZip({ json: optics }), key: rae.key, type: "application/zip" });
    const write = await ask(pia, { kind: "write", weekId: half.data.week.id });
    assert.deepEqual(write.data.request.toWrite, { topics: 1, sections: 2 });
    assert.equal(write.data.request.weekAuthor, "rae");
    const raes = (await today(rae)).task;
    assert.equal(raes, null);

    // A week planned in Studywise but not written goes with a request, for someone to write from.
    const four = (await ask(rae, { course: { name: "Thermo 201 (PHYS201)" }, number: 4 })).data.request;
    const planned = weekJson({ course: { name: "Thermo 201 (PHYS201)", module: "", level: "" }, week: { ...weekJson().week, label: "Week 4" }, topics: [weekJson().topics[1]], cards: [] });
    const plan = await call(`/api/requests/${four.id}/plan`, { method: "POST", body: await weekZip({ json: planned }), key: rae.key, type: "application/zip" });
    assert.equal(plan.status, 200, JSON.stringify(plan.data));
    // Once there's a plan, only whoever asked can replace it.
    assert.equal((await call(`/api/requests/${four.id}/plan`, { method: "POST", body: await weekZip({ json: planned }), key: pia.key, type: "application/zip" })).status, 403);
    assert.deepEqual([plan.data.request.ready, plan.data.request.plan.topics, plan.data.request.toWrite], [true, 1, { topics: 1, sections: 2 }]);
    // Publishing a week with nothing written is still refused.
    assert.match((await call("/api/weeks", { method: "POST", body: await weekZip({ json: planned }), key: rae.key, type: "application/zip" })).data.error, /none of its topics are written/);

    // Two waiting now: pia gets the one with the most votes she didn't ask for herself.
    const piasTask = (await today(pia)).task;
    assert.equal(piasTask.request.id, four.id);
    assert.equal((await call(`/api/tasks/${piasTask.id}/skip`, { method: "POST", key: pia.key })).data.task.status, "skipped");
    assert.equal((await today(pia)).task.status, "skipped");

    // Turning tasks off.
    assert.deepEqual((await call("/api/tasks/settings", { method: "POST", body: { on: false }, key: rae.key })).data, { on: false });
    assert.deepEqual(await today(rae), { task: null, on: false });

    // Whoever asked can take a request back while nobody else wants it.
    const lone = (await ask(rae, { course: { name: "Thermo 201 (PHYS201)" }, number: 5 })).data.request;
    assert.equal(lone.canRemove, true);
    assert.equal((await call(`/api/requests/${write.data.request.id}`, { method: "DELETE", key: rae.key })).status, 403);
    assert.equal((await call(`/api/requests/${lone.id}`, { method: "DELETE", key: rae.key })).status, 200);
  });

  it("lets anyone make a wanted week now, partway if they run out, and the rest stays wanted", async () => {
    const vic = await account("vic");
    const wes = await account("wes");
    const xen = await account("xen");
    const C = { name: "Optics 501 (PHYS501)" };
    const r = (await call("/api/requests", { method: "POST", body: { course: C, number: 10 }, key: vic.key })).data.request;
    // Nothing to make it from yet.
    assert.match((await call(`/api/requests/${r.id}/take`, { method: "POST", key: wes.key })).data.error, /slides/);
    // Anyone can send the first plan for it (whoever planned the week); not replace one.
    const planned = weekJson({ course: { ...C, module: "", level: "" }, week: { ...weekJson().week, label: "Week 10" }, topics: [weekJson().topics[1]], cards: [] });
    assert.equal((await call(`/api/requests/${r.id}/plan`, { method: "POST", body: await weekZip({ json: planned }), key: xen.key, type: "application/zip" })).status, 200);
    assert.equal((await call(`/api/requests/${r.id}/plan`, { method: "POST", body: await weekZip({ json: planned }), key: wes.key, type: "application/zip" })).status, 403);

    // wes makes it now (a voter or anyone, not only whoever is given it); xen can't at the same time.
    const took = await call(`/api/requests/${r.id}/take`, { method: "POST", key: wes.key });
    assert.deepEqual([took.status, took.data.task.status, took.data.task.request.id], [200, "started", r.id]);
    assert.equal((await call("/api/tasks/today", { key: wes.key })).data.task.id, took.data.task.id);
    assert.match((await call(`/api/requests/${r.id}/take`, { method: "POST", key: xen.key })).data.error, /making that week/);

    // wes runs out of limit after one of two topics: what's written goes up and the task is done.
    const half = weekJson({ course: { ...C, module: "", level: "" }, week: { ...weekJson().week, label: "Week 10" }, fingerprint: { v: 1, sig: sig(510), hashes: [] } });
    const pub = await call("/api/weeks", { method: "POST", body: await weekZip({ json: half }), key: wes.key, type: "application/zip" });
    const done = await call(`/api/tasks/${took.data.task.id}/done`, { method: "POST", body: { weekId: pub.data.week.id }, key: wes.key });
    assert.equal(done.data.task.status, "done", JSON.stringify(done.data));
    // The rest is still wanted, from that week.
    const left = (await call("/api/requests/mine", { key: vic.key })).data.requests.find((x) => x.id === r.id);
    assert.deepEqual([left.status, left.partial, left.partBy, left.weekId, left.toWrite], ["open", true, ["wes"], pub.data.week.id, { topics: 1, sections: 2 }]);
    // Now xen can make the rest.
    assert.equal((await call(`/api/requests/${r.id}/take`, { method: "POST", key: xen.key })).status, 200);
  });

  it("lets admins mark weeks of a course as having no content: not asked for, not handed out", async () => {
    const boss = await account("weekboss");
    const tam = await account("tam");
    const uma = await account("uma");
    execFileSync(process.execPath, ["manage.js", "make-owner", "weekboss"], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, DATA_DIR: dir } });
    const json = weekJson({ course: { name: "Acoustics 410 (PHYS410)", module: "", level: "" }, week: { ...weekJson().week, label: "Week 1" }, fingerprint: { v: 1, sig: sig(410), hashes: [] } });
    const pub = await call("/api/weeks", { method: "POST", body: await weekZip({ json }), key: tam.key, type: "application/zip" });
    const courseId = pub.data.week.courseId;
    // Someone asks for week 9 and adds its slides before anyone says it has no content.
    const nine = (await call("/api/requests", { method: "POST", body: { courseId, number: 9 }, key: tam.key })).data.request;
    await call(`/api/requests/${nine.id}/files?name=w9.pdf`, { method: "POST", body: PDF, key: tam.key, type: "application/octet-stream" });

    // Only admins, from the app (a key) or the site.
    assert.equal((await call(`/api/courses/${courseId}/no-content`, { method: "POST", body: { number: 9 }, key: tam.key })).status, 403);
    assert.deepEqual((await call("/api/app/me", { key: boss.key })).data.user, { name: "weekboss", owner: true });
    const set = await call(`/api/courses/${courseId}/no-content`, { method: "POST", body: { number: 9 }, key: boss.key });
    assert.deepEqual(set.data, { noContent: [9] });
    assert.deepEqual((await call(`/api/courses/${courseId}`, { key: uma.key })).data.course.noContent, [9]);

    // It can't be asked for, its request is out of the lists, and nobody is given it.
    assert.match((await call("/api/requests", { method: "POST", body: { courseId, number: 9 }, key: uma.key })).data.error, /no content/);
    assert.equal((await call(`/api/requests?courseId=${courseId}`, { key: uma.key })).data.requests.some((r) => r.number === 9), false);
    const task = (await call("/api/tasks/today", { key: uma.key })).data.task;
    assert.notEqual(task?.request?.id, nine.id);

    // Taken off again: wanted as before.
    await call(`/api/courses/${courseId}/no-content`, { method: "POST", body: { number: 9, on: false }, key: boss.key });
    assert.equal((await call(`/api/requests?courseId=${courseId}`, { key: uma.key })).data.requests.some((r) => r.id === nine.id), true);
  });
});

describe("upgrading old data", () => {
  it("merges courses that two people started under the same name", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "swm-mig-"));
    const course = (id, owner, name, extra = {}) => ({ id, owner, name, module: "", level: "", createdAt: `2026-01-0${id === "a" ? 1 : 3}`, updatedAt: "2026-01-01", ...extra });
    writeFileSync(path.join(dir, "db.json"), JSON.stringify({
      users: [], sessions: [], keys: [], signups: [],
      courses: [course("a", "alex", "Quantum 101"), course("b", "sam", "quantum 101", { module: "PHYS1" }), course("c", "kim", "Software Engineering 1 (COMP23311)"), course("d", "dx", "Software Engineering 1")],
      weeks: [{ id: "w1", courseId: "a", owner: "alex" }, { id: "w2", courseId: "b", owner: "sam" }, { id: "w3", courseId: "c", owner: "kim" }, { id: "w4", courseId: "d", owner: "dx" }],
    }));
    const port = 3800 + Math.floor(Math.random() * 90);
    const server = spawn(process.execPath, ["server.js"], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, PORT: String(port), DATA_DIR: dir }, stdio: ["ignore", "pipe", "inherit"] });
    try {
      await new Promise((ok, fail) => {
        server.stdout.once("data", ok);
        server.once("exit", (code) => fail(new Error(`server exited with ${code}`)));
      });
      const d = JSON.parse(readFileSync(path.join(dir, "db.json"), "utf8"));
      assert.deepEqual(d.courses.map((c) => [c.id, c.name, c.module, "owner" in c]), [["a", "Quantum 101", "PHYS1", false], ["c", "Software Engineering 1 (COMP23311)", "", false]]);
      assert.deepEqual(d.weeks.map((w) => w.courseId), ["a", "a", "c", "c"]);
    } finally {
      server.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
