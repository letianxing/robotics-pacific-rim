#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  hasNonEmptyReadme,
  loadProjects,
  pathExists,
  projectCacheDir,
  rootDir,
} from "./workspace.mjs";

const [projectNameOrRoot] = process.argv.slice(2);

if (!projectNameOrRoot) {
  console.error("Usage: node bin/check-project.mjs <project-name-or-root>");
  process.exitCode = 1;
} else {
  await main(projectNameOrRoot).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main(projectNameOrRoot) {
  const projects = await loadProjects();
  const project = projects.find(
    (item) => item.name === projectNameOrRoot || item.root === projectNameOrRoot,
  );

  if (!project) {
    throw new Error(`Unknown project: ${projectNameOrRoot}`);
  }

  const failures = [];

  if (!(await pathExists(join(rootDir, project.root)))) {
    failures.push(`Missing project root: ${project.root}`);
  }

  if (!(await hasNonEmptyReadme(project.root))) {
    failures.push(`Missing or empty README: ${project.root}/README.md`);
  }

  for (const dependency of project.implicitDependencies ?? []) {
    if (!projects.some((item) => item.name === dependency)) {
      failures.push(`Unknown dependency "${dependency}" in ${project.name}`);
    }
  }

  failures.push(...(await checkRos2Project(project)));

  const cacheDir = projectCacheDir(project.name, "check");
  await mkdir(cacheDir, { recursive: true });

  if (failures.length > 0) {
    await writeResult(cacheDir, project, 1, failures);
    for (const failure of failures) {
      console.error(failure);
    }
    process.exitCode = 1;
    return;
  }

  await writeResult(cacheDir, project, 0, []);
  console.log(`${project.name}: check passed`);
}

async function checkRos2Project(project) {
  const failures = [];

  if (!project.tags?.includes("framework:ros2")) {
    return failures;
  }

  const root = join(rootDir, project.root);
  const distroTag = project.tags.find((tag) => tag.startsWith("ros2:"));
  const supportedDistros = new Set(["humble", "jazzy", "kilted", "lyrical", "rolling"]);

  if (!distroTag) {
    failures.push(`${project.name} must declare a ros2:<distro> tag.`);
  } else {
    const distro = distroTag.slice("ros2:".length);
    if (!supportedDistros.has(distro)) {
      failures.push(`${project.name} has unsupported ROS2 distro tag: ${distroTag}`);
    }
  }

  if (!(await pathExists(join(root, "package.xml")))) {
    failures.push(`Missing ROS2 package manifest: ${project.root}/package.xml`);
  } else {
    failures.push(...(await checkRos2Config(project, root, distroTag)));
  }

  if (project.tags.includes("language:python")) {
    if (!(await pathExists(join(root, "setup.py")))) {
      failures.push(`Missing ROS2 Python setup file: ${project.root}/setup.py`);
    }
  }

  if (project.tags.includes("language:cpp")) {
    const cmakePath = join(root, "CMakeLists.txt");
    if (!(await pathExists(cmakePath))) {
      failures.push(`Missing ROS2 C++ build file: ${project.root}/CMakeLists.txt`);
    } else {
      failures.push(...(await checkCmakeExecutables(project, cmakePath)));
    }
  }

  failures.push(...(await checkConsumerOnlyCommunicationConfig(project, root)));

  return failures;
}

async function checkRos2Config(project, root, distroTag) {
  const failures = [];
  const packageName = await readPackageXmlName(root);
  const tagDistro = distroTag ? distroTag.slice("ros2:".length) : "";

  if (!project.ros2 || typeof project.ros2 !== "object" || Array.isArray(project.ros2)) {
    failures.push(`${project.name} must declare a ros2 config object in project.json.`);
    return failures;
  }

  if (project.ros2.package !== packageName) {
    failures.push(`${project.name} ros2.package must match package.xml name "${packageName}".`);
  }

  if (project.ros2.distro !== tagDistro) {
    failures.push(`${project.name} ros2.distro must match ${distroTag}.`);
  }

  if (project.ros2.includeInAll !== undefined && typeof project.ros2.includeInAll !== "boolean") {
    failures.push(`${project.name} ros2.includeInAll must be a boolean when set.`);
  }

  if (project.ros2.env !== undefined) {
    if (!project.ros2.env || typeof project.ros2.env !== "object" || Array.isArray(project.ros2.env)) {
      failures.push(`${project.name} ros2.env must be an object when set.`);
    } else {
      for (const [key, value] of Object.entries(project.ros2.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          failures.push(`${project.name} ros2.env has invalid key "${key}".`);
        }
        if (value === undefined || value === null || `${value}` === "") {
          failures.push(`${project.name} ros2.env.${key} must be a non-empty value.`);
        }
        if (/\s/.test(`${value}`)) {
          failures.push(`${project.name} ros2.env.${key} must not contain whitespace.`);
        }
      }
    }
  }

  const command = project.targets?.build?.command;
  if (typeof command === "string") {
    if (!command.includes(`--packages-select ${packageName}`) && !command.includes(`--packages-select=${packageName}`)) {
      failures.push(`${project.name} targets.build.command must select ros2.package "${packageName}".`);
    }
    if (tagDistro && !command.includes(`ROS_DISTRO=${tagDistro}`)) {
      failures.push(`${project.name} targets.build.command must include ROS_DISTRO=${tagDistro}.`);
    }
    for (const [key, value] of Object.entries(project.ros2.env ?? {})) {
      if (!command.includes(`${key}=${value}`)) {
        failures.push(`${project.name} targets.build.command must include ${key}=${value}.`);
      }
    }
  }

  return failures;
}

async function readPackageXmlName(root) {
  const packageXml = await readFile(join(root, "package.xml"), "utf8");
  return packageXml.match(/<name>\s*([^<\s]+)\s*<\/name>/)?.[1] ?? "";
}

async function checkCmakeExecutables(project, cmakePath) {
  const failures = [];
  const cmake = await readFile(cmakePath, "utf8");
  const executableBlocks = [...cmake.matchAll(/add_executable\s*\(([\s\S]*?)\)/g)];

  if (executableBlocks.length === 0) {
    failures.push(`Missing ROS2 C++ executable in ${project.root}/CMakeLists.txt`);
    return failures;
  }

  for (const block of executableBlocks) {
    const tokens = block[1]
      .split(/\s+/)
      .map((token) => token.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    for (const token of tokens.slice(1)) {
      if (!/\.(cc|cpp|cxx)$/i.test(token) || token.includes("$")) {
        continue;
      }
      if (!(await pathExists(join(rootDir, project.root, token)))) {
        failures.push(`Missing ROS2 C++ executable source: ${project.root}/${token}`);
      }
    }
  }

  return failures;
}

async function checkConsumerOnlyCommunicationConfig(project, root) {
  const failures = [];
  const configPath = await firstExisting([
    join(root, "src", "config", "config.yaml"),
    join(root, "config", "config.yaml"),
    join(root, "config.yaml"),
  ]);
  if (!configPath) {
    return failures;
  }
  const text = await readFile(configPath, "utf8");
  for (const route of communicationConfigRoutes(text)) {
    const direction = route.direction.toLowerCase();
    if (!direction) {
      failures.push(
        `${project.root}/config.yaml route ${route.section}.${route.name} must declare direction client or subscribe; provider routes belong in pkg/idl/<service>/public/interfaces.yaml.`,
      );
      continue;
    }
    if (route.section === "services" && !["client", "consumer"].includes(direction)) {
      failures.push(
        `${project.root}/config.yaml service "${route.name}" uses provider direction "${route.direction}". Define it under pkg/idl/<service>/public/interfaces.yaml instead.`,
      );
    }
    if (route.section === "topics" && !["subscribe", "subscriber", "in", "consumer"].includes(direction)) {
      failures.push(
        `${project.root}/config.yaml topic "${route.name}" uses provider direction "${route.direction}". Define it under pkg/idl/<service>/public/interfaces.yaml instead.`,
      );
    }
  }
  return failures;
}

async function firstExisting(paths) {
  for (const candidate of paths) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function communicationConfigRoutes(text) {
  const routes = [];
  const lines = text.split(/\r?\n/);
  let inCommunication = false;
  let section = null;
  let current = null;
  const finish = () => {
    if (current) {
      routes.push(current);
    }
    current = null;
  };
  for (const raw of lines) {
    const line = lineInfo(raw);
    if (line.indent === 0 && line.trimmed === "communication:") {
      finish();
      inCommunication = true;
      section = null;
      continue;
    }
    if (inCommunication && line.indent === 0 && line.trimmed) {
      finish();
      inCommunication = false;
      section = null;
    }
    if (
      inCommunication &&
      line.indent === 2 &&
      (line.trimmed === "services:" || line.trimmed === "topics:")
    ) {
      finish();
      section = line.trimmed.slice(0, -1);
      continue;
    }
    if (section && line.trimmed && line.indent <= 2) {
      finish();
      section = null;
    }
    const routeMatch = line.trimmed.match(/^([A-Za-z0-9_./-]+):$/);
    if (section && line.indent === 4 && routeMatch) {
      finish();
      current = {
        direction: "",
        name: routeMatch[1],
        section,
      };
      continue;
    }
    const directionMatch = line.trimmed.match(/^direction:\s*(.*)$/);
    if (current && line.indent === 6 && directionMatch) {
      current.direction = directionMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  finish();
  return routes;
}

function lineInfo(raw) {
  const line = raw.replace(/\s+#.*$/, "");
  return {
    indent: line.match(/^ */)?.[0].length ?? 0,
    trimmed: line.trim(),
  };
}

async function writeResult(cacheDir, project, code, failures) {
  await writeFile(
    join(cacheDir, "result.json"),
    `${JSON.stringify(
      {
        code,
        failures,
        project: project.name,
        root: project.root,
        relativeCacheDir: relative(rootDir, cacheDir),
      },
      null,
      2,
    )}\n`,
  );
}
