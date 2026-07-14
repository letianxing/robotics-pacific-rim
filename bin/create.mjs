#!/usr/bin/env node
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathExists, rootDir } from "./workspace.mjs";

const templateDir = join(rootDir, "bin", "templates");

const commands = new Map([
  ["module", createModule],
  ["infra", createInfra],
  ["pkg", createPkg],
]);

async function main(argv) {
  const [command, name, ...args] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "list") {
    await listTemplates();
    return;
  }

  const handler = commands.get(command);
  if (!handler) {
    throw new Error(`Unknown command "${command}". Run "npm run create -- help".`);
  }

  if (!name) {
    throw new Error(`Missing name. Usage: npm run create -- ${command} <name>`);
  }

  await handler(name, parseOptions(args));
}

async function createModule(name, options) {
  const slug = normalizeModuleName(name);
  const packageName = toPackageName(slug);
  const serviceName = toServiceName(slug);
  const ros2Language = normalizeRos2Language(options.ros2 ?? (options.ros2Version ? "python" : undefined));
  const ros2Distro = normalizeRos2Distro(options.ros2Version);
  const templateName = ros2Language ? `module-ros2-${ros2Language}` : "module";
  const targetDir = join(rootDir, "module", "service", serviceName);
  const skillDir = join(rootDir, ".skill", serviceName);

  if (await pathExists(targetDir)) {
    throw new Error(`Target already exists: ${relative(rootDir, targetDir)}`);
  }
  if (await pathExists(skillDir)) {
    throw new Error(`Skill already exists: ${relative(rootDir, skillDir)}`);
  }

  const vars = {
    className: toClassName(slug),
    executableName: `${packageName}_node`,
    language: ros2Language ?? "generic",
    name: serviceName,
    packageName,
    projectName: `module-${serviceName}`,
    rosDistro: ros2Distro,
    securityEnvPrefix: toEnvPrefix(packageName),
    title: toTitle(slug),
  };

  await copyTemplate(templateName, targetDir, vars, { skipSkill: true });
  const skillPath = await writeModuleSkill(templateName, serviceName, vars);
  if (skillPath) {
    await writeModuleAgents(targetDir, serviceName, skillPath);
  }
}

async function createInfra(name) {
  const slug = normalizeName(name);
  await copyTemplate("infra", join(rootDir, "infra", slug), {
    name: slug,
    projectName: `infra-${slug}`,
    title: toTitle(slug),
  });
}

async function createPkg(name) {
  const slug = normalizeName(name);
  await copyTemplate("pkg", join(rootDir, "pkg", slug), {
    name: slug,
    projectName: `pkg-${slug}`,
    title: toTitle(slug),
  });
}

async function copyTemplate(templateName, targetDir, vars, options = {}) {
  const sourceDir = join(templateDir, templateName);
  await assertExists(sourceDir);

  if (await pathExists(targetDir)) {
    throw new Error(`Target already exists: ${relative(rootDir, targetDir)}`);
  }

  await copyDirectory(sourceDir, targetDir, vars, options);
  console.log(`Created ${relative(rootDir, targetDir)}`);
}

async function copyDirectory(sourceDir, targetDir, vars, options = {}) {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (options.skipSkill && entry.isFile() && entry.name === "SKILL.md") {
      continue;
    }
    const sourcePath = join(sourceDir, entry.name);
    const renderedName = render(entry.name, vars).replace(/\.template$/, "");
    const targetPath = join(targetDir, renderedName);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath, vars, options);
      continue;
    }

    const content = await readFile(sourcePath, "utf8");
    await writeFile(targetPath, render(content, vars), { flag: "wx" });
    if (targetPath.endsWith(".sh")) {
      await chmod(targetPath, 0o755);
    }
  }
}

async function writeModuleSkill(templateName, serviceName, vars) {
  const sourcePath = join(templateDir, templateName, "SKILL.md");
  if (!(await pathExists(sourcePath))) {
    return null;
  }
  const targetDir = join(rootDir, ".skill", serviceName);
  await mkdir(targetDir, { recursive: true });
  const targetPath = join(targetDir, "SKILL.md");
  const content = render(await readFile(sourcePath, "utf8"), vars);
  await writeFile(targetPath, content, { flag: "wx" });
  console.log(`Created ${relative(rootDir, targetPath)}`);
  return targetPath;
}

async function writeModuleAgents(targetDir, serviceName, skillPath) {
  const relativeSkillPath = relative(rootDir, skillPath).replaceAll("\\", "/");
  const relativeServicePath = relative(rootDir, targetDir).replaceAll("\\", "/");
  const content = `# ${serviceName} Agent Entry

Before changing this service, read repository-root path \`${relativeSkillPath}\`.

Service-local entry points:
- Service root: \`${relativeServicePath}\`
- Config: \`${relativeServicePath}/config/config.yaml\`, \`${relativeServicePath}/src/config/config.yaml\`, or \`${relativeServicePath}/config.yaml\`
- IDL contracts: \`pkg/idl/${serviceName}\`
- Generated protocol code: \`pkg/idl/${serviceName}/generated\`

Keep business logic inside this service and communicate with other services only through configured protocols.
`;
  const targetPath = join(targetDir, "AGENTS.md");
  await writeFile(targetPath, content, { flag: "wx" });
  console.log(`Created ${relative(rootDir, targetPath)}`);
}

