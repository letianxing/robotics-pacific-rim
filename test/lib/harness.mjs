import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const harnessDir = dirname(fileURLToPath(import.meta.url));
export const rootDir = resolve(harnessDir, "..", "..");
const registeredTests = [];

export function test(name, fn) {
  registeredTests.push({ name, fn });
}

export function readText(relativePath) {
  return readFileSync(resolve(rootDir, relativePath), "utf8");
}

export function runCommand(command, args = [], options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
  });
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertIncludes(value, expected, label) {
  if (!String(value).includes(expected)) {
    throw new Error(`${label}: expected to include ${JSON.stringify(expected)}\n${value}`);
  }
}

export function assertNotIncludes(value, expected, label) {
  if (String(value).includes(expected)) {
    throw new Error(`${label}: expected not to include ${JSON.stringify(expected)}\n${value}`);
  }
}

export function assertMatch(value, pattern, label) {
  if (!pattern.test(String(value))) {
    throw new Error(`${label}: expected ${JSON.stringify(String(value))} to match ${pattern}`);
  }
}

export function commandOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

export function assertExit(result, expectedStatus, label) {
  if (result.error) {
    throw new Error(`${label}: failed to start command: ${result.error.message}`);
  }
  if (result.status !== expectedStatus) {
    throw new Error(`${label}: expected exit ${expectedStatus}, got ${result.status}\n${commandOutput(result)}`);
  }
}

export async function runRegisteredTests() {
  let passed = 0;
  const failures = [];

  for (const item of registeredTests) {
    try {
      await item.fn();
      passed += 1;
      console.log(`ok ${passed} - ${item.name}`);
    } catch (error) {
      failures.push({ name: item.name, error });
      console.error(`not ok ${passed + failures.length} - ${item.name}`);
      console.error(error?.stack ?? error);
    }
  }

  const total = passed + failures.length;
  console.log(`\n${passed}/${total} stability tests passed.`);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}
