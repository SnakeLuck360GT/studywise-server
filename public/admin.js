// The admin page: everything on the site, what it takes up on disk, and the
// tools to look after people, courses and weeks. The server checks you're an
// admin for every call; this page only decides what to show.

import { api, date, el, fillNav, showError } from "/common.js";

const me = await fillNav();
if (!me) {
  location.replace("/login");
  throw new Error("Not logged in");
}
if (!me.owner) {
  location.replace("/account");
  throw new Error("Not an admin");
}

const errorBox = document.getElementById("error");
const noticeBox = document.getElementById("notice");
let data = null;

/** Bytes as KB, MB or GB. */
function size(bytes) {
  if (!bytes) return "0 MB";
  const units = [["GB", 1e9], ["MB", 1e6], ["KB", 1e3]];
  for (const [u, n] of units) if (bytes >= n) return `${(bytes / n).toFixed(bytes / n < 10 ? 1 : 0)} ${u}`;
  return `${bytes} B`;
}
const num = (n) => Number(n ?? 0).toLocaleString();
const ago = (iso) => {
  if (!iso) return "Never";
  const d = (Date.now() - Date.parse(iso)) / 864e5;
  if (d < 1 / 24) return "Just now";
  if (d < 1) return `${Math.round(d * 24)}h ago`;
  if (d < 14) return `${Math.round(d)}d ago`;
  return date(iso);
};

function notice(node) {
  noticeBox.replaceChildren(node);
  noticeBox.hidden = false;
  noticeBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function act(fn, done) {
  showError(errorBox, null);
  try {
    const r = await fn();
    if (done) notice(typeof done === "function" ? done(r) : el("span", { textContent: done }));
    await load();
  } catch (err) {
    showError(errorBox, err);
    errorBox.scrollIntoView({ block: "nearest" });
  }
}

/** A small ⋯ menu of actions. */
function menu(items) {
  const d = el("details", { className: "menu" }, el("summary", { textContent: "⋯", title: "Actions" }));
  const list = el("div", { className: "menu-list" });
  for (const it of items.filter(Boolean)) {
    const b = el("button", { className: it.danger ? "danger" : "ghost", textContent: it.label });
    b.addEventListener("click", () => {
      d.open = false;
      it.run();
    });
    list.append(b);
  }
  d.append(list);
  return d;
}

// Tables: click a heading to sort by it (again to flip), type to filter.

const sorts = {};
function table(id, rows, columns, { query = "", text, initial }) {
  const t = document.getElementById(id);
  const state = (sorts[id] ??= initial ?? { key: columns[0].key, dir: 1 });
  const q = query.trim().toLowerCase();
  const shown = rows.filter((r) => !q || q.split(/\s+/).every((w) => text(r).toLowerCase().includes(w)));
  const col = columns.find((c) => c.key === state.key) ?? columns[0];
  const val = col.sort ?? ((r) => r[col.key]);
  shown.sort((a, b) => {
    const x = val(a);
    const y = val(b);
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true })) * state.dir;
  });
  const head = el(
    "tr",
    {},
    ...columns.map((c) => {
      const th = el("th", { className: [c.num ? "num" : "", c.label ? "sortable" : ""].join(" ") });
      if (!c.label) return th;
      const arrow = c.key === state.key ? (state.dir > 0 ? " ↑" : " ↓") : "";
      const b = el("button", { className: "th", textContent: c.label + arrow });
      b.addEventListener("click", () => {
        if (state.key === c.key) state.dir = -state.dir;
        else Object.assign(state, { key: c.key, dir: c.num ? -1 : 1 });
        render();
      });
      th.append(b);
      return th;
    }),
  );
  const body = shown.map((r) => el("tr", {}, ...columns.map((c) => el("td", { className: c.num ? "num" : c.actions ? "actions" : "" }, c.render ? c.render(r) : String(r[c.key] ?? "")))));
  t.replaceChildren(el("thead", {}, head), el("tbody", {}, ...(body.length ? body : [el("tr", {}, el("td", { colSpan: columns.length, className: "empty", textContent: q ? "Nothing matches." : "Nothing yet." }))])));
}

