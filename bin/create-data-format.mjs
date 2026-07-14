#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolveRootDir();

const VALID_KINDS = new Set(["proto", "msg", "srv", "dds_idl"]);
const NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROTO_FIELD_REGEX =
  /^(?:(optional|required|repeated)\s+)?(map\s*<\s*[A-Za-z_][A-Za-z0-9_.]*\s*,\s*[A-Za-z_][A-Za-z0-9_.]*\s*>|[A-Za-z_][A-Za-z0-9_.<>]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*;$/;
const ROS_FIELD_REGEX =
  /^[A-Za-z][A-Za-z0-9_/.<>]*(?:<=\d+)?(?:\[[^\]]*\])?\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*=.*)?$/;

function resolveRootDir() {
  const candidates = [
    process.cwd(),
    dirname(dirname(fileURLToPath(import.meta.url))),
  ];
  for (const candidate of candidates) {
    const match = findUpPackageJson(candidate);
    if (match) {
      return match;
    }
  }
  return process.cwd();
}

function findUpPackageJson(startDir) {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return "";
    }
    dir = parent;
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  if (options.listServices) {
    await listServices();
    return;
  }

  if (!options.service) {
    throw new Error("Missing --service.");
  }
  if (!options.kind) {
    throw new Error("Missing --kind.");
  }

  const kind = normalizeKind(options.kind);
  const moduleRoot = await resolveServiceModuleRoot(options.service);
  const serviceName = basename(moduleRoot).replaceAll("-", "_");
  const rawDefinition = await readDefinition(options);
  const built = buildDefinition(kind, options.name, rawDefinition, serviceName);
  const targetPath = dataFormatTargetPath(serviceName, kind, built.name);

  if (options.dryRun) {
    console.log(`Would create ${relative(rootDir, targetPath)}`);
    console.log("");
    console.log(built.newFileContent.trimEnd());
    return;
  }

  await mkdir(dirname(targetPath), { recursive: true });
  if (kind === "proto") {
    await writeProtoDefinition(targetPath, built, options.force);
  } else {
    if (existsSync(targetPath) && !options.force) {
      throw new Error(`${relative(rootDir, targetPath)} already exists. Pass --force to overwrite it.`);
    }
    await writeFile(targetPath, `${built.newFileContent.trimEnd()}\n`, "utf8");
    if (kind === "msg" || kind === "srv") {
      await writeRos2PackageMetadata(serviceName);
    }
  }

  console.log(`Created ${relative(rootDir, targetPath)}`);
  console.log(`Next: ./pr gen:interfaces --service ${serviceName}`);
}

function parseArgs(argv) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h" || arg === "help") {
      options.help = true;
      continue;
    }
    if (arg === "--list-services" || arg === "list") {
      options.listServices = true;
      continue;
    }
    if (arg === "--service" || arg === "-s") {
      options.service = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--service=")) {
      options.service = arg.slice("--service=".length);
      continue;
    }
    if (arg === "--kind" || arg === "--format" || arg === "--data-format" || arg === "-k") {
      options.kind = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--kind=")) {
      options.kind = arg.slice("--kind=".length);
      continue;
    }
    if (arg.startsWith("--format=")) {
      options.kind = arg.slice("--format=".length);
      continue;
    }
    if (arg.startsWith("--data-format=")) {
      options.kind = arg.slice("--data-format=".length);
      continue;
    }
    if (arg === "--name" || arg === "-n") {
      options.name = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--name=")) {
      options.name = arg.slice("--name=".length);
      continue;
    }
    if (arg === "--file" || arg === "--definition-file" || arg === "-f") {
      options.file = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--file=")) {
      options.file = arg.slice("--file=".length);
      continue;
    }
    if (arg.startsWith("--definition-file=")) {
      options.file = arg.slice("--definition-file=".length);
      continue;
    }
    if (arg === "--data" || arg === "--definition" || arg === "-d") {
      options.data = readOptionValue(argv, index, arg, { allowDashPrefix: true });
      index += 1;
      continue;
    }
    if (arg.startsWith("--data=")) {
      options.data = arg.slice("--data=".length);
      continue;
    }
    if (arg.startsWith("--definition=")) {
      options.data = arg.slice("--definition=".length);
      continue;
    }
    if (arg === "--stdin") {
      options.stdin = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positionals.push(arg);
  }

  options.service ??= positionals.shift();
  options.kind ??= positionals.shift();
  options.name ??= positionals.shift();
  if (positionals.length > 0) {
    throw new Error(`Unexpected positional argument: ${positionals[0]}`);
  }
  return options;
}

