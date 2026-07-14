import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertExit,
  assertIncludes,
  commandOutput,
  rootDir,
  runCommand,
  test,
} from "./lib/harness.mjs";

test("ROS2 scaffold defaults to Humble for all languages", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pacific-rim-stability-scaffold-"));
  try {
    await cp(join(rootDir, "bin"), join(tempDir, "bin"), { recursive: true });
    const cases = [
      ["vision-camera", ["module", "vision-camera", "--ros2", "python"], "python"],
      ["motion-core", ["module", "motion-core", "--ros2", "cpp"], "cpp"],
      ["bridge-sidecar", ["module", "bridge-sidecar", "--ros2", "go"], "go"],
    ];

    for (const [name, args, language] of cases) {
      const result = runCommand(process.execPath, [join(tempDir, "bin", "create.mjs"), ...args], { cwd: tempDir });
      assertExit(result, 0, `create ${name}`);
      const projectJson = await readFile(join(tempDir, "module", "service", `${name.replaceAll("-", "_")}_service`, "project.json"), "utf8");
      assertIncludes(projectJson, "\"ros2:humble\"", `${language} Humble tag`);
      assertIncludes(projectJson, `"language:${language}"`, `${language} language tag`);
      if (language !== "go") {
        assertIncludes(projectJson, "ROS_DISTRO=humble scripts/ros2-docker.sh build", `${language} Humble build command`);
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ROS2 scaffold still supports explicit Jazzy override", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pacific-rim-stability-scaffold-jazzy-"));
  try {
    await cp(join(rootDir, "bin"), join(tempDir, "bin"), { recursive: true });
    const result = runCommand(process.execPath, [
      join(tempDir, "bin", "create.mjs"),
      "module",
      "legacy-vision",
      "--ros2",
      "python",
      "--ros2-version",
      "jazzy",
    ], { cwd: tempDir });
    assertExit(result, 0, "create explicit Jazzy");
    const projectJson = await readFile(join(tempDir, "module", "service", "legacy_vision_service", "project.json"), "utf8");
    assertIncludes(projectJson, "\"ros2:jazzy\"", "Jazzy tag");
    assertIncludes(projectJson, "ROS_DISTRO=jazzy scripts/ros2-docker.sh build", "Jazzy build command");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

const invalidCreateArgs = [
  ["module", "BadName"],
  ["module", "bad_name"],
  ["module", "bad--name"],
  ["module", "123"],
  ["module", "bad name"],
  ["module", "bad", "--ros2", "ruby"],
  ["module", "bad", "--ros2", "python", "--distro", "galactic"],
];

for (const args of invalidCreateArgs) {
  test(`create rejects invalid input: ${args.join(" ")}`, async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pacific-rim-stability-scaffold-invalid-"));
    try {
      await cp(join(rootDir, "bin"), join(tempDir, "bin"), { recursive: true });
      const result = runCommand(process.execPath, [join(tempDir, "bin", "create.mjs"), ...args], { cwd: tempDir });
      if (result.status === 0) {
        throw new Error(`create should have rejected ${args.join(" ")}\n${commandOutput(result)}`);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}
