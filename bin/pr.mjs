#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { cpus, freemem, hostname, loadavg, networkInterfaces, release, totalmem, type as osType } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function findUpPackageJson(startDir) {
  let dir = resolve(startDir);

  while (true) {
    const candidate = resolve(dir, "package.json");
    if (existsSync(candidate)) {
      return { packagePath: candidate, rootDir: dir };
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function resolveRoot() {
  const candidates = [
    process.cwd(),
    dirname(process.execPath),
    process.argv[1] ? dirname(resolve(process.argv[1])) : "",
  ];

  try {
    candidates.push(dirname(dirname(fileURLToPath(import.meta.url))));
  } catch {
    // Bun compiled executables use an embedded import.meta.url; ignore it.
  }

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const match = findUpPackageJson(candidate);
    if (match) {
      return match;
    }
  }

  return {
    packagePath: resolve(process.cwd(), "package.json"),
    rootDir: process.cwd(),
  };
}

const { packagePath, rootDir } = resolveRoot();
const dashboardDir = join(rootDir, "dashboard");
const dashboardPostgresImage = "postgres:17-alpine";
const dashboardPostgresImageArchive = join(rootDir, "image", "postgres-17-alpine.tar");
const args = process.argv.slice(2);
const prCommandLine = `./pr${args.length > 0 ? ` ${redactCommandArgs(args).join(" ")}` : ""}`;
let finalStatusPrinted = false;

function redactCommandArgs(commandArgs) {
  const redacted = [];
  const secretFlags = new Set(["--password", "--token", "--secret", "--api-key", "--apikey", "--key"]);

  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index];
    const lowerArg = arg.toLowerCase();

    if (secretFlags.has(lowerArg)) {
      redacted.push(arg);
      if (index + 1 < commandArgs.length) {
        redacted.push("<redacted>");
        index += 1;
      }
      continue;
    }

    if (/^--(password|token|secret|api-key|apikey|key)=/i.test(arg)) {
      const [flag] = arg.split("=", 1);
      redacted.push(`${flag}=<redacted>`);
      continue;
    }

    redacted.push(arg);
  }

  return redacted;
}

function finalStatusMessage(code, reason = "") {
  const ok = code === 0;
  const statusText = ok ? "SUCCESS" : "FAILED";
  const detail = reason || (ok ? "completed" : `exit code ${code}`);
  return `[PR ${statusText}] ${prCommandLine} ${detail}`;
}

function printFinalStatus(code, reason = "") {
  if (finalStatusPrinted) {
    return;
  }
  finalStatusPrinted = true;

  const line = finalStatusMessage(code, reason);
  if (code === 0) {
    console.log(line);
  } else {
    console.error(line);
  }
}

function exitCodeForSignal(signal) {
  const signals = {
    SIGHUP: 129,
    SIGINT: 130,
    SIGTERM: 143,
  };
  return signals[signal] ?? 1;
}

process.on("exit", (code) => {
  printFinalStatus(code ?? 0);
});

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    const code = exitCodeForSignal(signal);
    printFinalStatus(code, `terminated by ${signal}`);
    process.exit(code);
  });
}

function readPackageJson() {
  if (!existsSync(packagePath)) {
    console.error(`package.json not found in ${rootDir}`);
    process.exit(1);
  }

  return JSON.parse(readFileSync(packagePath, "utf8"));
}

