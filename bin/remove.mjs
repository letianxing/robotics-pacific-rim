#!/usr/bin/env node
import { rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadProjects, pathExists, readJson, rootDir } from "./workspace.mjs";

await main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main(argv) {
  const [kind, name] = argv;

  if (!kind || kind === "help" || kind === "--help" || kind === "-h") {
    printHelp();
    return;
  }

  if (kind !== "module") {
    throw new Error(`Unsupported remove target "${kind}". Use "module".`);
  }

  if (!name) {
    throw new Error("Missing module name. Usage: npm run remove -- module <name>");
  }

  await removeModule(name);
}

async function removeModule(name) {
  const moduleDirName = normalizeModuleDirName(name);
  const moduleRoot = join(rootDir, "module", moduleDirName);
  const projectPath = join(moduleRoot, "project.json");

  if (!(await pathExists(projectPath))) {
    throw new Error(`Module project not found: ${relative(rootDir, moduleRoot)}`);
  }

  const project = await readJson(projectPath);
  if (project.root !== `module/${moduleDirName}`) {
    throw new Error(`${relative(rootDir, projectPath)} root does not match module/${moduleDirName}.`);
  }

  await rm(moduleRoot, { recursive: true, force: true });
  const updatedFiles = await removeImplicitDependency(project.name);

  console.log(`Removed ${relative(rootDir, moduleRoot)} (${project.name}).`);
  if (updatedFiles.length > 0) {
    console.log("Updated project dependencies:");
    for (const file of updatedFiles) {
      console.log(`- ${relative(rootDir, file)}`);
    }
  }
  console.log(`Run: rg "${project.name}|${moduleDirName}|${moduleDirName.replaceAll("-", "_")}"`);
  console.log("Then run: npm run check");
}

async function removeImplicitDependency(projectName) {
  const updatedFiles = [];

  for (const project of await loadProjects()) {
    if (!Array.isArray(project.implicitDependencies)) {
      continue;
    }

    const dependencies = project.implicitDependencies.filter((dependency) => dependency !== projectName);
    if (dependencies.length === project.implicitDependencies.length) {
      continue;
    }

    const nextProject = {
      ...project,
      implicitDependencies: dependencies,
    };
    delete nextProject.file;
    delete nextProject.fileRoot;

    await writeFile(project.file, `${JSON.stringify(nextProject, null, 2)}\n`);
    updatedFiles.push(project.file);
  }

  return updatedFiles;
}

function normalizeModuleDirName(value) {
  const normalized = value
    .trim()
    .replace(/^module\//, "")
    .replace(/^module-/, "")
    .replaceAll("_", "-")
    .toLowerCase();

  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
    throw new Error(`Invalid module name "${value}".`);
  }

  return normalized;
}

function printHelp() {
  console.log(`Remove a workspace project.

Usage:
  npm run remove -- module <name>

Examples:
  npm run remove -- module smoke-module
  npm run remove -- module smoke_module
  npm run remove -- module module-smoke-module
`);
}
