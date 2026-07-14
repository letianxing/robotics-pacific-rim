import {
  assertExit,
  assertIncludes,
  assertNotIncludes,
  commandOutput,
  runCommand,
  test,
} from "./lib/harness.mjs";

function deployDryRun({ env = {}, platform = "linux/amd64", packageName = "imu" } = {}) {
  const args = [
    "scripts/ros2-docker.sh",
    "deploy-image",
    "--dry-run",
    "--host",
    "192.0.2.10",
    "--user",
    "robot",
    "--platform",
    platform,
    "--packages-select",
    packageName,
    "--domain-id",
    "42",
    "--no-logs",
  ];
  return runCommand("bash", args, { env });
}

const autoPlatformCases = [
  ["linux/amd64", "pc-nvidia", "--gpus", "humble-vision-pc-nvidia"],
  ["linux/x86_64", "pc-nvidia", "--gpus", "humble-vision-pc-nvidia"],
  ["linux/arm64", "jetson", "--runtime", "humble-vision-jetson"],
  ["linux/aarch64", "jetson", "--runtime", "humble-vision-jetson"],
];

for (const [platform, target, runtimeFlag, tag] of autoPlatformCases) {
  test(`VISION_TARGET=auto maps ${platform} to ${target}`, () => {
    const result = deployDryRun({ env: { VISION_TARGET: "auto" }, platform });
    assertExit(result, 0, `auto ${platform}`);
    const output = commandOutput(result);
    assertIncludes(output, `Auto-detected VISION_TARGET=${target} from platform ${platform}.`, "auto target message");
    assertIncludes(output, `--build-arg VISION_TARGET=${target}`, "build target arg");
    assertIncludes(output, `--build-arg ENABLE_VISION_STACK=1`, "vision enabled arg");
    assertIncludes(output, `pacific-rim-ros2-imu:${tag}`, "image tag");
    assertIncludes(output, runtimeFlag, "runtime flag");
  });
}

const explicitTargetCases = [
  ["pc-nvidia", "linux/amd64", "--gpus", "humble-vision-pc-nvidia"],
  ["jetson", "linux/arm64", "--runtime", "humble-vision-jetson"],
];

for (const [target, platform, runtimeFlag, tag] of explicitTargetCases) {
  test(`VISION_TARGET=${target} produces expected deploy dry-run`, () => {
    const result = deployDryRun({ env: { VISION_TARGET: target }, platform });
    assertExit(result, 0, `explicit ${target}`);
    const output = commandOutput(result);
    assertNotIncludes(output, "Auto-detected VISION_TARGET", "explicit target should not print auto message");
    assertIncludes(output, `--build-arg VISION_TARGET=${target}`, "build target arg");
    assertIncludes(output, `pacific-rim-ros2-imu:${tag}`, "image tag");
    assertIncludes(output, runtimeFlag, "runtime flag");
  });
}

test("ENABLE_VISION_STACK=1 without NVIDIA target keeps runtime plain", () => {
  const result = deployDryRun({ env: { ENABLE_VISION_STACK: "1" }, platform: "linux/amd64" });
  assertExit(result, 0, "plain vision stack dry-run");
  const output = commandOutput(result);
  assertIncludes(output, "--build-arg ENABLE_VISION_STACK=1", "vision build arg");
  assertIncludes(output, "--build-arg VISION_TARGET=none", "target none arg");
  assertIncludes(output, "pacific-rim-ros2-imu:humble-vision", "plain vision image tag");
  assertNotIncludes(output, "--gpus", "plain vision should not request GPU runtime");
  assertNotIncludes(output, "--runtime", "plain vision should not request Jetson runtime");
});

test("plain ROS2 deploy dry-run keeps vision disabled", () => {
  const result = deployDryRun({ platform: "linux/amd64" });
  assertExit(result, 0, "plain dry-run");
  const output = commandOutput(result);
  assertIncludes(output, "--build-arg ENABLE_VISION_STACK=0", "vision disabled arg");
  assertIncludes(output, "--build-arg VISION_TARGET=none", "target none arg");
  assertIncludes(output, "pacific-rim-ros2-imu:humble", "plain image tag");
  assertNotIncludes(output, "--gpus", "plain should not request GPU runtime");
  assertNotIncludes(output, "--runtime", "plain should not request Jetson runtime");
});

test("ROS_DISTRO override is reflected in base image and tag", () => {
  const result = deployDryRun({
    env: { ROS_DISTRO: "jazzy", VISION_TARGET: "auto", HARBOR_PREFER_ROS_BASE: "0" },
    platform: "linux/arm64",
  });
  assertExit(result, 0, "jazzy auto dry-run");
  const output = commandOutput(result);
  assertIncludes(output, "--build-arg ROS_DISTRO=jazzy", "distro build arg");
  assertIncludes(output, "--build-arg ROS_BASE_IMAGE=ros:jazzy-ros-base", "base image arg");
  assertIncludes(output, "pacific-rim-ros2-imu:jazzy-vision-jetson", "jazzy image tag");
});

test("VISION_TARGET=auto dry-run requires explicit platform", () => {
  const result = runCommand("bash", [
    "scripts/ros2-docker.sh",
    "deploy-image",
    "--dry-run",
    "--host",
    "192.0.2.10",
    "--packages-select",
    "imu",
    "--domain-id",
    "42",
    "--no-logs",
  ], { env: { VISION_TARGET: "auto" } });
  assertExit(result, 1, "auto dry-run missing platform");
  assertIncludes(commandOutput(result), "VISION_TARGET=auto requires --platform during dry-run", "missing platform message");
});

test("invalid VISION_TARGET fails before any Docker work", () => {
  const result = runCommand("bash", ["scripts/ros2-docker.sh", "help"], {
    env: { VISION_TARGET: "bogus" },
  });
  assertExit(result, 2, "invalid target");
  assertIncludes(commandOutput(result), "Unsupported VISION_TARGET=bogus", "invalid target message");
});