const packageJson = readPackageJson();
const scripts = packageJson.scripts ?? {};
const ignoredProjectDirs = new Set([
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
const allowedProjectRoots = ["arch", "bin", "dashboard", "deploy", "doc", "example", "module", "infra", "pkg", "monitor"];
const allowedProjectTypes = new Set(["application", "deployment", "documentation", "library", "tool"]);
const allowedScopes = new Set(["scope:app", "scope:deploy", "scope:doc", "scope:module", "scope:infra", "scope:pkg", "scope:tools"]);
const supportedRos2Distros = new Set(["humble", "jazzy", "kilted", "lyrical", "rolling"]);

function executable(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function hasCommand(command) {
  const result = spawnSync(executable(command), ["--version"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "ignore",
  });

  return result.error === undefined;
}

function requireCommand(command, purpose) {
  if (hasCommand(command)) {
    return;
  }

  console.error(`${command} is required${purpose ? ` to ${purpose}` : ""}, but it was not found on PATH.`);
  process.exit(127);
}

function commandEnv(command) {
  if (command !== "go" || process.env.GOCACHE) {
    return process.env;
  }

  return {
    ...process.env,
    GOCACHE: join(rootDir, ".cache", "go-build"),
  };
}

function run(command, commandArgs) {
  const result = spawnSync(executable(command), commandArgs, {
    cwd: rootDir,
    env: commandEnv(command),
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`Failed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  }

  process.exit(result.status ?? 1);
}

function runShell(command, commandArgs, options = {}) {
  const env = options.env ? { ...commandEnv(command), ...options.env } : commandEnv(command);
  const result = spawnSync(executable(command), commandArgs, {
    cwd: options.cwd ?? rootDir,
    env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`Failed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  }

  return result.status ?? 1;
}

function runShellCaptured(command, commandArgs, options = {}) {
  const result = spawnSync(executable(command), commandArgs, {
    cwd: options.cwd ?? rootDir,
    env: commandEnv(command),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
  });

  return {
    error: result.error,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    signal: result.signal,
    status: result.status ?? 1,
  };
}

function runScript(scriptName, scriptArgs) {
  requireCommand("npm", `run npm script "${scriptName}"`);

  const npmArgs = ["run", scriptName];
  if (scriptArgs.length > 0) {
    npmArgs.push("--", ...scriptArgs);
  }

  run("npm", npmArgs);
}

function printScripts() {
  for (const name of Object.keys(scripts).sort()) {
    console.log(`  ${name}`);
  }
}

function printHelp() {
  console.log(`${packageJson.name ?? "project"} command wrapper`);
  console.log("");
  console.log("Usage:");
  console.log("  ./pr <npm-script> [args...]");
  console.log("  ./pr run <npm-script> [args...]");
  console.log("  ./pr scripts");
  console.log("  ./pr doctor");
  console.log("  ./pr clean [--dry-run] [--no-docker] [--docker-builder]");
  console.log("  ./pr check [env|diag]");
  console.log("  ./pr check:comm");
  console.log("  ./pr dashboard [--daemon] [--no-open] [-- extra Next.js args]");
  console.log("  ./pr dashboard:db:<start|push|stop|down|watch|studio|generate|migrate|save-image> [args...]");
  console.log("  ./pr gen:interfaces --service <service_name> [--dry-run]");
  console.log("  ./pr data-format --service <service_name> --kind <proto|msg|srv|dds_idl> --name <Type> (--file <path>|--data <text>|--stdin)");
  console.log("  ./pr robot:profiles [--json]");
  console.log("  ./pr robot:show <profile-id> [--json]");
  console.log("  ./pr robot:check");
  console.log("  ./pr robot:deploy <profile-id> [--dry-run] [ros2 deploy args...]");
  console.log("  ./pr projects");
  console.log("  ./pr monitor [args...]");
  console.log("  ./pr test:go");
  console.log("  ./pr npm <args...>");
  console.log("  ./pr nx <args...>");
  console.log("  ./pr docker <args...>");
  console.log("");
  console.log("Examples:");
  console.log("  ./pr check");
  console.log("  ./pr check env");
  console.log("  ./pr check diag");
  console.log("  ./pr clean --dry-run");
  console.log("  ./pr check:comm");
  console.log("  ./pr dashboard");
  console.log("  ./pr dashboard --daemon");
  console.log("  ./pr dashboard:db:start");
  console.log("  ./pr dashboard:db:push");
  console.log("  ./pr dashboard:db:save-image");
  console.log("  ./pr gen:interfaces --service smoke_001_service");
  console.log("  ./pr data-format --service smoke_001_service --kind msg --name RobotState --data \"string robot_id\"");
  console.log("  ./pr robot:profiles");
  console.log("  ./pr robot:show pure-driver-sample");
  console.log("  ./pr robot:deploy pure-driver-sample --dry-run --host 192.0.2.20 --domain-id 42");
  console.log("  ./pr check:all");
  console.log("  ./pr test:go");
  console.log("  ./pr monitor -i upperbody");
  console.log("  ./pr monitor list -i upperbody");
  console.log("  ./pr ros2:build --packages-select smoke_test1");
  console.log("  ./pr ros2:deploy-base-image");
  console.log("  ./pr ros2:exec --network host ros2 topic list");
  console.log("  ./pr ros2:deploy --host 192.0.2.20 --packages-select smoke_test1 --domain-id 42");
  console.log("  ./pr create module navigation");
  console.log("");
  console.log("Available npm scripts:");
  printScripts();
}

function failUnknown(command) {
  console.error(`Unknown command or npm script: ${command}`);
  console.error("Run './pr scripts' to list available npm scripts.");
  process.exit(1);
}

function failInterfaceGenerationAlias() {
  console.error("Interface generation has one command form:");
  console.error("  ./pr gen:interfaces --service <service_name>");
  process.exit(1);
}

function firstLine(value) {
  return value.trim().split(/\r?\n/, 1)[0] ?? "";
}

function commandOutput(command, commandArgs) {
  const result = spawnSync(executable(command), commandArgs, {
    cwd: rootDir,
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    return "";
  }

  return firstLine(result.stdout || result.stderr);
}

function status(level, message) {
  console.log(`[${level}] ${message}`);
}

const colorsEnabled = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function paint(value, colorName) {
  if (!colorsEnabled) {
    return value;
  }
  return `${ansi[colorName]}${value}${ansi.reset}`;
}

function doctor() {
  status("OK", `Workspace: ${rootDir}`);
  status("OK", `pr runtime: Bun-compiled executable`);

  const nodeVersion = commandOutput("node", ["--version"]);
  if (nodeVersion) {
    const major = nodeVersion.replace(/^v/, "").split(".", 1)[0];
    status(major === "22" ? "OK" : "WARN", `Node.js: ${nodeVersion}${major === "22" ? "" : " (expected v22)"}`);
  } else {
    status("WARN", "Node.js: not found. Commands backed by npm/node will not run.");
  }

  const npmVersion = commandOutput("npm", ["--version"]);
  status(npmVersion ? "OK" : "WARN", npmVersion ? `npm: ${npmVersion}` : "npm: not found. npm script commands will not run.");

  const goVersion = commandOutput("go", ["version"]);
  status(goVersion ? "OK" : "WARN", goVersion || "Go: not found. ./pr test:go will not run.");

  const dockerVersion = commandOutput("docker", ["--version"]);
  if (!dockerVersion) {
    status("WARN", "Docker: not found. ROS2 and observability commands need Docker.");
    return;
  }

  status("OK", dockerVersion);

  const dockerInfo = spawnSync(executable("docker"), ["info"], {
    cwd: rootDir,
    stdio: "ignore",
  });
  status(dockerInfo.status === 0 ? "OK" : "WARN", dockerInfo.status === 0 ? "Docker daemon: running" : "Docker daemon: not reachable");

  const composeVersion = commandOutput("docker", ["compose", "version"]);
  status(composeVersion ? "OK" : "WARN", composeVersion || "Docker Compose v2: not found");
}

function printCleanHelp() {
  console.log("Usage:");
  console.log("  ./pr clean [--dry-run] [--no-docker] [--docker-builder]");
  console.log("");
  console.log("Cleans generated workspace caches and Pacific-Rim Docker images.");
  console.log("");
  console.log("Options:");
  console.log("  --dry-run          Print what would be removed without deleting anything.");
  console.log("  --no-docker        Skip Docker image cleanup.");
  console.log("  --docker-builder   Also run docker builder prune -f. This affects the Docker daemon, not only this repo.");
}

function runClean(commandArgs) {
  let dryRun = false;
  let cleanDocker = true;
  let cleanDockerBuilder = false;

  for (const arg of commandArgs) {
    if (arg === "--dry-run" || arg === "-n") {
      dryRun = true;
    } else if (arg === "--no-docker") {
      cleanDocker = false;
    } else if (arg === "--docker-builder") {
      cleanDockerBuilder = true;
    } else if (arg === "--help" || arg === "-h") {
      printCleanHelp();
      return;
    } else {
      console.error(`Unknown clean option: ${arg}`);
      printCleanHelp();
      process.exit(1);
    }
  }

  const paths = cleanWorkspacePaths();
  let removedBytes = 0;
  let removedPaths = 0;

  for (const path of paths) {
    const result = removeCleanPath(path, dryRun);
    if (result.removed) {
      removedBytes += result.bytes;
      removedPaths += 1;
    }
  }

  if (removedPaths === 0) {
    console.log("Workspace cache: nothing to clean.");
  } else {
    console.log(`${dryRun ? "Would remove" : "Removed"} ${removedPaths} workspace cache path${removedPaths === 1 ? "" : "s"} (${formatBytesLocal(removedBytes)}).`);
  }

  if (cleanDocker) {
    cleanProjectDockerImages(dryRun);
  }

  if (cleanDockerBuilder) {
    cleanDockerBuilderCache(dryRun);
  }
}

function cleanWorkspacePaths() {
  const candidates = [
    ".cache",
    ".nx/cache",
    ".nx/workspace-data",
    "build",
    "install",
    "log",
    "coverage",
    "dist",
    "out",
    "target",
    "test-results",
    "dashboard/.turbo",
    "dashboard/apps/web/.next",
    "dashboard/apps/web/.turbo",
    "dashboard/apps/tui/.turbo",
    "dashboard/packages/api/dist",
    "dashboard/packages/db/dist",
    "dashboard/packages/ui/.turbo",
    "dashboard/packages/ui/dist",
    "infra/log/dist",
    "infra/metric/dist",
    "infra/otel/dist",
    "infra/trace/dist",
    "monitor/pr-monitor/dist",
  ];

  return [...new Set(candidates)]
    .map((candidate) => resolveCleanPath(candidate))
    .filter((candidate) => candidate && existsSync(candidate));
}

function resolveCleanPath(relativePath) {
  const path = resolve(rootDir, relativePath);
  const pathRelativeToRoot = relative(rootDir, path);
  if (!pathRelativeToRoot || pathRelativeToRoot.startsWith("..") || pathRelativeToRoot.includes(`..${sep}`)) {
    console.error(`Refusing to clean path outside workspace: ${relativePath}`);
    process.exit(1);
  }
  return path;
}

function removeCleanPath(path, dryRun) {
  if (!existsSync(path)) {
    return { removed: false, bytes: 0 };
  }

  const label = relative(rootDir, path) || ".";
  const bytes = pathSize(path);
  console.log(`${dryRun ? "Would remove" : "Removing"} ${label}${bytes > 0 ? ` (${formatBytesLocal(bytes)})` : ""}`);
  if (!dryRun) {
    rmSync(path, { recursive: true, force: true });
  }
  return { removed: true, bytes };
}

function pathSize(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) {
      return stat.size;
    }

    let total = stat.size;
    for (const entry of readdirSync(path)) {
      total += pathSize(join(path, entry));
    }
    return total;
  } catch {
    return 0;
  }
}

function cleanProjectDockerImages(dryRun) {
  if (!hasCommand("docker")) {
    status("INFO", "Docker: not found; skipping project image cleanup.");
    return;
  }

  const info = commandResult("docker", ["info"], { timeout: 3000 });
  if (!info.ok) {
    status("WARN", `Docker daemon: not reachable; skipping project image cleanup (${info.errorMessage}).`);
    return;
  }

  const images = commandResult("docker", ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"], {
    timeout: 10000,
    maxBuffer: 1024 * 1024 * 4,
  });
  if (!images.ok) {
    status("WARN", `Docker images: unable to list project images (${images.errorMessage}).`);
    return;
  }

  const refs = [...new Set(images.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^pacific-rim-ros2(?:-.+)?:[^:<>\s]+$/.test(line))
    .filter((line) => !line.endsWith(":<none>")))];

  if (refs.length === 0) {
    console.log("Docker project images: nothing to clean.");
    return;
  }

  console.log(`${dryRun ? "Would remove" : "Removing"} Docker project image${refs.length === 1 ? "" : "s"}: ${refs.join(", ")}`);
  if (dryRun) {
    return;
  }

  const result = runShell("docker", ["image", "rm", "-f", ...refs]);
  if (result !== 0) {
    process.exit(result);
  }
}

function cleanDockerBuilderCache(dryRun) {
  if (!hasCommand("docker")) {
    status("INFO", "Docker: not found; skipping builder cache cleanup.");
    return;
  }

  const info = commandResult("docker", ["info"], { timeout: 3000 });
  if (!info.ok) {
    status("WARN", `Docker daemon: not reachable; skipping builder cache cleanup (${info.errorMessage}).`);
    return;
  }

  console.log(`${dryRun ? "Would run" : "Running"} docker builder prune -f`);
  if (dryRun) {
    return;
  }

  const result = runShell("docker", ["builder", "prune", "-f"]);
  if (result !== 0) {
    process.exit(result);
  }
}

function runCheckCommand(commandArgs) {
  const [subcommand, ...rest] = commandArgs;
  if (!subcommand) {
    runCheck();
    return;
  }

  if (["env", "environment"].includes(subcommand)) {
    if (rest.length > 0) {
      console.error("Usage: ./pr check env");
      process.exit(1);
    }
    printEnvironmentCheck();
    return;
  }

  if (["diag", "diagnose", "diagnostics", "doctor"].includes(subcommand)) {
    if (rest.length > 0) {
      console.error("Usage: ./pr check diag");
      process.exit(1);
    }
    printDiagnostics();
    return;
  }

  console.error(`Unknown check subcommand: ${subcommand}`);
  console.error("Usage: ./pr check [env|diag]");
  process.exit(1);
}

function printEnvironmentCheck() {
  const entries = [
    {
      name: "VLINK_PROTO_DIR",
      aliases: ["PACIFIC_RIM_PROTO_DIR"],
      description: "Specifies the directory path where protocol buffer (.proto) files are stored.",
    },
    {
      name: "VLINK_FBS_DIR",
      aliases: ["PACIFIC_RIM_FBS_DIR"],
      description: "Specifies the directory path where flatbuffers (.fbs) files are stored.",
    },
    {
      name: "VLINK_SCHEMA_PLUGIN",
      description: "Specifies the schema plugin used for protobuf/flatbuffers schema loading.",
    },
    {
      name: "VLINK_TMP_DIR",
      description: "Specifies the temporary directory folder.",
    },
    {
      name: "VLINK_LOCK_DIR",
      description: "Specifies the lock directory folder.",
    },
    {
      name: "VLINK_LOG_LEVEL",
      description: "Sets log level (TRACE(0), DEBUG(1), INFO(2), WARN(3), ERROR(4), FATAL(5)).",
    },
    {
      name: "VLINK_LOG_CONSOLE_LEVEL",
      description: "Defines the log level for console output.",
    },
    {
      name: "VLINK_LOG_FILE_LEVEL",
      description: "Specifies the log level for file output.",
    },
    {
      name: "VLINK_LOG_CONSOLE_UNORDER",
      description: "Enable non-synchronized console output for better performance.",
    },
    {
      name: "VLINK_LOG_CONSOLE_FMT",
      description: "Set the console to output in a specific format.",
    },
    {
      name: "VLINK_LOG_FILE_FMT",
      description: "Set the file to output in a specific format.",
    },
    {
      name: "ROS_DOMAIN_ID",
      description: "Sets the ROS2 domain id used by local discovery.",
    },
    {
      name: "ROS_DISTRO",
      description: "Selects the ROS2 distribution for local or container workflows.",
    },
    {
      name: "PR_MONITOR_PROMETHEUS_URL",
      aliases: ["PROMETHEUS_URL"],
      description: "Sets the Prometheus endpoint used by pr-monitor metrics collection.",
    },
  ];

  console.log(paint("$ ./pr check env", "bold"));
  console.log("");
  for (const entry of entries) {
    const resolved = resolveEnvEntry(entry);
    const label = `[${entry.name}]`;
    const suffix = resolved.value ? `: ${resolved.value}${resolved.source !== entry.name ? ` (${resolved.source})` : ""}` : "";
    console.log(`${paint(`${label}${suffix}`, resolved.value ? "green" : "red")}`);
    console.log(entry.description);
    console.log("");
  }
}

function resolveEnvEntry(entry) {
  const names = [entry.name, ...(entry.aliases ?? [])];
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return { source: name, value };
    }
  }
  return { source: entry.name, value: "" };
}

