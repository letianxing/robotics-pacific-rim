import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  assertExit,
  assertIncludes,
  assertNotIncludes,
  commandOutput,
  rootDir,
  runCommand,
  test,
} from "./lib/harness.mjs";

function fakeDockerEnv(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pacific-rim-fake-docker-"));
  const dockerPath = join(dir, "docker");
  writeFileSync(dockerPath, `#!/usr/bin/env bash
printf 'FAKE_DOCKER'
for arg in "$@"; do
  printf ' <%s>' "$arg"
done
printf '\\n'
printf 'FAKE_ENV ROS_DISTRO=%s ENABLE_VISION_STACK=%s VISION_TARGET=%s ROS2_IMAGE=%s\\n' "\${ROS_DISTRO:-}" "\${ENABLE_VISION_STACK:-}" "\${VISION_TARGET:-}" "\${ROS2_IMAGE:-}"
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  exit "\${FAKE_IMAGE_INSPECT_STATUS:-0}"
fi
exit 0
`);
  chmodSync(dockerPath, 0o755);

  return {
    PATH: `${dir}${delimiter}${process.env.PATH}`,
    ...extraEnv,
  };
}

function runRos2Docker(args, env = {}) {
  return runCommand("bash", ["scripts/ros2-docker.sh", ...args], {
    env: fakeDockerEnv(env),
  });
}

const localCompose = `${rootDir}/deploy/local/ros2/compose.yaml`;
const pcOverlay = `${rootDir}/deploy/local/ros2/compose.vision-pc.yaml`;
const jetsonOverlay = `${rootDir}/deploy/local/ros2/compose.vision-jetson.yaml`;

test("local build-image uses base compose file and Humble image tag", () => {
  const result = runRos2Docker(["build-image"]);
  assertExit(result, 0, "build-image plain");
  const output = commandOutput(result);
  assertIncludes(output, `<compose> <-f> <${localCompose}> <build> <ros2>`, "compose build");
  assertIncludes(output, "FAKE_ENV ROS_DISTRO=humble ENABLE_VISION_STACK=0 VISION_TARGET=none ROS2_IMAGE=pacific-rim-ros2:humble", "plain image env");
  assertNotIncludes(output, "compose.vision-", "no vision overlay");
});

test("local build-image common vision keeps base compose only", () => {
  const result = runRos2Docker(["build-image"], { ENABLE_VISION_STACK: "1" });
  assertExit(result, 0, "build-image common vision");
  const output = commandOutput(result);
  assertIncludes(output, "ROS2_IMAGE=pacific-rim-ros2:humble-vision", "vision image tag");
  assertNotIncludes(output, "compose.vision-pc.yaml", "no pc overlay");
  assertNotIncludes(output, "compose.vision-jetson.yaml", "no jetson overlay");
});

test("local build-image pc-nvidia adds PC compose overlay", () => {
  const result = runRos2Docker(["build-image"], { VISION_TARGET: "pc-nvidia" });
  assertExit(result, 0, "build-image pc-nvidia");
  const output = commandOutput(result);
  assertIncludes(output, `<-f> <${pcOverlay}>`, "pc overlay");
  assertIncludes(output, "ENABLE_VISION_STACK=1 VISION_TARGET=pc-nvidia ROS2_IMAGE=pacific-rim-ros2:humble-vision-pc-nvidia", "pc image env");
  assertNotIncludes(output, "compose.vision-jetson.yaml", "no jetson overlay");
});

test("local build-image jetson adds Jetson compose overlay", () => {
  const result = runRos2Docker(["build-image"], { VISION_TARGET: "jetson" });
  assertExit(result, 0, "build-image jetson");
  const output = commandOutput(result);
  assertIncludes(output, `<-f> <${jetsonOverlay}>`, "jetson overlay");
  assertIncludes(output, "ENABLE_VISION_STACK=1 VISION_TARGET=jetson ROS2_IMAGE=pacific-rim-ros2:humble-vision-jetson", "jetson image env");
  assertNotIncludes(output, "compose.vision-pc.yaml", "no pc overlay");
});

