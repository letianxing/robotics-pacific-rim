import {
  assertExit,
  assertIncludes,
  assertNotIncludes,
  commandOutput,
  readText,
  runCommand,
  test,
} from "./lib/harness.mjs";

const installer = readText("deploy/ros2/install-vision-stack.sh");

function bashArrayBody(name) {
  const match = installer.match(new RegExp(`${name}=\\(\\n([\\s\\S]*?)\\n\\)`, "m"));
  if (!match) {
    throw new Error(`Missing bash array ${name}`);
  }
  return match[1];
}

const commonPackages = [
  "build-essential",
  "cmake",
  "git",
  "libopencv-dev",
  "pkg-config",
  "python3-colcon-common-extensions",
  "python3-numpy",
  "python3-opencv",
  "python3-pip",
  "python3-rosdep",
  "python3-serial",
  "ros-${ROS_DISTRO}-ament-cmake",
  "ros-${ROS_DISTRO}-ament-cmake-python",
  "ros-${ROS_DISTRO}-geometry-msgs",
  "ros-${ROS_DISTRO}-launch",
  "ros-${ROS_DISTRO}-launch-ros",
  "ros-${ROS_DISTRO}-nav-msgs",
  "ros-${ROS_DISTRO}-rcl-interfaces",
  "ros-${ROS_DISTRO}-rclcpp",
  "ros-${ROS_DISTRO}-rclpy",
  "ros-${ROS_DISTRO}-rosidl-default-generators",
  "ros-${ROS_DISTRO}-rosidl-default-runtime",
  "ros-${ROS_DISTRO}-sensor-msgs",
  "ros-${ROS_DISTRO}-std-msgs",
];

for (const packageName of commonPackages) {
  test(`vision installer includes common dependency ${packageName}`, () => {
    assertIncludes(installer, packageName, `common package ${packageName}`);
  });
}

const nvidiaPackages = [
  "libnvinfer-dev",
  "libnvinfer-plugin-dev",
  "libnvonnxparsers-dev",
];

for (const packageName of nvidiaPackages) {
  test(`vision installer includes NVIDIA dependency ${packageName}`, () => {
    assertIncludes(installer, packageName, `NVIDIA package ${packageName}`);
  });
}

test("vision installer keeps TensorRT Python on JetPack side", () => {
  assertIncludes(installer, "TensorRT Python should come from JetPack, not pip", "JetPack TensorRT guidance");
  assertNotIncludes(installer, "pip install tensorrt", "no TensorRT pip install");
});

test("vision installer configures Jetson apt source before TensorRT package checks", () => {
  assertIncludes(installer, "JETSON_L4T_RELEASE", "configurable Jetson L4T release");
  assertIncludes(installer, "jetson-ota-public.asc", "Jetson apt key");
  assertIncludes(installer, "repo.download.nvidia.com/jetson", "Jetson apt repository");
  assertIncludes(installer, "configure_jetson_apt_source", "Jetson apt source setup function");
  assertIncludes(installer, "VISION_TARGET}\" == \"jetson\"", "Jetson source setup branch");
});

test("vision installer defaults Jetson apt source to common only", () => {
  assertIncludes(installer, 'JETSON_L4T_REPOSITORIES="${JETSON_L4T_REPOSITORIES:-common}"', "minimal Jetson repository default");
  assertNotIncludes(installer, "common som ffmpeg", "no extra Jetson apt repositories by default");
});

test("vision installer wraps apt installs with retry options", () => {
  assertIncludes(installer, "APT_RETRIES", "configurable apt retry count");
  assertIncludes(installer, "apt_get_install", "apt install retry wrapper");
  assertIncludes(installer, "Acquire::Retries", "apt acquire retry option");
  assertIncludes(installer, "apt_get_install \"${base_packages[@]}\"", "base packages use wrapper");
  assertIncludes(installer, "apt_get_install \"${nvidia_packages[@]}\"", "NVIDIA packages use wrapper");
});

test("vision installer can rewrite Ubuntu ports apt source to a faster mirror", () => {
  assertIncludes(installer, "APT_UBUNTU_PORTS_MIRROR", "configurable Ubuntu ports mirror");
  assertIncludes(installer, "configure_ubuntu_ports_mirror", "Ubuntu ports mirror function");
  assertIncludes(installer, "mirrors.tuna.tsinghua.edu.cn/ubuntu-ports", "default Ubuntu ports mirror");
  assertIncludes(installer, "ubuntu.sources", "deb822 source support");
});

