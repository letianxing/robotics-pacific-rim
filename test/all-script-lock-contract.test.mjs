import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assert,
  assertExit,
  assertIncludes,
  commandOutput,
  rootDir,
  test,
} from "./lib/harness.mjs";

test("build-all.sh stops a previous locked run before starting", async () => {
  const workspace = createScriptWorkspace("build");
  const oldProcess = spawnOldScriptProcess(workspace, "build-all.sh");
  try {
    writeLock(workspace, "build-all.lock", oldProcess.pid);

    const result = spawnSync("./build-all.sh", ["--jobs", "1", "--skip-build-image"], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        BUILD_ALL_LOCK_DIR: join(workspace, ".cache", "build-all.lock"),
      },
    });

    assertExit(result, 0, "build-all stale lock run");
    assertIncludes(commandOutput(result), "Stopping previous build-all.sh run", "build-all stale lock cleanup");
    assertIncludes(commandOutput(result), "Build summary:", "build-all continued after cleanup");
    await assertProcessExited(oldProcess, "old build-all process");
  } finally {
    stopProcess(oldProcess);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("deploy-all.sh stops a previous locked run before starting", async () => {
  const workspace = createScriptWorkspace("deploy");
  const oldProcess = spawnOldScriptProcess(workspace, "deploy-all.sh");
  try {
    writeLock(workspace, "deploy-all.lock", oldProcess.pid);

    const result = spawnSync("./deploy-all.sh", [
      "--jobs",
      "1",
      "--host",
      "198.51.100.20",
      "--user",
      "robot",
      "--password",
      "secret",
      "--domain-id",
      "42",
    ], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(workspace, "bin")}:${process.env.PATH}`,
        DEPLOY_ALL_LOCK_DIR: join(workspace, ".cache", "deploy-all.lock"),
      },
    });

    assertExit(result, 0, "deploy-all stale lock run");
    assertIncludes(commandOutput(result), "Stopping previous deploy-all.sh run", "deploy-all stale lock cleanup");
    assertIncludes(commandOutput(result), "Deploy summary:", "deploy-all continued after cleanup");
    await assertProcessExited(oldProcess, "old deploy-all process");
  } finally {
    stopProcess(oldProcess);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("deploy-all.sh detects remote platform once and forwards it to each deploy", () => {
  const workspace = createScriptWorkspace("deploy-platform");
  try {
    const result = spawnSync("./deploy-all.sh", [
      "--jobs",
      "1",
      "--host",
      "198.51.100.20",
      "--user",
      "robot",
      "--password",
      "secret",
      "--domain-id",
      "42",
    ], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(workspace, "bin")}:${process.env.PATH}`,
        DEPLOY_ALL_LOCK_DIR: join(workspace, ".cache", "deploy-all.lock"),
      },
    });

    assertExit(result, 0, "deploy-all shared platform");
    assertIncludes(commandOutput(result), "Detected shared remote platform: aarch64 -> linux/arm64", "shared platform message");
    const prCalls = commandOutput(spawnSync("cat", ["pr-calls.log"], {
      cwd: workspace,
      encoding: "utf8",
    }));
    assertIncludes(prCalls, "--platform linux/arm64", "platform forwarded");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function createScriptWorkspace(label) {
  const workspace = mkdtempSync(join(tmpdir(), `pacific-rim-${label}-lock-`));
  mkdirSync(join(workspace, "bin"), { recursive: true });
  mkdirSync(join(workspace, ".cache"), { recursive: true });
  cpSync(join(rootDir, "build-all.sh"), join(workspace, "build-all.sh"));
  cpSync(join(rootDir, "deploy-all.sh"), join(workspace, "deploy-all.sh"));
  chmodSync(join(workspace, "build-all.sh"), 0o755);
  chmodSync(join(workspace, "deploy-all.sh"), 0o755);
  writeFileSync(join(workspace, "bin", "ros2-projects.mjs"), [
    "#!/usr/bin/env node",
    "console.log('module/service/example_service\\texample\\thumble\\tROS_DISTRO=humble');",
    "",
  ].join("\n"));
  chmodSync(join(workspace, "bin", "ros2-projects.mjs"), 0o755);
  writeFileSync(join(workspace, "pr"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf '%s\\n' \"$*\" >> pr-calls.log",
    "",
  ].join("\n"));
  chmodSync(join(workspace, "pr"), 0o755);
  writeFileSync(join(workspace, "bin", "sshpass"), [
    "#!/usr/bin/env bash",
    "if [[ \"$*\" == *\"uname -m\"* ]]; then",
    "  printf '%s\\n' 'aarch64'",
    "  exit 0",
    "fi",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(join(workspace, "bin", "sshpass"), 0o755);
  return workspace;
}

function writeLock(workspace, lockName, pid) {
  const lockDir = join(workspace, ".cache", lockName);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "pid"), `${pid}\n`);
}

function spawnOldScriptProcess(workspace, scriptName) {
  const oldScript = join(workspace, `.old-${scriptName}`);
  writeFileSync(oldScript, [
    "#!/usr/bin/env bash",
    "sleep 60",
    "",
  ].join("\n"));
  chmodSync(oldScript, 0o755);
  return spawn(oldScript, [], {
    stdio: "ignore",
  });
}

async function assertProcessExited(child, label) {
  const exit = await waitForExit(child, 3000);
  assert(exit.exited, `${label} should have been stopped`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ exited: true });
      return;
    }
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve({ exited: false });
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve({ exited: true });
    };
    child.once("exit", onExit);
  });
}

function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
}
