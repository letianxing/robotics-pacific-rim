import { readFile } from "node:fs/promises";
import { basename, extname, relative, sep } from "node:path";

export function isGeneratedArtifactCandidate(file) {
  return [".cc", ".cpp", ".cxx", ".py", ".go", ".rs", ".java", ".kt", ".ts", ".js"].includes(extname(file));
}

export async function parseGeneratedArtifactFile(protocolsDir, file) {
  const text = await readFile(file, "utf8");
  const language = artifactLanguage(file);
  const messages = {};
  const services = {};

  for (const artifact of parseCppRos2TypeSupport(text, file, language)) {
    addArtifact(artifact.kind === "service" ? services : messages, artifact.type, artifact);
  }
  for (const artifact of parseRos2GeneratedImports(text, file, language)) {
    addArtifact(artifact.kind === "service" ? services : messages, artifact.type, artifact);
  }

  const pathArtifact = inferGeneratedArtifactFromPath(protocolsDir, file, language);
  if (pathArtifact) {
    addArtifact(pathArtifact.kind === "service" ? services : messages, pathArtifact.type, pathArtifact);
  }

  return { messages, services };
}

function parseCppRos2TypeSupport(text, file, language) {
  if (language !== "cpp") {
    return [];
  }
  const artifacts = [];
  for (const match of text.matchAll(
    /GetRos2(Message|Service)TypeSupport\s*<\s*([A-Za-z_]\w*(?:::[A-Za-z_]\w*)+)\s*>\s*\(/g,
  )) {
    const [, supportKind, cppType] = match;
    const type = cppRos2TypeToRouteType(cppType);
    if (type) {
      artifacts.push(languageArtifact({
        artifactKind: "type_support",
        file,
        generatedType: cppType,
        kind: supportKind === "Service" ? "srv" : "msg",
        language,
        type,
      }));
    }
  }
  return artifacts;
}

function parseRos2GeneratedImports(text, file, language) {
  if (language === "cpp") {
    return parseCppGeneratedIncludes(text, file, language);
  }
  if (language === "python") {
    return parsePythonGeneratedImports(text, file, language);
  }
  return [];
}

function parseCppGeneratedIncludes(text, file, language) {
  const artifacts = [];
  for (const match of text.matchAll(/#\s*include\s+"([A-Za-z0-9_]+)\/(msg|srv)\/([A-Za-z0-9_]+)\.hpp"/g)) {
    const [, packageName, kind, stem] = match;
    artifacts.push(languageArtifact({
      artifactKind: "type_support",
      file,
      generatedType: `${packageName}::${kind}::${nameToTypeLeaf(stem)}`,
      includeOnly: true,
      kind,
      language,
      type: `${packageName}/${kind}/${nameToTypeLeaf(stem)}`,
    }));
  }
  return artifacts;
}

function parsePythonGeneratedImports(text, file, language) {
  const artifacts = [];
  for (const match of text.matchAll(/from\s+([A-Za-z_]\w*)\.(msg|srv)\._?([A-Za-z0-9_]+)\s+import\s+([A-Za-z_]\w*)/g)) {
    const [, packageName, kind, stem, importedType] = match;
    artifacts.push(languageArtifact({
      artifactKind: "binding",
      file,
      generatedType: importedType || nameToTypeLeaf(stem),
      kind,
      language,
      type: `${packageName}/${kind}/${importedType || nameToTypeLeaf(stem)}`,
    }));
  }
  return artifacts;
}

function inferGeneratedArtifactFromPath(protocolsDir, file, language) {
  const parts = relative(protocolsDir, file).split(sep);
  const kindIndex = parts.findIndex((part) => part === "msg" || part === "srv");
  if (kindIndex <= 0 || kindIndex + 1 >= parts.length) {
    return null;
  }
  const kind = parts[kindIndex];
  const packageName = parts[kindIndex - 1];
  const name = nameToTypeLeaf(basename(parts[kindIndex + 1], extname(parts[kindIndex + 1])));
  return languageArtifact({
    artifactKind: language === "cpp" ? "type_support" : "binding",
    file,
    generatedType: name,
    kind,
    language,
    pathInferred: true,
    type: `${packageName}/${kind}/${name}`,
  });
}

function languageArtifact({ artifactKind, file, generatedType, includeOnly, kind, language, pathInferred, type }) {
  return {
    format: "ros2_generated_artifact",
    artifactKind,
    language,
    sourceFormat: kind === "srv" ? "ros2_srv" : "ros2_msg",
    kind: kind === "srv" ? "service" : "message",
    type,
    generatedType,
    file,
    includeOnly: Boolean(includeOnly),
    pathInferred: Boolean(pathInferred),
    fields: [],
    requestFields: [],
    responseFields: [],
  };
}

function addArtifact(target, type, artifact) {
  target[type] ??= [];
  if (!target[type].some((item) => item.file === artifact.file && item.language === artifact.language)) {
    target[type].push(artifact);
  }
}

function artifactLanguage(file) {
  const extension = extname(file);
  if (extension === ".cc" || extension === ".cpp" || extension === ".cxx") {
    return "cpp";
  }
  const languages = {
    ".go": "go",
    ".java": "java",
    ".js": "javascript",
    ".kt": "kotlin",
    ".py": "python",
    ".rs": "rust",
    ".ts": "typescript",
  };
  return languages[extension] ?? "unknown";
}

function cppRos2TypeToRouteType(cppType) {
  const parts = cppType.split("::");
  const markerIndex = parts.findIndex((part) => part === "msg" || part === "srv");
  if (markerIndex <= 0 || markerIndex + 1 >= parts.length) {
    return null;
  }
  return `${parts[markerIndex - 1]}/${parts[markerIndex]}/${parts[markerIndex + 1]}`;
}

function nameToTypeLeaf(value) {
  const normalized = String(value ?? "").replace(/^_/, "");
  if (!normalized) {
    return "";
  }
  if (!normalized.includes("_")) {
    return normalized[0].toUpperCase() + normalized.slice(1);
  }
  return normalized
    .split("_")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}
