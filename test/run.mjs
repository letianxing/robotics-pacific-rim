#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runRegisteredTests } from "./lib/harness.mjs";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const files = (await readdir(testDir))
  .filter((file) => file.endsWith(".test.mjs"))
  .sort();

for (const file of files) {
  await import(pathToFileURL(join(testDir, file)));
}

await runRegisteredTests();
