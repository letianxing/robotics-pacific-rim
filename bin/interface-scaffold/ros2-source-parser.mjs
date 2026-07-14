import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { rootDir } from "../workspace.mjs";

export async function parseRos2Message(protocolsDir, file) {
  const text = await readFile(file, "utf8");
  const typeInfo = ros2TypeName(protocolsDir, file);
  const type = typeInfo.type;
  const sourceFile = relative(rootDir, file).replaceAll("\\", "/");
  return {
    format: "ros2_msg",
    type,
    aliases: typeInfo.aliases,
    package: type.split("/")[0],
    name: basename(file, extname(file)),
    file: sourceFile,
    fields: parseRos2Fields(text),
  };
}

export async function parseRos2Service(protocolsDir, file) {
  const text = await readFile(file, "utf8");
  const [requestText, responseText = ""] = text.split(/^---\s*$/m);
  const typeInfo = ros2TypeName(protocolsDir, file);
  const type = typeInfo.type;
  const sourceFile = relative(rootDir, file).replaceAll("\\", "/");
  return {
    format: "ros2_srv",
    type,
    aliases: typeInfo.aliases,
    package: type.split("/")[0],
    name: basename(file, extname(file)),
    file: sourceFile,
    requestFields: parseRos2Fields(requestText),
    responseFields: parseRos2Fields(responseText),
  };
}

function ros2TypeName(protocolsDir, file) {
  const relativeParts = relative(protocolsDir, file).split(sep);
  const ros2Index = relativeParts.indexOf("ros2");
  const serviceScope = relativeParts[0] || "";
  const parts = ros2Index >= 0
    ? relativeParts.slice(ros2Index + 1)
    : relativeParts;
  if (parts.length >= 2 && (parts[0] === "msg" || parts[0] === "srv")) {
    const compatibilityPackage = serviceScope.replace(/_service$/, "");
    const packageName = compatibilityPackage || serviceScope || basename(dirname(dirname(file)));
    const type = `${packageName}/${parts[0]}/${basename(parts[1], extname(parts[1]))}`;
    return {
      type,
      aliases: serviceScope && serviceScope !== packageName
        ? [`${serviceScope}/${parts[0]}/${basename(parts[1], extname(parts[1]))}`]
        : [],
    };
  }
  if (parts.length < 3) {
    const kind = basename(dirname(file));
    return {
      type: `${basename(dirname(dirname(file)))}/${kind}/${basename(file, extname(file))}`,
      aliases: [],
    };
  }
  return {
    type: `${parts[0]}/${parts[1]}/${basename(parts[2], extname(parts[2]))}`,
    aliases: [],
  };
}

function parseRos2Fields(text) {
  const fields = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#", 1)[0].trim();
    if (!line || line === "---" || line.includes("=")) {
      continue;
    }
    const [type, name] = line.split(/\s+/);
    if (type && name) {
      fields.push({ type, name });
    }
  }
  return fields;
}
