import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function collectFiles(dir) {
  if (!(await exists(dir))) {
    return [];
  }
  const result = [];
  await walk(dir, result);
  return result.sort();
}

async function walk(dir, result) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, result);
    } else if (entry.isFile()) {
      result.push(path);
    }
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
