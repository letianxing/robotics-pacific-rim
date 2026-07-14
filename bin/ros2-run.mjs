#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { loadProjects, pathExists, rootDir } from "./workspace.mjs";

const supportedRos2Distros = new Set(["humble", "jazzy", "kilted", "lyrical", "rolling"]);
const defaultRosDomainByDistro = new Map([
  ["jazzy", "42"],
  ["humble", "43"],
  ["kilted", "44"],
  ["lyrical", "45"],
  ["rolling", "46"],
]);
const ignoredPackageSearchDirs = new Set([
  ".cache",
  ".git",
  ".idea",
  ".nx",
  "build",
  "coverage",
  "dist",
  "install",
  "log",
  "node_modules",
  "target",
  "third_party",
  "vendor",
]);

await main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main(argv) {
  if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0])) {
    printHelp();
    return;
  }

  const options = parseArgs(argv);
  const { packageName, executableName, domainId, devices, network, privileged, rosArgs } = options;

  if (!packageName) {
    printHelp();
    return;
  }

  const module = await resolveModule(packageName);
  const executable = executableName || (await resolveExecutable(module));
  const otlpEndpoint = process.env.PLATFORM_OTLP_ENDPOINT || await readPlatformOtlpEndpoint();
  const rosDistro = module.rosDistro || process.env.ROS_DISTRO || "humble";
  const rosDomainId = domainId || process.env.ROS_DOMAIN_ID || defaultRosDomainByDistro.get(rosDistro) || "42";
  const distroInstallSetup = `install/${rosDistro}/setup.bash`;
  const legacyInstallSetup = "install/setup.bash";
  const containerName = rosRunContainerName(module.packageName, executable, rosDistro, rosDomainId);

  console.log(`ROS2 package: ${module.packageName}`);
  console.log(`ROS2 distro:  ${rosDistro}`);
  console.log(`ROS domain:   ${rosDomainId}`);
  console.log(`Container:    ${containerName}`);
  console.log(`Executable:   ${executable}`);
  if (devices.length > 0) {
    console.log(`Devices:      ${devices.join(", ")}`);
  }
  if (network) {
    console.log(`Network:      ${network}`);
  }
  if (privileged) {
    console.log("Privileged:   true");
  }
  console.log(`OTLP HTTP:    ${otlpEndpoint}`);
  if (process.env.PR_COMMAND_LINE) {
    console.log(`[PR RUNNING] ${process.env.PR_COMMAND_LINE} starting foreground ROS2 process; final status prints after it exits.`);
  }

  execFileSync("scripts/ros2-docker.sh", [
    "run",
    ros2RunCommand({
      distroInstallSetup,
      executable,
      legacyInstallSetup,
      packageName: module.packageName,
      rosArgs,
    }),
  ], {
    cwd: rootDir,
    env: {
      ...process.env,
      ROS_DISTRO: rosDistro,
      ROS_DOMAIN_ID: rosDomainId,
      ROS_RUN_CONTAINER_NAME: containerName,
      ROS_RUN_DEVICES: devices.join("\n"),
      ROS_RUN_EXECUTABLE_NAME: executable,
      ROS_RUN_NETWORK: network,
      ROS_RUN_PACKAGE_NAME: module.packageName,
      ROS_RUN_PRIVILEGED: privileged ? "1" : "",
    },
    stdio: "inherit",
  });
}

function ros2RunCommand({ distroInstallSetup, executable, legacyInstallSetup, packageName, rosArgs }) {
  const distroSetup = shellQuote(distroInstallSetup);
  const legacySetup = shellQuote(legacyInstallSetup);
  const packageArg = shellQuote(packageName);
  const executableArg = shellQuote(executable);
  const rosArgsString = rosArgs.map(shellQuote).join(" ");
  const packageForMessage = shellQuoteForDoubleQuotedString(packageName);
  const distroSetupForMessage = shellQuoteForDoubleQuotedString(distroInstallSetup);
  const legacySetupForMessage = shellQuoteForDoubleQuotedString(legacyInstallSetup);

  return [
    `install_setup=${distroSetup}`,
    `if [[ ! -f "$install_setup" && -f ${legacySetup} ]]; then echo "ROS2 install setup not found: ${distroSetupForMessage}; using ${legacySetupForMessage}." >&2; install_setup=${legacySetup}; fi`,
    `if [[ ! -f "$install_setup" ]]; then echo "ROS2 install setup not found: ${distroSetupForMessage} or ${legacySetupForMessage}. Run ./pr ros2:build --packages-select ${packageForMessage} first." >&2; exit 1; fi`,
    `source "$install_setup"`,
    `ros2 run ${packageArg} ${executableArg}${rosArgsString ? ` ${rosArgsString}` : ""}`,
  ].join("; ");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function shellQuoteForDoubleQuotedString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`");
}

function parseArgs(argv) {
  const options = {
    packageName: "",
    executableName: "",
    domainId: "",
    devices: [],
    network: "",
    privileged: false,
    rosArgs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      options.rosArgs = argv.slice(index + 1);
      break;
    }
    if (arg === "--domain-id") {
      options.domainId = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--domain-id=")) {
      options.domainId = arg.slice("--domain-id=".length);
      continue;
    }
    if (arg === "--device") {
      options.devices.push(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg.startsWith("--device=")) {
      options.devices.push(arg.slice("--device=".length));
      continue;
    }
    if (arg === "--network") {
      const value = argv[index + 1] ?? "";
      if (!value || value.startsWith("-")) {
        throw new Error("--network requires a non-empty Docker network mode.");
      }
      options.network = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--network=")) {
      const value = arg.slice("--network=".length);
      if (!value) {
        throw new Error("--network requires a non-empty Docker network mode.");
      }
      options.network = value;
      continue;
    }
    if (arg === "--host-network") {
      options.network = "host";
      continue;
    }
    if (arg === "--privileged") {
      options.privileged = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown ros2:run option: ${arg}`);
    }
    if (!options.packageName) {
      options.packageName = arg;
      continue;
    }
    if (!options.executableName) {
      options.executableName = arg;
      continue;
    }

    throw new Error(`Unexpected ros2:run argument: ${arg}`);
  }

  if (options.domainId && !/^[0-9]+$/.test(options.domainId)) {
    throw new Error("--domain-id must be a non-negative integer.");
  }
  if (options.devices.some((device) => !device)) {
    throw new Error("--device requires a non-empty device path or Docker device spec.");
  }
  if (options.network === "") {
    return options;
  }
  if (!/^[a-zA-Z0-9_.:-]+$/.test(options.network)) {
    throw new Error("--network requires a non-empty Docker network mode.");
  }

  return options;
}

