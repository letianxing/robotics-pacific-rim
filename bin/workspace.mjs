import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ignoredDirs = new Set([
  ".cache",
  ".git",
  ".idea",
  ".nx",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(path) {
  const content = await readFile(path, "utf8");
  return JSON.parse(content);
}

export async function findProjectFiles(dir = rootDir) {
  const relativeDir = relative(rootDir, dir);

  if (relativeDir === join("bin", "templates") || relativeDir.startsWith(`${join("bin", "templates")}/`)) {
    return [];
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isFile() && entry.name === "project.json") {
      files.push(path);
      continue;
    }

    if (entry.isDirectory() && !ignoredDirs.has(entry.name)) {
      files.push(...(await findProjectFiles(path)));
    }
  }

  return files.sort();
}

export async function loadProjects() {
  const projects = [];

  for (const file of await findProjectFiles()) {
    const project = await readJson(file);
    projects.push({
      ...project,
      file,
      fileRoot: relative(rootDir, dirname(file)),
    });
  }

  return projects.sort((left, right) => left.name.localeCompare(right.name));
}

export function projectCacheDir(projectName, targetName) {
  return join(rootDir, ".cache", "pacific-rim", projectName, targetName);
}

export async function listFiles(dir) {
  const result = [];

  if (!(await pathExists(dir))) {
    return result;
  }

  await collectFiles(dir, result);
  return result.sort();
}

async function collectFiles(dir, result) {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        await collectFiles(path, result);
      }
      continue;
    }

    if (entry.isFile()) {
      result.push(path);
    }
  }
}

export async function hasNonEmptyReadme(root) {
  const readme = join(rootDir, root, "README.md");

  if (!(await pathExists(readme))) {
    return false;
  }

  return (await readFile(readme, "utf8")).trim().length > 0;
}

export async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
