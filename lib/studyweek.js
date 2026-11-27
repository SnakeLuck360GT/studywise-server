// Checks that an upload really is a week exported by Studywise Courses, and
// reads what the marketplace shows about it. Anything else is refused: the
// zip may hold week.json and the week's source files and nothing more, every
// source file must be listed in week.json, and each file's bytes must match
// its type (a .pdf has to start like a PDF, a .txt has to be text, and so on).
//
// The shape follows src/main/services/weekShare.ts in the app.

import { createHash } from "node:crypto";
import JSZip from "jszip";
import { HttpError } from "./auth.js";

const FORMAT = 1;
export const FINGERPRINT_VERSION = 1;
export const SIGNATURE_SIZE = 128;

const MAX_WEEK_JSON = 60 * 1000 * 1000;
const MAX_UNPACKED = 1500 * 1000 * 1000;
const MAX_FILES = 150;
const MAX_TOPICS = 300;
const MAX_CARDS = 20000;

const bad = (why) => new HttpError(400, `That isn't a Studywise week: ${why}`);

// What a week can hold, the same list the app accepts, and how to recognise
// each by its first bytes.
const startsWith = (buf, sig, at = 0) => buf.length >= at + sig.length && sig.every((b, i) => buf[at + i] === b);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const ZIP = ascii("PK\x03\x04");
const BINARY = {
  pdf: (b) => {
    // Some PDFs have a little junk before the header; the spec allows 1024 bytes.
    const head = b.subarray(0, 1024).toString("latin1");
    return head.includes("%PDF-");
  },
  docx: (b) => startsWith(b, ZIP),
  pptx: (b) => startsWith(b, ZIP),
  png: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  jpeg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  gif: (b) => startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a")),
  webp: (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8),
};
const TEXT = new Set(["txt", "md", "markdown", "vtt", "srt", "html", "htm", "csv", "rtf"]);

function isText(buf, ext) {
  // UTF-16 transcripts carry a byte order mark; anything else must be UTF-8.
  if (startsWith(buf, [0xff, 0xfe]) || startsWith(buf, [0xfe, 0xff])) return true;
  const sample = buf.subarray(0, 256 * 1024);
  if (sample.includes(0)) return false;
  try {
    // stream: a character split by the sample's end isn't an error.
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: buf.length > sample.length });
  } catch {
    return false;
  }
  if (ext === "rtf") return sample.subarray(0, 6).toString("latin1").startsWith("{\\rtf");
  return true;
}

function checkContent(name, buf, fail = bad) {
  const ext = name.toLowerCase().split(".").pop();
  if (BINARY[ext]) {
    if (!BINARY[ext](buf)) throw fail(`${name} isn't really a .${ext} file`);
  } else if (TEXT.has(ext)) {
    if (!isText(buf, ext)) throw fail(`${name} isn't a text file`);
  } else {
    throw fail(`.${ext} files can't be in a week`);
  }
}

/** A slide, transcript or reading someone uploads for a requested week: the same kinds a week can hold. */
export function checkSourceFile(name, buf) {
  checkContent(name, buf, (why) => new HttpError(400, why));
}

const str = (v, max, what) => {
  if (typeof v !== "string") throw bad(`${what} is missing`);
  if (v.length > max) throw bad(`${what} is too long`);
  return v;
};

function parseJsonText(v, what) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw bad(`${what} isn't stored the way Studywise stores it`);
  try {
    return JSON.parse(v);
  } catch {
    throw bad(`${what} is damaged`);
  }
}

const safePath = (p) => typeof p === "string" && p.length < 600 && !p.includes("\\") && !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === "." || s === "");

function modelOf(v) {
  if (!v || typeof v !== "object" || typeof v.model !== "string" || !v.model.trim()) return null;
  return {
    model: v.model.slice(0, 100),
    effort: typeof v.effort === "string" && v.effort ? v.effort.slice(0, 40) : null,
    provider: v.provider === "ollama" ? "ollama" : v.provider === "claude" ? "claude" : null,
  };
}

const LEVELS = ["standard", "quick", "deep"];

/** Each topic as the marketplace lists it. */
function topicSummary(t) {
  const plan = parseJsonText(t.plan, "A topic's plan") ?? {};
  const content = parseJsonText(t.content, "A topic's notes");
  if (content !== null && !Array.isArray(content?.sections)) throw bad("a topic's notes have no sections");
  const versions = parseJsonText(t.versions ?? "{}", "A topic's other levels") ?? {};
  const levels = LEVELS.filter((l) => (content && (t.level || "standard") === l) || versions[l]?.content);
  const sections = content ? content.sections.map((s) => String(s?.heading ?? "")) : Array.isArray(plan.sections) ? plan.sections.map(String) : [];
  return {
    title: String(content?.title || plan.title || "Untitled topic").slice(0, 300),
    goal: String(content?.goal || plan.goal || "").slice(0, 1000),
    sections: sections.slice(0, 40).map((s) => s.slice(0, 300)),
    levels,
    written: t.status === "ready" && !!content,
  };
}

/** The signature the app sent, if it's the shape we compare. */
function signatureOf(fp) {
  if (!fp || fp.v !== FINGERPRINT_VERSION) return null;
  const sig = fp.sig;
  if (!Array.isArray(sig) || sig.length !== SIGNATURE_SIZE || !sig.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)) return null;
  return sig;
}

/**
 * Reads an uploaded .studyweek. Throws a 400 HttpError saying what's wrong
 * when it isn't one. Returns what's stored about the week.
 */
