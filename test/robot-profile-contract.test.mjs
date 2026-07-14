import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assert,
  assertExit,
  assertIncludes,
  commandOutput,
  readText,
  rootDir,
  runCommand,
  test,
} from "./lib/harness.mjs";

const catalog = JSON.parse(readText("pkg/robot/capabilities.json"));
const pureProfile = JSON.parse(readText("deploy/robot-profiles/pure-driver-sample.json"));
const prSource = readText("bin/pr.mjs");

function capabilityIds() {
  return new Set(catalog.capabilities.map((capability) => capability.id));
}

function runRobotProfiles(args) {
  return runCommand("node", ["bin/robot-profiles.mjs", ...args]);
}

test("robot capability catalog has stable unique capability ids", () => {
  const ids = catalog.capabilities.map((capability) => capability.id);
  assert(ids.length >= 20, "expected at least 20 robot capabilities");
  assert(new Set(ids).size === ids.length, "capability ids must be unique");
  assert(ids.includes("state.inertial"), "state.inertial capability is required");
  assert(ids.includes("motion.base_velocity"), "motion.base_velocity capability is required");
  assert(ids.includes("ai.internal_state"), "ai.internal_state capability is required");
});

test("inertial capability describes angular velocity", () => {
  const inertial = catalog.capabilities.find((capability) => capability.id === "state.inertial");
  assert(inertial, "state.inertial capability is missing");
  const signalNames = inertial.signals.map((signal) => `${signal.name}:${signal.unit}`);
  assertIncludes(signalNames.join(","), "angular_velocity:rad/s", "state.inertial signals");
});

test("pure driver sample profile references existing services", () => {
  assert(pureProfile.status === "active", "pure-driver-sample must stay active");
  for (const serviceEntry of pureProfile.services) {
    const projectPath = join(rootDir, "module", "service", serviceEntry.service, "project.json");
    assert(existsSync(projectPath), `missing service project: ${serviceEntry.service}`);
    const project = JSON.parse(readFileSync(projectPath, "utf8"));
    assert(
      project.ros2?.package === serviceEntry.package,
      `${serviceEntry.service} package must match ${serviceEntry.package}`
    );
  }
});

test("robot profiles only reference known capabilities", () => {
  const ids = capabilityIds();
  for (const profileName of [
    "pure-driver-sample",
    "humanoid-reference",
    "four-wheel-reference",
    "biped-reference",
    "tracked-reference",
  ]) {
    const profile = JSON.parse(readText(`deploy/robot-profiles/${profileName}.json`));
    for (const capabilityId of profile.capabilities) {
      assert(ids.has(capabilityId), `${profileName} references unknown capability ${capabilityId}`);
    }
    for (const serviceEntry of [...(profile.services ?? []), ...(profile.plannedServices ?? [])]) {
      for (const capabilityId of serviceEntry.capabilities ?? []) {
        assert(ids.has(capabilityId), `${profileName}/${serviceEntry.service} references unknown capability ${capabilityId}`);
      }
    }
  }
});

test("robot profile CLI check passes", () => {
  const result = runRobotProfiles(["check"]);
  assertExit(result, 0, "robot profile check");
  assertIncludes(commandOutput(result), "Robot profiles passed", "robot profile check output");
});

test("robot profile CLI lists active and template profiles", () => {
  const result = runRobotProfiles(["list"]);
  assertExit(result, 0, "robot profile list");
  const output = commandOutput(result);
  assertIncludes(output, "pure-driver-sample", "robot profile list");
  assertIncludes(output, "humanoid-reference", "robot profile list");
});

test("robot profile deploy dry run selects active service packages", () => {
  const result = runRobotProfiles(["deploy", "pure-driver-sample", "--dry-run", "--host", "192.168.1.20"]);
  assertExit(result, 0, "robot profile deploy dry-run");
  const output = commandOutput(result);
  assertIncludes(output, "./pr ros2:deploy --packages-select", "robot profile deploy dry-run");
  assertIncludes(output, "imu middleware_pub_test middleware_sub_test middleware_rpc_client_test middleware_rpc_server_test", "robot profile deploy packages");
  assertIncludes(output, "--domain-id 42", "robot profile deploy default domain");
});

test("template robot profile cannot deploy", () => {
  const result = runRobotProfiles(["deploy", "humanoid-reference", "--dry-run"]);
  assertExit(result, 1, "template profile deploy");
  assertIncludes(commandOutput(result), "only active profiles can deploy", "template deploy output");
});

test("pr exposes robot profile commands", () => {
  for (const command of ["robot:profiles", "robot:show", "robot:check", "robot:deploy"]) {
    assertIncludes(prSource, command, `bin/pr.mjs exposes ${command}`);
  }
});