test("local build-image respects ROS2_IMAGE override", () => {
  const result = runRos2Docker(["build-image"], {
    ROS2_IMAGE: "registry.local/custom/ros2:dev",
    VISION_TARGET: "pc-nvidia",
  });
  assertExit(result, 0, "build-image override");
  assertIncludes(commandOutput(result), "ROS2_IMAGE=registry.local/custom/ros2:dev", "image override");
});

const observabilityServices = ["loki", "tempo", "prometheus", "grafana", "otel-collector"];

for (const service of observabilityServices) {
  test(`local observability up includes ${service}`, () => {
    const result = runRos2Docker(["up-observability"]);
    assertExit(result, 0, "up-observability");
    assertIncludes(commandOutput(result), `<${service}>`, `service ${service}`);
  });
}

test("local observability up prints external URL hints", () => {
  const result = runRos2Docker(["up-observability"], {
    PLATFORM_GRAFANA_URL: "http://localhost:16000",
    PLATFORM_PROMETHEUS_URL: "http://localhost:18180",
  });
  assertExit(result, 0, "up-observability urls");
  const output = commandOutput(result);
  assertIncludes(output, "Grafana:", "grafana hint");
  assertIncludes(output, "external: http://<host-ip>:16000", "grafana external hint");
  assertIncludes(output, "Prometheus:", "prometheus hint");
  assertIncludes(output, "external: http://<host-ip>:18180", "prometheus external hint");
});

test("local observability logs follows all services", () => {
  const result = runRos2Docker(["logs-observability"]);
  assertExit(result, 0, "logs-observability");
  const output = commandOutput(result);
  assertIncludes(output, "<logs> <-f>", "logs follow");
  for (const service of observabilityServices) {
    assertIncludes(output, `<${service}>`, `logs service ${service}`);
  }
});

test("local down uses docker compose down", () => {
  const result = runRos2Docker(["down"]);
  assertExit(result, 0, "down");
  assertIncludes(commandOutput(result), `<compose> <-f> <${localCompose}> <down>`, "compose down");
});

test("local shell uses existing ROS2 image when present", () => {
  const result = runRos2Docker(["shell"]);
  assertExit(result, 0, "shell");
  const output = commandOutput(result);
  assertNotIncludes(output, "was not found locally", "existing image should not trigger build");
  assertNotIncludes(output, "<build> <ros2>", "existing image should skip build");
  assertIncludes(output, "<run> <--rm> <ros2> <bash>", "shell run");
});

test("local shell builds ROS2 image when missing", () => {
  const result = runRos2Docker(["shell"], {
    FAKE_IMAGE_INSPECT_STATUS: "1",
    HARBOR_IMAGE_PULL: "0",
  });
  assertExit(result, 0, "shell missing image");
  const output = commandOutput(result);
  assertIncludes(output, "ROS2 image pacific-rim-ros2:humble was not found locally; building it.", "missing image message");
  assertIncludes(output, "<build> <ros2>", "fallback build");
  assertIncludes(output, "<run> <--rm> <ros2> <bash>", "shell run");
});

test("local shell supports host-network runtime override", () => {
  const result = runRos2Docker([
    "shell",
    "--network",
    "host",
    "--privileged",
    "--device",
    "/dev/kcanusbfd36:/dev/kcan36",
  ]);
  assertExit(result, 0, "shell runtime override");
  const output = commandOutput(result);
  assertIncludes(output, "pacific-rim-ros2-run.", "runtime override file");
  assertIncludes(output, "<run> <--rm> <ros2> <bash>", "shell run");
});

