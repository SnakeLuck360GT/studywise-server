import { api, fillNav, showError } from "/common.js";

fillNav();
const form = document.getElementById("form");
// Invite-only: ask for the code (filled in from an invite link); closed: say so.
const invite = new URLSearchParams(location.search).get("invite");
api("/api/signup-mode")
  .then(({ mode }) => {
    document.getElementById("invite-box").hidden = mode !== "invite";
    form.invite.required = mode === "invite";
    if (invite) form.invite.value = invite;
    document.getElementById("closed").hidden = mode !== "closed";
    form.querySelector("button").disabled = mode === "closed";
  })
  .catch(() => {});
const error = document.getElementById("error");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  showError(error, null);
  try {
    await api("/api/signup", { method: "POST", body: { name: form.name.value, password: form.password.value, invite: form.invite.value } });
    location.href = "/account";
  } catch (err) {
    showError(error, err);
    button.disabled = false;
  }
});
