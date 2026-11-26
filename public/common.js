// Shared by every page: calling the API, showing errors, and the top links.

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Something went wrong (${res.status})`), { status: res.status });
  return data;
}

export async function currentUser() {
  try {
    return (await api("/api/me")).user;
  } catch {
    return null;
  }
}

export function showError(el, err) {
  el.textContent = err ? err.message ?? String(err) : "";
  el.hidden = !err;
}

/** The admin's message for everyone, under the header on every page (hidden once you close it). */
async function showAnnouncement() {
  const { announcement: a } = await api("/api/announcement").catch(() => ({}));
  if (!a || localStorage.getItem("sw.closed") === a.id) return;
  const bar = el("div", { className: `announce ${a.level}` }, el("span", { textContent: a.text }), a.link ? el("a", { href: a.link, textContent: "More", target: "_blank", rel: "noopener" }) : "");
  const x = el("button", { className: "ghost", textContent: "×", title: "Hide", ariaLabel: "Hide this message" });
  x.addEventListener("click", () => {
    localStorage.setItem("sw.closed", a.id);
    bar.remove();
  });
  bar.append(x);
  document.querySelector("header.top")?.after(bar);
}

/** Log in / Sign up, or Account / Log out, in the header. */
export async function fillNav() {
  void showAnnouncement();
  const nav = document.querySelector("nav.links");
  const me = await currentUser();
  nav.replaceChildren();
  const link = (href, text) => Object.assign(document.createElement("a"), { href, textContent: text });
  if (me) {
    nav.append(link("/leaderboard", "Leaderboard"));
    if (me.owner) nav.append(link("/admin", "Admin"));
    nav.append(link("/account", me.name));
    const out = link("#", "Log out");
    out.addEventListener("click", async (e) => {
      e.preventDefault();
      await api("/api/logout", { method: "POST", body: {} }).catch(() => {});
      location.href = "/";
    });
    nav.append(out);
  } else {
    nav.append(link("/login", "Log in"), link("/signup", "Sign up"));
  }
  return me;
}

export const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  // Leave out children that aren't there (a badge that doesn't apply, say).
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return e;
};

export const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "Never");
export const mb = (bytes) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