function printDiagnostics() {
  console.log(paint("$ ./pr check diag", "bold"));
  console.log("");
  printHostDiagnostics();
  printNetworkDiagnostics();
  printResourceDiagnostics();
  printToolDiagnostics();
  printRuntimeProcessDiagnostics();
}

function printHostDiagnostics() {
  status("OK", `Host: ${hostname()}`);
  status("OK", `OS: ${osType()} ${release()}`);
}

function printNetworkDiagnostics() {
  const ips = localIpAddresses();
  if (ips.length > 0) {
    status("OK", `IP: ${ips.map((item) => `${item.address} (${item.name})`).join(", ")}`);
  } else {
    status("WARN", "IP: no non-internal IPv4 address found");
  }

  const memberships = multicastMemberships();
  const multicastGroups = [
    ["DDS discovery", "239.255.0.1"],
    ["mDNS discovery", "224.0.0.251"],
    ["IPv6 link-local", "ff02::"],
  ];
  if (!memberships.ok && !memberships.stdout) {
    status("WARN", `Multicast: unable to inspect group membership (${memberships.errorMessage})`);
    for (const [name, address] of multicastGroups) {
      status("INFO", `${name}: ${address}`);
    }
    return;
  }

  const groupText = memberships.stdout.toLowerCase();
  for (const [name, address] of multicastGroups) {
    const matched = groupText.includes(address.toLowerCase());
    status(matched ? "OK" : "INFO", `${name}: ${address}${matched ? " joined" : " expected group"}`);
  }
}

function multicastMemberships() {
  const attempts = [
    ["-g", "-f", "inet"],
    ["-g", "-f", "inet6"],
    ["-g"],
  ];
  let stdout = "";
  let errorMessage = "";
  for (const args of attempts) {
    const result = commandResult("netstat", args, { timeout: 1500 });
    if (result.stdout) {
      stdout += `${result.stdout}\n`;
    }
    if (result.ok) {
      return { ok: true, stdout, errorMessage: "" };
    }
    errorMessage ||= result.errorMessage;
  }
  return { ok: false, stdout, errorMessage };
}

