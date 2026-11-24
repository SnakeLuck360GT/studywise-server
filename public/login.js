import { api, fillNav, showError } from "/common.js";

fillNav();
const form = document.getElementById("form");
const error = document.getElementById("error");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  showError(error, null);
  try {
    await api("/api/login", { method: "POST", body: { name: form.name.value, password: form.password.value } });
    location.href = "/account";
  } catch (err) {
    showError(error, err);
    button.disabled = false;
  }
});
