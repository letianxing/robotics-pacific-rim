#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(rootDir, "pkg", "robot", "capabilities.json");
const profilesDir = join(rootDir, "deploy", "robot-profiles");
const validProfileStatuses = new Set(["active", "template"]);
const idPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function pathExists(path) {
  return existsSync(path);
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function relativePath(path) {
  return relative(rootDir, path).replace(/\\/g, "/");
}

function readCatalog() {
  const raw = readJson(catalogPath);
  const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  return {
    raw,
    capabilities,
    byId: new Map(capabilities.map((capability) => [capability.id, capability])),
  };
}

function profileFiles() {
  if (!pathExists(profilesDir)) {
    return [];
  }
  return readdirSync(profilesDir)
    .filter((name) => name.endsWith(".json") && name !== "project.json")
    .sort((left, right) => left.localeCompare(right))
    .map((name) => join(profilesDir, name))
    .filter(isFile);
}

function readProfiles() {
  return profileFiles().map((file) => ({
    file,
    profile: readJson(file),
  }));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values)];
}

function packageXmlName(serviceRoot) {
  const packageXmlPath = join(serviceRoot, "package.xml");
  if (!pathExists(packageXmlPath)) {
    return "";
  }
  return readFileSync(packageXmlPath, "utf8").match(/<name>\s*([^<\s]+)\s*<\/name>/)?.[1] ?? "";
}

function serviceProjectPath(serviceName) {
  return join(rootDir, "module", "service", serviceName, "project.json");
}

function readServiceProject(serviceName) {
  const projectPath = serviceProjectPath(serviceName);
  if (!pathExists(projectPath)) {
    return null;
  }
  return readJson(projectPath);
}

function serviceRoot(serviceName) {
  return join(rootDir, "module", "service", serviceName);
}

function packageFromService(serviceEntry) {
  if (serviceEntry.package) {
    return serviceEntry.package;
  }
  const project = readServiceProject(serviceEntry.service);
  if (typeof project?.ros2?.package === "string" && project.ros2.package.trim()) {
    return project.ros2.package.trim();
  }
  return packageXmlName(serviceRoot(serviceEntry.service));
}

function displayProfile(profile) {
  const services = asArray(profile.services);
  const plannedServices = asArray(profile.plannedServices);
  return {
    id: profile.id,
    displayName: profile.displayName ?? profile.id,
    status: profile.status,
    robotClass: profile.robotClass ?? "unknown",
    serviceCount: services.length,
    plannedServiceCount: plannedServices.length,
    capabilityCount: asArray(profile.capabilities).length,
  };
}

function validateCapabilityCatalog(catalog) {
  const failures = [];
  const seen = new Set();
  for (const capability of catalog.capabilities) {
    if (!capability.id || typeof capability.id !== "string") {
      failures.push("Capability is missing string id.");
      continue;
    }
    if (!idPattern.test(capability.id)) {
      failures.push(`Capability has invalid id: ${capability.id}`);
    }
    if (seen.has(capability.id)) {
      failures.push(`Duplicate capability id: ${capability.id}`);
    }
    seen.add(capability.id);
    if (!capability.family || typeof capability.family !== "string") {
      failures.push(`${capability.id} must declare family.`);
    }
    if (!capability.summary || typeof capability.summary !== "string") {
      failures.push(`${capability.id} must declare summary.`);
    }
    if (
      capability.contractStatus === "available" &&
      asArray(capability.contracts).length === 0
    ) {
      failures.push(`${capability.id} is available but has no contract reference.`);
    }
    for (const contract of asArray(capability.contracts)) {
      if (contract.status === "available" && contract.path) {
        const contractPath = join(rootDir, contract.path);
        if (!pathExists(contractPath)) {
          failures.push(`${capability.id} references missing contract: ${contract.path}`);
        }
      }
    }
  }
  return failures;
}

