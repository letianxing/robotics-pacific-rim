import {
  assertExit,
  assertIncludes,
  commandOutput,
  runCommand,
  test,
} from "./lib/harness.mjs";

const helpResult = runCommand("bash", ["scripts/ros2-docker.sh", "help"]);
const helpOutput = commandOutput(helpResult);

const usageSnippets = [
  "scripts/ros2-docker.sh build-image",
  "scripts/ros2-docker.sh up-observability",
  "scripts/ros2-docker.sh logs-observability",
  "scripts/ros2-docker.sh down",
  "scripts/ros2-docker.sh shell",
  "scripts/ros2-docker.sh build [colcon args...]",
  "scripts/ros2-docker.sh test [colcon args...]",
  "scripts/ros2-docker.sh run <command...>",
  "scripts/ros2-docker.sh deploy-image --host <ip-or-host> --packages-select <pkg>",
  "scripts/ros2-docker.sh deploy --host <ip-or-host> --remote-dir <dir>",
];

for (const snippet of usageSnippets) {
  test(`ros2-docker help usage includes ${snippet}`, () => {
    assertExit(helpResult, 0, "ros2-docker help");
    assertIncludes(helpOutput, snippet, `usage ${snippet}`);
  });
}

const environmentSnippets = [
  "ROS_DISTRO=humble|jazzy|kilted|lyrical|rolling",
  "RMW_IMPLEMENTATION=rmw_cyclonedds_cpp",
  "PACIFIC_RIM_GO_BUILD_TAGS=pacific_rim_ros2_rclgo",
  "ROS_BASE_IMAGE=ros:<distro>-ros-base",
  "ENABLE_VISION_STACK=0|1",
  "VISION_TARGET=none|pc-nvidia|jetson|auto",
  "ONNX_VERSION=1.16.2",
  "HARBOR_REGISTRY=<registry-host:port>",
  "HARBOR_PROJECT=library",
  "HARBOR_ROS_BASE_IMAGE=<registry>/<project>/ros:<distro>-ros-base",
  "HARBOR_PREFER_ROS_BASE=0",
  "HARBOR_IMAGE_PULL=0",
  "HARBOR_IMAGE_PUSH=0",
  "ROS_DOCKERHUB_FALLBACK=1",
];

for (const snippet of environmentSnippets) {
  test(`ros2-docker help environment includes ${snippet}`, () => {
    assertExit(helpResult, 0, "ros2-docker help");
    assertIncludes(helpOutput, snippet, `environment ${snippet}`);
  });
}

const deployOptionSnippets = [
  "--host <ip-or-host>",
  "--user <user>",
  "--password <password>",
  "--port <port>",
  "--packages-select <pkg>",
  "--executable <name>",
  "--domain-id <id>",
  "--image <name:tag>",
  "--container-name <name>",
  "--platform <linux/arch>",
  "--base-image <image>",
  "--network <mode>",
  "--env KEY=VALUE",
  "--device <spec>",
  "--volume <spec>",
  "--privileged",
  "--restart <policy>",
  "--logs-tail <lines>",
  "--no-logs",
  "--pull",
  "--no-cache",
  "--build-arg KEY=VALUE",
  "--dry-run",
];

for (const snippet of deployOptionSnippets) {
  test(`ros2-docker help deploy option includes ${snippet}`, () => {
    assertExit(helpResult, 0, "ros2-docker help");
    assertIncludes(helpOutput, snippet, `deploy option ${snippet}`);
  });
}
