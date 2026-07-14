import {
  assertIncludes,
  assertMatch,
  assertNotIncludes,
  readText,
  test,
} from "./lib/harness.mjs";

const files = {
  pr: readText("bin/pr.mjs"),
  ros2Run: readText("bin/ros2-run.mjs"),
  ros2Docker: readText("scripts/ros2-docker.sh"),
  installer: readText("deploy/ros2/install-vision-stack.sh"),
  localDockerfile: readText("deploy/local/ros2/Dockerfile"),
  remoteDockerfile: readText("deploy/remote/ros2/Dockerfile"),
  localCompose: readText("deploy/local/ros2/compose.yaml"),
  pcOverlay: readText("deploy/local/ros2/compose.vision-pc.yaml"),
  jetsonOverlay: readText("deploy/local/ros2/compose.vision-jetson.yaml"),
  packageJson: readText("package.json"),
  cppServiceConfig: readText("infra/communication/cpp/core/service_config.hpp"),
};

const sourceMustInclude = [
  ["scripts/ros2-docker.sh", files.ros2Docker, "vision_target_from_arch"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "vision_target_from_platform"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "resolve_local_vision_target"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "configure_vision_target"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "ROS2_IMAGE_TAG"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "ROS2_IMAGE_OVERRIDE"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "COMPOSE_ARGS"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "compose.vision-pc.yaml"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "compose.vision-jetson.yaml"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "VISION_TARGET=auto requires --platform"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "Auto-detected VISION_TARGET"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "NVIDIA_CONTAINER_RUNTIME"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "NVIDIA_DRIVER_CAPABILITIES"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "NVIDIA_VISIBLE_DEVICES"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "ROS_RUN_DEVICES"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "ROS_RUN_NETWORK"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "ROS_RUN_PRIVILEGED"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "write_ros_run_override"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "dockerhub_failure_output"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "run_docker_build_with_base_fallback"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "deploy_image_remote"],
  ["scripts/ros2-docker.sh", files.ros2Docker, 'DEPLOY_BASE_REV="${DEPLOY_BASE_REV:-runtime2}"'],
  ["scripts/ros2-docker.sh", files.ros2Docker, 'HARBOR_DEPLOY_BASE_REUSE_ROS2_IMAGE="${HARBOR_DEPLOY_BASE_REUSE_ROS2_IMAGE:-0}"'],
  ["scripts/ros2-docker.sh", files.ros2Docker, "deploy_base_image_is_current"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "PYTHON_RUNTIME_REQUIREMENTS_SHA=$(deploy_base_runtime_requirements_sha)"],
  ["deploy/ros2/install-vision-stack.sh", files.installer, "base_packages=("],
  ["deploy/ros2/install-vision-stack.sh", files.installer, "nvidia_packages=("],
  ["deploy/ros2/install-vision-stack.sh", files.installer, "apt-cache show"],
  ["deploy/ros2/install-vision-stack.sh", files.installer, "onnx==${ONNX_VERSION}"],
  ["deploy/local/ros2/Dockerfile", files.localDockerfile, "ARG ROS_DISTRO=humble"],
  ["deploy/remote/ros2/Dockerfile", files.remoteDockerfile, "ARG ROS_DISTRO=humble"],
  ["deploy/remote/ros2/Dockerfile", files.remoteDockerfile, "org.pacific-rim.python-runtime-requirements-sha"],
  ["deploy/local/ros2/compose.yaml", files.localCompose, "ROS_DISTRO: ${ROS_DISTRO:-humble}"],
  ["deploy/local/ros2/compose.vision-pc.yaml", files.pcOverlay, "gpus: all"],
  ["deploy/local/ros2/compose.vision-jetson.yaml", files.jetsonOverlay, "runtime: ${NVIDIA_CONTAINER_RUNTIME:-nvidia}"],
  ["bin/ros2-run.mjs", files.ros2Run, "ROS_RUN_DEVICES: devices.join"],
  ["bin/pr.mjs", files.pr, "runRos2Build"],
  ["package.json", files.packageJson, "\"test:stability\""],
  ["infra/communication/cpp/core/service_config.hpp", files.cppServiceConfig, "InjectOwnPublicInterfaceRoutes"],
  ["infra/communication/cpp/core/service_config.hpp", files.cppServiceConfig, "MiddlewaresFromAddresses"],
];

for (const [path, content, expected] of sourceMustInclude) {
  test(`${path} contains ${expected}`, () => {
    assertIncludes(content, expected, path);
  });
}

const sourceMustNotInclude = [
  ["scripts/ros2-docker.sh", files.ros2Docker, "local -n"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "Tagging compatible legacy deploy base image"],
  ["deploy/ros2/install-vision-stack.sh", files.installer, "pip install tensorrt"],
  ["deploy/local/ros2/Dockerfile", files.localDockerfile, "ARG ROS_DISTRO=jazzy"],
  ["deploy/remote/ros2/Dockerfile", files.remoteDockerfile, "ARG ROS_DISTRO=jazzy"],
  ["deploy/local/ros2/compose.yaml", files.localCompose, "ROS_DISTRO:-jazzy"],
  ["README package scripts", files.packageJson, "npm test"],
];

for (const [label, content, forbidden] of sourceMustNotInclude) {
  test(`${label} does not contain ${forbidden}`, () => {
    assertNotIncludes(content, forbidden, label);
  });
}

const regexContracts = [
  ["ros2-docker supported target list", files.ros2Docker, /none\|pc-nvidia\|jetson\|auto/],
  ["installer supported target list", files.installer, /none\|pc-nvidia\|jetson\|auto/],
  ["ros2-run supported distro set", files.ros2Run, /new Set\(\["humble", "jazzy", "kilted", "lyrical", "rolling"\]\)/],
  ["pr supported distro set", files.pr, /new Set\(\["humble", "jazzy", "kilted", "lyrical", "rolling"\]\)/],
  ["local Dockerfile target arch propagation", files.localDockerfile, /TARGETARCH="\$\{TARGETARCH\}"/],
  ["remote Dockerfile target arch propagation", files.remoteDockerfile, /TARGETARCH="\$\{TARGETARCH\}"/],
  ["compose ROS2 image override", files.localCompose, /image: \$\{ROS2_IMAGE:-pacific-rim-ros2:humble\}/],
  ["package test stability script", files.packageJson, /"test:stability": "node test\/run\.mjs"/],
];

for (const [label, content, pattern] of regexContracts) {
  test(label, () => {
    assertMatch(content, pattern, label);
  });
}

const architectureMappings = [
  ["scripts/ros2-docker.sh", files.ros2Docker, "amd64|x86_64", "pc-nvidia"],
  ["scripts/ros2-docker.sh", files.ros2Docker, "arm64|aarch64", "jetson"],
  ["deploy/ros2/install-vision-stack.sh", files.installer, "amd64|x86_64", "pc-nvidia"],
  ["deploy/ros2/install-vision-stack.sh", files.installer, "arm64|aarch64", "jetson"],
];

for (const [path, content, archPattern, target] of architectureMappings) {
  test(`${path} maps ${archPattern} to ${target}`, () => {
    assertIncludes(content, archPattern, `${path} arch`);
    assertIncludes(content, target, `${path} target`);
  });
}
