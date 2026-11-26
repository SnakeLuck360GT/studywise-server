// The admin page: everything on the site, what it takes up on disk, and the
// tools to look after people, courses and weeks. The server checks you're an
// admin for every call; this page only decides what to show.

import { api, date, el, fillNav, showError } from "/common.js";
import { ACTIONS, barChart, describe, person, when } from "/admin-common.js";

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
    stat(num(t.people), "people", `${t.admins} admin${t.admins === 1 ? "" : "s"} · ${t.newPeople} new this week · ${t.activeToday} active today`),
    stat(num(t.openReports), "open reports", t.openReports ? "See Reports" : "Nothing to look at"),
    stat(num(t.courses), "courses"),
    stat(num(t.weeks), "weeks", `${t.newWeeks} new, ${t.updatedWeeks} updated this week`),
    stat(num(t.written), "topics written", `of ${num(t.topics)} planned`),
    stat(num(t.cards), "flashcards"),
    stat(num(t.downloads), "downloads"),
    stat(num(t.keys), "API keys"),
    stat(num(s.cloudPeople ?? 0), "syncing in the cloud", `${size((s.cloud ?? 0) + (s.snapshots ?? 0))} with backups`),
    stat(size(s.weeks + s.db + s.leftovers.bytes + (s.cloud ?? 0) + (s.snapshots ?? 0)), "stored", s.disk ? `${size(s.disk.free)} free on the disk` : ""),
  );
}

function renderStorage() {
  const s = data.storage;
  const ours = s.weeks + s.db + s.leftovers.bytes + (s.cloud ?? 0) + (s.snapshots ?? 0);
  const bar = document.getElementById("disk-bar");
  const legend = document.getElementById("disk-legend");
  const parts = [];
  if (s.disk) {
    const other = Math.max(0, s.disk.total - s.disk.free - ours);
    parts.push(["weeks", "Published weeks", s.weeks], ["cloud", "Cloud sync", s.cloud ?? 0], ["snap", "Daily backups", s.snapshots ?? 0], ["db", "Accounts & index", s.db], ["left", "Leftover files", s.leftovers.bytes], ["other", "Everything else on the disk", other], ["free", "Free", s.disk.free]);
    document.getElementById("disk-line").textContent = `Studywise uses ${size(ours)} of a ${size(s.disk.total)} disk (${((ours / s.disk.total) * 100).toFixed(ours / s.disk.total < 0.01 ? 2 : 1)}%). ${size(s.disk.free)} is free.`;
  } else {
    parts.push(["weeks", "Published weeks", s.weeks], ["cloud", "Cloud sync", s.cloud ?? 0], ["snap", "Daily backups", s.snapshots ?? 0], ["db", "Accounts & index", s.db], ["left", "Leftover files", s.leftovers.bytes]);
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

  // Everything a person takes up: their published weeks, and their cloud copy with its backups.
  const takes = (u) => u.bytes + (u.cloud?.usage.total ?? 0);
  const people = [...data.users].filter((u) => takes(u)).sort((a, b) => takes(b) - takes(a)).slice(0, 8);
  document.getElementById("by-person").replaceChildren(
    ...(people.length
      ? people.map((u) => meter(u.name, [u.weeks ? `${u.weeks} week${u.weeks === 1 ? "" : "s"}` : "", u.cloud?.on ? `cloud ${size(u.cloud.usage.total)}` : ""].filter(Boolean).join(" · "), takes(u), takes(people[0])))
      : [small("Nobody has published or synced anything yet.")]),
  );
  const weeks = [...data.weeks].sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  document.getElementById("by-week").replaceChildren(...(weeks.length ? weeks.map((w) => meter(`${w.courseName} · ${w.label}`, w.authors.join(", "), w.bytes, weeks[0].bytes)) : [small("No weeks yet.")]));
}

function renderPeople() {
  table("people-table", data.users, [
    { key: "name", label: "Name", render: (u) => frag(el("b", {}, person(u.name)), u.owner ? badge("Admin", "accent") : null, u.suspended ? badge("Suspended", "bad") : null, u.name === me.name ? badge("You") : null, small(`Joined ${date(u.createdAt)}`)) },
    { key: "weeks", label: "Weeks", num: true },
    { key: "bytes", label: "Storage", num: true, render: (u) => size(u.bytes) },
    { key: "downloads", label: "Downloads", num: true, render: (u) => num(u.downloads) },
    {
      key: "cloud",
      label: "Cloud",
      num: true,
      sort: (u) => (u.cloud?.on ? u.cloud.usage.data + u.cloud.usage.files : -1),
      render: (u) => {
        if (!u.cloud?.on) return el("span", { className: "muted", textContent: "Off" });
        const used = u.cloud.usage.data + u.cloud.usage.files;
        const fill = el("span");
        fill.style.width = `${Math.min(100, Math.max(2, (used / u.cloud.quota) * 100))}%`;
        return frag(el("div", { textContent: `${size(used)} of ${size(u.cloud.quota)}` }), el("div", { className: "meter-bar mini" }, fill), small(`${u.cloud.devices} device${u.cloud.devices === 1 ? "" : "s"} · ${ago(u.cloud.lastChange)}`));
      },
    },
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
          { label: "Cloud limit…", run: () => cloudLimit(u) },
          u.cloud?.on && { label: "Restore a backup…", run: () => void backups(u) },
          u.cloud?.on && { label: "Delete cloud copy", danger: true, run: () => confirm(`Delete ${u.name}'s cloud copy, files and daily backups? Their devices keep their own copies but stop syncing through the cloud.`) && act(() => api(`/api/admin/users/${u.name}/cloud`, { method: "DELETE" }), `Deleted ${u.name}'s cloud copy.`) },
          u.name !== me.name && u.sessions > 0 && { label: "Log out of the site", run: () => act(() => api(`/api/admin/users/${u.name}/logout`, { method: "POST", body: {} }), `${u.name} is logged out of the site everywhere.`) },
          u.name !== me.name && { label: u.suspended ? "Lift suspension" : "Suspend…", run: () => void suspend(u) },
          u.name !== me.name && { label: "Delete account", danger: true, run: () => confirm(`Delete ${u.name}, their ${u.keys} API key${u.keys === 1 ? "" : "s"} and the ${u.weeks} week${u.weeks === 1 ? "" : "s"} they published? This can't be undone.`) && act(() => api(`/api/admin/users/${u.name}`, { method: "DELETE" }), `Deleted ${u.name}.`) },
        ]),
    },
  ], { query: document.getElementById("people-q").value, text: (u) => u.name, initial: { key: "bytes", dir: -1 } });
}


