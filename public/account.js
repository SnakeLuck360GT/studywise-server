import { api, date, el, fillNav, showError } from "/common.js";

const me = await fillNav();
if (!me) {
  location.replace("/login");
  throw new Error("Not logged in");
}
document.getElementById("hello").textContent = `Hi, ${me.name}`;
document.getElementById("origin").textContent = location.origin;

// API keys

const keyError = document.getElementById("key-error");

async function loadKeys() {
  const { keys } = await api("/api/keys");
  const table = document.getElementById("keys");
  table.hidden = !keys.length;
  table.tBodies[0].replaceChildren(
    ...keys.map((k) => {
      const del = el("button", { className: "danger", textContent: "Delete" });
      del.addEventListener("click", async () => {
        if (!confirm(`Delete “${k.label}”? Studywise using it will stop working until you give it a new key.`)) return;
        await api(`/api/keys/${k.id}`, { method: "DELETE" }).catch((err) => showError(keyError, err));
        loadKeys();
      });
      return el("tr", {}, el("td", { textContent: k.label }), el("td", { className: "mono", textContent: `${k.prefix}…` }), el("td", { textContent: date(k.createdAt) }), el("td", { textContent: date(k.lastUsed) }), el("td", { className: "actions" }, del));
    }),
  );
}

document.getElementById("key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError(keyError, null);
  try {
    const label = document.getElementById("key-label");
    const { key } = await api("/api/keys", { method: "POST", body: { label: label.value } });
    label.value = "";
    document.getElementById("new-key-value").textContent = key;
    document.getElementById("new-key").hidden = false;
    loadKeys();
  } catch (err) {
    showError(keyError, err);
  }
});

document.getElementById("copy").addEventListener("click", async (e) => {
  await navigator.clipboard.writeText(document.getElementById("new-key-value").textContent);
  e.target.textContent = "Copied";
});

// Published weeks

function weekRows(weeks, { withAuthor, onDelete }) {
  return weeks.map((w) => {
    const del = el("button", { className: "danger", textContent: "Delete" });
    del.addEventListener("click", async () => {
      if (!confirm(`Take “${w.courseName} · ${w.label}” off the marketplace? People who already added it keep their copy.`)) return;
      await onDelete(w);
    });
    return el(
      "tr",
      {},
      el("td", {}, el("b", { textContent: w.courseName }), document.createTextNode(` · ${w.label}`)),
      ...(withAuthor ? [el("td", { textContent: w.author })] : []),
      el("td", { textContent: `${w.writtenCount} of ${w.topicCount} written` }),
      el("td", { textContent: String(w.downloads) }),
      ...(withAuthor ? [] : [el("td", { textContent: date(w.updatedAt) })]),
      el("td", { className: "actions" }, del),
    );
  });
}

async function loadWeeks() {
  const error = document.getElementById("weeks-error");
  try {
    const { weeks } = await api("/api/mine");
    document.getElementById("weeks").hidden = !weeks.length;
    document.getElementById("weeks-empty").hidden = !!weeks.length;
    document.querySelector("#weeks tbody").replaceChildren(
      ...weekRows(weeks, {
        withAuthor: false,
        onDelete: async (w) => {
          await api(`/api/weeks/${w.id}`, { method: "DELETE" }).catch((err) => showError(error, err));
          loadWeeks();
        },
      }),
    );
  } catch (err) {
    showError(error, err);
  }
}

function loadAdmin() {
  document.getElementById("admin").hidden = !me.owner;
}

// Password

document.getElementById("password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const error = document.getElementById("password-error");
  showError(error, null);
  document.getElementById("password-done").hidden = true;
  try {
    await api("/api/password", { method: "POST", body: { current: e.target.current.value, next: e.target.next.value } });
    e.target.reset();
    document.getElementById("password-done").hidden = false;
  } catch (err) {
    showError(error, err);
  }
});

loadKeys().catch((err) => showError(keyError, err));
loadWeeks();
loadAdmin();
