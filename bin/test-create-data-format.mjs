#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootDir } from "./workspace.mjs";

const tempDir = await mkdtemp(join(tmpdir(), "pacific-rim-data-format-"));

try {
  const service = "demo_action_service";
  await mkdir(join(tempDir, "module", "service", service, "config"), { recursive: true });
  await writeFile(
    join(tempDir, "module", "service", service, "config", "config.yaml"),
    "service:\n  name: demo_action_service\n  runtime_package: demo_action\n",
    "utf8",
  );
  await writeFile(join(tempDir, "package.json"), '{"type":"module"}\n', "utf8");

  runDataFormat([
    "--service",
    "demo-action",
    "--kind",
    "msg",
    "--name",
    "RobotState",
    "--data",
    "string robot_id\nfloat32 battery",
  ]);
  assertIncludes(
    await readFile(join(tempDir, "pkg", "idl", service, "ros2", service, "msg", "RobotState.msg"), "utf8"),
    "float32 battery\n",
    "msg file",
  );
  assertIncludes(
    await readFile(join(tempDir, "pkg", "idl", service, "ros2", service, "CMakeLists.txt"), "utf8"),
    '"msg/RobotState.msg"',
    "msg package CMake",
  );
  assertIncludes(
    await readFile(join(tempDir, "pkg", "idl", service, "ros2", service, "package.xml"), "utf8"),
    "<member_of_group>rosidl_interface_packages</member_of_group>",
    "msg package manifest",
  );

  runDataFormat([
    "-s",
    service,
    "-k",
    "srv",
    "-n",
    "Plan",
    "--data",
    "string goal\n---\nbool accepted",
  ]);
  assertIncludes(
    await readFile(join(tempDir, "pkg", "idl", service, "ros2", service, "srv", "Plan.srv"), "utf8"),
    "---\nbool accepted\n",
    "srv file",
  );
  assertIncludes(
    await readFile(join(tempDir, "pkg", "idl", service, "ros2", service, "CMakeLists.txt"), "utf8"),
    '"srv/Plan.srv"',
    "srv package CMake",
  );

  runDataFormat([
    "-s",
    service,
    "-k",
    "proto",
    "-n",
    "RobotState",
    "--data",
    "string robot_id = 1;\nfloat battery = 2;",
  ]);
  assertIncludes(
    await readFile(join(tempDir, "pkg", "idl", service, "pb", `${service}.proto`), "utf8"),
    "message RobotState {\n  string robot_id = 1;\n  float battery = 2;\n}\n",
    "proto file",
  );

  runDataFormat([
    "-s",
    service,
    "-k",
    "proto",
    "--data",
    "message Telemetry {\n  uint32 seq = 1;\n}",
  ]);
  assertIncludes(
    await readFile(join(tempDir, "pkg", "idl", service, "pb", `${service}.proto`), "utf8"),
    "message Telemetry {\n  uint32 seq = 1;\n}\n",
    "proto append",
  );

  runDataFormat([
    "-s",
    service,
    "-k",
    "dds_idl",
    "-n",
    "DdsState",
    "--data",
    "string<32> robot_id;\nfloat battery;",
  ]);
  assertIncludes(
    await readFile(join(tempDir, "pkg", "idl", service, "dds", service, "DdsState.idl"), "utf8"),
    "struct DdsState {\n  string<32> robot_id;\n  float battery;\n};\n",
    "dds idl file",
  );

  expectFailure([
    "-s",
    service,
    "-k",
    "proto",
    "-n",
    "Broken",
    "--data",
    "string missing_tag;",
  ], "Invalid proto field");

  console.log("create data format test passed");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function runDataFormat(args) {
  const result = spawnSync(process.execPath, [join(rootDir, "bin", "create-data-format.mjs"), ...args], {
    cwd: tempDir,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`data-format ${args.join(" ")} failed with exit ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
}

function expectFailure(args, message) {
  const result = spawnSync(process.execPath, [join(rootDir, "bin", "create-data-format.mjs"), ...args], {
    cwd: tempDir,
    encoding: "utf8",
  });
  if (result.status === 0) {
    throw new Error(`data-format ${args.join(" ")} should have failed`);
  }
  if (!`${result.stdout}\n${result.stderr}`.includes(message)) {
    throw new Error(`Expected failure to include ${JSON.stringify(message)}, got:\n${result.stdout}\n${result.stderr}`);
  }
}

function assertIncludes(value, expected, label) {
  if (!value.includes(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)} in:\n${value}`);
  }
}
