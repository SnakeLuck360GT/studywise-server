// Asking for weeks, and people donating their AI usage to make them.
//
// A request is for one week of a course that isn't on the marketplace yet
// (kind "week"), or for the unwritten topics of a week that is (kind
// "write"). Anyone can ask, and anyone else who wants the same week adds
// their vote. For a "week" request, someone uploads the lecture slides and
// transcripts (or a week they've planned in Studywise but not written), so
// that whoever picks it up has the material.
//
// Tasks hand requests out: each person gets at most one a day, the most
// wanted request nobody else is working on. Their app makes the week with
// their own AI and publishes it, which is what finishes the request: a
// request is done when its week is on the marketplace (for "write", fully
// written), however it got there. Everyone who asked gets it on their
// devices the next time they sync with the cloud.
//
// Modules are 12 weeks long, with week 6 a reading week.

import { courseKey, sameCourse, weekNumber } from "./courses.js";

export const WEEKS_PER_MODULE = 12;
export const READING_WEEK = 6;
/** How long a task someone started stays theirs before others can be given it. */
export const STARTED_HOLD_DAYS = 3;
/** Done requests stay listed this long. */
const DONE_SHOWN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "2026-11-27": tasks are handed out per day (UTC). */
export const today = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);

/** Week numbers a module has teaching in: 1 to 12 without the reading week. */
export const TEACHING_WEEKS = Array.from({ length: WEEKS_PER_MODULE }, (_, i) => i + 1).filter((n) => n !== READING_WEEK);

/** Week numbers of a marketplace course an admin marked as having no content (no lectures that week, like reading week). */
export const noContentOf = (c) => (Array.isArray(c?.noContent) ? c.noContent : []);

/** A request for a week its course has no content for: nothing to make. */
export function noContent(data, r) {
  return r.kind === "week" && noContentOf(requestCourse(data, r)).includes(r.number);
}

export function checkWeekNumber(n) {
  if (!Number.isInteger(n) || n < 1 || n > WEEKS_PER_MODULE) return `Modules have weeks 1 to ${WEEKS_PER_MODULE}`;
  if (n === READING_WEEK) return `Week ${READING_WEEK} is reading week, so there's nothing to make`;
  return null;
}

/** The marketplace course a request is for, if it's there yet (it may not be: nobody has published a week of it). */
export function requestCourse(data, r) {
  const byId = r.courseId && data.courses.find((c) => c.id === r.courseId);
  if (byId) return byId;
  const key = courseKey(r.course.name, r.course.module);
  return data.courses.find((c) => sameCourse(courseKey(c.name, c.module), key)) ?? null;
}

/** Where a merged-away week went, following merges of merges. */
function current(data, id) {
  let at = id;
  for (let i = 0; i < 50 && data.mergedInto?.[at]; i++) at = data.mergedInto[at];
  return data.weeks.find((w) => w.id === at) ?? null;
}

/** Topics of a week not written yet, and their sections. */
export function unwrittenOf(topics) {
  const left = (topics ?? []).filter((t) => !t.levels?.length);
  return { topics: left.length, sections: left.reduce((n, t) => n + Math.max(1, t.sections?.length ?? 0), 0) };
}

/**
 * Whether a request is done, and by which week. Worked out each time from
 * what's published, so a week published the usual way finishes a request too,
 * and one taken down opens it again.
 */
export function requestState(data, r) {
  if (r.kind === "write") {
    const w = current(data, r.weekId);
    if (!w) return { status: "gone", week: null };
    return { status: w.writtenCount >= w.topicCount ? "done" : "open", week: w };
  }
  const c = requestCourse(data, r);
  if (!c) return { status: "open", week: null };
  const theirs = data.weeks.filter((w) => w.courseId === c.id && weekNumber(w.label) === r.number);
  // The one made for it, else the most written.
  const made = (r.weekId && current(data, r.weekId)) || theirs.sort((a, b) => b.writtenCount - a.writtenCount || a.createdAt.localeCompare(b.createdAt))[0];
  if (!made || made.courseId !== c.id) return { status: "open", week: null };
  // Made partway (someone ran out of limit): still open, for the rest to be written into that week.
  return { status: made.writtenCount >= made.topicCount ? "done" : "open", week: made };
}