function validateServiceEntry(profile, serviceEntry, catalog, file, options = {}) {
  const failures = [];
  const prefix = `${relativePath(file)}:${profile.id}`;
  if (!serviceEntry.service || typeof serviceEntry.service !== "string") {
    failures.push(`${prefix} has service entry without string service name.`);
    return failures;
  }
  for (const capabilityId of asArray(serviceEntry.capabilities)) {
    if (!catalog.byId.has(capabilityId)) {
      failures.push(`${prefix} service ${serviceEntry.service} references unknown capability ${capabilityId}.`);
    }
  }
  const project = readServiceProject(serviceEntry.service);
  if (!project && options.mustExist) {
    failures.push(`${prefix} requires missing service module: ${serviceEntry.service}`);
    return failures;
  }
  if (!project) {
    return failures;
  }
  const actualPackage = packageFromService(serviceEntry);
  if (serviceEntry.package && actualPackage && serviceEntry.package !== actualPackage) {
    failures.push(`${prefix} service ${serviceEntry.service} package ${serviceEntry.package} does not match ${actualPackage}.`);
  }
  return failures;
}

function validateProfile(file, profile, catalog) {
  const failures = [];
  const prefix = `${relativePath(file)}:${profile.id ?? "<missing-id>"}`;
  if (!profile.id || typeof profile.id !== "string") {
    failures.push(`${relativePath(file)} is missing string id.`);
    return failures;
  }
  if (!idPattern.test(profile.id)) {
    failures.push(`${prefix} has invalid id.`);
  }
  if (!validProfileStatuses.has(profile.status)) {
    failures.push(`${prefix} has invalid status: ${profile.status}`);
  }
  for (const capabilityId of asArray(profile.capabilities)) {
    if (!catalog.byId.has(capabilityId)) {
      failures.push(`${prefix} references unknown capability ${capabilityId}.`);
    }
  }
  const services = asArray(profile.services);
  for (const serviceEntry of services) {
    failures.push(
      ...validateServiceEntry(profile, serviceEntry, catalog, file, {
        mustExist: profile.status === "active" && serviceEntry.required !== false,
      })
    );
  }
  for (const serviceEntry of asArray(profile.plannedServices)) {
    failures.push(...validateServiceEntry(profile, serviceEntry, catalog, file));
  }
  if (profile.status === "active") {
    const packages = services
      .filter((serviceEntry) => serviceEntry.required !== false)
      .map((serviceEntry) => packageFromService(serviceEntry))
      .filter(Boolean);
    if (packages.length === 0) {
      failures.push(`${prefix} active profile must resolve at least one ROS2 package.`);
    }
  }
  return failures;
}

function validateProfiles() {
  const catalog = readCatalog();
  const failures = validateCapabilityCatalog(catalog);
  const profiles = readProfiles();
  const seenProfiles = new Set();
  for (const { file, profile } of profiles) {
    if (profile.id && seenProfiles.has(profile.id)) {
      failures.push(`Duplicate profile id: ${profile.id}`);
    }
    if (profile.id) {
      seenProfiles.add(profile.id);
    }
    failures.push(...validateProfile(file, profile, catalog));
  }
  if (profiles.length === 0) {
    failures.push(`No robot profiles found in ${relativePath(profilesDir)}.`);
  }
  return { catalog, failures, profiles };
}

function findProfile(profileId) {
  const match = readProfiles().find((item) => item.profile.id === profileId);
  return match ?? null;
}

function printHelp() {
  console.log("Pacific-Rim robot profile commands");
  console.log("");
  console.log("Usage:");
  console.log("  ./pr robot:profiles [--json]");
  console.log("  ./pr robot:show <profile-id> [--json]");
  console.log("  ./pr robot:check");
  console.log("  ./pr robot:deploy <profile-id> [--dry-run] [ros2 deploy args...]");
  console.log("");
  console.log("Examples:");
  console.log("  ./pr robot:profiles");
  console.log("  ./pr robot:show pure-driver-sample");
  console.log("  ./pr robot:deploy pure-driver-sample --dry-run --host 192.168.1.20");
}

function printList(args) {
  const json = args.includes("--json");
  const { failures, profiles } = validateProfiles();
  if (json) {
    console.log(JSON.stringify(profiles.map(({ profile }) => displayProfile(profile)), null, 2));
    return failures.length === 0 ? 0 : 1;
  }
  for (const { profile } of profiles) {
    const item = displayProfile(profile);
    console.log(`${item.id.padEnd(24)} ${item.status.padEnd(8)} ${item.robotClass.padEnd(12)} services=${item.serviceCount} planned=${item.plannedServiceCount} capabilities=${item.capabilityCount}`);
  }
  if (failures.length > 0) {
    console.error("");
    for (const failure of failures) {
      console.error(failure);
    }
    return 1;
  }
  return 0;
}

