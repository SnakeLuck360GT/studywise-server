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

// Courses, each with its weeks underneath. Headings sort the courses; weeks
// stay in week order inside their course. A course folds away with its arrow.

const folded = new Set();
const courseSort = { key: "updatedAt", dir: -1 };

function courseMenu(c) {
  return menu([
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
  ]);
}

function weekMenu(w) {
  return menu([
    !w.missing && { label: "Download .studyweek", run: () => (location.href = `/api/weeks/${w.id}/file`) },
    { label: "Take down", danger: true, run: () => confirm(`Take “${w.courseName} · ${w.label}” off the marketplace? People who already added it keep their copy.`) && act(() => api(`/api/weeks/${w.id}`, { method: "DELETE" }), `Took down ${w.courseName} · ${w.label}.`) },
  ]);
}

function renderCourses() {
  const q = document.getElementById("courses-q").value.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const has = (text) => words.every((w) => text.toLowerCase().includes(w));
  const models = (w) => [...new Set((w.writtenWith ?? []).map((m) => m.model))].join(", ");
  const byCourse = new Map(data.courses.map((c) => [c.id, []]));
  for (const w of data.weeks) byCourse.get(w.courseId)?.push(w);

  const groups = data.courses
    .map((c) => {
      const all = (byCourse.get(c.id) ?? []).sort((a, b) => (a.number ?? 999) - (b.number ?? 999) || a.label.localeCompare(b.label, undefined, { numeric: true }) || a.author.localeCompare(b.author));
      const courseHit = !words.length || has([c.name, c.module, c.level, ...c.authors].join(" "));
      // The course matches: all its weeks. Otherwise only the weeks that match (by label, author or topic).
      const weeks = courseHit ? all : all.filter((w) => has([w.label, ...w.authors, ...(w.topics ?? []).map((t) => t.title)].join(" ")));
      const files = all.reduce((n, w) => n + (w.files?.length ?? 0), 0);
      return { c: { ...c, files, written: all.reduce((n, w) => n + w.writtenCount, 0) }, weeks, show: courseHit || weeks.length };
    })
    .filter((g) => g.show);

  const cols = [
    { key: "name", label: "Course / week", sort: (g) => g.c.name },
    { key: "topics", label: "Topics", num: true, sort: (g) => g.c.topics },
    { key: "cards", label: "Cards", num: true, sort: (g) => g.c.cards },
    { key: "files", label: "Files", num: true, sort: (g) => g.c.files },
    { key: "bytes", label: "Size", num: true, sort: (g) => g.c.bytes },
    { key: "downloads", label: "Downloads", num: true, sort: (g) => g.c.downloads },
    { key: "updatedAt", label: "Updated", sort: (g) => g.c.updatedAt },
    { key: "actions" },
  ];
  const col = cols.find((x) => x.key === courseSort.key) ?? cols[0];
  groups.sort((a, b) => {
    const x = col.sort(a);
    const y = col.sort(b);
    return (typeof x === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true })) * courseSort.dir;
  });

  const head = el(
    "tr",
    {},
    ...cols.map((c) => {
      const th = el("th", { className: c.num ? "num" : "" });
      if (!c.label) return th;
      const b = el("button", { className: "th", textContent: c.label + (c.key === courseSort.key ? (courseSort.dir > 0 ? " ↑" : " ↓") : "") });
      b.addEventListener("click", () => {
        if (courseSort.key === c.key) courseSort.dir = -courseSort.dir;
        else Object.assign(courseSort, { key: c.key, dir: c.num || c.key === "updatedAt" ? -1 : 1 });
        renderCourses();
      });
      th.append(b);
      return th;
    }),
  );

  const bodies = groups.map(({ c, weeks }) => {
    const open = !folded.has(c.id) || words.length > 0;
    const toggle = el("button", { className: `fold${open ? " open" : ""}`, textContent: "›", title: open ? "Hide its weeks" : "Show its weeks", ariaExpanded: String(open) });
    toggle.addEventListener("click", () => {
      if (folded.has(c.id)) folded.delete(c.id);
      else folded.add(c.id);
      renderCourses();
    });
    const courseRow = el(
      "tr",
      { className: "group" },
      el(
        "td",
        {},
        el(
          "div",
          { className: "group-name" },
          toggle,
          el("div", {}, el("b", { textContent: c.name }), el("span", { className: "muted", textContent: ` · ${c.weeks} week${c.weeks === 1 ? "" : "s"}` }), small([c.module, c.level, c.authors.length ? `by ${c.authors.join(", ")}` : ""].filter(Boolean).join(" · "))),
        ),
      ),
      el("td", { className: "num", textContent: `${c.written}/${c.topics}` }),
      el("td", { className: "num", textContent: num(c.cards) }),
      el("td", { className: "num", textContent: num(c.files) }),
      el("td", { className: "num" }, el("b", { textContent: size(c.bytes) })),
      el("td", { className: "num", textContent: num(c.downloads) }),
      el("td", { textContent: date(c.updatedAt) }),
      el("td", { className: "actions" }, courseMenu(c)),
    );
    const weekRows = open
      ? weeks.map((w) =>
          el(
            "tr",
            { className: "child" },
            el("td", {}, el("div", { className: "child-name" }, el("span", { textContent: w.label }), w.merged ? badge("Merged") : null, w.missing ? badge("File missing", "bad") : null, small(`By ${w.authors.join(", ")}${models(w) ? ` · written with ${models(w)}` : ""}`))),
            el("td", { className: "num", textContent: `${w.writtenCount}/${w.topicCount}` }),
            el("td", { className: "num", textContent: num(w.cardCount) }),
            el("td", { className: "num", textContent: num(w.files?.length ?? 0) }),
            el("td", { className: "num", textContent: size(w.bytes) }),
            el("td", { className: "num", textContent: num(w.downloads) }),
            el("td", { textContent: date(w.updatedAt) }),
            el("td", { className: "actions" }, weekMenu(w)),
          ),
        )
      : [];
    return el("tbody", { className: "course-group" }, courseRow, ...weekRows);
  });

  const t = document.getElementById("courses-table");
  t.replaceChildren(el("thead", {}, head), ...(bodies.length ? bodies : [el("tbody", {}, el("tr", {}, el("td", { colSpan: cols.length, className: "empty", textContent: words.length ? "Nothing matches." : "No courses yet." })))]));
  const all = document.getElementById("fold-all");
  all.textContent = data.courses.every((c) => folded.has(c.id)) ? "Show all weeks" : "Hide all weeks";
}

function render() {
  if (!data) return;
  renderStats();
  renderStorage();
  renderPeople();
  renderCourses();
}

async function load() {
  try {
    data = await api("/api/admin/overview");
    render();
  } catch (err) {
    showError(errorBox, err);
  }
}

for (const id of ["people-q", "courses-q"]) document.getElementById(id).addEventListener("input", render);
document.getElementById("fold-all").addEventListener("click", () => {
  const allFolded = data.courses.every((c) => folded.has(c.id));
  for (const c of data.courses) allFolded ? folded.delete(c.id) : folded.add(c.id);
  renderCourses();
});
document.getElementById("refresh").addEventListener("click", () => {
  noticeBox.hidden = true;
  load();
});
// Close an open ⋯ menu when clicking elsewhere.
document.addEventListener("click", (e) => {
  for (const d of document.querySelectorAll("details.menu[open]")) if (!d.contains(e.target)) d.open = false;
});
await load();