/** Whether someone could make it now: it has material to make it from (slides, a plan, or a week made partway). */
export const hasMaterial = (data, r) => r.kind === "write" || Boolean(r.files?.length || r.plan) || Boolean(requestState(data, r).week);

/** Whose work a week holds. */
const authorsOf = (w) => (w.authors?.length ? w.authors : [w.owner]);

/** People working on it right now (a task assigned today, or started and not given up). */
function holders(data, r, now = Date.now()) {
  return (data.tasks ?? []).filter((t) => t.requestId === r.id && activeTask(t, now)).map((t) => t.user);
}

export function activeTask(t, now = Date.now()) {
  if (t.status === "assigned") return t.day === today(now);
  if (t.status === "started") return now - Date.parse(t.startedAt) < STARTED_HOLD_DAYS * DAY_MS;
  return false;
}

export function requestView(data, r, me, now = Date.now()) {
  const state = requestState(data, r);
  const c = requestCourse(data, r);
  const w = state.week;
  // Made partway: what's left of that week. Otherwise what's left of the plan sent with it.
  const partial = r.kind === "week" && state.status === "open" && Boolean(w);
  const toWrite = r.kind === "write" || partial ? (w ? unwrittenOf(w.topics) : null) : (r.plan?.toWrite ?? null);
  const working = holders(data, r, now);
  return {
    id: r.id,
    kind: r.kind,
    courseId: c?.id ?? null,
    course: c?.name ?? r.course.name,
    module: c?.module || r.course.module || "",
    level: c?.level || r.course.level || "",
    number: r.number,
    label: r.label,
    status: state.status,
    // "write": the week to finish. "week": the week that was made for it (partway, or done).
    weekId: w?.id ?? (r.kind === "write" ? r.weekId : null),
    doneBy: state.status === "done" ? authorsOf(w) : [],
    // Made partway: who has written some of it so far.
    partial,
    partBy: partial ? authorsOf(w) : [],
    // The week's owner asked for the rest of it to be written.
    weekAuthor: r.kind === "write" && w ? w.owner : null,
    votes: r.voters.length,
    voted: r.voters.includes(me.name),
    mine: r.createdBy === me.name,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    files: (r.files ?? []).map((f) => ({ id: f.id, name: f.name, size: f.size, by: f.by, mine: f.by === me.name })),
    plan: r.plan ? { size: r.plan.size, by: r.plan.by, topics: r.plan.topics, at: r.plan.at } : null,
    ready: hasMaterial(data, r),
    toWrite,
    inProgress: working.length > 0,
    yours: working.includes(me.name),
    canRemove: Boolean(me.owner) || (r.createdBy === me.name && r.voters.every((v) => v === me.name)),
  };
}

/** What the list shows: open requests, most wanted first, then ones done in the last month. */
export function listRequests(data, me, { courseId } = {}, now = Date.now()) {
  const views = (data.requests ?? [])
    .map((r) => requestView(data, r, me, now))
    .filter((v) => !courseId || v.courseId === courseId)
    // Weeks an admin marked as having no content aren't wanted.
    .filter((v) => !(v.kind === "week" && noContentOf(data.courses.find((c) => c.id === v.courseId)).includes(v.number)))
    .filter((v) => v.status === "open" || (v.status === "done" && now - Date.parse(doneAt(data, v)) < DONE_SHOWN_DAYS * DAY_MS));
  const rank = (v) => (v.status === "open" ? 0 : 1);
  return views.sort((a, b) => rank(a) - rank(b) || b.votes - a.votes || a.createdAt.localeCompare(b.createdAt));
}

function doneAt(data, v) {
  const w = v.weekId && data.weeks.find((x) => x.id === v.weekId);
  return w?.updatedAt ?? v.createdAt;
}

/** An open request for the same week (or for finishing the same published week), to vote for instead of asking twice. */
export function findRequest(data, kind, { course, number, weekId }) {
  return (data.requests ?? []).find((r) => {
    if (r.kind !== kind) return false;
    if (kind === "write") return current(data, r.weekId)?.id === current(data, weekId)?.id;
    return r.number === number && sameCourse(courseKey(r.course.name, r.course.module), courseKey(course.name, course.module));
  });
}