function printShow(args) {
  const profileId = args.find((arg) => !arg.startsWith("-"));
  const json = args.includes("--json");
  if (!profileId) {
    console.error("Usage: ./pr robot:show <profile-id> [--json]");
    return 1;
  }
  const match = findProfile(profileId);
  if (!match) {
    console.error(`Robot profile not found: ${profileId}`);
    return 1;
  }
  if (json) {
    console.log(JSON.stringify(match.profile, null, 2));
    return 0;
  }
  const profile = match.profile;
  console.log(`${profile.displayName ?? profile.id} (${profile.id})`);
  console.log(`status: ${profile.status}`);
  console.log(`robotClass: ${profile.robotClass ?? "unknown"}`);
  console.log(`summary: ${profile.summary ?? ""}`);
  console.log(`capabilities: ${asArray(profile.capabilities).join(", ") || "none"}`);
  console.log("");
  console.log("services:");
  for (const serviceEntry of asArray(profile.services)) {
    const required = serviceEntry.required === false ? "optional" : "required";
    console.log(`- ${serviceEntry.service} (${packageFromService(serviceEntry) || "no-package"}, ${required}) -> ${asArray(serviceEntry.capabilities).join(", ")}`);
  }
  const planned = asArray(profile.plannedServices);
  if (planned.length > 0) {
    console.log("");
    console.log("plannedServices:");
    for (const serviceEntry of planned) {
      console.log(`- ${serviceEntry.service} -> ${asArray(serviceEntry.capabilities).join(", ")}`);
    }
  }
  return 0;
}

function printCheck() {
  const { catalog, failures, profiles } = validateProfiles();
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    return 1;
  }
  const activeCount = profiles.filter(({ profile }) => profile.status === "active").length;
  const templateCount = profiles.filter(({ profile }) => profile.status === "template").length;
  console.log(`Robot profiles passed: ${profiles.length} profiles, ${catalog.capabilities.length} capabilities, ${activeCount} active, ${templateCount} templates.`);
  return 0;
}

function hasFlag(args, flag) {
  return args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`));
}

function parseDeployArgs(args) {
  const forwarded = [];
  let profileId = "";
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!profileId && !arg.startsWith("-")) {
      profileId = arg;
      continue;
    }
    forwarded.push(arg);
  }
  return { dryRun, forwarded, profileId };
}

function deployProfile(args) {
  const { dryRun, forwarded, profileId } = parseDeployArgs(args);
  if (!profileId) {
    console.error("Usage: ./pr robot:deploy <profile-id> [--dry-run] [ros2 deploy args...]");
    return 1;
  }
  const match = findProfile(profileId);
  if (!match) {
    console.error(`Robot profile not found: ${profileId}`);
    return 1;
  }
  const { failures } = validateProfiles();
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    return 1;
  }
  const profile = match.profile;
  if (profile.status !== "active") {
    console.error(`Robot profile ${profile.id} is ${profile.status}; only active profiles can deploy.`);
    return 1;
  }
  const packages = unique(
    asArray(profile.services)
      .filter((serviceEntry) => serviceEntry.required !== false)
      .map((serviceEntry) => packageFromService(serviceEntry))
      .filter(Boolean)
  );
  if (packages.length === 0) {
    console.error(`Robot profile ${profile.id} does not resolve any deployable ROS2 packages.`);
    return 1;
  }
  const ros2Args = ["ros2:deploy", "--packages-select", ...packages, ...forwarded];
  if (!hasFlag(ros2Args, "--domain-id") && profile.deploy?.defaultDomainId !== undefined) {
    ros2Args.push("--domain-id", String(profile.deploy.defaultDomainId));
  }
  if (dryRun) {
    console.log(`./pr ${ros2Args.join(" ")}`);
    return 0;
  }
  const result = spawnSync(process.execPath, ["bin/pr.mjs", ...ros2Args], {
    cwd: rootDir,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Failed to run ./pr: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) {
    printHelp();
    return 0;
  }
  if (["list", "profiles"].includes(command)) {
    return printList(args);
  }
  if (command === "show") {
    return printShow(args);
  }
  if (command === "check") {
    return printCheck();
  }
  if (command === "deploy") {
    return deployProfile(args);
  }
  console.error(`Unknown robot profile command: ${command}`);
  printHelp();
  return 1;
}

process.exitCode = main();