const small = (text) => el("div", { className: "muted small", textContent: text });
const badge = (text, kind = "") => el("span", { className: `badge ${kind}`, textContent: text });
const frag = (...nodes) => {
  const f = document.createDocumentFragment();
  f.append(...nodes.filter(Boolean));
  return f;
};

/** A thin bar for a share of the biggest value. */
function meter(label, sub, bytes, max) {
  const fill = el("span");
  fill.style.width = `${max ? Math.max(2, (bytes / max) * 100) : 0}%`;
  return el("div", { className: "meter" }, el("div", { className: "meter-top" }, el("span", { className: "meter-label" }, el("b", { textContent: label }), sub ? el("span", { className: "muted", textContent: ` ${sub}` }) : ""), el("span", { className: "muted", textContent: size(bytes) })), el("div", { className: "meter-bar" }, fill));
}

// Sections

function renderStats() {
  const t = data.totals;
  const s = data.storage;
  const stat = (n, label, sub) => el("div", { className: "stat" }, el("b", { textContent: n }), el("span", { textContent: label }), sub ? small(sub) : "");
  document.getElementById("stats").replaceChildren(
    stat(num(t.people), "people", `${t.admins} admin${t.admins === 1 ? "" : "s"} · ${t.newPeople} new this week`),
    stat(num(t.courses), "courses"),
    stat(num(t.weeks), "weeks", `${t.newWeeks} new, ${t.updatedWeeks} updated this week`),
    stat(num(t.written), "topics written", `of ${num(t.topics)} planned`),
    stat(num(t.cards), "flashcards"),
    stat(num(t.downloads), "downloads"),
    stat(num(t.keys), "API keys"),
    stat(size(s.weeks + s.db + s.leftovers.bytes), "stored", s.disk ? `${size(s.disk.free)} free on the disk` : ""),
  );
}

function renderStorage() {
  const s = data.storage;
  const ours = s.weeks + s.db + s.leftovers.bytes;
  const bar = document.getElementById("disk-bar");
  const legend = document.getElementById("disk-legend");
  const parts = [];
  if (s.disk) {
    const other = Math.max(0, s.disk.total - s.disk.free - ours);
    parts.push(["weeks", "Published weeks", s.weeks], ["db", "Accounts & index", s.db], ["left", "Leftover files", s.leftovers.bytes], ["other", "Everything else on the disk", other], ["free", "Free", s.disk.free]);
    document.getElementById("disk-line").textContent = `Studywise uses ${size(ours)} of a ${size(s.disk.total)} disk (${((ours / s.disk.total) * 100).toFixed(ours / s.disk.total < 0.01 ? 2 : 1)}%). ${size(s.disk.free)} is free.`;
  } else {
    parts.push(["weeks", "Published weeks", s.weeks], ["db", "Accounts & index", s.db], ["left", "Leftover files", s.leftovers.bytes]);
    document.getElementById("disk-line").textContent = `Studywise uses ${size(ours)}.`;
  }
  const total = parts.reduce((n, [, , b]) => n + b, 0) || 1;
  bar.replaceChildren(
    ...parts
      .filter(([, , b]) => b > 0)
      .map(([k, label, b]) => {
        const seg = el("span", { className: `seg ${k}`, title: `${label}: ${size(b)}` });
        // Tiny but there: Studywise's own share is always visible.
        seg.style.flexGrow = String(Math.max(b / total, k === "free" || k === "other" ? 0 : 0.006));
        return seg;
      }),
  );
  legend.replaceChildren(...parts.filter(([k, , b]) => b > 0 || k === "weeks").map(([k, label, b]) => el("span", { className: "key" }, el("i", { className: `seg ${k}` }), `${label} `, el("b", { textContent: size(b) }))));

  const left = document.getElementById("leftovers");
  left.hidden = !s.leftovers.count;
  if (s.leftovers.count) {
    const clean = el("button", { className: "ghost", textContent: "Clean up" });
    clean.addEventListener("click", () => {
      if (!confirm(`Delete ${s.leftovers.count} leftover file${s.leftovers.count === 1 ? "" : "s"} (${size(s.leftovers.bytes)})? No published week uses them.`)) return;
      act(() => api("/api/admin/cleanup", { method: "POST", body: {} }), (r) => el("span", { textContent: `Deleted ${r.count} file${r.count === 1 ? "" : "s"}, ${size(r.bytes)} freed.` }));
    });
    left.replaceChildren(el("span", { textContent: `${s.leftovers.count} file${s.leftovers.count === 1 ? "" : "s"} (${size(s.leftovers.bytes)}) in the weeks folder that no published week uses, from uploads that stopped halfway or weeks deleted by hand.` }), clean);
  }

  const people = data.users.filter((u) => u.bytes).slice(0, 8);
  document.getElementById("by-person").replaceChildren(...(people.length ? people.map((u) => meter(u.name, `${u.weeks} week${u.weeks === 1 ? "" : "s"}`, u.bytes, people[0].bytes)) : [small("Nobody has published anything yet.")]));
  const weeks = [...data.weeks].sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  document.getElementById("by-week").replaceChildren(...(weeks.length ? weeks.map((w) => meter(`${w.courseName} · ${w.label}`, w.authors.join(", "), w.bytes, weeks[0].bytes)) : [small("No weeks yet.")]));
}

