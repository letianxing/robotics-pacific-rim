import {
  assertIncludes,
  assertMatch,
  readText,
  test,
} from "./lib/harness.mjs";

const localDockerfile = readText("deploy/local/ros2/Dockerfile");
const remoteDockerfile = readText("deploy/remote/ros2/Dockerfile");
const pythonRuntimeRequirements = readText("deploy/ros2/python-runtime-requirements.txt");
const compose = readText("deploy/local/ros2/compose.yaml");
const pcOverlay = readText("deploy/local/ros2/compose.vision-pc.yaml");
const jetsonOverlay = readText("deploy/local/ros2/compose.vision-jetson.yaml");

for (const [label, dockerfile] of [
  ["local", localDockerfile],
  ["remote", remoteDockerfile],
]) {
  test(`${label} Dockerfile defaults to Humble`, () => {
    assertMatch(dockerfile, /^ARG ROS_DISTRO=humble/m, `${label} Humble default`);
  });

  test(`${label} Dockerfile wires vision installer`, () => {
    assertIncludes(dockerfile, "COPY deploy/ros2/install-vision-stack.sh", `${label} installer copy`);
    assertIncludes(dockerfile, "ENABLE_VISION_STACK=\"${ENABLE_VISION_STACK}\"", `${label} enable arg`);
    assertIncludes(dockerfile, "VISION_TARGET=\"${VISION_TARGET}\"", `${label} target arg`);
    assertIncludes(dockerfile, "TARGETARCH=\"${TARGETARCH}\"", `${label} target arch`);
    assertIncludes(dockerfile, "ONNX_VERSION=\"${ONNX_VERSION}\"", `${label} onnx arg`);
  });

  test(`${label} Dockerfile exposes vision metadata`, () => {
    assertIncludes(dockerfile, "ENV ENABLE_VISION_STACK=${ENABLE_VISION_STACK}", `${label} enable env`);
    assertIncludes(dockerfile, "ENV VISION_TARGET=${VISION_TARGET}", `${label} target env`);
    assertIncludes(dockerfile, "ENV ONNX_VERSION=${ONNX_VERSION}", `${label} onnx env`);
  });

  test(`${label} Dockerfile installs Pydantic v2 for Python ROS nodes`, () => {
    assertIncludes(dockerfile, "python-runtime-requirements.txt", `${label} runtime requirements`);
    assertIncludes(pythonRuntimeRequirements, "pydantic>=2", "pydantic runtime dependency");
  });
}

test("local compose passes vision build args and Humble defaults", () => {
  assertIncludes(compose, "ROS_DISTRO: ${ROS_DISTRO:-humble}", "compose Humble default");
  assertIncludes(compose, "ROS_BASE_IMAGE: ${ROS_BASE_IMAGE:-ros:${ROS_DISTRO:-humble}-ros-base}", "compose Humble base");
  assertIncludes(compose, "ENABLE_VISION_STACK: ${ENABLE_VISION_STACK:-0}", "compose enable arg");
  assertIncludes(compose, "VISION_TARGET: ${VISION_TARGET:-none}", "compose target arg");
  assertIncludes(compose, "ONNX_VERSION: ${ONNX_VERSION:-1.16.2}", "compose onnx arg");
  assertIncludes(compose, "image: ${ROS2_IMAGE:-pacific-rim-ros2:humble}", "compose image override");
});

test("PC NVIDIA overlay requests Docker GPU runtime", () => {
  assertIncludes(pcOverlay, "gpus: all", "PC GPU overlay");
  assertIncludes(pcOverlay, "NVIDIA_VISIBLE_DEVICES", "PC visible devices");
  assertIncludes(pcOverlay, "NVIDIA_DRIVER_CAPABILITIES", "PC driver caps");
});

test("Jetson overlay requests NVIDIA runtime", () => {
  assertIncludes(jetsonOverlay, "runtime: ${NVIDIA_CONTAINER_RUNTIME:-nvidia}", "Jetson runtime");
  assertIncludes(jetsonOverlay, "NVIDIA_VISIBLE_DEVICES", "Jetson visible devices");
  assertIncludes(jetsonOverlay, "NVIDIA_DRIVER_CAPABILITIES", "Jetson driver caps");
});
