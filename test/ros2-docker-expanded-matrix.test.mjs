import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertExit,
  assertIncludes,
  assertNotIncludes,
  commandOutput,
  runCommand,
  test,
} from "./lib/harness.mjs";

const distros = ["humble", "jazzy", "kilted", "lyrical", "rolling"];
const platforms = {
  amd64: "linux/amd64",
  x86_64: "linux/x86_64",
  arm64: "linux/arm64",
  aarch64: "linux/aarch64",
};

function deployDryRun({ distro = "humble", env = {}, platform = platforms.amd64, extraArgs = [] } = {}) {
  return runCommand("bash", [
    "scripts/ros2-docker.sh",
    "deploy-image",
    "--dry-run",
    "--host",
    "198.51.100.20",
    "--user",
    "robot",
    "--platform",
    platform,
    "--packages-select",
    "imu",
    "--domain-id",
    "42",
    "--no-logs",
    ...extraArgs,
  ], {
    env: {
      ROS_DISTRO: distro,
      HARBOR_PREFER_ROS_BASE: "0",
      ...env,
    },
  });
}

function writeExecutable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function deployWithMockRemoteArchitecture(output) {
  const binDir = mkdtempSync(join(tmpdir(), "pacific-rim-ros2-docker-test-"));
  writeExecutable(join(binDir, "docker"), `#!/usr/bin/env bash
if [[ "$1" == "build" ]]; then
  printf '+ docker'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\\n'
  exit 0
fi
if [[ "$1" == "save" ]]; then
  printf 'mock image'
fi
exit 0
`);
  writeExecutable(join(binDir, "ssh"), `#!/usr/bin/env bash
if [[ "$*" == *"uname -m"* ]]; then
${output}
  exit 0
fi
cat >/dev/null || true
exit 0
`);

  return runCommand("bash", [
    "scripts/ros2-docker.sh",
    "deploy-image",
    "--host",
    "198.51.100.20",
    "--user",
    "robot",
    "--packages-select",
    "imu",
    "--domain-id",
    "42",
    "--no-logs",
  ], {
    env: {
      HARBOR_PREFER_ROS_BASE: "0",
      PATH: `${binDir}:${process.env.PATH}`,
    },
  });
}

function deployBaseWithReusableRos2Image() {
  const binDir = mkdtempSync(join(tmpdir(), "pacific-rim-ros2-docker-test-"));
  const logFile = join(binDir, "docker.log");
  writeFileSync(logFile, "");
  writeExecutable(join(binDir, "docker"), `#!/usr/bin/env bash
log_file=${JSON.stringify(logFile)}
printf 'docker' >> "$log_file"
for arg in "$@"; do
  printf ' %q' "$arg" >> "$log_file"
done
printf '\\n' >> "$log_file"

if [[ "$1" == "image" && "$2" == "ls" ]]; then
  printf '%s\\n' 'pacific-rim-ros2:jazzy ros2id'
  exit 0
fi

if [[ "$1" == "image" && "$2" == "inspect" && "$3" == "--format" ]]; then
  last_arg="\${!#}"
  if [[ "$last_arg" == "ros2id" ]]; then
    printf '%s\\n' 'linux/arm64'
    exit 0
  fi
  exit 1
fi

if [[ "$1" == "build" ]]; then
  printf '%s\\n' 'mock deploy-base build'
  exit 0
fi

if [[ "$1" == "tag" || "$1" == "rmi" ]]; then
  exit 0
fi

exit 1
`);

  const result = runCommand("bash", [
    "scripts/ros2-docker.sh",
    "deploy-base-image",
    "--platform",
    platforms.arm64,
  ], {
    env: {
      ROS_DISTRO: "jazzy",
      HARBOR_IMAGE_PULL: "0",
      HARBOR_DEPLOY_BASE_IMAGE_PULL: "0",
      HARBOR_DEPLOY_BASE_IMAGE_PUSH: "0",
      HARBOR_PREFER_ROS_BASE: "0",
      PATH: `${binDir}:${process.env.PATH}`,
    },
  });

  return { result, dockerLog: readFileSync(logFile, "utf8") };
}

