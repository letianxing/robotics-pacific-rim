#!/usr/bin/env node
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { loadProtocolCatalog } from "./interface-scaffold/protocols.mjs";
import { buildInterfaceManifest } from "./interface-scaffold/manifest.mjs";
import { renderScaffoldFiles } from "./interface-scaffold/render.mjs";
import { parseYamlSubset } from "./interface-scaffold/yaml.mjs";
import { loadProjects, pathExists, rootDir } from "./workspace.mjs";

await main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.moduleRoot) {
    printUsage();
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const resolvedProject = await resolveProject(args.moduleRoot);
  const project = resolvedProject.project;
  const moduleRoot = resolvedProject.root;
  const configPath = args.config
    ? resolve(rootDir, args.config)
    : await firstExisting([
        join(moduleRoot, "src", "config", "config.yaml"),
        join(moduleRoot, "config", "config.yaml"),
        join(moduleRoot, "config.yaml"),
      ]);
  const protocolSources = args.protocols
    ? [resolvePath(args.protocols)]
    : await defaultProtocolSources();

  if (!configPath) {
    throw new Error(`Missing config.yaml under ${moduleRoot}`);
  }
  if (protocolSources.length === 0) {
    throw new Error(
      `Missing protocol sources. Put public IDL under ${join(rootDir, "pkg", "idl")} or pass --protocols <dir>.`,
    );
  }

  const config = parseYamlSubset(await readFile(configPath, "utf8"));
  const catalog = await loadProtocolCatalog(protocolSources);
  const moduleLeaf = moduleRoot.split(/[\\/]/).at(-1);
  const manifest = buildInterfaceManifest({
    moduleName: config.service?.name ?? moduleRoot.split(/[\\/]/).at(-1),
    runtimePackage: config.service?.runtime_package ?? inferRuntimePackage(moduleLeaf),
    language: args.language ? normalizeLanguage(args.language) : detectLanguage(project, moduleRoot),
    goModulePath: await readGoModulePath(moduleRoot),
    includeRuntimeRegistry: await includeRuntimeRegistry(args, project, moduleRoot),
    moduleRoot,
    configPath,
    protocolSources,
    config,
    catalog,
  });
  const files = renderScaffoldFiles(manifest);
  const output = { ...manifest, generatedFiles: Object.keys(files).sort() };

  if (args.dryRun) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  const outDir = args.out ? resolvePath(args.out) : await defaultOutputRoot(moduleRoot, manifest.language);
  const writeResult = await writeFiles(outDir, files, args.force, { explicitOut: Boolean(args.out) });
  console.log(JSON.stringify({ ...output, outputDir: outDir, ...writeResult }, null, 2));
}

function parseArgs(argv) {
  const args = { dryRun: false, force: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") {
      args.dryRun = true;
    } else if (value === "--force") {
      args.force = true;
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    } else if (value === "--runtime-registry") {
      args.runtimeRegistry = true;
    } else if (value === "--no-runtime-registry") {
      args.runtimeRegistry = false;
    } else if (value === "--config" || value === "--protocols" || value === "--out" || value === "--language") {
      args[value.slice(2)] = argv[++index];
    } else if (!args.moduleRoot) {
      args.moduleRoot = value;
    } else {
      throw new Error(`Unexpected argument: ${value}`);
    }
  }
  return args;
}

function resolvePath(path) {
  if (path.startsWith("/") || path.startsWith("~")) {
    return path.replace(/^~/, process.env.HOME ?? "");
  }
  return resolve(rootDir, path);
}

async function resolveProject(projectNameOrRoot) {
  const direct = resolve(rootDir, projectNameOrRoot);
  const projects = await loadProjects();
  if (await pathExists(direct)) {
    const root = relative(rootDir, direct);
    const project = projects.find((item) => item.root === root || item.fileRoot === root);
    return { project, root: direct };
  }
  const project = projects.find((item) => item.name === projectNameOrRoot || item.root === projectNameOrRoot);
  if (!project) {
    throw new Error(`Unknown project or path: ${projectNameOrRoot}`);
  }
  return { project, root: join(rootDir, project.root) };
}

