import {
  assertExit,
  assertIncludes,
  assertNotIncludes,
  commandOutput,
  runCommand,
  test,
} from "./lib/harness.mjs";

const expectedScripts = [
  "affected",
  "build",
  "check",
  "check:all",
  "create",
  "graph",
  "list",
  "observability:down",
  "observability:logs",
  "observability:up",
  "projects",
  "remove",
  "ros2:build",
  "ros2:build-image",
  "ros2:deploy",
  "ros2:exec",
  "ros2:run",
  "ros2:shell",
  "test:go",
  "test:stability",
  "trace:demo",
];

test("./pr scripts lists test:stability and common scripts", () => {
  const result = runCommand("./pr", ["scripts"]);
  assertExit(result, 0, "./pr scripts");
  for (const script of expectedScripts) {
    assertIncludes(result.stdout, script, `script ${script}`);
  }
});

const expectedHelpSnippets = [
  "./pr check",
  "./pr check:comm",
  "./pr check:all",
  "./pr test:go",
  "./pr ros2:build --packages-select smoke_test1",
  "./pr ros2:exec --network host ros2 topic list",
  "./pr ros2:deploy --host 192.168.1.20 --packages-select smoke_test1 --domain-id 42",
  "./pr create module navigation",
];

for (const snippet of expectedHelpSnippets) {
  test(`./pr help includes ${snippet}`, () => {
    const result = runCommand("./pr", ["--help"]);
    assertExit(result, 0, "./pr --help");
    assertIncludes(result.stdout, snippet, `help snippet ${snippet}`);
  });
}

test("./pr version prints package version", () => {
  const result = runCommand("./pr", ["--version"]);
  assertExit(result, 0, "./pr --version");
  assertIncludes(result.stdout, "pacific-rim", "package name");
});

test("./pr rejects unknown command with useful message", () => {
  const result = runCommand("./pr", ["does-not-exist"]);
  if (result.status === 0) {
    throw new Error(`unknown command should fail\n${commandOutput(result)}`);
  }
  assertIncludes(commandOutput(result), "Unknown command or npm script", "unknown command message");
});

test("./pr ros2:deploy dry-run hides password in status line", () => {
  const result = runCommand("./pr", [
    "ros2:deploy",
    "--dry-run",
    "--host",
    "198.51.100.20",
    "--user",
    "robot",
    "--password",
    "secret-value",
    "--platform",
    "linux/amd64",
    "--packages-select",
    "middleware_pub_test",
    "--domain-id",
    "42",
    "--no-logs",
  ]);
  assertExit(result, 0, "redacted deploy dry-run");
  const output = commandOutput(result);
  assertIncludes(output, "--password <redacted>", "redacted status");
  assertNotIncludes(output, "[PR SUCCESS] ./pr ros2:deploy --dry-run --host 198.51.100.20 --user robot --password secret-value", "plain password in status");
});

test("./pr ros2:deploy generates interfaces before deploy", () => {
  const result = runCommand("./pr", [
    "ros2:deploy",
    "--dry-run",
    "--host",
    "198.51.100.20",
    "--platform",
    "linux/amd64",
    "--packages-select",
    "middleware_pub_test",
    "--domain-id",
    "42",
    "--no-logs",
  ]);
  assertExit(result, 0, "deploy dry-run interface generation");
  assertIncludes(commandOutput(result), "Generating interfaces before ROS2 deploy.", "deploy interface generation");
});