function deployBaseWithStaleLocalBaseImage() {
  const binDir = mkdtempSync(join(tmpdir(), "pacific-rim-ros2-docker-test-"));
  const logFile = join(binDir, "docker.log");
  writeFileSync(logFile, "");
  writeExecutable(join(binDir, "docker"), `#!/usr/bin/env bash
log_file=${JSON.stringify(logFile)}
printf 'docker' >> "$log_file"
for arg in "$@"; do
  printf ' %q' "$arg" >> "$log_file"
done
printf '\\n' >> "$log_file"

base_image='pacific-rim-ros2-deploy-base:jazzy-runtime2-arm64'

if [[ "$1" == "image" && "$2" == "ls" ]]; then
  printf '%s\\n' "$base_image baseid"
  exit 0
fi

if [[ "$1" == "image" && "$2" == "inspect" && "$3" == "--format" ]]; then
  format="$4"
  case "$format" in
    *'.Os'*'.Architecture'*)
      printf '%s\\n' 'linux/arm64'
      exit 0
      ;;
    *'python-runtime-requirements-sha'*)
      printf '\\n'
      exit 0
      ;;
  esac
  exit 1
fi

if [[ "$1" == "build" ]]; then
  printf '%s\\n' 'mock deploy-base build'
  exit 0
fi

exit 1
`);

  const result = runCommand("bash", [
    "scripts/ros2-docker.sh",
    "deploy-base-image",
    "--platform",
    platforms.arm64,
  ], {
    env: {
      ROS_DISTRO: "jazzy",
      HARBOR_IMAGE_PULL: "0",
      HARBOR_DEPLOY_BASE_IMAGE_PULL: "0",
      HARBOR_DEPLOY_BASE_IMAGE_PUSH: "0",
      HARBOR_PREFER_ROS_BASE: "0",
      PATH: `${binDir}:${process.env.PATH}`,
    },
  });

  return { result, dockerLog: readFileSync(logFile, "utf8") };
}

const profileCases = [
  {
    name: "plain",
    env: {},
    platform: platforms.amd64,
    target: "none",
    enable: "0",
    tagSuffix: "",
    absent: ["--gpus", "--runtime"],
  },
  {
    name: "common vision",
    env: { ENABLE_VISION_STACK: "1" },
    platform: platforms.amd64,
    target: "none",
    enable: "1",
    tagSuffix: "-vision",
    absent: ["--gpus", "--runtime"],
  },
  {
    name: "pc nvidia",
    env: { VISION_TARGET: "pc-nvidia" },
    platform: platforms.amd64,
    target: "pc-nvidia",
    enable: "1",
    tagSuffix: "-vision-pc-nvidia",
    present: ["--gpus", "NVIDIA_VISIBLE_DEVICES=all", "NVIDIA_DRIVER_CAPABILITIES=compute"],
  },
  {
    name: "jetson",
    env: { VISION_TARGET: "jetson" },
    platform: platforms.arm64,
    target: "jetson",
    enable: "1",
    tagSuffix: "-vision-jetson",
    present: ["--runtime", "NVIDIA_VISIBLE_DEVICES=all", "NVIDIA_DRIVER_CAPABILITIES=compute"],
  },
  {
    name: "auto amd64",
    env: { VISION_TARGET: "auto" },
    platform: platforms.amd64,
    target: "pc-nvidia",
    enable: "1",
    tagSuffix: "-vision-pc-nvidia",
    present: ["Auto-detected VISION_TARGET=pc-nvidia", "--gpus"],
  },
  {
    name: "auto arm64",
    env: { VISION_TARGET: "auto" },
    platform: platforms.arm64,
    target: "jetson",
    enable: "1",
    tagSuffix: "-vision-jetson",
    present: ["Auto-detected VISION_TARGET=jetson", "--runtime"],
  },
];

