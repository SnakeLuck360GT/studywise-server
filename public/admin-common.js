// Shared by the admin pages: sizes and dates, activity as sentences, and the
// small bar charts on the Trends section.

import { date, el } from "/common.js";

/** Bytes as KB, MB or GB. */
export function size(bytes) {
  if (!bytes) return "0 MB";
  for (const [u, n] of [["GB", 1e9], ["MB", 1e6], ["KB", 1e3]]) if (bytes >= n) return `${(bytes / n).toFixed(bytes / n < 10 ? 1 : 0)} ${u}`;
  return `${bytes} B`;
}
export const num = (n) => Number(n ?? 0).toLocaleString();
export function ago(iso) {
  if (!iso) return "Never";
  const d = (Date.now() - Date.parse(iso)) / 864e5;
  if (d < 1 / 24) return "Just now";
  if (d < 1) return `${Math.round(d * 24)}h ago`;
  if (d < 14) return `${Math.round(d)}d ago`;
  return date(iso);
}
export const when = (iso) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const small = (text) => el("div", { className: "muted small", textContent: text });
export const badge = (text, kind = "") => el("span", { className: `badge ${kind}`, textContent: text });
export const frag = (...nodes) => {
  const f = document.createDocumentFragment();
  f.append(...nodes.filter((n) => n !== null && n !== undefined && n !== false));
  return f;
};
/** A person's name, linking to their admin page. */
export const person = (name) => (name ? el("a", { href: `/admin-person?name=${encodeURIComponent(name)}`, className: "person", textContent: name }) : el("span", { className: "muted", textContent: "someone" }));

const t = (s) => document.createTextNode(s);
const REASONS = { wrong: "wrong or misleading", copyright: "someone else's work", spam: "spam", offensive: "offensive", other: "something else" };
const b = (s) => el("b", { textContent: s ?? "" });

/** What happened, as a sentence: "alex published Quantum 101 · Week 3". */
export function describe(a) {
  const d = a.detail ?? {};
  const who = person(a.actor);
  const them = person(a.target);
  switch (a.action) {
    case "signup":
      return frag(who, t(" made an account"));
    case "login":
      return frag(who, t(" logged in"));
    case "publish":
      return frag(who, t(d.replaced ? " published a new version of " : " published "), b(d.week), d.bytes ? t(` (${size(d.bytes)})`) : null);
    case "merge":
      return frag(who, t(` merged ${d.from?.length ?? "several"} copies of `), b(d.week));
    case "download":
      return frag(who, t(" added "), b(d.week), t(" by "), person(d.author));
    case "take-down":
      return d.byAdmin ? frag(who, t(" took down "), b(d.week), t(" by "), person(d.author), d.report ? t(" (reported)") : null) : frag(who, t(" took down their "), b(d.week));
    case "report":
      return frag(who, t(" reported "), b(d.week), t(` (${REASONS[d.reason] ?? d.reason})`));
    case "report-dismiss":
      return frag(who, t(" dismissed a report about "), b(d.week));
    case "suspend":
      return frag(who, t(" suspended "), them, d.reason ? t(`: ${d.reason}`) : null);
    case "unsuspend":
      return frag(who, t(" lifted the suspension of "), them);
    case "admin-add":
      return frag(who, t(" made "), them, t(" an admin"));
    case "admin-remove":
      return frag(who, t(" took admin away from "), them);
    case "password-reset":
      return frag(who, t(" reset the password of "), them);
    case "account-delete":
      return frag(who, t(" deleted the account "), b(a.target), t(` and ${d.weeks ?? 0} weeks`));
    case "course-delete":
      return frag(who, t(` deleted a course and its ${d.weeks ?? 0} weeks`));
    case "course-rename":
      return frag(who, t(" renamed a course to "), b(d.name));
    case "cloud-limit":
      return frag(who, t(" set the cloud limit of "), them, t(` to ${d.gb} GB`));
    case "cloud-restore":
      return frag(who, t(" restored "), them, t(`’s library to ${date(d.day)}`));
    case "cloud-delete":
      return a.actor === a.target ? frag(who, t(" deleted their cloud copy")) : frag(who, t(" deleted the cloud copy of "), them);
    case "key-revoke":
      return frag(who, t(" revoked an API key of "), them);
    case "signups":
      return frag(who, t(` set sign-ups to ${{ open: "open", invite: "invite only", closed: "closed" }[d.mode] ?? d.mode}`));
    case "invite":
      return frag(who, t(" made an invite code"), d.note ? t(` (${d.note})`) : null);
    case "announce":
      return frag(who, t(" posted an announcement: "), el("i", { textContent: `“${d.text}”` }));
    case "announce-clear":
      return frag(who, t(" cleared the announcement"));
    case "cleanup":
      return frag(who, t(` cleaned up ${d.count} leftover file${d.count === 1 ? "" : "s"} (${size(d.bytes)})`));
    default:
      return frag(who, t(` ${a.action}`), a.target ? t(` ${a.target}`) : null);
  }
}