// Cloud: a person's limit, and their daily backups.

function cloudLimit(u) {
  const now = (u.cloud?.quota ?? 5e9) / 1e9;
  const v = prompt(`Cloud limit for ${u.name}, in GB`, String(Math.round(now * 10) / 10));
  if (v === null) return;
  const gb = Number(v);
  if (!Number.isFinite(gb) || gb < 0) return showError(errorBox, new Error("Give the limit as a number of GB"));
  act(() => api(`/api/admin/users/${u.name}/cloud`, { method: "PATCH", body: { quotaGb: gb } }), `${u.name} can keep up to ${gb} GB in the cloud.`);
}

async function backups(u) {
  showError(errorBox, null);
  try {
    const st = await api(`/api/admin/users/${u.name}/cloud`);
    if (!st.snapshots.length) return notice(el("span", { textContent: `${u.name} has no daily backups yet. The first is made the day after they start syncing.` }));
    const list = el(
      "div",
      { className: "backup-list" },
      ...st.snapshots.map((b) => {
        const btn = el("button", { className: "ghost", textContent: `Restore ${date(b.day)}` });
        btn.addEventListener("click", () => {
          if (!confirm(`Put ${u.name}'s library back to how it was on ${date(b.day)}? Everything changed since goes back, and every device follows on its next sync.`)) return;
          act(() => api(`/api/admin/users/${u.name}/cloud/restore`, { method: "POST", body: { day: b.day } }), (r) => el("span", { textContent: `Restored ${u.name}'s library to ${date(b.day)} (${r.changed} change${r.changed === 1 ? "" : "s"}). Their devices follow on their next sync.` }));
        });
        return btn;
      }),
    );
    notice(frag(el("div", { textContent: `${u.name}'s daily backups (${st.snapshots.length}, kept 14 days):` }), list));
  } catch (err) {
    showError(errorBox, err);
  }
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
  const rc = document.getElementById("reports-count");
  rc.hidden = !data.totals.openReports;
  rc.textContent = String(data.totals.openReports);
  renderStats();
  renderStorage();
  renderPeople();
  renderCourses();
}

async function load() {
  try {
    data = await api("/api/admin/overview");
    render();
    void loadTrends();
    void loadReports();
    void loadActivity();
    void loadSettings();
  } catch (err) {
    showError(errorBox, err);
  }
}

/** Suspend someone (with a reason they'll be told nothing about), or lift it. */
function suspend(u) {
  if (u.suspended) return act(() => api(`/api/admin/users/${u.name}`, { method: "PATCH", body: { suspended: false } }), `${u.name} can use the site again.`);
  const reason = prompt(`Suspend ${u.name}? They're logged out, can't log in, and their API keys stop working until you lift it. Nothing is deleted.\n\nWhy (for the activity log, optional):`, "");
  if (reason === null) return;
  act(() => api(`/api/admin/users/${u.name}`, { method: "PATCH", body: { suspended: true, reason } }), `${u.name} is suspended.`);
}

