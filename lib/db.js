// A small JSON file is plenty here: accounts, keys, and a summary of each
// published week (its topics, models and fingerprint). The weeks themselves
// are files on disk.

import { readFile, rename, writeFile } from "node:fs/promises";

const EMPTY = { users: [], sessions: [], keys: [], courses: [], weeks: [], signups: [], requests: [], tasks: [] };

export function openDb(file) {
  let queue = Promise.resolve();

  async function read() {
    try {
      return { ...structuredClone(EMPTY), ...JSON.parse(await readFile(file, "utf8")) };
    } catch (err) {
      if (err.code === "ENOENT") return structuredClone(EMPTY);
      throw err;
    }
  }

  async function save(data) {
    const temp = `${file}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(temp, file);
  }

  // Changes run one at a time and re-read the file first, so edits made by
  // manage.js while the server is running aren't lost.
  function update(change) {
    const run = queue.then(async () => {
      const data = await read();
      const result = await change(data);
      await save(data);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  return { read, update };
}
