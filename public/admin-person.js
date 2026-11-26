// One person, for admins: who they are, how they study, their cloud copy and
// backups, their API keys, what they've published, reports by and about them,
// and everything they've done (or had done to them) on the site.

import { api, date, el, fillNav, showError } from "/common.js";
import { ago, badge, describe, frag, num, person, size, small, when } from "/admin-common.js";

const me = await fillNav();
if (!me) {
  location.replace("/login");
  throw new Error("Not logged in");
}
if (!me.owner) {
  location.replace("/account");
  throw new Error("Not an admin");
}

const name = new URLSearchParams(location.search).get("name") ?? "";
const errorBox = document.getElementById("error");
const noticeBox = document.getElementById("notice");
const hours = (s) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`);

function notice(node) {
  noticeBox.replaceChildren(node);
  noticeBox.hidden = false;
}
async function act(fn, done) {
  showError(errorBox, null);
  try {
    const r = await fn();
    if (done) notice(typeof done === "function" ? done(r) : el("span", { textContent: done }));
    await load();
  } catch (err) {
    showError(errorBox, err);
  }
}
const button = (label, run, kind = "ghost") => {
  const b = el("button", { className: kind, textContent: label });
  b.addEventListener("click", run);
  return b;
};
const table = (id, head, rows, empty) => {
  const t = document.getElementById(id);
  t.replaceChildren(
    ...(rows.length ? [el("thead", {}, el("tr", {}, ...head.map((h) => el("th", { className: h.num ? "num" : "", textContent: h.label ?? h }))))] : []),
    el("tbody", {}, ...(rows.length ? rows : [el("tr", {}, el("td", { className: "empty", textContent: empty }))])),
  );
};

async function load() {
  let d;
  try {
    d = await api(`/api/admin/users/${encodeURIComponent(name)}`);
  } catch (err) {
    showError(errorBox, err);
    return;
  }
  const u = d.user;
  document.title = `${u.name} · Admin · Studywise courses`;
  const h1 = document.getElementById("name");
  h1.replaceChildren(frag(document.createTextNode(u.name), u.owner ? badge("Admin", "accent") : null, u.suspended ? badge("Suspended", "bad") : null, u.name === me.name ? badge("You") : null, u.onLeaderboard ? null : badge("Off the leaderboard")));
  document.getElementById("facts").textContent = [`Joined ${date(u.createdAt)}`, `last logged in ${ago(u.lastLogin).toLowerCase()}`, `${u.sessions} site login${u.sessions === 1 ? "" : "s"} open`, u.invitedWith ? `invited with ${u.invitedWith}` : null].filter(Boolean).join(" · ");

  const sus = document.getElementById("suspended");
  sus.hidden = !u.suspended;
  if (u.suspended) sus.textContent = `Suspended by ${u.suspended.by} on ${date(u.suspended.at)}${u.suspended.reason ? `: ${u.suspended.reason}` : ""}. They can't log in and their keys don't work until it's lifted.`;

  // What an admin can do to them.
  const self = u.name === me.name;
  document.getElementById("actions").replaceChildren(
    ...[
      !self && button(u.owner ? "Remove admin" : "Make admin", () => confirm(u.owner ? `Take admin away from ${u.name}?` : `Make ${u.name} an admin? They'll be able to see and delete everything here.`) && act(() => api(`/api/admin/users/${u.name}`, { method: "PATCH", body: { owner: !u.owner } }), u.owner ? `${u.name} is no longer an admin.` : `${u.name} is now an admin.`)),
      !self &&
        button(u.suspended ? "Lift suspension" : "Suspend…", () => {
          if (u.suspended) return act(() => api(`/api/admin/users/${u.name}`, { method: "PATCH", body: { suspended: false } }), `${u.name} can use the site again.`);
          const reason = prompt(`Suspend ${u.name}? They're logged out, can't log in, and their API keys stop working until you lift it. Nothing is deleted.\n\nWhy (for the activity log, optional):`, "");
          if (reason !== null) act(() => api(`/api/admin/users/${u.name}`, { method: "PATCH", body: { suspended: true, reason } }), `${u.name} is suspended.`);
        }),
      button("Reset password", () =>
        confirm(`Give ${u.name} a new password? Their old one stops working.`) &&
        act(
          () => api(`/api/admin/users/${u.name}/password`, { method: "POST", body: {} }),
          (r) => frag(el("span", { textContent: `New password for ${u.name} (send it to them; it won't be shown again): ` }), el("code", { textContent: r.password })),
        ),
      ),
      !self && u.sessions > 0 && button("Log out of the site", () => act(() => api(`/api/admin/users/${u.name}/logout`, { method: "POST", body: {} }), `${u.name} is logged out of the site.`)),
      !self &&
        button(
          "Delete account",
          () =>
            confirm(`Delete ${u.name}, their keys, their cloud copy and the ${d.weeks.length} week${d.weeks.length === 1 ? "" : "s"} they published? This can't be undone.`) &&
            api(`/api/admin/users/${u.name}`, { method: "DELETE" })
              .then(() => location.replace("/admin#people"))
              .catch((err) => showError(errorBox, err)),
          "danger",
        ),
    ].filter(Boolean),
  );

  // Studying (from their cloud copy).
  const s = d.study;
  const stat = (n, label) => el("div", { className: "stat" }, el("b", { textContent: n }), el("span", { textContent: label }));
  document.getElementById("study").replaceChildren(
    ...(s
      ? [
          stat(hours(s.secondsWeek), "studied this week"),
          stat(hours(s.seconds), "studied in all"),
          stat(num(s.reviews), "cards reviewed"),
          stat(`${s.streak} day${s.streak === 1 ? "" : "s"}`, "streak"),
          stat(num(s.topicsDone), "topics done"),
          stat(s.answered ? `${Math.round((s.correct / s.answered) * 100)}%` : "–", `of ${num(s.answered)} questions right`),
          stat(num(s.courses), "courses"),
          stat(num(s.cards), "flashcards"),
          stat(num(s.notes), "notes"),
        ]
      : [small("They don't sync through the cloud, so there's nothing to show.")]),
  );

  // Cloud copy, limit and backups.
  const c = d.cloud;
  const cloudBox = document.getElementById("cloud");
  if (!c.on) cloudBox.replaceChildren(small(`Off. They can keep up to ${size(c.quota)} when they turn it on.`), el("div", { className: "row" }, button("Change limit…", () => limit(c))));
  else {
    const used = c.usage.data + c.usage.files;
    const fill = el("span");
    fill.style.width = `${Math.min(100, Math.max(1, (used / c.quota) * 100))}%`;
    cloudBox.replaceChildren(
      el("div", { className: "meter-top" }, el("b", { textContent: `${size(used)} of ${size(c.quota)}` }), el("span", { className: "muted", textContent: `${num(c.rows)} items · ${size(c.usage.files)} of files · backups ${size(c.usage.snapshots)}` })),
      el("div", { className: "meter-bar" }, fill),
      el("h3", { textContent: "Devices" }),
      el("ul", { className: "plain" }, ...c.devices.map((dv) => el("li", {}, el("b", { textContent: dv.name }), el("span", { className: "muted", textContent: ` · ${dv.kind} · synced ${ago(dv.lastSync).toLowerCase()}` })))),
      el("h3", { textContent: "Daily backups" }),
      c.snapshots.length
        ? el(
            "div",
            { className: "backup-list" },
            ...c.snapshots.map((b) =>
              button(`Restore ${date(b.day)}`, () => confirm(`Put ${u.name}'s library back to how it was on ${date(b.day)}? Everything changed since goes back, and every device follows on its next sync.`) && act(() => api(`/api/admin/users/${u.name}/cloud/restore`, { method: "POST", body: { day: b.day } }), (r) => el("span", { textContent: `Restored to ${date(b.day)} (${r.changed} changes).` }))),
            ),
          )
        : small("None yet: the first is made the day after they start syncing."),
      el("div", { className: "row gap-top" }, button("Change limit…", () => limit(c)), button("Delete cloud copy", () => confirm(`Delete ${u.name}'s cloud copy, files and backups? Their devices keep their own copies.`) && act(() => api(`/api/admin/users/${u.name}/cloud`, { method: "DELETE" }), "Cloud copy deleted."), "danger")),
    );
  }

  table(
    "keys",
    ["Name", "Key", "Made", "Last used", ""],
    d.keys.map((k) => el("tr", {}, el("td", { textContent: k.label }), el("td", { className: "mono", textContent: `${k.prefix}…` }), el("td", { textContent: date(k.createdAt) }), el("td", { textContent: ago(k.lastUsed) }), el("td", { className: "actions" }, button("Revoke", () => confirm(`Revoke “${k.label}”? Studywise using it stops working until ${u.name} makes a new key.`) && act(() => api(`/api/admin/users/${u.name}/keys/${k.id}`, { method: "DELETE" }), "Key revoked."), "danger")))),
    "No keys.",
  );

  table(
    "weeks",
    ["Week", { label: "Topics", num: true }, { label: "Size", num: true }, { label: "Downloads", num: true }, "Updated", ""],
    d.weeks.map((w) =>
      el(
        "tr",
        {},
        el("td", {}, el("b", { textContent: w.courseName }), document.createTextNode(` · ${w.label}`), w.merged ? badge("Merged") : null),
        el("td", { className: "num", textContent: `${w.writtenCount}/${w.topicCount}` }),
        el("td", { className: "num", textContent: size(w.size) }),
        el("td", { className: "num", textContent: num(w.downloads) }),
        el("td", { textContent: date(w.updatedAt) }),
        el("td", { className: "actions" }, button("Take down", () => confirm(`Take “${w.courseName} · ${w.label}” off the marketplace?`) && act(() => api(`/api/weeks/${w.id}`, { method: "DELETE" }), "Taken down."), "danger")),
      ),
    ),
    "Nothing published.",
  );

  const rep = (r, about) => el("li", {}, el("span", { className: "when", textContent: when(r.at) }), el("span", {}, about ? frag(person(r.reporter), document.createTextNode(` reported their `), el("b", { textContent: r.week_name })) : frag(document.createTextNode("Reported "), el("b", { textContent: r.week_name }), document.createTextNode(" by "), person(r.author)), document.createTextNode(` (${r.reason}${r.note ? `: “${r.note}”` : ""}) · ${r.status}`)));
  const all = [...d.reports.about.map((r) => rep(r, true)), ...d.reports.by.map((r) => rep(r, false))];
  document.getElementById("reports").replaceChildren(all.length ? el("ol", { className: "activity" }, ...all) : small("None, about them or by them."));

  document.getElementById("activity").replaceChildren(...(d.activity.length ? d.activity.map((a) => el("li", {}, el("span", { className: "when", textContent: when(a.at) }), el("span", {}, describe(a)))) : [el("li", { className: "muted", textContent: "Nothing yet." })]));
}

function limit(c) {
  const v = prompt(`Cloud limit for ${name}, in GB`, String(Math.round((c.quota / 1e9) * 10) / 10));
  if (v === null) return;
  act(() => api(`/api/admin/users/${name}/cloud`, { method: "PATCH", body: { quotaGb: Number(v) } }), `${name} can keep up to ${v} GB in the cloud.`);
}

await load();