function detectLanguage(project, moduleRoot) {
  const tag = project?.tags?.find((item) => String(item).startsWith("language:"));
  const tagged = tag ? tag.slice("language:".length) : "";
  if (tagged) {
    return normalizeLanguage(tagged);
  }
  const frameworkTags = project?.tags
    ?.filter((item) => String(item).startsWith("framework:"))
    .map((item) => normalizeLanguage(String(item).slice("framework:".length))) ?? [];
  if (frameworkTags.includes("go")) {
    return "go";
  }
  if (frameworkTags.includes("python")) {
    return "python";
  }
  if (frameworkTags.includes("cpp") || frameworkTags.includes("ros2")) {
    return "cpp";
  }
  if (moduleRoot.includes(`${join("module")}`)) {
    return "cpp";
  }
  return "generic";
}

function normalizeLanguage(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["c++", "cpp", "cxx"].includes(normalized)) {
    return "cpp";
  }
  if (["go", "golang"].includes(normalized)) {
    return "go";
  }
  if (["py", "python", "python3"].includes(normalized)) {
    return "python";
  }
  return normalized || "generic";
}

function inferRuntimePackage(moduleName) {
  const normalized = String(moduleName ?? "module")
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return normalized.endsWith("_service") ? normalized.slice(0, -"_service".length) : normalized;
}

async function includeRuntimeRegistry(args, project, moduleRoot) {
  if (typeof args.runtimeRegistry === "boolean") {
    return args.runtimeRegistry;
  }
  return await defaultIncludeRuntimeRegistry(project, moduleRoot);
}

async function defaultIncludeRuntimeRegistry(project, moduleRoot) {
  if (detectLanguage(project, moduleRoot) !== "cpp") {
    return false;
  }
  return true;
}

async function defaultProtocolSources() {
  const candidates = [join(rootDir, "pkg", "idl")];
  const sources = [];
  for (const candidate of candidates) {
    if ((await pathExists(candidate)) && !sources.includes(candidate)) {
      sources.push(candidate);
    }
  }
  return sources;
}

async function firstExisting(paths, allowMissing = false) {
  for (const path of paths) {
    if (await pathExists(path)) {
      return path;
    }
  }
  return allowMissing ? paths[0] : null;
}

async function defaultOutputRoot(moduleRoot, language = "generic") {
  if (language === "go" || language === "python") {
    return moduleRoot;
  }
  const sourceRoot = join(moduleRoot, "src");
  if (await pathExists(sourceRoot)) {
    return sourceRoot;
  }
  return moduleRoot;
}

async function readGoModulePath(moduleRoot) {
  const goMod = join(moduleRoot, "go.mod");
  if (!(await pathExists(goMod))) {
    return "";
  }
  const content = await readFile(goMod, "utf8");
  const match = content.match(/^module\s+(\S+)/m);
  return match?.[1] ?? "";
}

async function writeFiles(outDir, files, force, options = {}) {
  const writtenFiles = [];
  const skippedFiles = [];
  const removedFiles = await removeObsoleteGeneratedFiles(outDir, files, options);

  for (const relativePath of Object.keys(files).sort()) {
    const path = scaffoldOutputPath(outDir, relativePath, options);
    if (!force && (await exists(path)) && !(await canReplaceGeneratedFile(relativePath, path))) {
      skippedFiles.push(relativePath);
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, files[relativePath], "utf8");
    writtenFiles.push(relativePath);
  }

  return { writtenFiles, skippedFiles, removedFiles };
}

