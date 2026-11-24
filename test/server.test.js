// Runs the server on a spare port with a throwaway data folder, and drives it
// like the site and the app do.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import JSZip from "jszip";
import { inspectWeek } from "../lib/studyweek.js";

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
    server = spawn(process.execPath, ["server.js"], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, PORT: String(port), DATA_DIR: dir, TRUST_PROXY: "0" }, stdio: ["ignore", "pipe", "inherit"] });
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

  it("deleting a key stops it working", async () => {
    const pat = await account("pat");
    const { keys } = (await call("/api/keys", { cookie: pat.cookie })).data;
    await call(`/api/keys/${keys[0].id}`, { method: "DELETE", cookie: pat.cookie });
    assert.equal((await call("/api/app/me", { key: pat.key })).status, 401);
  });
});

describe("upgrading old data", () => {
  it("merges courses that two people started under the same name", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "swm-mig-"));
    const course = (id, owner, name, extra = {}) => ({ id, owner, name, module: "", level: "", createdAt: `2026-01-0${id === "a" ? 1 : 3}`, updatedAt: "2026-01-01", ...extra });
    writeFileSync(path.join(dir, "db.json"), JSON.stringify({
      users: [], sessions: [], keys: [], signups: [],
      courses: [course("a", "alex", "Quantum 101"), course("b", "sam", "quantum 101", { module: "PHYS1" })],
      weeks: [{ id: "w1", courseId: "a", owner: "alex" }, { id: "w2", courseId: "b", owner: "sam" }],
    }));
    const port = 3800 + Math.floor(Math.random() * 90);
    const server = spawn(process.execPath, ["server.js"], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, PORT: String(port), DATA_DIR: dir }, stdio: ["ignore", "pipe", "inherit"] });
    try {
      await new Promise((ok, fail) => {
        server.stdout.once("data", ok);
        server.once("exit", (code) => fail(new Error(`server exited with ${code}`)));
      });
      const d = JSON.parse(readFileSync(path.join(dir, "db.json"), "utf8"));
      assert.deepEqual(d.courses.map((c) => [c.id, c.module, "owner" in c]), [["a", "PHYS1", false]]);
      assert.deepEqual(d.weeks.map((w) => w.courseId), ["a", "a"]);
    } finally {
      server.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