function readOptionValue(argv, index, flag, options = {}) {
  const value = argv[index + 1];
  if (!value || (!options.allowDashPrefix && value.startsWith("-"))) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function normalizeKind(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["omg_idl", "omg-dds-idl", "ddsidl", "omgidl"].includes(normalized)) {
    return "dds_idl";
  }
  if (!VALID_KINDS.has(normalized)) {
    throw new Error("Invalid --kind. Use one of: proto, msg, srv, dds_idl.");
  }
  return normalized;
}

async function readDefinition(options) {
  const sources = [options.file ? "file" : "", options.data !== undefined ? "data" : "", options.stdin ? "stdin" : ""].filter(Boolean);
  if (sources.length !== 1) {
    throw new Error("Provide exactly one definition source: --file <path>, --data <text>, or --stdin.");
  }
  if (options.data !== undefined) {
    return String(options.data);
  }
  if (options.stdin || options.file === "-") {
    return readStdin();
  }
  return readFile(resolve(rootDir, options.file), "utf8");
}

async function readStdin() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}

async function listServices() {
  const serviceRoot = join(rootDir, "module", "service");
  const entries = await readdir(serviceRoot, { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    console.log(entry.name);
  }
}

async function resolveServiceModuleRoot(service) {
  const normalized = normalizeServiceInput(service);
  if (!normalized) {
    throw new Error("Missing service name.");
  }

  const direct = resolve(rootDir, normalized);
  if (await isDirectory(direct)) {
    return direct;
  }

  for (const name of candidateServiceNames(normalized)) {
    const candidate = join(rootDir, "module", "service", name);
    if (await isDirectory(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Service module not found: ${service}. Expected module/service/<service_name>.`);
}

function normalizeServiceInput(value) {
  return String(value ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
}

function candidateServiceNames(value) {
  const normalized = normalizeServiceInput(value);
  const leaf = basename(normalized);
  const withoutProjectPrefix = leaf.replace(/^module-/, "");
  const base = withoutProjectPrefix.replaceAll("-", "_");
  const names = new Set([leaf, withoutProjectPrefix, base]);
  if (base && !base.endsWith("_service")) {
    names.add(`${base}_service`);
  }
  return [...names].filter(Boolean);
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function buildDefinition(kind, name, rawDefinition, serviceName) {
  if (kind === "proto") {
    return buildProtoDefinition(name, rawDefinition, serviceName);
  }
  if (kind === "msg") {
    return buildRosMessageDefinition(name, rawDefinition);
  }
  if (kind === "srv") {
    return buildRosServiceDefinition(name, rawDefinition);
  }
  return buildDdsIdlDefinition(name, rawDefinition);
}

function dataFormatTargetPath(serviceName, kind, name) {
  const idlRoot = join(rootDir, "pkg", "idl", serviceName);
  if (kind === "proto") {
    return join(idlRoot, "pb", `${serviceName}.proto`);
  }
  if (kind === "dds_idl") {
    return join(idlRoot, "dds", serviceName, `${name}.idl`);
  }
  return join(idlRoot, "ros2", serviceName, kind, `${name}.${kind}`);
}

async function writeRos2PackageMetadata(serviceName) {
  const packageDir = join(rootDir, "pkg", "idl", serviceName, "ros2", serviceName);
  const msgFiles = await listFilesWithExtension(join(packageDir, "msg"), ".msg");
  const srvFiles = await listFilesWithExtension(join(packageDir, "srv"), ".srv");
  const interfaceFiles = [
    ...msgFiles.map((name) => `msg/${name}`),
    ...srvFiles.map((name) => `srv/${name}`),
  ].sort();
  if (interfaceFiles.length === 0) {
    return;
  }

  const dependencies = await ros2InterfaceDependencies(packageDir, interfaceFiles, serviceName);
  const cmake = renderRos2PackageCMake(serviceName, interfaceFiles, dependencies);
  const packageXml = renderRos2PackageXml(serviceName, dependencies);
  await writeFile(join(packageDir, "CMakeLists.txt"), cmake, "utf8");
  await writeFile(join(packageDir, "package.xml"), packageXml, "utf8");
}

async function listFilesWithExtension(dir, extension) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function ros2InterfaceDependencies(packageDir, interfaceFiles, serviceName) {
  const dependencies = new Set();
  for (const interfaceFile of interfaceFiles) {
    const content = await readFile(join(packageDir, interfaceFile), "utf8");
    for (const dep of ros2DefinitionDependencies(content, serviceName)) {
      dependencies.add(dep);
    }
  }
  return [...dependencies].sort();
}

function ros2DefinitionDependencies(content, serviceName) {
  const dependencies = new Set();
  for (const item of definitionLines(content, { comment: "#" })) {
    if (item.line === "---") {
      continue;
    }
    const [rawType] = item.line.split(/\s+/, 1);
    const type = String(rawType || "")
      .replace(/<=\d+/g, "")
      .replace(/\[[^\]]*\]/g, "");
    if (!type.includes("/")) {
      continue;
    }
    const [pkg] = type.split("/");
    if (pkg && pkg !== serviceName) {
      dependencies.add(pkg);
    }
  }
  return dependencies;
}

function renderRos2PackageCMake(serviceName, interfaceFiles, dependencies) {
  const dependencyFinds = dependencies.map((dep) => `find_package(${dep} REQUIRED)`);
  const dependencyClause = dependencies.length > 0 ? [`  DEPENDENCIES ${dependencies.join(" ")}`] : [];
  return [
    "cmake_minimum_required(VERSION 3.8)",
    `project(${serviceName})`,
    "",
    "find_package(ament_cmake REQUIRED)",
    "find_package(rosidl_default_generators REQUIRED)",
    ...dependencyFinds,
    "",
    "rosidl_generate_interfaces(${PROJECT_NAME}",
    ...interfaceFiles.map((file) => `  "${file}"`),
    ...dependencyClause,
    ")",
    "",
    "ament_export_dependencies(rosidl_default_runtime)",
    "ament_package()",
    "",
  ].join("\n");
}

function renderRos2PackageXml(serviceName, dependencies) {
  const dependencyLines = dependencies.map((dep) => `  <depend>${dep}</depend>`);
  return [
    '<?xml version="1.0"?>',
    '<package format="3">',
    `  <name>${serviceName}</name>`,
    "  <version>0.1.0</version>",
    `  <description>ROS2 interfaces for the ${serviceName} public contract.</description>`,
    "  <maintainer email=\"dev@example.com\">Pacific-Rim Developers</maintainer>",
    "  <license>TODO</license>",
    "",
    "  <buildtool_depend>ament_cmake</buildtool_depend>",
    "  <build_depend>rosidl_default_generators</build_depend>",
    ...dependencyLines,
    "",
    "  <exec_depend>rosidl_default_runtime</exec_depend>",
    "",
    "  <member_of_group>rosidl_interface_packages</member_of_group>",
    "",
    "  <export>",
    "    <build_type>ament_cmake</build_type>",
    "  </export>",
    "</package>",
    "",
  ].join("\n");
}

function buildProtoDefinition(name, rawDefinition, serviceName) {
  const source = normalizeText(rawDefinition);
  if (!source.trim()) {
    throw new Error("Proto definition is empty.");
  }

  const messageNames = [...source.matchAll(/\bmessage\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g)].map((match) => match[1]);
  const resolvedName = validateName(name || inferSingleName(messageNames, "proto message"));

  if (messageNames.length > 0) {
    const block = extractNamedBlock(source, "message", resolvedName);
    if (!block) {
      throw new Error(`Proto definition does not contain message "${resolvedName}".`);
    }
    validateProtoMessageBlock(block, resolvedName);
    const hasProtoHeader = /^\s*(syntax|package|import|option)\s*[=;]/m.test(source);
    return {
      name: resolvedName,
      appendContent: block,
      newFileContent: hasProtoHeader ? source : `${protoHeader(serviceName)}\n\n${block}`,
    };
  }

  const fields = validateProtoFieldFragment(source);
  const block = renderProtoMessage(resolvedName, fields);
  return {
    name: resolvedName,
    appendContent: block,
    newFileContent: `${protoHeader(serviceName)}\n\n${block}`,
  };
}

function buildRosMessageDefinition(name, rawDefinition) {
  const resolvedName = validateName(name);
  const source = normalizeText(rawDefinition).trim();
  if (!source) {
    throw new Error("ROS2 msg definition is empty.");
  }
  validateRosFields(source, { kind: "msg", requireField: true });
  return {
    name: resolvedName,
    newFileContent: source,
  };
}

function buildRosServiceDefinition(name, rawDefinition) {
  const resolvedName = validateName(name);
  const source = normalizeText(rawDefinition).trim();
  if (!source) {
    throw new Error("ROS2 srv definition is empty.");
  }
  const sections = source.split(/^---\s*$/m);
  if (sections.length !== 2) {
    throw new Error('ROS2 srv definition must contain exactly one "---" separator.');
  }
  validateRosFields(sections[0], { kind: "srv request", requireField: false });
  validateRosFields(sections[1], { kind: "srv response", requireField: true });
  return {
    name: resolvedName,
    newFileContent: `${sections[0].trimEnd()}\n---\n${sections[1].trim()}`,
  };
}

function buildDdsIdlDefinition(name, rawDefinition) {
  const source = normalizeText(rawDefinition);
  if (!source.trim()) {
    throw new Error("DDS IDL definition is empty.");
  }

  const declaredNames = [
    ...source.matchAll(/\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g),
    ...source.matchAll(/\binterface\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g),
  ].map((match) => match[1]);
  if (declaredNames.length > 0) {
    const resolvedName = validateName(name || inferSingleName(declaredNames, "DDS IDL type"));
    if (!declaredNames.includes(resolvedName)) {
      throw new Error(`DDS IDL definition does not contain struct/interface "${resolvedName}".`);
    }
    validateBalancedBraces(source, "DDS IDL");
    return {
      name: resolvedName,
      newFileContent: source.trimEnd(),
    };
  }

  const resolvedName = validateName(name);
  const fields = validateDdsIdlFieldFragment(source);
  return {
    name: resolvedName,
    newFileContent: renderDdsIdlStruct(resolvedName, fields),
  };
}

async function writeProtoDefinition(targetPath, built, force) {
  if (!existsSync(targetPath)) {
    await writeFile(targetPath, `${built.newFileContent.trimEnd()}\n`, "utf8");
    return;
  }

  const current = await readFile(targetPath, "utf8");
  if (current.includes(`message ${built.name}`)) {
    if (!force) {
      throw new Error(`Proto message "${built.name}" already exists in ${relative(rootDir, targetPath)}. Pass --force to replace it.`);
    }
    await writeFile(targetPath, replaceNamedBlock(current, "message", built.name, built.appendContent), "utf8");
    return;
  }

  await writeFile(targetPath, `${current.trimEnd()}\n\n${built.appendContent.trimEnd()}\n`, "utf8");
}

function validateName(value) {
  const raw = String(value || "").trim();
  if (!NAME_REGEX.test(raw)) {
    throw new Error(`Invalid name "${value ?? ""}". Use letters, numbers, and underscores, and start with a letter or underscore.`);
  }
  return raw;
}

function inferSingleName(names, label) {
  const unique = [...new Set(names)];
  if (unique.length === 1) {
    return unique[0];
  }
  if (unique.length === 0) {
    throw new Error(`Missing --name. No ${label} name could be inferred from the definition.`);
  }
  throw new Error(`Missing --name. Definition contains multiple ${label}s: ${unique.join(", ")}.`);
}

function protoHeader(serviceName) {
  return ['syntax = "proto3";', "", `package pacific_rim.${serviceName}.protocols.pb;`].join("\n");
}

function renderProtoMessage(name, fields) {
  return [`message ${name} {`, ...fields.map((line) => `  ${line}`), "}"].join("\n");
}

function renderDdsIdlStruct(name, fields) {
  return [`struct ${name} {`, ...fields.map((line) => `  ${line}`), "};"].join("\n");
}

function validateProtoFieldFragment(text) {
  const lines = [];
  const tags = new Set();
  for (const item of definitionLines(text)) {
    const match = item.line.match(PROTO_FIELD_REGEX);
    if (!match) {
      throw new Error(`Invalid proto field on line ${item.number}: "${item.line}". Expected: <type> <name> = <number>;`);
    }
    const tag = match[4];
    if (tags.has(tag)) {
      throw new Error(`Duplicate proto field number ${tag} on line ${item.number}.`);
    }
    tags.add(tag);
    lines.push(item.line);
  }
  if (lines.length === 0) {
    throw new Error("Proto field fragment has no fields.");
  }
  return lines;
}

function validateProtoMessageBlock(block, name) {
  validateBalancedBraces(block, `proto message ${name}`);
  const body = block.slice(block.indexOf("{") + 1, block.lastIndexOf("}"));
  const candidates = definitionLines(body).filter((item) => !/^(option|reserved|extensions|oneof)\b/.test(item.line));
  for (const item of candidates) {
    if (item.line === "{" || item.line === "}" || item.line.endsWith("{")) {
      continue;
    }
    if (!item.line.match(PROTO_FIELD_REGEX)) {
      throw new Error(`Invalid proto field inside message "${name}" near line ${item.number}: "${item.line}".`);
    }
  }
}

function validateRosFields(text, options) {
  let fieldCount = 0;
  for (const item of definitionLines(text, { comment: "#" })) {
    if (item.line === "---") {
      throw new Error(`${options.kind} field list must not contain a service separator.`);
    }
    if (!ROS_FIELD_REGEX.test(item.line)) {
      throw new Error(`Invalid ROS2 ${options.kind} field on line ${item.number}: "${item.line}". Expected: <type> <name>.`);
    }
    if (!item.line.includes("=")) {
      fieldCount += 1;
    }
  }
  if (options.requireField && fieldCount === 0) {
    throw new Error(`ROS2 ${options.kind} definition must contain at least one field.`);
  }
}

function validateDdsIdlFieldFragment(text) {
  const fields = [];
  for (const item of definitionLines(text)) {
    if (!item.line.endsWith(";")) {
      throw new Error(`Invalid DDS IDL field on line ${item.number}: "${item.line}". Fields must end with ";".`);
    }
    const field = item.line.replace(/;$/, "").trim();
    const match = field.match(/^(.+?)\s+([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!match || !/^[A-Za-z_][A-Za-z0-9_:<>, \t]*$/.test(match[1].trim())) {
      throw new Error(`Invalid DDS IDL field on line ${item.number}: "${item.line}". Expected: <type> <name>;`);
    }
    fields.push(`${field};`);
  }
  if (fields.length === 0) {
    throw new Error("DDS IDL field fragment has no fields.");
  }
  return fields;
}

function definitionLines(text, options = {}) {
  const comment = options.comment ?? "//";
  return normalizeText(text)
    .split("\n")
    .map((raw, index) => {
      const line = stripComment(raw, comment).trim();
      return { line, number: index + 1 };
    })
    .filter((item) => item.line);
}

function stripComment(line, comment) {
  const index = line.indexOf(comment);
  return index >= 0 ? line.slice(0, index) : line;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function extractNamedBlock(text, keyword, name) {
  const regex = new RegExp(`\\b${keyword}\\s+${escapeRegExp(name)}\\s*\\{`, "m");
  const match = regex.exec(text);
  if (!match) {
    return "";
  }
  const start = match.index;
  const open = text.indexOf("{", start);
  const close = matchingBraceIndex(text, open);
  if (close < 0) {
    throw new Error(`Unbalanced braces in ${keyword} "${name}".`);
  }
  return text.slice(start, close + 1).trim();
}

function replaceNamedBlock(text, keyword, name, replacement) {
  const regex = new RegExp(`\\b${keyword}\\s+${escapeRegExp(name)}\\s*\\{`, "m");
  const match = regex.exec(text);
  if (!match) {
    throw new Error(`Unable to locate ${keyword} "${name}".`);
  }
  const open = text.indexOf("{", match.index);
  const close = matchingBraceIndex(text, open);
  if (close < 0) {
    throw new Error(`Unbalanced braces in existing ${keyword} "${name}".`);
  }
  return `${text.slice(0, match.index)}${replacement.trimEnd()}${text.slice(close + 1)}`.trimEnd() + "\n";
}

function matchingBraceIndex(text, openIndex) {
  if (openIndex < 0) {
    return -1;
  }
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function validateBalancedBraces(text, label) {
  let depth = 0;
  for (const char of text) {
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth < 0) {
        throw new Error(`${label} has an unexpected closing brace.`);
      }
    }
  }
  if (depth !== 0) {
    throw new Error(`${label} has unbalanced braces.`);
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printHelp() {
  console.log(`Create a data format under pkg/idl/<service>.

Usage:
  ./pr data-format --service <service> --kind <proto|msg|srv|dds_idl> --name <Type> --file <path>
  ./pr data-format --service <service> --kind <proto|msg|srv|dds_idl> --name <Type> --data <definition>
  ./pr data-format --service <service> --kind <proto|msg|srv|dds_idl> --name <Type> --stdin
  ./pr data-format --list-services

Examples:
  ./pr data-format -s smoke_001_service -k msg -n RobotState --data "string robot_id"
  ./pr data-format -s smoke_001_service -k proto -n RobotState --file ./RobotState.proto
  cat Plan.idl | ./pr data-format -s planner_service -k dds_idl -n Plan --stdin

Notes:
  proto can be a full .proto file, a message block, or field lines with tags.
  msg is ROS2 .msg field content.
  srv must contain exactly one "---" separator and at least one response field.
  dds_idl can be a struct/interface definition or struct field lines.
`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