async function listTemplates() {
  const entries = await readdir(templateDir, { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isDirectory())) {
    console.log(entry.name);
  }
}

async function assertExists(path) {
  try {
    await stat(path);
  } catch {
    throw new Error(`Template does not exist: ${path}`);
  }
}

function normalizeName(value) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!slug) {
    throw new Error(`Invalid name "${value}". Use letters, numbers, spaces, "_" or "-".`);
  }

  return slug;
}

function normalizeModuleName(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new Error("Invalid module name. Use lowercase kebab-case, for example: action-planner.");
  }
  if (/[A-Z]/.test(raw)) {
    throw new Error(`Invalid module name "${value}". Uppercase letters are not allowed.`);
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(raw)) {
    throw new Error(
      `Invalid module name "${value}". Use lowercase kebab-case, start with a letter, and avoid underscores, spaces, duplicate separators, or pure numbers.`,
    );
  }
  if (/^\d+(?:-\d+)*$/.test(raw)) {
    throw new Error(`Invalid module name "${value}". Pure numeric names are not allowed.`);
  }
  return raw;
}

function normalizeRos2Language(value) {
  if (!value) {
    return undefined;
  }

  const normalized = value.toLowerCase();

  if (["py", "python", "python3"].includes(normalized)) {
    return "python";
  }

  if (["c++", "cpp", "cxx"].includes(normalized)) {
    return "cpp";
  }

  if (["go", "golang"].includes(normalized)) {
    return "go";
  }

  throw new Error(`Unsupported ROS2 language "${value}". Use "python", "cpp" or "go".`);
}

function normalizeRos2Distro(value) {
  const distro = (value ?? "humble").toLowerCase();
  const supported = new Set(["humble", "jazzy", "kilted", "lyrical", "rolling"]);

  if (!supported.has(distro)) {
    throw new Error(
      `Unsupported ROS2 version "${value}". Use one of: ${Array.from(supported).join(", ")}.`,
    );
  }

  return distro;
}

function parseOptions(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--ros2") {
      if (args[index + 1] && !args[index + 1].startsWith("--")) {
        options.ros2 = args[index + 1];
        index += 1;
      } else {
        options.ros2 = "python";
      }

      continue;
    }

    if (arg.startsWith("--ros2=")) {
      options.ros2 = arg.slice("--ros2=".length);
      continue;
    }

    if (arg === "--ros2-version" || arg === "--ros-distro" || arg === "--distro") {
      if (!args[index + 1]) {
        throw new Error(`Missing value for ${arg}.`);
      }

      options.ros2Version = args[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--ros2-version=")) {
      options.ros2Version = arg.slice("--ros2-version=".length);
      continue;
    }

    if (arg.startsWith("--ros-distro=")) {
      options.ros2Version = arg.slice("--ros-distro=".length);
      continue;
    }

    if (arg.startsWith("--distro=")) {
      options.ros2Version = arg.slice("--distro=".length);
      continue;
    }

    if (arg === "--python") {
      options.ros2 = "python";
      continue;
    }

    if (arg === "--cpp" || arg === "--c++") {
      options.ros2 = "cpp";
      continue;
    }

    if (arg === "--go" || arg === "--golang") {
      options.ros2 = "go";
      continue;
    }

    throw new Error(`Unknown option "${arg}". Run "npm run create -- help".`);
  }

  return options;
}

function toPackageName(value) {
  return value.replaceAll("-", "_");
}

function toServiceName(value) {
  const packageName = toPackageName(value);
  return packageName.endsWith("_service") ? packageName : `${packageName}_service`;
}

function toClassName(value) {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function toEnvPrefix(value) {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function toTitle(value) {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function render(content, vars) {
  return Object.entries(vars).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    content,
  );
}

function printHelp() {
  console.log(`Pacific-Rim scaffold

Usage:
  npm run create -- list
  npm run create -- module <lowercase-kebab-name>
  npm run create -- module <lowercase-kebab-name> --ros2 python --ros2-version humble
  npm run create -- module <lowercase-kebab-name> --ros2 cpp --ros2-version humble
  npm run create -- module <lowercase-kebab-name> --ros2 go --ros2-version humble
  npm run create -- pkg <name>
  npm run create -- infra <name>

Examples:
  npm run create -- module navigation
  npm run create -- module lidar-driver --ros2 python --ros2-version humble
  npm run create -- module drive-control --ros2 cpp --distro humble
  npm run create -- module brain-sidecar --ros2 go --distro humble
  npm run create -- pkg communication
  npm run create -- infra telemetry

ROS2 versions:
  humble, jazzy, kilted, lyrical, rolling

Module naming:
  Use lowercase kebab-case, start with a letter, and avoid uppercase,
  underscores, spaces, duplicate separators, and pure numeric names.
  The module directory is generated as module/service/<name>_service. Its
  Codex/Claude service entry is module/service/<name>_service/AGENTS.md, which
  points to the generated .skill/<name>_service/SKILL.md.
`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