function printResourceDiagnostics() {
  const disk = diskUsage(rootDir);
  if (disk) {
    const freeLevel = disk.availableBytes >= 10 * 1024 ** 3 ? "OK" : "WARN";
    status(freeLevel, `Disk: ${formatBytesLocal(disk.availableBytes)} free at ${disk.mount || rootDir} (${disk.capacity || "unknown"} used)`);
  } else {
    status("WARN", `Disk: unable to inspect ${rootDir}`);
  }

  const cpuCount = cpus().length;
  const [one, five, fifteen] = loadavg();
  const loadLevel = one <= Math.max(1, cpuCount) ? "OK" : "WARN";
  status(loadLevel, `CPU: ${cpuCount} cores, load ${one.toFixed(2)} / ${five.toFixed(2)} / ${fifteen.toFixed(2)}`);

  const memoryTotal = totalmem();
  const memoryFree = freemem();
  const memoryLevel = memoryFree / Math.max(1, memoryTotal) >= 0.1 ? "OK" : "WARN";
  status(memoryLevel, `Memory: ${formatBytesLocal(memoryFree)} free / ${formatBytesLocal(memoryTotal)} total`);
}

function printToolDiagnostics() {
  for (const commandName of ["bun", "node", "npm", "go", "docker", "ros2", "nats-server"]) {
    const version = versionLine(commandName);
    status(version ? "OK" : "WARN", version ? `${commandName}: ${version}` : `${commandName}: not found on PATH`);
  }

  const dockerInfo = commandResult("docker", ["info"], { timeout: 3000 });
  if (versionLine("docker")) {
    status(dockerInfo.ok ? "OK" : "WARN", dockerInfo.ok ? "Docker daemon: running" : `Docker daemon: not reachable (${dockerInfo.errorMessage})`);
  }

  const natsListen = commandResult("lsof", ["-nP", "-iTCP:4222", "-sTCP:LISTEN"], { timeout: 2500 });
  const hasNatsListener = natsListen.ok && natsListen.stdout.trim().split(/\r?\n/).length > 1;
  status(hasNatsListener ? "OK" : "INFO", hasNatsListener ? "NATS: listener found on tcp/4222" : "NATS: no local listener found on tcp/4222");
}

function printRuntimeProcessDiagnostics() {
  const result = commandResult("ps", ["-axo", "pid=,pcpu=,pmem=,comm=,args="], { timeout: 2500, maxBuffer: 1024 * 1024 * 8 });
  if (!result.ok && !result.stdout) {
    status("WARN", `Processes: unable to inspect process table (${result.errorMessage})`);
    return;
  }

  const projectTokens = runtimeProjectTokens();
  const rows = parseProcessDiagnostics(result.stdout)
    .filter((row) => isRelevantRuntimeProcess(row, projectTokens))
    .sort((left, right) => right.cpu - left.cpu)
    .slice(0, 12);

  if (rows.length === 0) {
    status("WARN", "Processes: no matching VLink/Pacific-Rim runtime process found");
    return;
  }

  status("OK", `Processes: ${rows.length} matching runtime process${rows.length === 1 ? "" : "es"}`);
  for (const row of rows) {
    const label = `${row.pid}`.padStart(6, " ");
    const usage = `cpu=${row.cpu.toFixed(1)}% mem=${row.mem.toFixed(1)}%`;
    console.log(`  ${label}  ${usage}  ${shortenProcess(row.args || row.command)}`);
  }
}

function commandResult(command, commandArgs, options = {}) {
  const result = spawnSync(executable(command), commandArgs, {
    cwd: options.cwd ?? rootDir,
    encoding: "utf8",
    timeout: options.timeout ?? 2500,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const errorMessage = result.error?.message || firstLine(stderr) || `exit ${result.status ?? "unknown"}`;
  return {
    ok: result.error === undefined && result.status === 0,
    stdout,
    stderr,
    status: result.status,
    errorMessage,
  };
}

function versionLine(commandName) {
  const candidatesByCommand = {
    bun: [["--version"]],
    node: [["--version"]],
    npm: [["--version"]],
    go: [["version"]],
    docker: [["--version"]],
    ros2: [["--help"]],
    "nats-server": [["--version"], ["-v"]],
  };
  const candidates = candidatesByCommand[commandName] ?? [["--version"], ["version"]];
  for (const args of candidates) {
    const result = commandResult(commandName, args, { timeout: 2500 });
    if (result.ok) {
      return firstLine(result.stdout || result.stderr) || "available";
    }
  }
  return "";
}

function localIpAddresses() {
  const addresses = [];
  for (const [name, values] of Object.entries(networkInterfaces())) {
    for (const value of values ?? []) {
      if (value.internal || value.family !== "IPv4") {
        continue;
      }
      addresses.push({ name, address: value.address });
    }
  }
  return addresses;
}

function diskUsage(path) {
  const result = commandResult("df", ["-k", path], { timeout: 2500 });
  if (!result.ok || !result.stdout) {
    return null;
  }
  const line = result.stdout.trim().split(/\r?\n/)[1];
  if (!line) {
    return null;
  }
  const columns = line.trim().split(/\s+/);
  const availableKib = Number.parseInt(columns[3] ?? "", 10);
  if (!Number.isFinite(availableKib)) {
    return null;
  }
  return {
    availableBytes: availableKib * 1024,
    capacity: columns[4] ?? "",
    mount: columns[columns.length - 1] ?? "",
  };
}

function formatBytesLocal(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function runtimeProjectTokens() {
  try {
    return loadProjects()
      .filter((project) => project.root?.startsWith("module/"))
      .flatMap((project) => [project.name, project.root.split("/").at(-1) ?? ""])
      .filter(Boolean)
      .map((token) => token.toLowerCase());
  } catch {
    return [];
  }
}

function parseProcessDiagnostics(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s*(.*)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number.parseInt(match[1], 10),
        cpu: Number.parseFloat(match[2]),
        mem: Number.parseFloat(match[3]),
        command: match[4],
        args: match[5] || match[4],
      };
    })
    .filter((row) => row && Number.isFinite(row.pid) && Number.isFinite(row.cpu) && Number.isFinite(row.mem));
}

function isRelevantRuntimeProcess(row, projectTokens) {
  const haystack = `${row.command} ${row.args}`.toLowerCase();
  if (haystack.includes(rootDir.toLowerCase())) {
    return true;
  }
  if (/(vlink|pacific[-_ ]rim|pr-monitor|ros2|nats|smoke_001|middleware_)/i.test(haystack)) {
    return true;
  }
  return projectTokens.some((token) => token.length >= 4 && haystack.includes(token));
}

function shortenProcess(value) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 140 ? `${compact.slice(0, 137)}...` : compact;
}

function pathExists(path) {
  return existsSync(path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findProjectFiles(dir = rootDir) {
  const relativeDir = relative(rootDir, dir);
  if (relativeDir === join("bin", "templates") || relativeDir.startsWith(`${join("bin", "templates")}/`)) {
    return [];
  }

  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isFile() && entry.name === "project.json") {
      files.push(path);
      continue;
    }

    if (entry.isDirectory() && !ignoredProjectDirs.has(entry.name)) {
      files.push(...findProjectFiles(path));
    }
  }

  return files.sort();
}

