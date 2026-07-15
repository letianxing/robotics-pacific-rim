import {
  assertIncludes,
  assertNotIncludes,
  readText,
  test,
} from "./lib/harness.mjs";

const readme = readText("README.md");
const readmeZh = readText("README_ZH.md");
const prCommands = readText("pr-cmd-all.md");

for (const [label, text] of [
  ["README", readme],
  ["pr-cmd-all", prCommands],
]) {
  test(`${label} documents Humble as the ROS2 default`, () => {
    if (label === "README") {
      assertIncludes(text, "--ros2-version humble", `${label} Humble scaffold examples`);
      assertIncludes(text, "ros:humble-ros-base", `${label} Humble base image`);
    } else {
      assertIncludes(text, "ROS_DISTRO=humble", `${label} Humble default`);
    }
    assertNotIncludes(text, "默认 `ROS_DISTRO=jazzy`", `${label} no old Jazzy default`);
  });

  test(`${label} documents vision auto mapping`, () => {
    assertIncludes(text, "VISION_TARGET=auto", `${label} auto command`);
    assertIncludes(text, "amd64", `${label} amd64 mapping`);
    assertIncludes(text, "arm64", `${label} arm64 mapping`);
    assertIncludes(text, "pc-nvidia", `${label} PC target`);
    assertIncludes(text, "jetson", `${label} Jetson target`);
  });

  test(`${label} documents dry-run platform requirement`, () => {
    assertIncludes(text, "--dry-run", `${label} dry-run`);
    assertIncludes(text, "--platform linux/arm64", `${label} platform example`);
  });
}

test("README keeps plain ROS2 and vision profile commands distinct", () => {
  assertIncludes(readmeZh, "不设置 `VISION_TARGET` 时仍构建普通 ROS2 镜像", "plain image note");
  assertIncludes(readme, "ENABLE_VISION_STACK=1 ./pr ros2:build-image", "common vision command");
  assertIncludes(readme, "VISION_TARGET=auto ./pr ros2:build --packages-select demo_action", "profile build package");
});

test("README exposes language switch files", () => {
  assertIncludes(readme, "[English](./README_EN.md) | [中文](./README_ZH.md)", "English README language switch");
  assertIncludes(readmeZh, "[English](./README_EN.md) | [中文](./README_ZH.md)", "Chinese README language switch");
});

test("README documents AI Native service workflow", () => {
  assertIncludes(readme, "AI Native + Robotics", "English AI Native positioning");
  assertIncludes(readme, "vibe coding", "English vibe coding workflow");
  assertIncludes(readmeZh, "AI Native + Robotics", "Chinese AI Native positioning");
  assertIncludes(readmeZh, "vibe coding", "Chinese vibe coding workflow");
});
