// Which published weeks belong to the same course. People name the same module
// differently ("Software Engineering 1 (COMP23311)", "Software Engineering 1",
// "software engineering 1"), so courses are matched on their module code when
// both names have one, and otherwise on the title with the code, brackets,
// punctuation and case taken out.

// A module code: letters then digits, like COMP23311, CS101, PHYS 1001, MA-2210A.
// Spaced out, only in capitals (so "1900 to 2000" isn't a code); written
// solid, in any case ("comp23311").
const CODES = [/\b([A-Z]{2,6})[\s-]?(\d{3,6}[A-Z]?)\b/, /\b([a-z]{2,6})(\d{3,6}[a-z]?)\b/i];

/** "COMP23311" from "Software Engineering 1 (COMP23311)", or null. */
export function courseCode(...texts) {
  for (const t of texts) {
    for (const re of CODES) {
      const m = String(t ?? "").match(re);
      if (m) return `${m[1]}${m[2]}`.toUpperCase();
    }
  }
  return null;
}

// Words people shorten.
const WORDS = { intro: "introduction", eng: "engineering", sys: "systems", prog: "programming", comp: "computer", maths: "mathematics", math: "mathematics" };

/** "software engineering 1" from "Software Engineering 1 (COMP23311)". */
export function courseTitle(name) {
  return String(name ?? "")
    .replace(new RegExp(CODES[0].source, "g"), " ")
    .replace(new RegExp(CODES[1].source, "gi"), " ")
    .replace(/[()[\]{}]/g, " ")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w, i) => w && !(i === 0 && w === "the"))
    .map((w) => WORDS[w] ?? w)
    .join(" ");
}

/** What a course is matched on. */
export const courseKey = (name, module) => ({ code: courseCode(name, module), title: courseTitle(name) });

/** Two names for the same course? Different module codes always mean different courses. */
export function sameCourse(a, b) {
  if (a.code && b.code) return a.code === b.code;
  return Boolean(a.title) && a.title === b.title;
}

/** Of two names for one course, the one that says more: with its module code, then the longer. */
export function betterName(a, b) {
  const ca = Boolean(courseCode(a));
  const cb = Boolean(courseCode(b));
  if (ca !== cb) return ca ? a : b;
  return b.length > a.length ? b : a;
}