function loadProjects() {
  return findProjectFiles()
    .map((file) => ({
      ...readJson(file),
      file,
      fileRoot: relative(rootDir, dirname(file)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function readPackageXmlName(moduleRoot) {
  const packageXmlPath = join(moduleRoot, "package.xml");
  if (!existsSync(packageXmlPath)) {
    return "";
  }

  const packageXml = readFileSync(packageXmlPath, "utf8");
  return packageXml.match(/<name>\s*([^<\s]+)\s*<\/name>/)?.[1] ?? "";
}

function ros2DistroFromProject(project) {
  if (typeof project.ros2?.distro === "string" && supportedRos2Distros.has(project.ros2.distro)) {
    return project.ros2.distro;
  }

  const distroTag = project.tags?.find((tag) => tag.startsWith("ros2:"));
  if (!distroTag) {
    return "";
  }

  const distro = distroTag.slice("ros2:".length);
  return supportedRos2Distros.has(distro) ? distro : "";
}

function ros2PackageFromProject(project) {
  if (typeof project.ros2?.package === "string" && project.ros2.package.trim()) {
    return project.ros2.package.trim();
  }

  return readPackageXmlName(join(rootDir, project.root));
}

function ros2EnvFromProject(project) {
  const distro = ros2DistroFromProject(project);
  const env = {};
  if (distro) {
    env.ROS_DISTRO = distro;
  }

  if (project.ros2?.env && typeof project.ros2.env === "object" && !Array.isArray(project.ros2.env)) {
    for (const [key, value] of Object.entries(project.ros2.env)) {
      if (value !== undefined && value !== null && `${value}` !== "") {
        env[key] = `${value}`;
      }
    }
  }

  return env;
}

function ros2EnvSignature(env) {
  return Object.keys(env)
    .sort()
    .map((key) => `${key}=${env[key]}`)
    .join("\n");
}

function findRos2ProjectByPackage(packageName) {
  if (!packageName) {
    return null;
  }

  for (const project of loadProjects()) {
    if (!project.tags?.includes("framework:ros2")) {
      continue;
    }

    if (ros2PackageFromProject(project) === packageName || readPackageXmlName(join(rootDir, project.root)) === packageName) {
      return project;
    }
  }

  return null;
}

function ros2PackagesFromArgs(commandArgs) {
  const packages = [];
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index];
    if (arg === "--package") {
      if (commandArgs[index + 1]) {
        packages.push(commandArgs[index + 1]);
      }
      index += 1;
      continue;
    }
    if (arg === "--packages-select" || arg === "--packages-up-to") {
      for (let packageIndex = index + 1; packageIndex < commandArgs.length; packageIndex += 1) {
        const value = commandArgs[packageIndex];
        if (!value || value.startsWith("-")) {
          break;
        }
        packages.push(value);
        index = packageIndex;
      }
      continue;
    }
    if (arg.startsWith("--packages-select=")) {
      packages.push(arg.slice("--packages-select=".length));
      continue;
    }
    if (arg.startsWith("--packages-up-to=")) {
      packages.push(arg.slice("--packages-up-to=".length));
      continue;
    }
    if (arg.startsWith("--package=")) {
      packages.push(arg.slice("--package=".length));
    }
  }

  return packages;
}

function hasTag(project, tag) {
  return Array.isArray(project.tags) && project.tags.includes(tag);
}

function hasNonEmptyReadme(projectRoot) {
  const readmePath = join(rootDir, projectRoot, "README.md");
  return pathExists(readmePath) && readFileSync(readmePath, "utf8").trim().length > 0;
}

function checkProject(project, projects) {
  const failures = [];

  if (!pathExists(join(rootDir, project.root))) {
    failures.push(`Missing project root: ${project.root}`);
  }

  if (!hasNonEmptyReadme(project.root)) {
    failures.push(`Missing or empty README: ${project.root}/README.md`);
  }

  for (const dependency of project.implicitDependencies ?? []) {
    if (!projects.some((item) => item.name === dependency)) {
      failures.push(`Unknown dependency "${dependency}" in ${project.name}`);
    }
  }

  if (project.tags?.includes("framework:ros2")) {
    const projectRoot = join(rootDir, project.root);
    const distroTag = project.tags.find((tag) => tag.startsWith("ros2:"));

    if (!distroTag) {
      failures.push(`${project.name} must declare a ros2:<distro> tag.`);
    } else {
      const distro = distroTag.slice("ros2:".length);
      if (!supportedRos2Distros.has(distro)) {
        failures.push(`${project.name} has unsupported ROS2 distro tag: ${distroTag}`);
      }
    }

    if (!pathExists(join(projectRoot, "package.xml"))) {
      failures.push(`Missing ROS2 package manifest: ${project.root}/package.xml`);
    } else {
      failures.push(...checkRos2Config(project, projectRoot, distroTag));
    }

    if (project.tags.includes("language:python") && !pathExists(join(projectRoot, "setup.py"))) {
      failures.push(`Missing ROS2 Python setup file: ${project.root}/setup.py`);
    }

    if (project.tags.includes("language:cpp")) {
      const cmakePath = join(projectRoot, "CMakeLists.txt");
      if (!pathExists(cmakePath)) {
        failures.push(`Missing ROS2 C++ build file: ${project.root}/CMakeLists.txt`);
      } else {
        failures.push(...checkCmakeExecutables(project, cmakePath));
      }
    }
  }

  return failures;
}

function checkRos2Config(project, projectRoot, distroTag) {
  const failures = [];
  const packageName = readPackageXmlName(projectRoot);
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

function checkCmakeExecutables(project, cmakePath) {
  const failures = [];
  const cmake = readFileSync(cmakePath, "utf8");
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
      if (!pathExists(join(rootDir, project.root, token))) {
        failures.push(`Missing ROS2 C++ executable source: ${project.root}/${token}`);
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

    if (!allowedProjectRoots.some((allowedRoot) => project.root === allowedRoot || project.root.startsWith(`${allowedRoot}/`))) {
      failures.push(`${project.name} root is outside allowed monorepo roots: ${project.root}`);
    }

    if (!allowedProjectTypes.has(project.projectType)) {
      failures.push(`${project.name} has unsupported projectType: ${project.projectType}`);
    }

    if (!Array.isArray(project.tags) || project.tags.length === 0) {
      failures.push(`${project.name} must declare tags.`);
    } else if (!project.tags.some((tag) => allowedScopes.has(tag))) {
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

      if (hasTag(project, "scope:infra") && !hasTag(dependency, "scope:infra")) {
        if (!hasTag(dependency, "scope:pkg")) {
          failures.push(`${project.name} is shared infra code and may only depend on scope:infra or scope:pkg projects.`);
        }
      }

      if (hasTag(project, "scope:pkg") && !hasTag(dependency, "scope:pkg")) {
        failures.push(`${project.name} is pure shared package code and may only depend on scope:pkg projects.`);
      }

      if (hasTag(project, "scope:module") && hasTag(dependency, "scope:module") && !isConfiguredMiddlewareModuleDependency(project)) {
        failures.push(`${project.name} must not depend directly on another scope:module project.`);
      }

      if (hasTag(project, "scope:tools") && !hasTag(dependency, "scope:tools")) {
        failures.push(`${project.name} tooling must stay independent of runtime projects.`);
      }
    }
  }

  return failures;
}

function isConfiguredMiddlewareModuleDependency(project) {
  const dependencies = new Set(project.implicitDependencies ?? []);
  return dependencies.has("pkg-idl") &&
    (dependencies.has("infra-communication") || project.tags?.includes("framework:ros2"));
}

function runCheck() {
  const failures = [];

  for (const requiredFile of ["package.json", "nx.json", ".gitignore"]) {
    if (!pathExists(join(rootDir, requiredFile))) {
      failures.push(`Missing required root file: ${requiredFile}`);
    }
  }

  if (packageJson.private !== true) {
    failures.push("package.json must set private=true for this workspace.");
  }

  const gitignorePath = join(rootDir, ".gitignore");
  if (pathExists(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, "utf8");
    for (const ignoredPath of [".cache/", ".nx/cache/", ".nx/workspace-data/"]) {
      if (!gitignore.includes(ignoredPath)) {
        failures.push(`.gitignore must include ${ignoredPath}`);
      }
    }
  }

  const projects = loadProjects();
  failures.push(...checkProjects(projects));
  failures.push(...checkDependencies(projects));

  if (projects.length === 0) {
    failures.push("No project.json files found.");
  }

  for (const project of projects) {
    failures.push(...checkProject(project, projects));
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    process.exit(1);
  }

  printProjectGraph(projects);
  console.log("Monorepo check passed.");
}

function printProjectGraph(projects = loadProjects()) {
  console.log("Project graph:");

  for (const project of projects) {
    const dependencies = project.implicitDependencies ?? [];
    const edgeList = dependencies.length > 0 ? dependencies.join(", ") : "none";
    console.log(`- ${project.name} -> ${edgeList}`);
  }
}

function printProjectNames() {
  for (const project of loadProjects()) {
    console.log(project.name);
  }
}

function serviceGoTestCommands() {
  const serviceRoot = join(rootDir, "module/service");
  if (!existsSync(serviceRoot)) {
    return [];
  }

  return readdirSync(serviceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(serviceRoot, entry.name))
    .filter((serviceDir) => existsSync(join(serviceDir, "go.mod")))
    .map((cwd) => ({ cwd, args: ["test", "./..."] }));
}

function runGoTests() {
  requireCommand("go", "run Go tests");
  const commands = [
    {
      cwd: join(rootDir, "infra"),
      args: ["test", "./communication/go/...", "./protocol/go/...", "./otel/go", "./trace/go", "./metric/go", "./log/go"],
    },
    ...serviceGoTestCommands(),
  ];
  for (const item of commands) {
    const code = runShell("go", item.args, { cwd: item.cwd });
    if (code !== 0) {
      process.exit(code);
    }
  }
}

function runCommunicationChecks() {
  requireCommand("node", "run communication architecture checks");
  requireCommand("go", "run communication Go tests");

  const commands = [
    ["node", ["bin/test-interface-scaffold.mjs"], rootDir],
    ["node", ["bin/test-create-scaffold.mjs"], rootDir],
    ["node", ["bin/test-create-data-format.mjs"], rootDir],
    ["go", ["test", "./communication/go/...", "./protocol/go/..."], join(rootDir, "infra")],
    ...serviceGoTestCommands().map((item) => ["go", item.args, item.cwd]),
  ];

  for (const [command, commandArgs, cwd] of commands) {
    const code = runShell(command, commandArgs, { cwd });
    if (code !== 0) {
      process.exit(code);
    }
  }
}

function parseInterfaceGenerateArgs(commandArgs) {
  const options = {
    generatorArgs: [],
  };

  for (let index = 0; index < commandArgs.length; index += 1) {
    const value = commandArgs[index];

    if (value === "--service") {
      const service = commandArgs[index + 1];
      if (!service || service.startsWith("--")) {
        console.error(`Missing value for ${value}.`);
        process.exit(1);
      }
      options.service = service;
      index += 1;
      continue;
    }

    if (value === "--service_name" || value === "--service-name" || value.startsWith("--service_name=") || value.startsWith("--service-name=")) {
      console.error("Use --service.");
      failInterfaceGenerationAlias();
    }

    if (value.startsWith("--service=")) {
      options.service = value.slice("--service=".length);
      continue;
    }

    if (value === "--config") {
      const config = commandArgs[index + 1];
      if (!config || config.startsWith("--")) {
        console.error("Missing value for --config.");
        process.exit(1);
      }
      options.config = config;
      index += 1;
      continue;
    }

    if (value.startsWith("--config=")) {
      options.config = value.slice("--config=".length);
      continue;
    }

    if (value === "--protocols") {
      const protocols = commandArgs[index + 1];
      if (!protocols || protocols.startsWith("--")) {
        console.error("Missing value for --protocols.");
        process.exit(1);
      }
      options.protocols = protocols;
      index += 1;
      continue;
    }

    if (value.startsWith("--protocols=")) {
      options.protocols = value.slice("--protocols=".length);
      continue;
    }

    if (!value.startsWith("--") && !options.service) {
      options.service = value;
      continue;
    }

    options.generatorArgs.push(value);
  }

  return options;
}

function normalizeServiceInput(value) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function candidateServiceNames(value) {
  const normalized = normalizeServiceInput(value);
  const leaf = basename(normalized);
  const base = leaf.replace(/-/g, "_");
  const names = new Set([normalized, leaf, base]);
  if (base && !base.endsWith("_service")) {
    names.add(`${base}_service`);
  }
  return [...names].filter(Boolean);
}

function resolveServiceModuleRoot(service) {
  const normalized = normalizeServiceInput(service);
  if (!normalized) {
    console.error("Missing service name. Usage: ./pr gen:interfaces --service <service_name>");
    process.exit(1);
  }

  const direct = resolve(rootDir, normalized);
  if (isDirectory(direct)) {
    return direct;
  }

  for (const name of candidateServiceNames(normalized)) {
    const candidate = join(rootDir, "module", "service", name);
    if (isDirectory(candidate)) {
      return candidate;
    }
  }

  console.error(`Service module not found: ${service}`);
  console.error("Expected module/service/<service_name> or a direct module path.");
  process.exit(1);
}

function resolveServiceConfigPath(moduleRoot, override) {
  const configPath = findServiceConfigPath(moduleRoot, override);
  if (configPath) {
    return configPath;
  }
  console.error(`config.yaml not found for ${relative(rootDir, moduleRoot)}`);
  console.error("Expected config/config.yaml, src/config/config.yaml, or config.yaml.");
  process.exit(1);
}

function findServiceConfigPath(moduleRoot, override) {
  const candidates = override
    ? [resolve(rootDir, override)]
    : [
        join(moduleRoot, "config", "config.yaml"),
        join(moduleRoot, "src", "config", "config.yaml"),
        join(moduleRoot, "config.yaml"),
      ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "";
}

function serviceIdlName(moduleRoot) {
  const raw = basename(moduleRoot);
  return raw.replace(/-/g, "_");
}

function resolveProtocolsPath(moduleRoot, configPath, override) {
  if (override) {
    const protocols = resolve(rootDir, override);
    if (!isDirectory(protocols)) {
      console.error(`Protocol source directory not found: ${relative(rootDir, protocols)}`);
      process.exit(1);
    }
    return protocols;
  }

  const idlRoot = join(rootDir, "pkg", "idl");
  const publicInterfaces = join(idlRoot, serviceIdlName(moduleRoot), "public", "interfaces.yaml");
  if (!existsSync(publicInterfaces) && configDeclaresProviderRoutes(configPath)) {
    console.warn(`Public interfaces.yaml not found for this service: ${relative(rootDir, publicInterfaces)}`);
    console.warn("Provider routes should be published under pkg/idl/<service_name>/public/interfaces.yaml.");
  }
  return idlRoot;
}

function configDeclaresProviderRoutes(configPath) {
  const text = readFileSync(configPath, "utf8");
  return /^\s*direction:\s*(server|publish)\s*$/m.test(text) || /^\s*role:\s*(server|publisher)\s*$/m.test(text);
}

function runInterfaceScaffold(commandArgs) {
  requireCommand("node", "run interface scaffold generation");
  const options = parseInterfaceGenerateArgs(commandArgs);
  const moduleRoot = resolveServiceModuleRoot(options.service);
  const code = runInterfaceScaffoldForModule(moduleRoot, options);
  process.exit(code);
}

function runInterfaceScaffoldForModule(moduleRoot, options = {}) {
  const configPath = options.skipMissingConfig
    ? findServiceConfigPath(moduleRoot, options.config)
    : resolveServiceConfigPath(moduleRoot, options.config);
  if (!configPath) {
    console.log(`Skipping interface generation for ${relative(rootDir, moduleRoot)}: config.yaml not found.`);
    return 0;
  }
  const protocolsPath = resolveProtocolsPath(moduleRoot, configPath, options.protocols);
  const generator = join(rootDir, "bin", "generate-interface-scaffold.mjs");
  const args = [
    generator,
    relative(rootDir, moduleRoot),
    "--config",
    relative(rootDir, configPath),
    "--protocols",
    relative(rootDir, protocolsPath),
    ...(options.generatorArgs ?? []),
  ];

  console.log(`Generating interfaces for ${relative(rootDir, moduleRoot)}`);
  console.log(`  config: ${relative(rootDir, configPath)}`);
  console.log(`  idl: ${relative(rootDir, protocolsPath)}`);
  return runShell("node", args);
}

function ros2InterfaceProjectsFromArgs(commandArgs) {
  const packages = ros2PackagesFromArgs(commandArgs);
  const projects = packages.length > 0
    ? packages.map((packageName) => findRos2ProjectByPackage(packageName)).filter(Boolean)
    : loadProjects().filter((project) => project.tags?.includes("framework:ros2"));
  const uniqueByRoot = new Map();
  for (const project of projects) {
    uniqueByRoot.set(project.root, project);
  }
  return [...uniqueByRoot.values()];
}

function generateInterfacesBeforeRos2Command(commandArgs, commandLabel) {
  requireCommand("node", `generate interfaces before ROS2 ${commandLabel}`);
  const projects = ros2InterfaceProjectsFromArgs(commandArgs);
  if (projects.length === 0) {
    return;
  }
  console.log(`Generating interfaces before ROS2 ${commandLabel}.`);
  for (const project of projects) {
    const code = runInterfaceScaffoldForModule(join(rootDir, project.root), {
      skipMissingConfig: true,
    });
    if (code !== 0) {
      process.exit(code);
    }
  }
}

function runRos2Build(commandArgs) {
  generateInterfacesBeforeRos2Command(commandArgs, "build");
  runRos2Docker(["build", ...commandArgs]);
}

function runRos2Deploy(commandArgs) {
  generateInterfacesBeforeRos2Command(commandArgs, "deploy");
  runRos2Docker(["deploy-image", ...commandArgs]);
}

function runRos2Docker(commandArgs) {
  requireCommand("docker", "run ROS2 Docker commands");
  const packages = ros2PackagesFromArgs(commandArgs);
  const envByPackage = new Map();
  for (const packageName of packages) {
    const project = findRos2ProjectByPackage(packageName);
    const env = project ? ros2EnvFromProject(project) : {};
    if (Object.keys(env).length > 0) {
      envByPackage.set(packageName, env);
    }
  }

  const envSignatures = new Set([...envByPackage.values()].map((env) => ros2EnvSignature(env)));
  if (envSignatures.size > 1) {
    const summary = [...envByPackage.entries()]
      .map(([packageName, env]) => `${packageName}:{${ros2EnvSignature(env).replaceAll("\n", ", ")}}`)
      .join(", ");
    console.error(`Selected ROS2 packages use different ROS2 project environments (${summary}). Build or deploy them separately.`);
    process.exit(1);
  }

  const env = [...envByPackage.values()][0] ?? {};
  if (Object.keys(env).length > 0) {
    const envText = Object.keys(env)
      .sort()
      .map((key) => `${key}=${env[key]}`)
      .join(" ");
    console.log(`ROS2 project env: ${envText} (${packages.join(", ")})`);
  }

  const code = runShell("scripts/ros2-docker.sh", commandArgs, {
    env: Object.keys(env).length > 0 ? env : undefined,
  });
  process.exit(code);
}

function runRos2Run(commandArgs) {
  requireCommand("node", "run ROS2 module commands");
  const code = runShell("node", ["bin/ros2-run.mjs", ...commandArgs], {
    env: {
      PR_COMMAND_LINE: prCommandLine,
    },
  });
  process.exit(code);
}

function runMonitor(commandArgs) {
  requireCommand("bun", "run pr-monitor");
  const monitorRoot = join(rootDir, "monitor/pr-monitor");
  const monitorEntry = join(monitorRoot, "src/index.ts");
  if (!existsSync(monitorEntry)) {
    console.error(`pr-monitor entry was not found: ${relative(rootDir, monitorEntry)}`);
    process.exit(1);
  }
  if (!existsSync(join(monitorRoot, "node_modules/@opentui/core/package.json"))) {
    console.error("pr-monitor dependencies are missing: @opentui/core was not found.");
    console.error("Run ./setup.sh --no-install-system --skip-dashboard --skip-db, then retry ./pr monitor.");
    process.exit(1);
  }
  const normalizedArgs = commandArgs[0] === "list" ? ["--list-processes", ...commandArgs.slice(1)] : commandArgs;
  run("bun", ["run", monitorEntry, ...normalizedArgs]);
}

function runRobotProfileCommand(subcommand, commandArgs) {
  requireCommand("node", "run robot profile commands");
  run("node", ["bin/robot-profiles.mjs", subcommand, ...commandArgs]);
}

function runDashboard(commandArgs) {
  requireCommand("npm", "start the dashboard web application");

  requireDashboardPackage();

  const code = runShell("./restart-dashboard.sh", commandArgs);
  process.exit(code);
}

function requireDashboardPackage() {
  const dashboardPackage = join(dashboardDir, "package.json");
  if (!existsSync(dashboardPackage)) {
    console.error(`Dashboard package was not found: ${relative(rootDir, dashboardPackage)}`);
    process.exit(1);
  }
  return dashboardPackage;
}

function dockerImageInspect(image) {
  return runShellCaptured("docker", ["image", "inspect", image]);
}

function dockerImageExists(image) {
  return dockerImageInspect(image).status === 0;
}

function dockerImageMissing(output) {
  return /No such image|not found/i.test(output);
}

function shouldLoadDashboardPostgresImage(output) {
  return /failed to resolve reference|pull access denied|tls: failed to verify certificate|x509: certificate|certificate is valid for|network is unreachable|connection refused|i\/o timeout|no such host|temporary failure in name resolution/i.test(output);
}

function printDashboardPostgresArchiveHint() {
  console.error(`No local image archive was found at ${relative(rootDir, dashboardPostgresImageArchive)}.`);
  console.error("On a machine that can pull Docker images, run:");
  console.error("  ./pr dashboard:db:save-image");
  console.error(`Then copy ${relative(rootDir, dashboardPostgresImageArchive)} into this workspace and retry:`);
  console.error("  ./pr dashboard:db:start");
}

function loadDashboardPostgresImageFromArchive() {
  requireCommand("docker", "load the dashboard Postgres image archive");

  if (!existsSync(dashboardPostgresImageArchive)) {
    printDashboardPostgresArchiveHint();
    return false;
  }

  console.error(`Loading ${dashboardPostgresImage} from ${relative(rootDir, dashboardPostgresImageArchive)}.`);
  const loadCode = runShell("docker", ["load", "-i", dashboardPostgresImageArchive]);
  if (loadCode !== 0) {
    return false;
  }

  if (!dockerImageExists(dashboardPostgresImage)) {
    console.error(`Loaded archive did not provide ${dashboardPostgresImage}.`);
    return false;
  }

  return true;
}

function dashboardDbNpmArgs(command, commandArgs) {
  const npmArgs = ["run", command];
  if (commandArgs.length > 0) {
    npmArgs.push("--", ...commandArgs);
  }
  return npmArgs;
}

function runDashboardDbStart(commandArgs) {
  requireCommand("npm", "start the dashboard database");
  requireCommand("docker", "start the dashboard database");
  requireDashboardPackage();

  const first = runShellCaptured("npm", dashboardDbNpmArgs("db:start", commandArgs), { cwd: dashboardDir });
  process.stdout.write(first.output);
  if (first.error) {
    console.error(`Failed to run npm: ${first.error.message}`);
    process.exit(1);
  }
  if (first.signal) {
    process.kill(process.pid, first.signal);
  }
  if (first.status === 0) {
    process.exit(0);
  }

  if (!shouldLoadDashboardPostgresImage(first.output)) {
    process.exit(first.status);
  }

  console.error(`${dashboardPostgresImage} could not be pulled. Trying local archive fallback.`);
  if (!loadDashboardPostgresImageFromArchive()) {
    process.exit(first.status);
  }

  const second = runShellCaptured("npm", dashboardDbNpmArgs("db:start", commandArgs), { cwd: dashboardDir });
  process.stdout.write(second.output);
  if (second.error) {
    console.error(`Failed to run npm: ${second.error.message}`);
    process.exit(1);
  }
  if (second.signal) {
    process.kill(process.pid, second.signal);
  }
  process.exit(second.status);
}

function runDashboardDbSaveImage(commandArgs) {
  if (commandArgs.length > 0) {
    console.error("Usage: ./pr dashboard:db:save-image");
    process.exit(1);
  }

  requireCommand("docker", "save the dashboard Postgres image archive");

  const inspect = dockerImageInspect(dashboardPostgresImage);
  if (inspect.status !== 0 && !dockerImageMissing(inspect.output)) {
    process.stderr.write(inspect.output);
    console.error(`Could not inspect ${dashboardPostgresImage}. Fix Docker access, then retry.`);
    process.exit(inspect.status);
  }

  if (inspect.status !== 0) {
    console.log(`Pulling ${dashboardPostgresImage}.`);
    const pullCode = runShell("docker", ["pull", dashboardPostgresImage]);
    if (pullCode !== 0) {
      process.exit(pullCode);
    }
  }

  mkdirSync(dirname(dashboardPostgresImageArchive), { recursive: true });
  console.log(`Saving ${dashboardPostgresImage} to ${relative(rootDir, dashboardPostgresImageArchive)}.`);
  const saveCode = runShell("docker", ["save", "-o", dashboardPostgresImageArchive, dashboardPostgresImage]);
  process.exit(saveCode);
}

function runDashboardDbScript(command, commandArgs) {
  if (command === "db:save-image") {
    runDashboardDbSaveImage(commandArgs);
  }

  requireCommand("npm", `run dashboard ${command}`);

  if (command === "db:start") {
    runDashboardDbStart(commandArgs);
  }

  const dashboardPackage = requireDashboardPackage();
  const dashboardPackageJson = JSON.parse(readFileSync(dashboardPackage, "utf8"));
  const dashboardScripts = dashboardPackageJson.scripts ?? {};
  if (!Object.prototype.hasOwnProperty.call(dashboardScripts, command)) {
    console.error(`Dashboard script not found: ${command}`);
    process.exit(1);
  }

  const npmArgs = ["run", command];
  if (commandArgs.length > 0) {
    npmArgs.push("--", ...commandArgs);
  }

  const code = runShell("npm", npmArgs, { cwd: dashboardDir });
  process.exit(code);
}

if (args.length === 0 || ["help", "--help", "-h"].includes(args[0])) {
  printHelp();
  process.exit(0);
}

const [command, ...rest] = args;

if (["version", "--version", "-v"].includes(command)) {
  console.log(`${packageJson.name ?? "project"} ${packageJson.version ?? "0.0.0"}`);
  process.exit(0);
}

if (["scripts", "list", "ls"].includes(command)) {
  printScripts();
  process.exit(0);
}

if (command === "doctor") {
  doctor();
  process.exit(0);
}

if (command === "clean") {
  runClean(rest);
  process.exit(0);
}

if (command === "check") {
  runCheckCommand(rest);
  process.exit(0);
}

if (command === "check:comm") {
  runCommunicationChecks();
  process.exit(0);
}

if (command === "dashboard") {
  runDashboard(rest);
}

if (command.startsWith("dashboard:db:")) {
  runDashboardDbScript(command.slice("dashboard:".length), rest);
}

if (command === "gen:interfaces") {
  runInterfaceScaffold(rest);
  process.exit(0);
}

if (command === "data-format" || command === "data:format" || command === "create:data-format") {
  requireCommand("node", "create data formats");
  run("node", ["bin/create-data-format.mjs", ...rest]);
}

if (command === "robot:profiles" || command === "robot:list") {
  runRobotProfileCommand("list", rest);
}

if (command === "robot:show") {
  runRobotProfileCommand("show", rest);
}

if (command === "robot:check") {
  runRobotProfileCommand("check", rest);
}

if (command === "robot:deploy") {
  runRobotProfileCommand("deploy", rest);
}

if ((command === "generate:interfaces" || command === "interfaces:generate") || (command === "create" && ["proto", "/proto", "interfaces", "interface"].includes(rest[0]))) {
  failInterfaceGenerationAlias();
}

if (command === "projects") {
  printProjectNames();
  process.exit(0);
}

if (command === "monitor") {
  runMonitor(rest);
}

if (command === "test:go") {
  runGoTests();
  process.exit(0);
}

if (command === "ros2:build") {
  runRos2Build(rest);
}

if (command === "ros2:run") {
  runRos2Run(rest);
}

if (command === "ros2:exec") {
  runRos2Docker(["run", ...rest]);
}

if (command === "ros2:deploy") {
  runRos2Deploy(rest);
}

if (command === "ros2:build-image") {
  runRos2Docker(["build-image", ...rest]);
}

if (command === "ros2:deploy-base-image") {
  runRos2Docker(["deploy-base-image", ...rest]);
}

if (command === "ros2:shell") {
  runRos2Docker(["shell", ...rest]);
}

if (command === "observability:up") {
  runRos2Docker(["up-observability", ...rest]);
}

if (command === "observability:logs") {
  runRos2Docker(["logs-observability", ...rest]);
}

if (command === "observability:down") {
  runRos2Docker(["down", ...rest]);
}

if (command === "run") {
  const [scriptName, ...scriptArgs] = rest;
  if (!scriptName) {
    console.error("Missing npm script name.");
    process.exit(1);
  }
  if (!Object.prototype.hasOwnProperty.call(scripts, scriptName)) {
    failUnknown(scriptName);
  }
  runScript(scriptName, scriptArgs);
} else if (command === "npm") {
  requireCommand("npm", "run npm");
  run("npm", rest);
} else if (command === "npx") {
  requireCommand("npx", "run npx");
  run("npx", rest);
} else if (command === "nx") {
  requireCommand("npx", "run nx");
  run("npx", ["nx", ...rest]);
} else if (command === "docker") {
  requireCommand("docker", "run docker");
  run("docker", rest);
} else if (Object.prototype.hasOwnProperty.call(scripts, command)) {
  runScript(command, rest);
} else {
  failUnknown(command);
}