function rosRunContainerName(packageName, executableName, rosDistro, rosDomainId) {
  return `pacific-rim-ros2-run-${packageName}-${executableName}-${rosDistro}-d${rosDomainId}`
    .replace(/[^a-zA-Z0-9_.-]/g, "-");
}

async function readPlatformOtlpEndpoint() {
  const platformPath = join(rootDir, "deploy", "local", "platform.yaml");
  if (!await pathExists(platformPath)) {
    return "http://localhost:8636";
  }

  const platform = await readFile(platformPath, "utf8");
  const match = platform.match(/^\s*otlp_endpoint:\s*["']?([^"'\n#]+)["']?/m);
  return match?.[1]?.trim() || "http://localhost:8636";
}

async function resolveModule(value) {
  for (const project of await loadProjects()) {
    if (!project.tags?.includes("framework:ros2")) {
      continue;
    }

    const moduleRoot = join(rootDir, project.root);
    const packageName = await readPackageXmlName(moduleRoot);
    if (packageName === value) {
      return {
        root: moduleRoot,
        name: project.name,
        packageName,
        rosDistro: ros2DistroFromProject(project),
      };
    }
  }

  const discovered = await findRos2PackagesByName(value);
  if (discovered.length === 1) {
    return discovered[0];
  }
  if (discovered.length > 1) {
    const roots = discovered.map((item) => relative(rootDir, item.root)).join(", ");
    throw new Error(`ROS2 package "${value}" is ambiguous. Matching package.xml roots: ${roots}`);
  }

  throw new Error(`Unknown ROS2 package "${value}". Use the package.xml <name>, for example "smoke_test1".`);
}

async function findRos2PackagesByName(packageName) {
  const packages = [];
  await collectRos2Packages(rootDir, packageName, packages);
  return packages;
}

async function collectRos2Packages(dir, packageName, packages) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === "package.xml") {
      const foundName = await readPackageXmlName(dirname(path));
      if (foundName === packageName) {
        packages.push({
          root: dirname(path),
          name: packageName,
          packageName,
          rosDistro: "",
        });
      }
      continue;
    }
    if (entry.isDirectory() && !ignoredPackageSearchDirs.has(entry.name)) {
      await collectRos2Packages(path, packageName, packages);
    }
  }
}

async function readPackageXmlName(moduleRoot) {
  const packageXmlPath = join(moduleRoot, "package.xml");
  if (await pathExists(packageXmlPath)) {
    const packageXml = await readFile(packageXmlPath, "utf8");
    const match = packageXml.match(/<name>\s*([^<\s]+)\s*<\/name>/);
    if (match) {
      return match[1];
    }
  }

  return "";
}

function ros2DistroFromProject(project) {
  const distroTag = project.tags?.find((tag) => tag.startsWith("ros2:"));
  if (!distroTag) {
    return "";
  }

  const distro = distroTag.slice("ros2:".length);
  return supportedRos2Distros.has(distro) ? distro : "";
}

async function resolveExecutable(module) {
  const setupPath = join(module.root, "setup.py");
  if (await pathExists(setupPath)) {
    const setup = await readFile(setupPath, "utf8");
    const match = setup.match(/["']([^"']+)\s*=\s*[^"']+:main["']/);
    if (match) {
      return match[1].trim();
    }
  }

  const cmakePath = join(module.root, "CMakeLists.txt");
  if (await pathExists(cmakePath)) {
    const cmake = await readFile(cmakePath, "utf8");
    const match = cmake.match(/add_executable\(([^)\s]+)/);
    if (match) {
      return match[1];
    }
  }

  return `${module.packageName}_node`;
}

function printHelp() {
  console.log(`Run a ROS2 module in the workspace Docker container.

Usage:
  ./pr ros2:run <ros_package_name> [executable] [--domain-id <id>] [--device <device>...] [--network <mode>] [--privileged] [-- <ros2 args...>]

Examples:
  ./pr ros2:run smoke_test1
  ./pr ros2:run smoke_test1 smoke_test1_node
  ./pr ros2:run smoke_test1 --domain-id 42
  ./pr ros2:run imu --device /dev/ttyUSB0
  ./pr ros2:run imu imu_node --network host --privileged --device /dev/ttyUSB0:/dev/ttyUSB0
  ./pr ros2:run imu imu_node --network host -- --ros-args -p sample_name:=pure_driver_sample
`);
}
