#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadProjects, pathExists, readJson, rootDir } from "./workspace.mjs";

const execFileAsync = promisify(execFile);

const allowedProjectRoots = [
  "arch",
  "bin",
  "dashboard",
  "deploy",
  "doc",
  "example",
  "module",
  "monitor",
  "infra",
  "pkg",
];

const allowedProjectTypes = new Set([
  "application",
  "deployment",
  "documentation",
  "library",
  "tool",
]);

const allowedScopes = new Set([
  "scope:app",
  "scope:deploy",
  "scope:doc",
  "scope:module",
  "scope:infra",
  "scope:pkg",
  "scope:tools",
]);

await main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const failures = [];

  failures.push(...(await checkRootFiles()));

  const projects = await loadProjects();
  failures.push(...checkProjects(projects));
  failures.push(...checkDependencies(projects));

  if (projects.length === 0) {
    failures.push("No project.json files found.");
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    process.exitCode = 1;
    return;
  }

  await runProjectChecks(projects);
  printGraph(projects);
  console.log("Monorepo check passed.");
}

async function checkRootFiles() {
  const failures = [];

  for (const path of ["package.json", "nx.json", ".gitignore"]) {
    if (!(await pathExists(join(rootDir, path)))) {
      failures.push(`Missing required root file: ${path}`);
    }
  }

  if (await pathExists(join(rootDir, "package.json"))) {
    const packageJson = await readJson(join(rootDir, "package.json"));
    if (packageJson.private !== true) {
      failures.push("package.json must set private=true for this workspace.");
    }
  }

  if (await pathExists(join(rootDir, ".gitignore"))) {
    const gitignore = await readFile(join(rootDir, ".gitignore"), "utf8");
    for (const ignoredPath of [".cache/", ".nx/cache/", ".nx/workspace-data/"]) {
      if (!gitignore.includes(ignoredPath)) {
        failures.push(`.gitignore must include ${ignoredPath}`);
      }
    }
  }

  return failures;
}

function checkProjects(projects) {
  const failures = [];
  const seenNames = new Set();
  const seenRoots = new Set();

  for (const project of projects) {
    if (!project.name) {
      failures.push(`Missing project name in ${project.fileRoot}/project.json`);
      continue;
    }

    if (seenNames.has(project.name)) {
      failures.push(`Duplicate project name: ${project.name}`);
    }
    seenNames.add(project.name);

    if (!project.root) {
      failures.push(`Missing root for project ${project.name}`);
      continue;
    }

    if (seenRoots.has(project.root)) {
      failures.push(`Duplicate project root: ${project.root}`);
    }
    seenRoots.add(project.root);

    if (project.root !== project.fileRoot) {
      failures.push(`${project.name} project.json root must match its directory.`);
    }

    if (!allowedProjectRoots.some((root) => project.root === root || project.root.startsWith(`${root}/`))) {
      failures.push(`${project.name} root is outside allowed monorepo roots: ${project.root}`);
    }

    if (!allowedProjectTypes.has(project.projectType)) {
      failures.push(`${project.name} has unsupported projectType: ${project.projectType}`);
    }

    if (!Array.isArray(project.tags) || project.tags.length === 0) {
      failures.push(`${project.name} must declare tags.`);
      continue;
    }

    if (!project.tags.some((tag) => allowedScopes.has(tag))) {
      failures.push(`${project.name} must declare one scope:* tag.`);
    }

    if (!project.targets?.check) {
      failures.push(`${project.name} must define a check target.`);
    }
  }

  return failures;
}

function checkDependencies(projects) {
  const failures = [];
  const byName = new Map(projects.map((project) => [project.name, project]));

  for (const project of projects) {
    for (const dependencyName of project.implicitDependencies ?? []) {
      const dependency = byName.get(dependencyName);

      if (!dependency) {
        failures.push(`${project.name} depends on unknown project ${dependencyName}.`);
        continue;
      }

      failures.push(...checkBoundary(project, dependency));
    }
  }

  return failures;
}

function checkBoundary(project, dependency) {
  const failures = [];

  if (hasTag(project, "scope:infra") && !hasTag(dependency, "scope:infra")) {
    if (!hasTag(dependency, "scope:pkg")) {
      failures.push(`${project.name} is shared infra code and may only depend on scope:infra or scope:pkg projects.`);
    }
  }

  if (hasTag(project, "scope:pkg") && !hasTag(dependency, "scope:pkg")) {
    failures.push(`${project.name} is pure shared package code and may only depend on scope:pkg projects.`);
  }

  if (hasTag(project, "scope:module") && hasTag(dependency, "scope:module")) {
    failures.push(`${project.name} must not depend directly on another scope:module project.`);
  }

  if (hasTag(project, "scope:tools") && !hasTag(dependency, "scope:tools")) {
    failures.push(`${project.name} tooling must stay independent of runtime projects.`);
  }

  return failures;
}

function hasTag(project, tag) {
  return project.tags?.includes(tag) ?? false;
}

async function runProjectChecks(projects) {
  for (const project of projects) {
    await execFileAsync("node", ["bin/check-project.mjs", project.name], {
      cwd: rootDir,
      encoding: "utf8",
    });
  }
}

function printGraph(projects) {
  console.log("Project graph:");

  for (const project of projects) {
    const dependencies = project.implicitDependencies ?? [];
    const edgeList = dependencies.length > 0 ? dependencies.join(", ") : "none";
    console.log(`- ${project.name} -> ${edgeList}`);
  }
}