async function removeObsoleteGeneratedFiles(outDir, files, options = {}) {
  const obsolete = new Set();
  for (const relativePath of Object.keys(files)) {
    const match = relativePath.match(/^(pkg\/idl\/[A-Za-z0-9_]+\/generated\/(go|python|cpp))\//);
    if (!match) {
      continue;
    }
    if (match[2] === "go") {
      obsolete.add(`${match[1]}/protocol.go`);
    } else if (match[2] === "python") {
      obsolete.add(`${match[1]}/protocol.py`);
    } else if (match[2] === "cpp") {
      obsolete.add(`${match[1]}/protocol.hpp`);
    }
  }
  const removed = [];
  for (const relativePath of obsolete) {
    if (files[relativePath]) {
      continue;
    }
    const path = scaffoldOutputPath(outDir, relativePath, options);
    if (!(await exists(path))) {
      continue;
    }
    let content = "";
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (!content.includes("Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.")) {
      continue;
    }
    await rm(path);
    removed.push(relativePath);
  }
  return removed.sort();
}

function scaffoldOutputPath(outDir, relativePath, options = {}) {
  if (relativePath.startsWith("pkg/idl/") && !options.explicitOut && isInsideRoot(outDir)) {
    return join(rootDir, relativePath);
  }
  return join(outDir, relativePath);
}

function isInsideRoot(path) {
  const normalized = relative(rootDir, path);
  return normalized === "" || (!normalized.startsWith("..") && !normalized.startsWith("/"));
}

async function canReplaceGeneratedFile(relativePath, path) {
  if (relativePath === "interface_scaffold_README.md" || /^pkg\/idl\/[A-Za-z0-9_]+\/protocol_manifest\.json$/.test(relativePath)) {
    return true;
  }
  if (/^pkg\/idl\/[A-Za-z0-9_]+\/generated\//.test(relativePath)) {
    return true;
  }

  const editableServiceScaffold =
    /^internal\/service\/generated\/.+_(service|publisher_service|subscriber_service|client_service)\.go$/.test(relativePath)
    || /^service\/generated\/include\/.+_(service|publisher_service|subscriber_service|client_service)\.hpp$/.test(relativePath)
    || /^[A-Za-z0-9_]+\/service\/generated\/.+_(service|publisher_service|subscriber_service|client_service)\.py$/.test(relativePath);
  if (editableServiceScaffold) {
    return false;
  }

  const generatedPaths = [
    "internal/service/generated/service.go",
  ];
  if (generatedPaths.includes(relativePath)) {
    return true;
  }
  if (/^[A-Za-z0-9_]+\/service\/generated\/(__init__\.py|defaults\.py)$/.test(relativePath)) {
    return true;
  }

  const generatedDirs = [
    "api/generated/",
    "internal/api/generated/",
    "api/client/include/",
    "api/publisher/include/",
  ];
  if (generatedDirs.some((prefix) => relativePath.startsWith(prefix))) {
    return true;
  }
  if (/^[A-Za-z0-9_]+\/api\/generated\//.test(relativePath)) {
    return true;
  }
  if (relativePath === "runtime/ros2/generated_interface_registry.hpp") {
    const content = await readFile(path, "utf8");
    return (
      content.includes("Generated registration scaffold from config.yaml and protocols") ||
      content.includes("Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.") ||
      (content.includes("struct GeneratedInterfaceHandles {};") &&
        content.includes("inline GeneratedInterfaceHandles register_generated_interfaces(rclcpp::Node&)") &&
        content.includes("return {};"))
    );
  }
  return false;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function printUsage() {
  console.error(`Usage:
  node bin/generate-interface-scaffold.mjs <module-root-or-project> --dry-run
  node bin/generate-interface-scaffold.mjs <module-root-or-project> [--force]
  node bin/generate-interface-scaffold.mjs <module-root-or-project> --out <dir> [--force]

Options:
  --config <file>      Override config.yaml path.
  --protocols <dir>    Override protocol source directory.
                       Defaults to pkg/idl only. Use this only for explicit
                       private or experimental schema sources.
  --dry-run            Print the interface manifest without writing files.
  --out <dir>          Write scaffold files under this directory.
                       Defaults to the module's src directory when it exists,
                       otherwise the module root.
  --language <name>    Override generated language: cpp, go, python, generic.
  --runtime-registry   Generate runtime registry/binding files.
  --no-runtime-registry
                       Generate only API/service scaffolds and manifest files.
  --force              Allow overwriting files under --out.
`);
}
