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

/** Log in / Sign up, or Account / Log out, in the header. */
export async function fillNav() {
  const nav = document.querySelector("nav.links");
  const me = await currentUser();
  nav.replaceChildren();
  const link = (href, text) => Object.assign(document.createElement("a"), { href, textContent: text });
  if (me) {
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
  e.append(...children);
  return e;
};

export const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "Never");
export const mb = (bytes) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
