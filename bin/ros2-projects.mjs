#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadProjects, pathExists, rootDir } from "./workspace.mjs";

const args = process.argv.slice(2);
const includeDisabled = args.includes("--include-disabled");
const formatArg = args.find((arg) => arg.startsWith("--format="));
const format = formatArg ? formatArg.slice("--format=".length) : "tsv";

if (!["tsv", "json"].includes(format)) {
  console.error(`Unsupported format: ${format}`);
  process.exit(2);
}

const projects = await loadRos2ServiceProjects();

if (format === "json") {
  console.log(`${JSON.stringify(projects, null, 2)}\n`);
} else {
  for (const project of projects) {
    console.log([
      project.root,
      project.package,
      project.distro,
      envAssignments(project.env),
    ].join("\t"));
  }
}

async function loadRos2ServiceProjects() {
  const result = [];

  for (const project of await loadProjects()) {
    if (!project.root?.startsWith("module/service/")) {
      continue;
    }
    if (!project.tags?.includes("framework:ros2")) {
      continue;
    }
    if (!includeDisabled && project.ros2?.includeInAll === false) {
      continue;
    }

    const root = join(rootDir, project.root);
    const packageName = project.ros2?.package ?? await readPackageXmlName(root);
    const distro = project.ros2?.distro ?? ros2DistroFromTags(project);
    const env = {
      ROS_DISTRO: distro,
      ...(project.ros2?.env ?? {}),
    };

    result.push({
      name: project.name,
      root: project.root,
      package: packageName,
      distro,
      env,
    });
  }

  return result.sort((left, right) => left.root.localeCompare(right.root));
}

async function readPackageXmlName(projectRoot) {
  const packageXmlPath = join(projectRoot, "package.xml");
  if (!await pathExists(packageXmlPath)) {
    return "";
  }

  const packageXml = await readFile(packageXmlPath, "utf8");
  return packageXml.match(/<name>\s*([^<\s]+)\s*<\/name>/)?.[1] ?? "";
}

function ros2DistroFromTags(project) {
  const tag = project.tags?.find((item) => item.startsWith("ros2:"));
  return tag ? tag.slice("ros2:".length) : "";
}

function envAssignments(env) {
  return Object.entries(env)
    .filter(([key, value]) => key && value !== undefined && value !== null && `${value}` !== "")
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid environment key in project.json: ${key}`);
      }
      const text = `${value}`;
      if (/\s/.test(text)) {
        throw new Error(`Environment value for ${key} must not contain whitespace.`);
      }
      return `${key}=${text}`;
    })
    .join(" ");
}
