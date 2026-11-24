import { api, fillNav } from "/common.js";

fillNav();
document.getElementById("origin").textContent = location.origin;
api("/api/stats")
  .then((s) => {
    for (const k of ["courses", "weeks", "people"]) document.getElementById(`stat-${k}`).textContent = s[k];
    document.getElementById("stats").hidden = false;
  })
  .catch(() => {});