test("local build converts packages-select to packages-up-to by default", () => {
  const result = runRos2Docker(["build", "--packages-select", "smoke_test1"]);
  assertExit(result, 0, "build packages-select");
  const output = commandOutput(result);
  assertIncludes(output, "colcon --log-base log/humble build", "build command");
  assertIncludes(output, "--packages-up-to smoke_test1", "packages-up-to conversion");
  assertIncludes(output, "--build-base build/humble", "default build base");
  assertIncludes(output, "--install-base install/humble", "default install base");
});

test("local build keeps explicit packages-up-to", () => {
  const result = runRos2Docker(["build", "--packages-up-to", "camera_graph"]);
  assertExit(result, 0, "build packages-up-to");
  const output = commandOutput(result);
  assertIncludes(output, "--packages-up-to camera_graph", "explicit packages-up-to");
  assertNotIncludes(output, "--packages-select camera_graph", "no packages-select rewrite");
});

test("local build uses explicit log-base once", () => {
  const result = runRos2Docker(["build", "--log-base", "log/custom", "--packages-select", "smoke_test1"]);
  assertExit(result, 0, "build log-base");
  const output = commandOutput(result);
  assertIncludes(output, "colcon --log-base log/custom build", "custom build log base");
  assertNotIncludes(output, "build --log-base log/custom", "log-base removed from colcon args");
});

test("local test uses distro-scoped result paths", () => {
  const result = runRos2Docker(["test", "--packages-select", "smoke_test1"]);
  assertExit(result, 0, "test defaults");
  const output = commandOutput(result);
  assertIncludes(output, "colcon --log-base log/humble test", "test command");
  assertIncludes(output, "--build-base build/humble", "test build base");
  assertIncludes(output, "--install-base install/humble", "test install base");
  assertIncludes(output, "colcon test-result --test-result-base build/humble --verbose", "test result path");
});

test("local test honors explicit build-base and log-base", () => {
  const result = runRos2Docker(["test", "--build-base", "build/custom", "--log-base", "log/custom"]);
  assertExit(result, 0, "test explicit paths");
  const output = commandOutput(result);
  assertIncludes(output, "colcon --log-base log/custom test", "custom test log base");
  assertIncludes(output, "--build-base build/custom", "custom test build base");
  assertIncludes(output, "colcon test-result --test-result-base build/custom --verbose", "custom test result base");
});

test("local run forwards arbitrary ROS command", () => {
  const result = runRos2Docker(["run", "ros2", "topic", "list"]);
  assertExit(result, 0, "run command");
  const output = commandOutput(result);
  assertIncludes(output, "source /opt/ros/humble/setup.bash", "sources ROS base");
  assertIncludes(output, "source install/humble/setup.bash", "sources workspace install");
  assertIncludes(output, "ros2 topic list", "forwarded command");
});

test("local run adds a runtime compose override for network, privileged, and devices", () => {
  const result = runRos2Docker([
    "run",
    "--network",
    "host",
    "--privileged",
    "--device",
    "/dev/kcanusbfd36:/dev/kcan36",
    "ros2",
    "topic",
    "list",
  ]);
  assertExit(result, 0, "run runtime override");
  const output = commandOutput(result);
  assertIncludes(output, "pacific-rim-ros2-run.", "runtime override file");
  assertIncludes(output, "<run> <--rm>", "compose run");
});

test("local run still accepts runtime overrides from environment", () => {
  const result = runRos2Docker(["run", "ros2", "topic", "list"], {
    ROS_RUN_NETWORK: "host",
  });
  assertExit(result, 0, "run environment runtime override");
  assertIncludes(commandOutput(result), "pacific-rim-ros2-run.", "runtime override file");
});

test("local run without command fails with usage", () => {
  const result = runRos2Docker(["run"]);
  assertExit(result, 1, "run without command");
  assertIncludes(commandOutput(result), "scripts/ros2-docker.sh run <command...>", "run usage");
});

test("local unknown command fails with usage", () => {
  const result = runRos2Docker(["not-a-command"]);
  assertExit(result, 1, "unknown command");
  assertIncludes(commandOutput(result), "Usage:", "usage output");
});