function renderPeople() {
  table("people-table", data.users, [
    { key: "name", label: "Name", render: (u) => frag(el("b", { textContent: u.name }), u.owner ? badge("Admin", "accent") : null, u.name === me.name ? badge("You") : null, small(`Joined ${date(u.createdAt)}`)) },
    { key: "weeks", label: "Weeks", num: true },
    { key: "bytes", label: "Storage", num: true, render: (u) => size(u.bytes) },
    { key: "downloads", label: "Downloads", num: true, render: (u) => num(u.downloads) },
    { key: "keys", label: "Keys", num: true },
    { key: "seen", label: "Last seen", sort: (u) => [u.lastLogin, u.lastKeyUse].filter(Boolean).sort().at(-1) ?? "", render: (u) => frag(el("div", { textContent: `Site: ${ago(u.lastLogin)}` }), small(`App: ${ago(u.lastKeyUse)}`)) },
    {
      key: "actions",
      actions: true,
      render: (u) =>
        menu([
          u.name !== me.name && { label: u.owner ? "Remove admin" : "Make admin", run: () => confirm(u.owner ? `Take admin away from ${u.name}?` : `Make ${u.name} an admin? They'll be able to see and delete everything here.`) && act(() => api(`/api/admin/users/${u.name}`, { method: "PATCH", body: { owner: !u.owner } }), u.owner ? `${u.name} is no longer an admin.` : `${u.name} is now an admin.`) },
          {
            label: "Reset password",
            run: () =>
              confirm(`Give ${u.name} a new password? Their old one stops working and they're logged out of the site. Their API keys keep working.`) &&
              act(
                () => api(`/api/admin/users/${u.name}/password`, { method: "POST", body: {} }),
                (r) => {
                  const copy = el("button", { className: "ghost", textContent: "Copy" });
                  copy.addEventListener("click", async () => {
                    await navigator.clipboard.writeText(r.password);
                    copy.textContent = "Copied";
                  });
                  return frag(el("span", { textContent: `New password for ${u.name}. Send it to them; it won't be shown again.` }), el("div", { className: "newkey" }, el("code", { textContent: r.password }), copy));
                },
              ),
          },
          u.name !== me.name && u.sessions > 0 && { label: "Log out of the site", run: () => act(() => api(`/api/admin/users/${u.name}/logout`, { method: "POST", body: {} }), `${u.name} is logged out of the site everywhere.`) },
          u.name !== me.name && { label: "Delete account", danger: true, run: () => confirm(`Delete ${u.name}, their ${u.keys} API key${u.keys === 1 ? "" : "s"} and the ${u.weeks} week${u.weeks === 1 ? "" : "s"} they published? This can't be undone.`) && act(() => api(`/api/admin/users/${u.name}`, { method: "DELETE" }), `Deleted ${u.name}.`) },
        ]),
    },
  ], { query: document.getElementById("people-q").value, text: (u) => u.name, initial: { key: "bytes", dir: -1 } });
}

