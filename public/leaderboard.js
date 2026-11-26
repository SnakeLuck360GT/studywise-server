// The leaderboard: everyone's studying (from their cloud-synced library) and
// sharing (their weeks on the marketplace), ranked by whichever column you pick.

import { api, el, fillNav, showError } from "/common.js";

const me = await fillNav();
if (!me) {
  location.replace("/login");
  throw new Error("Not logged in");
}

let people = [];
let period = "week";
let sortKey = "time";

const hours = (s) => (s >= 3600 ? `${(s / 3600).toFixed(s >= 36000 ? 0 : 1)} h` : `${Math.round(s / 60)} min`);
const num = (n) => Number(n ?? 0).toLocaleString();

// Each column: its heading, how it ranks, and how it shows. Study columns are blank for people who don't sync.
const columns = () => [
  { key: "time", label: period === "week" ? "Studied this week" : "Studied", value: (p) => (p.study ? (period === "week" ? p.study.secondsWeek : p.study.seconds) : -1), show: (p) => hours(period === "week" ? p.study.secondsWeek : p.study.seconds), study: true },
  { key: "reviews", label: period === "week" ? "Reviews this week" : "Cards reviewed", value: (p) => (p.study ? (period === "week" ? p.study.reviewsWeek : p.study.reviews) : -1), show: (p) => num(period === "week" ? p.study.reviewsWeek : p.study.reviews), study: true },
  { key: "streak", label: "Streak", value: (p) => p.study?.streak ?? -1, show: (p) => (p.study.streak ? `${p.study.streak} day${p.study.streak === 1 ? "" : "s"}` : "–"), study: true },
  { key: "topics", label: "Topics done", value: (p) => p.study?.topicsDone ?? -1, show: (p) => num(p.study.topicsDone), study: true },
  {
    key: "questions",
    label: "Questions",
    value: (p) => p.study?.answered ?? -1,
    show: (p) => (p.study.answered ? `${num(p.study.answered)} · ${Math.round((p.study.correct / p.study.answered) * 100)}%` : "0"),
    study: true,
    title: "Answered while learning topics, and how many were right",
  },
  { key: "cards", label: "Flashcards", value: (p) => p.study?.cards ?? -1, show: (p) => num(p.study.cards), study: true },
  { key: "weeks", label: "Weeks shared", value: (p) => p.weeks, show: (p) => num(p.weeks) },
  { key: "downloads", label: "Downloads", value: (p) => p.downloads, show: (p) => num(p.downloads), title: "Times other people added their weeks" },
];

function ranked() {
  const col = columns().find((c) => c.key === sortKey) ?? columns()[0];
  return [...people].sort((a, b) => col.value(b) - col.value(a) || a.name.localeCompare(b.name));
}

function podium(list) {
  const col = columns().find((c) => c.key === sortKey);
  const top = list.filter((p) => col.value(p) > 0).slice(0, 3);
  const medal = ["gold", "silver", "bronze"];
  document.getElementById("podium").replaceChildren(
    ...top.map((p, i) => el("div", { className: `place ${medal[i]}${p.me ? " you" : ""}` }, el("div", { className: "medal", textContent: String(i + 1) }), el("div", { className: "who", textContent: p.name }), el("div", { className: "what", textContent: `${col.show(p)}` }), el("div", { className: "muted small", textContent: col.label }))),
  );
}

function render() {
  const cols = columns();
  const list = ranked();
  podium(list);
  const head = el(
    "tr",
    {},
    el("th", { className: "num", textContent: "#" }),
    el("th", { textContent: "Person" }),
    ...cols.map((c) => {
      const b = el("button", { className: "th", textContent: c.label + (c.key === sortKey ? " ↓" : ""), title: c.title ?? "" });
      b.addEventListener("click", () => {
        sortKey = c.key;
        render();
      });
      return el("th", { className: `num${c.key === sortKey ? " sorted" : ""}` }, b);
    }),
  );
  const col = cols.find((c) => c.key === sortKey);
  const rows = list.map((p, i) =>
    el(
      "tr",
      { className: p.me ? "you" : "" },
      el("td", { className: "num rank", textContent: col.value(p) > 0 ? String(i + 1) : "–" }),
      el("td", {}, el("b", { textContent: p.name }), p.me ? el("span", { className: "badge accent", textContent: p.hidden ? "You (hidden)" : "You" }) : null, p.study ? null : el("div", { className: "muted small", textContent: "Doesn't sync through the cloud" })),
      ...cols.map((c) => el("td", { className: `num${c.key === sortKey ? " sorted" : ""}`, textContent: c.study && !p.study ? "–" : c.show(p) })),
    ),
  );
  document.getElementById("board").replaceChildren(el("thead", {}, head), el("tbody", {}, ...rows));
}

for (const b of document.querySelectorAll("#period button")) {
  b.addEventListener("click", () => {
    period = b.dataset.period;
    for (const x of document.querySelectorAll("#period button")) x.classList.toggle("on", x === b);
    render();
  });
}

try {
  people = (await api("/api/leaderboard")).people;
  render();
} catch (err) {
  showError(document.getElementById("error"), err);
}