/**
 * Today's task for someone: the one they have, or a new one, the most wanted
 * request that has material and nobody's working on. Not their own requests
 * (they asked for help), and not ones they skipped before. Null when there's
 * nothing to give (and nothing is recorded, so one can come later in the day).
 */
export function taskFor(data, me, newId, now = Date.now()) {
  data.tasks ??= [];
  const day = today(now);
  // Tasks left from before: given back.
  for (const t of data.tasks) if ((t.status === "assigned" || t.status === "started") && !activeTask(t, now)) t.status = "expired";
  const mine = data.tasks.filter((t) => t.user === me.name);
  const settle = (t) => {
    // Done since (by them or by someone else).
    const r = data.requests.find((x) => x.id === t.requestId);
    if (!r) t.status = "gone";
    else if ((t.status === "assigned" || t.status === "started") && requestState(data, r).status !== "open") {
      const st = requestState(data, r);
      t.status = st.week && (st.week.authors?.length ? st.week.authors : [st.week.owner]).includes(me.name) ? "done" : "beaten";
      t.doneAt ??= new Date(now).toISOString();
    }
    return t;
  };
  const started = mine.find((t) => t.status === "started");
  if (started) return settle(started);
  const todays = mine.filter((t) => t.day === day).sort((a, b) => b.assignedAt.localeCompare(a.assignedAt))[0];
  if (todays) return settle(todays);
  if (me.noTasks) return null;

  const skipped = new Set(mine.filter((t) => t.status === "skipped").map((t) => t.requestId));
  const pick = (data.requests ?? [])
    .filter((r) => r.createdBy !== me.name && !skipped.has(r.id) && hasMaterial(data, r) && !noContent(data, r))
    .filter((r) => requestState(data, r).status === "open" && !holders(data, r, now).length)
    // A week's owner doesn't get their own week to finish.
    .filter((r) => r.kind !== "write" || current(data, r.weekId)?.owner !== me.name)
    .sort((a, b) => b.voters.length - a.voters.length || a.createdAt.localeCompare(b.createdAt))[0];
  if (!pick) return null;
  const t = { id: newId(), user: me.name, requestId: pick.id, day, status: "assigned", assignedAt: new Date(now).toISOString() };
  data.tasks.push(t);
  // Keep the list from growing forever: a few months is plenty.
  data.tasks = data.tasks.filter((x) => now - Date.parse(x.assignedAt) < 120 * DAY_MS);
  return t;
}

/**
 * Make a request now, rather than waiting to be given it: it becomes your
 * task (started), if it has material, isn't done and nobody else is making
 * it. A task you were given today and haven't started goes back for someone
 * else (it isn't a skip); one you've started has to be finished or skipped first.
 */
export function takeRequest(data, me, id, newId, now = Date.now()) {
  data.tasks ??= [];
  const r = data.requests.find((x) => x.id === id);
  if (!r) return { error: [404, "That request isn't there any more"] };
  if (requestState(data, r).status !== "open") return { error: [409, "That week has been made already"] };
  if (noContent(data, r)) return { error: [400, "That week has no content, so there's nothing to make"] };
  if (!hasMaterial(data, r)) return { error: [400, "Nobody has added slides for that week yet"] };
  if (holders(data, r, now).some((u) => u !== me.name)) return { error: [409, "Someone is making that week right now"] };
  const mine = data.tasks.filter((t) => t.user === me.name && activeTask(t, now));
  const same = mine.find((t) => t.requestId === id);
  if (same) {
    same.status = "started";
    same.startedAt ??= new Date(now).toISOString();
    return { task: same };
  }
  const busy = mine.find((t) => t.status === "started");
  if (busy) return { error: [409, "You're making another week already. Finish or skip that one first"] };
  for (const t of mine) if (t.status === "assigned") t.status = "released";
  const at = new Date(now).toISOString();
  const t = { id: newId(), user: me.name, requestId: id, day: today(now), status: "started", assignedAt: at, startedAt: at, taken: true };
  data.tasks.push(t);
  return { task: t };
}

export function taskView(data, t, me, now = Date.now()) {
  const r = data.requests.find((x) => x.id === t.requestId);
  return { id: t.id, status: t.status, day: t.day, startedAt: t.startedAt ?? null, request: r ? requestView(data, r, me, now) : null };
}