function renderCourses() {
  table("courses-table", data.courses, [
    { key: "name", label: "Course", render: (c) => frag(el("b", { textContent: c.name }), small([c.module, c.level].filter(Boolean).join(" · ") || "No module or level"), small(c.authors.length ? `By ${c.authors.join(", ")}` : "")) },
    { key: "weeks", label: "Weeks", num: true },
    { key: "topics", label: "Topics", num: true },
    { key: "downloads", label: "Downloads", num: true, render: (c) => num(c.downloads) },
    { key: "bytes", label: "Storage", num: true, render: (c) => size(c.bytes) },
    { key: "updatedAt", label: "Updated", render: (c) => date(c.updatedAt) },
    {
      key: "actions",
      actions: true,
      render: (c) =>
        menu([
          {
            label: "Rename",
            run: () => {
              const name = prompt("Course name", c.name);
              if (name === null || !name.trim()) return;
              const module = prompt("Module code (leave empty for none)", c.module ?? "");
              if (module === null) return;
              act(() => api(`/api/admin/courses/${c.id}`, { method: "PATCH", body: { name, module } }), `Renamed to ${name.trim()}.`);
            },
          },
          { label: "Delete course", danger: true, run: () => confirm(`Delete ${c.name} and all ${c.weeks} of its weeks from the marketplace? People who added them keep their copies.`) && act(() => api(`/api/admin/courses/${c.id}`, { method: "DELETE" }), `Deleted ${c.name}.`) },
        ]),
    },
  ], { query: document.getElementById("courses-q").value, text: (c) => [c.name, c.module, c.level, ...c.authors].join(" "), initial: { key: "updatedAt", dir: -1 } });
}

function renderWeeks() {
  const models = (w) => [...new Set((w.writtenWith ?? []).map((m) => m.model))].join(", ");
  table("weeks-table", data.weeks, [
    {
      key: "name",
      label: "Week",
      sort: (w) => `${w.courseName} ${w.label}`,
      render: (w) => frag(el("b", { textContent: w.courseName }), document.createTextNode(` · ${w.label}`), w.merged ? badge("Merged") : null, w.missing ? badge("File missing", "bad") : null, small(`By ${w.authors.join(", ")}${models(w) ? ` · written with ${models(w)}` : ""}`)),
    },
    { key: "writtenCount", label: "Topics", num: true, render: (w) => `${w.writtenCount}/${w.topicCount}` },
    { key: "cardCount", label: "Cards", num: true },
    { key: "files", label: "Files", num: true, sort: (w) => w.files?.length ?? 0, render: (w) => String(w.files?.length ?? 0) },
    { key: "bytes", label: "Size", num: true, render: (w) => size(w.bytes) },
    { key: "downloads", label: "Downloads", num: true },
    { key: "updatedAt", label: "Updated", render: (w) => date(w.updatedAt) },
    {
      key: "actions",
      actions: true,
      render: (w) =>
        menu([
          !w.missing && { label: "Download .studyweek", run: () => (location.href = `/api/weeks/${w.id}/file`) },
          { label: "Take down", danger: true, run: () => confirm(`Take “${w.courseName} · ${w.label}” off the marketplace? People who already added it keep their copy.`) && act(() => api(`/api/weeks/${w.id}`, { method: "DELETE" }), `Took down ${w.courseName} · ${w.label}.`) },
        ]),
    },
  ], {
    query: document.getElementById("weeks-q").value,
    text: (w) => [w.courseName, w.label, ...w.authors, ...(w.topics ?? []).map((t) => t.title)].join(" "),
    initial: { key: "updatedAt", dir: -1 },
  });
}

function render() {
  if (!data) return;
  renderStats();
  renderStorage();
  renderPeople();
  renderCourses();
  renderWeeks();
}

async function load() {
  try {
    data = await api("/api/admin/overview");
    render();
  } catch (err) {
    showError(errorBox, err);
  }
}

for (const id of ["people-q", "courses-q", "weeks-q"]) document.getElementById(id).addEventListener("input", render);
document.getElementById("refresh").addEventListener("click", () => {
  noticeBox.hidden = true;
  load();
});
// Close an open ⋯ menu when clicking elsewhere.
document.addEventListener("click", (e) => {
  for (const d of document.querySelectorAll("details.menu[open]")) if (!d.contains(e.target)) d.open = false;
});
await load();