for (const distro of distros) {
  for (const profile of profileCases) {
    test(`deploy dry-run ${distro} ${profile.name} profile`, () => {
      const result = deployDryRun({ distro, env: profile.env, platform: profile.platform });
      assertExit(result, 0, `${distro} ${profile.name}`);
      const output = commandOutput(result);
      assertIncludes(output, `--build-arg ROS_DISTRO=${distro}`, "distro arg");
      assertIncludes(output, `--build-arg ROS_BASE_IMAGE=ros:${distro}-ros-base`, "base image arg");
      assertIncludes(output, `--build-arg ENABLE_VISION_STACK=${profile.enable}`, "vision enable arg");
      assertIncludes(output, `--build-arg VISION_TARGET=${profile.target}`, "vision target arg");
      assertIncludes(output, `pacific-rim-ros2-imu:${distro}${profile.tagSuffix}`, "image tag");
      for (const item of profile.present ?? []) {
        assertIncludes(output, item, `present ${item}`);
      }
      for (const item of profile.absent ?? []) {
        assertNotIncludes(output, item, `absent ${item}`);
      }
    });
  }
}

const autoArchCases = [
  [platforms.amd64, "pc-nvidia", "--gpus"],
  [platforms.x86_64, "pc-nvidia", "--gpus"],
  [platforms.arm64, "jetson", "--runtime"],
  [platforms.aarch64, "jetson", "--runtime"],
];

for (const [platform, target, runtimeFlag] of autoArchCases) {
  test(`deploy auto architecture alias ${platform}`, () => {
    const result = deployDryRun({ env: { VISION_TARGET: "auto" }, platform });
    assertExit(result, 0, `auto alias ${platform}`);
    const output = commandOutput(result);
    assertIncludes(output, `Auto-detected VISION_TARGET=${target} from platform ${platform}.`, "auto message");
    assertIncludes(output, `--build-arg VISION_TARGET=${target}`, "target arg");
    assertIncludes(output, runtimeFlag, "runtime flag");
  });
}

test("deploy remote architecture detection ignores SSH warning lines", () => {
  const result = deployWithMockRemoteArchitecture(`
printf '%s\\n' 'Warning: Permanently added host key.' >&2
printf '%s\\n' 'aarch64'
`);
  assertExit(result, 0, "remote architecture warning");
  const output = commandOutput(result);
  assertIncludes(output, "Detected remote architecture: aarch64 -> linux/arm64", "detected arm64");
  assertIncludes(output, "--platform linux/arm64", "build platform");
});

test("deploy remote architecture detection does not treat ssh diagnostics as architecture", () => {
  const result = deployWithMockRemoteArchitecture(`
printf '%s\\n' 'ssh: connect to host 198.51.100.20 port 22: Connection refused'
`);
  assertExit(result, 1, "ssh diagnostic architecture");
  const output = commandOutput(result);
  assertIncludes(output, "Failed to detect remote architecture", "detect failure");
  assertNotIncludes(output, 'Unsupported remote architecture "ssh"', "no ssh token fallback");
});

test("deploy base image tag includes runtime dependency revision", () => {
  const result = deployDryRun({
    distro: "jazzy",
    platform: platforms.arm64,
    extraArgs: ["--packages-select", "imu"],
  });
  assertExit(result, 0, "deploy base runtime revision");
  const output = commandOutput(result);
  assertIncludes(
    output,
    "Deploy base image: pacific-rim-ros2-deploy-base:jazzy-runtime2-arm64",
    "deploy base tag",
  );
  assertIncludes(
    output,
    "--build-arg DEPLOY_BASE_IMAGE=pacific-rim-ros2-deploy-base:jazzy-runtime2-arm64",
    "service build uses revised deploy base",
  );
});

test("deploy base image does not reuse existing ros2 image by default", () => {
  const { result, dockerLog } = deployBaseWithReusableRos2Image();
  assertExit(result, 0, "deploy base avoids ros2 image reuse");
  const output = commandOutput(result);
  assertIncludes(
    output,
    "Building deploy base image: pacific-rim-ros2-deploy-base:jazzy-runtime2-arm64",
    "deploy base is rebuilt",
  );
  assertNotIncludes(output, "Reusing ROS2 image as deploy base", "no reuse message");
  assertIncludes(dockerLog, "docker build", "docker build was used");
  assertNotIncludes(dockerLog, "docker tag pacific-rim-ros2:jazzy", "old ros2 image was not retagged");
});