/** A segmented control: calls back with the chosen button's data value. */
function seg(id, attr, onPick) {
  for (const btn of document.querySelectorAll(`#${id} button`)) {
    btn.addEventListener("click", () => {
      for (const x of document.querySelectorAll(`#${id} button`)) x.classList.toggle("on", x === btn);
      onPick(btn.dataset[attr]);
    });
  }
}
const setSeg = (id, attr, value) => {
  for (const x of document.querySelectorAll(`#${id} button`)) x.classList.toggle("on", x.dataset[attr] === value);
};

// Trends

let trendDays = 30;
async function loadTrends() {
  const { days } = await api(`/api/admin/trends?days=${trendDays}`);
  const sum = (k) => days.reduce((n, d) => n + d[k], 0);
  const lastStorage = [...days].reverse().find((d) => d.storage != null)?.storage;
  document.getElementById("charts").replaceChildren(
    barChart({ title: "People active", values: days.map((d) => ({ day: d.day, value: d.active })), headline: `${num(days.at(-1).active)} today` }),
    barChart({ title: "Sign-ups", values: days.map((d) => ({ day: d.day, value: d.signups })), headline: num(sum("signups")) }),
    barChart({ title: "Weeks published", values: days.map((d) => ({ day: d.day, value: d.published })), headline: num(sum("published")) }),
    barChart({ title: "Weeks added by others", values: days.map((d) => ({ day: d.day, value: d.downloads })), headline: num(sum("downloads")) }),
    barChart({ title: "Storage used", values: days.map((d) => ({ day: d.day, value: d.storage })), format: size, headline: lastStorage == null ? "–" : size(lastStorage) }),
  );
  document.getElementById("trend-table").replaceChildren(
    el("thead", {}, el("tr", {}, ...["Day", "Active", "Sign-ups", "Published", "Added", "Storage"].map((h, i) => el("th", { className: i ? "num" : "", textContent: h })))),
    el("tbody", {}, ...[...days].reverse().map((d) => el("tr", {}, el("td", { textContent: date(d.day) }), ...[d.active, d.signups, d.published, d.downloads].map((v) => el("td", { className: "num", textContent: num(v) })), el("td", { className: "num", textContent: d.storage == null ? "–" : size(d.storage) })))),
  );
}
seg("trend-days", "days", (d) => {
  trendDays = Number(d);
  void loadTrends();
});

// Reports

let reportStatus = "open";
async function loadReports() {
  const { reports, reasons } = await api(`/api/admin/reports?status=${reportStatus}`);
  const list = document.getElementById("report-list");
  if (!reports.length) return list.replaceChildren(small(reportStatus === "open" ? "No open reports." : "None."));
  list.replaceChildren(
    ...reports.map((r) => {
      const actions = el("div", { className: "row" });
      if (r.status === "open") {
        const down = el("button", { className: "danger", textContent: "Take the week down" });
        down.addEventListener("click", () => confirm(`Take “${r.week_name}” by ${r.author} off the marketplace? People who added it keep their copy.`) && act(() => api(`/api/admin/reports/${r.id}`, { method: "POST", body: { action: "remove" } }), `Took down ${r.week_name}.`));
        const keep = el("button", { className: "ghost", textContent: "Dismiss" });
        keep.addEventListener("click", () => act(() => api(`/api/admin/reports/${r.id}`, { method: "POST", body: { action: "dismiss" } }), "Report dismissed; the week stays."));
        actions.append(down, keep);
      } else {
        actions.append(small(`${r.status === "removed" ? "Taken down" : "Dismissed"} by ${r.resolved_by} ${ago(r.resolved_at)}`));
      }
      return el(
        "div",
        { className: "report" },
        el("div", { className: "report-head" }, el("b", { textContent: r.week_name }), el("span", { className: "muted" }, document.createTextNode(" by "), person(r.author)), badge(reasons[r.reason] ?? r.reason, r.status === "open" ? "bad" : "")),
        r.note ? el("p", { className: "report-note", textContent: `“${r.note}”` }) : null,
        el("div", { className: "muted small" }, document.createTextNode("Reported by "), person(r.reporter), document.createTextNode(` · ${ago(r.at)}`)),
        actions,
      );
    }),
  );
}
seg("report-status", "status", (st) => {
  reportStatus = st;
  void loadReports();
});

// Activity

