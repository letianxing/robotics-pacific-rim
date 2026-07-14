#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootDir } from "./workspace.mjs";

const tempDir = await mkdtemp(join(tmpdir(), "pacific-rim-create-scaffold-"));

try {
  await cp(join(rootDir, "bin"), join(tempDir, "bin"), { recursive: true });

  const cases = [
    {
      args: ["module", "navigation"],
      serviceName: "navigation_service",
      runtimePackage: "navigation",
      envPrefix: "NAVIGATION",
    },
    {
      args: ["module", "lidar-driver", "--ros2", "python", "--ros2-version", "jazzy"],
      serviceName: "lidar_driver_service",
      runtimePackage: "lidar_driver",
      envPrefix: "LIDAR_DRIVER",
    },
    {
      args: ["module", "drive-control", "--ros2", "cpp", "--distro", "humble"],
      serviceName: "drive_control_service",
      runtimePackage: "drive_control",
      envPrefix: "DRIVE_CONTROL",
    },
    {
      args: ["module", "brain-sidecar", "--ros2", "go", "--distro", "humble"],
      serviceName: "brain_sidecar_service",
      runtimePackage: "brain_sidecar",
      envPrefix: "BRAIN_SIDECAR",
    },
  ];

  for (const item of cases) {
    runCreate(item.args);

    const moduleSkillPath = join(tempDir, "module", "service", item.serviceName, "SKILL.md");
    const moduleAgentsPath = join(tempDir, "module", "service", item.serviceName, "AGENTS.md");
    const skillPath = join(tempDir, ".skill", item.serviceName, "SKILL.md");
    const configPath = join(tempDir, "module", "service", item.serviceName, "config", "config.yaml");
    const rendered = await readFile(configPath, "utf8");
    const skill = await readFile(skillPath, "utf8");
    const moduleAgents = await readFile(moduleAgentsPath, "utf8");

    assertIncludes(rendered, "  security:\n", `${item.serviceName} security section`);
    assertIncludes(rendered, "    require_explicit_profile: false\n", `${item.serviceName} explicit profile default`);
    assertIncludes(rendered, "      default:\n", `${item.serviceName} default profile`);
    assertIncludes(rendered, "        enabled: false\n", `${item.serviceName} disabled profile`);
    assertIncludes(rendered, "        algorithm: aes-256-gcm\n", `${item.serviceName} algorithm`);
    assertIncludes(rendered, `        key_id: "${item.runtimePackage}-dev-v1"\n`, `${item.serviceName} key id`);
    assertIncludes(
      rendered,
      `        key_env: "PR_COMM_SECURITY_${item.envPrefix}_KEY"\n`,
      `${item.serviceName} key env`,
    );
    assertIncludes(
      rendered,
      `        salt_env: "PR_COMM_SECURITY_${item.envPrefix}_SALT"\n`,
      `${item.serviceName} salt env`,
    );
    assertIncludes(rendered, `        aad_context: "pacific-rim.${item.serviceName}"\n`, `${item.serviceName} aad context`);
    assertIncludes(rendered, "        replay_window: 4096\n", `${item.serviceName} replay window`);
    assertIncludes(rendered, "        fail_open: false\n", `${item.serviceName} fail open`);

    if (rendered.includes("{{") || rendered.includes("}}")) {
      throw new Error(`${item.serviceName} config template left an unresolved placeholder`);
    }
    if (skill.includes("{{") || skill.includes("}}")) {
      throw new Error(`${item.serviceName} skill template left an unresolved placeholder`);
    }
    assertIncludes(
      moduleAgents,
      `.skill/${item.serviceName}/SKILL.md`,
      `${item.serviceName} module AGENTS.md skill reference`,
    );
    assertIncludes(
      moduleAgents,
      `pkg/idl/${item.serviceName}`,
      `${item.serviceName} module AGENTS.md IDL reference`,
    );
    if (await fileExists(moduleSkillPath)) {
      throw new Error(`${item.serviceName} should store SKILL.md under .skill/<service>/SKILL.md, not in module root`);
    }
    if (await fileExists(join(tempDir, "AGENTS.md"))) {
      throw new Error("create module should not dynamically update root AGENTS.md");
    }
  }

  console.log("create scaffold security config test passed");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function runCreate(args) {
  const result = spawnSync(process.execPath, [join(tempDir, "bin", "create.mjs"), ...args], {
    cwd: tempDir,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `create ${args.join(" ")} failed with exit ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function assertIncludes(value, expected, label) {
  if (!value.includes(expected)) {
    throw new Error(`${label}: expected rendered config to include ${JSON.stringify(expected)}`);
  }
}

async function fileExists(path) {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}