/** The kinds of activity, for the filter. */
export const ACTIONS = [
  ["", "Everything"],
  ["signup", "Sign-ups"],
  ["login", "Logins"],
  ["publish", "Publishing"],
  ["download", "Downloads"],
  ["take-down", "Take-downs"],
  ["report", "Reports"],
  ["suspend", "Suspensions"],
  ["cloud", "Cloud"],
];

// Charts: one measure per chart (small multiples), thin bars with a 2px gap and
// rounded tops on a shared baseline, a hover tooltip per bar, and the numbers
// in a table underneath for anyone who'd rather read them.

const W = 600;
const H = 120;
const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};
/** A bar with only its top corners rounded, standing on the baseline. */
function barPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${H}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${H}Z`;
}

/**
 * A bar chart of one measure by day. values: [{day, value}] (value null: no
 * record that day). format: how a value reads in the tooltip.
 */
export function barChart({ title, values, format = num, headline }) {
  const tip = el("div", { className: "chart-tip", hidden: true });
  const max = Math.max(1, ...values.map((v) => v.value ?? 0));
  const step = W / values.length;
  const gap = Math.min(2, step * 0.25);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "chart", role: "img", "aria-label": title });
  svg.append(svgEl("line", { x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5, class: "chart-base" }));
  values.forEach((v, i) => {
    const x = i * step + gap / 2;
    const w = step - gap;
    if (v.value) {
      const h = Math.max(2, (v.value / max) * (H - 6));
      svg.append(svgEl("path", { d: barPath(x, H - h, w, h, 4), class: "chart-bar" }));
    }
    // The hit target: the whole column, so thin bars are easy to hover.
    const hit = svgEl("rect", { x: i * step, y: 0, width: step, height: H, class: "chart-hit" });
    hit.addEventListener("mouseenter", () => {
      tip.hidden = false;
      tip.replaceChildren(el("b", { textContent: v.value == null ? "No record" : format(v.value) }), el("span", { textContent: new Date(`${v.day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) }));
      tip.style.left = `${((i + 0.5) / values.length) * 100}%`;
      hit.classList.add("on");
    });
    hit.addEventListener("mouseleave", () => {
      tip.hidden = true;
      hit.classList.remove("on");
    });
    svg.append(hit);
  });
  const first = values[0]?.day;
  const last = values.at(-1)?.day;
  const label = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return el(
    "div",
    { className: "chart-card" },
    el("div", { className: "chart-head" }, el("span", { className: "chart-title", textContent: title }), el("b", { className: "chart-headline", textContent: headline })),
    el("div", { className: "chart-plot" }, el("span", { className: "chart-max", textContent: format(max) }), svg, tip),
    el("div", { className: "chart-axis" }, el("span", { textContent: first ? label(first) : "" }), el("span", { textContent: last ? "Today" : "" })),
  );
}