const whatBox = document.getElementById("activity-what");
whatBox.replaceChildren(...ACTIONS.map(([v, label]) => el("option", { value: v, textContent: label })));
let oldest = null;
async function loadActivity(more = false) {
  const q = new URLSearchParams({ what: whatBox.value, who: document.getElementById("activity-who").value.trim().toLowerCase() });
  if (more && oldest) q.set("before", String(oldest));
  const { activity } = await api(`/api/admin/activity?${q}`);
  const items = activity.map((a) => el("li", {}, el("span", { className: "when", textContent: when(a.at) }), el("span", {}, describe(a))));
  const list = document.getElementById("activity-list");
  if (more) list.append(...items);
  else list.replaceChildren(...(items.length ? items : [el("li", { className: "muted", textContent: "Nothing yet." })]));
  oldest = activity.at(-1)?.id ?? oldest;
  document.getElementById("activity-more").hidden = activity.length < 100;
}
whatBox.addEventListener("change", () => void loadActivity());
let whoTimer;
document.getElementById("activity-who").addEventListener("input", () => {
  clearTimeout(whoTimer);
  whoTimer = setTimeout(() => void loadActivity(), 300);
});
document.getElementById("activity-more").addEventListener("click", () => void loadActivity(true));

// Settings: sign-ups, invites, announcement

const HINTS = { open: "Anyone can make an account on the sign-up page.", invite: "People need an invite code (or link) from you to make an account.", closed: "Nobody can make a new account. People who have one carry on as usual." };
async function loadSettings() {
  const st = await api("/api/admin/settings");
  setSeg("signup-mode", "mode", st.signups);
  document.getElementById("signup-hint").textContent = HINTS[st.signups];
  document.getElementById("invites-box").hidden = st.signups !== "invite" && !st.invites.length;
  document.getElementById("invite-table").replaceChildren(
    ...(st.invites.length ? [el("thead", {}, el("tr", {}, ...["Code", "For", "Made", "Used by", ""].map((h) => el("th", { textContent: h }))))] : []),
    el(
      "tbody",
      {},
      ...st.invites.map((i) => {
        const link = `${location.origin}/signup?invite=${i.code}`;
        const copy = el("button", { className: "ghost", textContent: "Copy link" });
        copy.addEventListener("click", async () => {
          await navigator.clipboard.writeText(link);
          copy.textContent = "Copied";
        });
        const del = el("button", { className: "ghost", textContent: "Delete" });
        del.addEventListener("click", () => act(() => api(`/api/admin/invites/${i.code}`, { method: "DELETE" })));
        const expired = i.expires && i.expires < new Date().toISOString();
        return el(
          "tr",
          {},
          el("td", { className: "mono", textContent: i.code }),
          el("td", { textContent: i.note || "–" }),
          el("td", { textContent: `${date(i.createdAt)}${i.expires ? ` · ${expired ? "expired" : `until ${date(i.expires)}`}` : ""}` }),
          el("td", {}, i.usedBy ? person(i.usedBy) : el("span", { className: "muted", textContent: expired ? "Expired" : "Not yet" })),
          el("td", { className: "actions" }, i.usedBy || expired ? "" : copy, del),
        );
      }),
    ),
  );
  const now = document.getElementById("announce-now");
  now.hidden = !st.announcement;
  if (st.announcement) {
    const clear = el("button", { className: "ghost", textContent: "Clear it" });
    clear.addEventListener("click", () => act(() => api("/api/admin/announcement", { method: "DELETE" }), "Announcement cleared."));
    now.replaceChildren(el("div", {}, el("b", { textContent: "Showing now: " }), document.createTextNode(st.announcement.text)), small(st.announcement.until ? `Until ${date(st.announcement.until)}` : "Until you clear it"), clear);
  }
}
seg("signup-mode", "mode", (mode) => void act(() => api("/api/admin/settings", { method: "PATCH", body: { signups: mode } })));
document.getElementById("invite-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const note = document.getElementById("invite-note");
  act(
    () => api("/api/admin/invites", { method: "POST", body: { note: note.value, days: Number(document.getElementById("invite-days").value) } }),
    (r) => {
      note.value = "";
      const link = `${location.origin}/signup?invite=${r.invite.code}`;
      return frag(el("span", { textContent: "New invite link (it works once): " }), el("div", { className: "newkey" }, el("code", { textContent: link })));
    },
  );
});
document.getElementById("announce-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = document.getElementById("announce-text");
  act(
    () => api("/api/admin/announcement", { method: "PUT", body: { text: text.value, level: document.getElementById("announce-level").value, link: document.getElementById("announce-link").value, days: Number(document.getElementById("announce-days").value) } }),
    () => {
      text.value = "";
      return el("span", { textContent: "Posted. It shows on the site now, and in Studywise within the hour." });
    },
  );
});

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
