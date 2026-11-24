// Accounts and published weeks from SSH. On the server: sudo studywise-server-admin <command>
//
//   add-user <name> [--owner]   make an account and print its password
//   reset-password <name>       print a new password (and log them out everywhere)
//   delete-user <name>          remove an account, its keys and everything it published
//   list                        accounts, with how many weeks each has published
//   weeks                       every published week
//   delete-week <id>            take a week down

import { rm } from "node:fs/promises";
import path from "node:path";
import { generatePassword, hashPassword, validUsername } from "./lib/auth.js";
import { config } from "./lib/config.js";
import { openDb } from "./lib/db.js";

const db = openDb(config.dbFile);
const [cmd, arg, ...flags] = process.argv.slice(2);
const weekFile = (id) => path.join(config.weeksDir, `${id}.studyweek`);
const dropEmptyCourses = (d) => {
  d.courses = d.courses.filter((c) => d.weeks.some((w) => w.courseId === c.id));
};

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

switch (cmd) {
  case "add-user": {
    const name = validUsername(arg);
    const password = generatePassword();
    const hash = await hashPassword(password);
    await db.update((d) => {
      if (d.users.some((u) => u.name === name)) fail(`${name} already exists`);
      d.users.push({ name, hash, owner: flags.includes("--owner") || undefined, createdAt: new Date().toISOString() });
    });
    console.log(`Made ${name}${flags.includes("--owner") ? " (owner)" : ""}. Password: ${password}`);
    break;
  }
  case "reset-password": {
    const password = generatePassword();
    const hash = await hashPassword(password);
    await db.update((d) => {
      const u = d.users.find((x) => x.name === arg);
      if (!u) fail(`No user called ${arg}`);
      u.hash = hash;
      d.sessions = d.sessions.filter((s) => s.user !== arg);
    });
    console.log(`New password for ${arg}: ${password}`);
    break;
  }
  case "delete-user": {
    const gone = await db.update((d) => {
      if (!d.users.some((u) => u.name === arg)) fail(`No user called ${arg}`);
      const ids = d.weeks.filter((w) => w.owner === arg).map((w) => w.id);
      d.users = d.users.filter((u) => u.name !== arg);
      d.sessions = d.sessions.filter((s) => s.user !== arg);
      d.keys = d.keys.filter((k) => k.user !== arg);
      d.weeks = d.weeks.filter((w) => w.owner !== arg);
      dropEmptyCourses(d);
      return ids;
    });
    for (const id of gone) await rm(weekFile(id), { force: true });
    console.log(`Deleted ${arg} and ${gone.length} published week${gone.length === 1 ? "" : "s"}`);
    break;
  }
  case "list": {
    const d = await db.read();
    for (const u of d.users) {
      const n = d.weeks.filter((w) => w.owner === u.name).length;
      console.log(`${u.name}${u.owner ? " (owner)" : ""}  ${n} week${n === 1 ? "" : "s"}  ${d.keys.filter((k) => k.user === u.name).length} keys  since ${u.createdAt.slice(0, 10)}`);
    }
    break;
  }
  case "weeks": {
    const d = await db.read();
    for (const w of d.weeks) {
      const c = d.courses.find((x) => x.id === w.courseId);
      console.log(`${w.id}  ${w.owner}  ${c?.name} · ${w.label}  ${w.writtenCount}/${w.topicCount} topics  ${w.downloads} downloads`);
    }
    break;
  }
  case "delete-week": {
    await db.update((d) => {
      if (!d.weeks.some((w) => w.id === arg)) fail(`No week ${arg}`);
      d.weeks = d.weeks.filter((w) => w.id !== arg);
      dropEmptyCourses(d);
    });
    await rm(weekFile(arg), { force: true });
    console.log(`Deleted week ${arg}`);
    break;
  }
  default:
    console.log("Commands: add-user <name> [--owner], reset-password <name>, delete-user <name>, list, weeks, delete-week <id>");
}