test("deploy base image rebuilds stale local image without runtime dependency fingerprint", () => {
  const { result, dockerLog } = deployBaseWithStaleLocalBaseImage();
  assertExit(result, 0, "deploy base rebuilds stale local image");
  const output = commandOutput(result);
  assertIncludes(
    output,
    "Building deploy base image: pacific-rim-ros2-deploy-base:jazzy-runtime2-arm64",
    "stale deploy base is rebuilt",
  );
  assertIncludes(dockerLog, "docker build", "docker build was used");
});

const runtimeOptionCases = [
  [["--network", "bridge"], ["--network", "bridge"]],
  [["--env", "CAMERA_ID=front"], ["CAMERA_ID=front"]],
  [["--device", "/dev/video0"], ["--device", "/dev/video0"]],
  [["--volume", "/data/models:/models:ro"], ["/data/models:/models:ro"]],
  [["--privileged"], ["--privileged"]],
  [["--restart", "always"], ["--restart", "always"]],
  [["--container-name", "matrix_custom"], ["--name", "matrix_custom"]],
  [["--run-arg", "--ipc=host"], ["--ipc=host"]],
];

for (const [extraArgs, expectedParts] of runtimeOptionCases) {
  test(`deploy dry-run forwards runtime option ${extraArgs.join(" ")}`, () => {
    const result = deployDryRun({ env: { VISION_TARGET: "pc-nvidia" }, extraArgs });
    assertExit(result, 0, `runtime option ${extraArgs.join(" ")}`);
    const output = commandOutput(result);
    for (const expected of expectedParts) {
      assertIncludes(output, expected, `runtime option output ${expected}`);
    }
  });
}

const buildOptionCases = [
  [["--base-image", "registry.local/ros:humble-vision-base"], "--build-arg ROS_BASE_IMAGE=registry.local/ros:humble-vision-base"],
  [["--image", "registry.local/custom:tag"], "Image: registry.local/custom:tag"],
  [["--build-arg", "COLCON_ARGS=--merge-install"], "--build-arg COLCON_ARGS=--merge-install"],
  [["--pull"], "--pull"],
  [["--no-cache"], "--no-cache"],
];

for (const [extraArgs, expected] of buildOptionCases) {
  test(`deploy dry-run forwards build option ${extraArgs.join(" ")}`, () => {
    const result = deployDryRun({ extraArgs });
    assertExit(result, 0, `build option ${extraArgs.join(" ")}`);
    assertIncludes(commandOutput(result), expected, "build option output");
  });
}

const validationCases = [
  {
    name: "missing host",
    args: ["scripts/ros2-docker.sh", "deploy-image", "--dry-run", "--packages-select", "matrix_probe"],
    status: 1,
    message: "--host is required for deploy-image",
  },
  {
    name: "missing package",
    args: ["scripts/ros2-docker.sh", "deploy-image", "--dry-run", "--host", "198.51.100.20"],
    status: 1,
    message: "--packages-select is required for deploy-image",
  },
  {
    name: "invalid domain id",
    args: ["scripts/ros2-docker.sh", "deploy-image", "--dry-run", "--host", "198.51.100.20", "--packages-select", "matrix_probe", "--domain-id", "x"],
    status: 1,
    message: "--domain-id must be a non-negative integer",
  },
  {
    name: "invalid logs tail",
    args: ["scripts/ros2-docker.sh", "deploy-image", "--dry-run", "--host", "198.51.100.20", "--packages-select", "matrix_probe", "--logs-tail", "many"],
    status: 1,
    message: "--logs-tail must be a non-negative integer",
  },
  {
    name: "unknown option",
    args: ["scripts/ros2-docker.sh", "deploy-image", "--dry-run", "--host", "198.51.100.20", "--packages-select", "matrix_probe", "--wat"],
    status: 1,
    message: "Unknown deploy-image option: --wat",
  },
];

for (const item of validationCases) {
  test(`deploy validation: ${item.name}`, () => {
    const result = runCommand("bash", item.args);
    assertExit(result, item.status, item.name);
    assertIncludes(commandOutput(result), item.message, "validation message");
  });
}