/** unwritten: a planned week with nothing written yet is fine (one sent with a request, for someone to write). */
export async function inspectWeek(buf, { unwritten = false } = {}) {
  if (!startsWith(buf, ZIP)) throw bad("it isn't a .studyweek file");
  let zip;
  try {
    zip = await JSZip.loadAsync(buf, { checkCRC32: true });
  } catch {
    throw bad("the file is damaged");
  }

  // Unpacked size, before unpacking anything (zip bombs).
  let unpacked = 0;
  for (const e of Object.values(zip.files)) unpacked += e._data?.uncompressedSize ?? 0;
  if (unpacked > MAX_UNPACKED) throw bad("it's far too big unpacked");

  const entry = zip.file("week.json");
  if (!entry || (entry._data?.uncompressedSize ?? 0) > MAX_WEEK_JSON) throw bad("week.json is missing");
  let json;
  try {
    json = JSON.parse(await entry.async("string"));
  } catch {
    throw bad("week.json is damaged");
  }
  if (json?.app !== "studywise-courses" || json.kind !== "week" || typeof json.format !== "number") throw bad("it wasn't made by Studywise");
  if (json.format > FORMAT) throw bad("it was made by a newer Studywise than this site knows");
  if (!json.week || typeof json.week !== "object" || !json.course || typeof json.course !== "object") throw bad("week.json is incomplete");
  if (!Array.isArray(json.topics) || !Array.isArray(json.cards) || !Array.isArray(json.files)) throw bad("week.json is incomplete");
  if (json.topics.length > MAX_TOPICS || json.cards.length > MAX_CARDS || json.files.length > MAX_FILES) throw bad("it has more in it than a week can");

  const courseName = str(json.course.name, 200, "The course name").replace(/\s+/g, " ").trim();
  if (!courseName) throw bad("the course has no name");
  const label = str(json.week.label, 200, "The week's name").replace(/\s+/g, " ").trim() || "Week";

  for (const c of json.cards) {
    if (!c || typeof c.front !== "string" || typeof c.back !== "string") throw bad("a flashcard is damaged");
    if (c.front.length > 20000 || c.back.length > 50000) throw bad("a flashcard is too long");
  }

  const topics = [...json.topics]
    .sort((a, b) => Number(a?.position ?? 0) - Number(b?.position ?? 0))
    .map((t) => {
      if (!t || typeof t !== "object" || typeof t.id !== "string") throw bad("a topic is damaged");
      return { row: t, summary: topicSummary(t) };
    });
  const written = topics.filter((t) => t.summary.written).length;
  if (!written && !unwritten) throw bad("none of its topics are written yet. Write some in Studywise first");
  if (!topics.length) throw bad("it has no topics planned");

  // Files: every listed file is in the zip, and nothing else is.
  const listed = new Map();
  const files = [];
  for (const f of json.files) {
    if (!f || typeof f.name !== "string" || !safePath(f.path)) throw bad("a file's details are damaged");
    const at = `files/${f.path}`;
    const e = zip.file(at);
    if (!e) throw bad(`${f.name} is listed but not in the file`);
    if (listed.has(at)) throw bad(`${f.name} is listed twice`);
    const bytes = await e.async("nodebuffer");
    checkContent(f.name, bytes);
    listed.set(at, f);
    files.push({ name: f.name.slice(0, 300), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  for (const [name, e] of Object.entries(zip.files)) {
    if (name === "week.json" || listed.has(name)) continue;
    // Folder entries for the listed files' folders are fine.
    if (e.dir && [...listed.keys()].some((p) => p.startsWith(name))) continue;
    throw bad(`it has something extra in it (${name.slice(0, 80)})`);
  }

  // Models: what planned the week, and what wrote each level of each topic.
  const counts = new Map();
  for (const { row } of topics) {
    const ww = parseJsonText(row.written_with ?? "{}", "A topic's models") ?? {};
    for (const v of Object.values(ww)) {
      const m = modelOf(v);
      if (!m) continue;
      const k = `${m.provider}|${m.model}|${m.effort}`;
      counts.set(k, { ...m, count: (counts.get(k)?.count ?? 0) + 1 });
    }
  }
  const plannedWith = modelOf(parseJsonText(json.week.planned_with ?? null, "The week's model"));

  return {
    course: {
      name: courseName,
      module: String(json.course.module ?? "").slice(0, 200),
      level: String(json.course.level ?? "").slice(0, 200),
    },
    label,
    number: Number.isInteger(json.week.position) && json.week.position >= 0 ? json.week.position + 1 : 1,
    topics: topics.map((t) => ({ title: t.summary.title, goal: t.summary.goal, sections: t.summary.sections, levels: t.summary.levels })),
    topicCount: topics.length,
    writtenCount: written,
    cardCount: json.cards.length,
    files: files.map(({ name, size }) => ({ name, size })),
    hashes: [...new Set(files.map((f) => f.sha256))],
    sig: signatureOf(json.fingerprint),
    plannedWith,
    writtenWith: [...counts.values()].sort((a, b) => b.count - a.count),
  };
}

/** Roughly how much of two weeks' material is the same, 0–1 (see src/shared/fingerprint.ts in the app). */
export function similarity(a, b) {
  if (!a || !b || a.length !== SIGNATURE_SIZE || b.length !== SIGNATURE_SIZE) return 0;
  let same = 0;
  for (let i = 0; i < SIGNATURE_SIZE; i++) if (a[i] === b[i]) same++;
  return same / SIGNATURE_SIZE;
}

export { signatureOf };
