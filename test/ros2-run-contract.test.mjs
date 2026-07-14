import {
  assertExit,
  assertIncludes,
  commandOutput,
  readText,
  runCommand,
  test,
} from "./lib/harness.mjs";

const ros2Run = readText("bin/ros2-run.mjs");
const ros2Docker = readText("scripts/ros2-docker.sh");

test("ros2:run help documents devices and domain IDs", () => {
  const result = runCommand(process.execPath, ["bin/ros2-run.mjs", "help"]);
  assertExit(result, 0, "ros2-run help");
  assertIncludes(result.stdout, "./pr ros2:run <ros_package_name> [executable] [--domain-id <id>] [--device <device>...] [--network <mode>] [--privileged] [-- <ros2 args...>]", "usage");
  assertIncludes(result.stdout, "./pr ros2:run imu --device /dev/ttyUSB0", "device example");
  assertIncludes(result.stdout, "./pr ros2:run imu imu_node --network host --privileged --device /dev/ttyUSB0:/dev/ttyUSB0", "host network example");
  assertIncludes(result.stdout, "./pr ros2:run imu imu_node --network host -- --ros-args -p sample_name:=pure_driver_sample", "ros args example");
});

test("ros2:run defaults to Humble when project has no distro tag", () => {
  assertIncludes(ros2Run, "process.env.ROS_DISTRO || \"humble\"", "Humble fallback");
});

test("ros2:run propagates requested devices to ros2-docker", () => {
  assertIncludes(ros2Run, "ROS_RUN_DEVICES: devices.join(\"\\n\")", "device env propagation");
  assertIncludes(ros2Docker, "write_ros_run_override", "runtime compose override writer");
  assertIncludes(ros2Docker, "devices:", "device compose key");
});

test("ros2:run supports local host-network and privileged runtime flags", () => {
  assertIncludes(ros2Run, "ROS_RUN_NETWORK: network", "network env propagation");
  assertIncludes(ros2Run, "ROS_RUN_PRIVILEGED: privileged ? \"1\" : \"\"", "privileged env propagation");
  assertIncludes(ros2Docker, "network_mode:", "network compose override");
  assertIncludes(ros2Docker, "privileged: true", "privileged compose override");
});

test("ros2:run discovers nested ROS2 package.xml packages", () => {
  assertIncludes(ros2Run, "findRos2PackagesByName", "package.xml fallback resolver");
  assertIncludes(ros2Run, "collectRos2Packages", "recursive package.xml scanner");
  assertIncludes(ros2Run, "ignoredPackageSearchDirs", "package search ignore list");
});

test("ros2:run container names include package and executable", () => {
  assertIncludes(ros2Run, "rosRunContainerName(module.packageName, executable, rosDistro, rosDomainId)", "executable container name call");
  assertIncludes(ros2Run, "pacific-rim-ros2-run-${packageName}-${executableName}-${rosDistro}-d${rosDomainId}", "executable container name format");
});

test("ros2:run forwards ROS args after --", () => {
  assertIncludes(ros2Run, "options.rosArgs = argv.slice(index + 1)", "passthrough parser");
  assertIncludes(ros2Run, "ros2 run ${packageArg} ${executableArg}${rosArgsString ? ` ${rosArgsString}` : \"\"}", "passthrough command");
});

const invalidRunCases = [
  [["smoke_test1", "--domain-id", "abc"], "--domain-id must be a non-negative integer."],
  [["smoke_test1", "--device"], "--device requires a non-empty device path or Docker device spec."],
  [["smoke_test1", "--network"], "--network requires a non-empty Docker network mode."],
  [["smoke_test1", "--unknown"], "Unknown ros2:run option: --unknown"],
];

for (const [args, expectedMessage] of invalidRunCases) {
  test(`ros2:run rejects ${args.join(" ")}`, () => {
    const result = runCommand(process.execPath, ["bin/ros2-run.mjs", ...args]);
    if (result.status === 0) {
      throw new Error(`ros2-run should have failed for ${args.join(" ")}\n${commandOutput(result)}`);
    }
    assertIncludes(commandOutput(result), expectedMessage, "failure message");
  });
}