test("vision installer removes stale non-architecture OpenCV CMake config", () => {
  assertIncludes(installer, "install_opencv_dev_apt_candidate", "OpenCV dev candidate repair function");
  assertIncludes(installer, "apt-cache policy libopencv-dev", "OpenCV dev candidate lookup");
  assertIncludes(installer, "--allow-downgrades", "OpenCV dev downgrade support");
  assertIncludes(installer, "repair_opencv_dev_library_links", "OpenCV dev library link repair function");
  assertIncludes(installer, "OpenCVModules-release.cmake", "OpenCV imported library path check");
  assertIncludes(installer, "_IMPORT_PREFIX", "OpenCV imported prefix path support");
  assertIncludes(installer, "remove_stale_opencv_cmake_config", "stale OpenCV CMake cleanup function");
  assertIncludes(installer, "/usr/lib/cmake/opencv4", "legacy OpenCV CMake path");
  assertIncludes(installer, "OpenCVModules.cmake", "OpenCV module file check");
  assertIncludes(installer, "libopencv_core", "missing OpenCV core detection");
  assertIncludes(installer, "rm -rf", "stale OpenCV config removal");
});

test("vision installer uses Jetson CUDA runtime dev packages instead of Ubuntu CUDA toolkit", () => {
  assertIncludes(installer, "NVIDIA_JETSON_CUDA_VERSION", "configurable Jetson CUDA version");
  assertIncludes(installer, "cuda-cudart-dev-${NVIDIA_JETSON_CUDA_VERSION}", "Jetson CUDA runtime dev package");
  assertIncludes(installer, "cuda-crt-${NVIDIA_JETSON_CUDA_VERSION}", "Jetson CUDA crt package");
  assertNotIncludes(installer, "repair_jetson_cuda_include_links", "no hand-written CUDA crt header repair");
  assertNotIncludes(installer, "nvidia-cuda-toolkit", "no Ubuntu CUDA toolkit for Jetson");
  assertNotIncludes(installer, "nvidia-cuda-dev", "no Ubuntu CUDA dev package for Jetson");
  assertNotIncludes(installer, "python3-pycuda", "no PyCUDA package for Jetson deploy base");
});

test("vision installer keeps Jetson TensorRT install to runtime and header packages", () => {
  const jetsonPackages = bashArrayBody("jetson_nvidia_packages");
  assertIncludes(jetsonPackages, "libnvinfer-headers-dev", "Jetson TensorRT headers");
  assertIncludes(jetsonPackages, "libnvinfer-headers-plugin-dev", "Jetson TensorRT plugin headers");
  assertIncludes(jetsonPackages, "libnvinfer10", "Jetson TensorRT runtime");
  assertIncludes(jetsonPackages, "libnvinfer-plugin10", "Jetson TensorRT plugin runtime");
  assertIncludes(jetsonPackages, "libnvonnxparsers10", "Jetson ONNX parser runtime");
  assertIncludes(jetsonPackages, "libopencv", "Jetson OpenCV runtime matching Jetson libopencv-dev");
  assertNotIncludes(jetsonPackages, "libnvinfer-dev", "no huge Jetson TensorRT dev package");
  assertNotIncludes(jetsonPackages, "libnvinfer-plugin-dev", "no huge Jetson TensorRT plugin dev package");
  assertNotIncludes(jetsonPackages, "libnvonnxparsers-dev", "no Jetson ONNX parser dev package");
});

test("vision installer creates Jetson TensorRT library links for CMake find_library", () => {
  assertIncludes(installer, "create_jetson_tensorrt_dev_links", "Jetson TensorRT link helper");
  assertIncludes(installer, "libnvinfer.so", "nvinfer unversioned library link");
  assertIncludes(installer, "libnvinfer_plugin.so", "nvinfer plugin unversioned library link");
  assertIncludes(installer, "libnvonnxparser.so", "ONNX parser unversioned library link");
});

test("vision installer supports auto target from TARGETARCH", () => {
  assertIncludes(installer, "TARGETARCH", "TARGETARCH support");
  assertIncludes(installer, "VISION_TARGET=\"$(vision_target_from_arch", "auto target resolution");
  assertIncludes(installer, "amd64|x86_64", "pc architecture mapping");
  assertIncludes(installer, "arm64|aarch64", "Jetson architecture mapping");
});

test("disabled vision installer exits before apt work", () => {
  const result = runCommand("bash", ["deploy/ros2/install-vision-stack.sh"], {
    env: { ENABLE_VISION_STACK: "0", VISION_TARGET: "none" },
  });
  assertExit(result, 0, "disabled installer");
  assertIncludes(commandOutput(result), "Vision stack disabled.", "disabled message");
});

test("invalid vision target exits without apt work", () => {
  const result = runCommand("bash", ["deploy/ros2/install-vision-stack.sh"], {
    env: { VISION_TARGET: "not-real" },
  });
  assertExit(result, 2, "invalid installer target");
  assertIncludes(commandOutput(result), "Unsupported VISION_TARGET=not-real", "invalid message");
});

test("auto target rejects unsupported architecture before apt work", () => {
  const result = runCommand("bash", ["deploy/ros2/install-vision-stack.sh"], {
    env: { VISION_TARGET: "auto", TARGETARCH: "mips64" },
  });
  assertExit(result, 2, "unsupported auto arch");
  assertIncludes(commandOutput(result), "Cannot auto-detect VISION_TARGET", "unsupported arch message");
});
