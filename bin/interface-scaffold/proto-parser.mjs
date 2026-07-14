import { readFile } from "node:fs/promises";
import { basename, dirname, relative, sep } from "node:path";
import { rootDir } from "../workspace.mjs";

export async function parseProtoFile(protocolsDir, file) {
  const text = await readFile(file, "utf8");
  const packageName = text.match(/^\s*package\s+([A-Za-z0-9_.]+)\s*;/m)?.[1] ?? "";
  const idlService = idlServiceName(protocolsDir, file);
  const sourceFile = relative(rootDir, file).replaceAll("\\", "/");
  const localMessages = {};
  const messages = {};
  const rpcs = {};

  for (const match of text.matchAll(/message\s+([A-Za-z_]\w*)\s*\{([\s\S]*?)\n\}/g)) {
    const [, name, body] = match;
    const message = {
      format: "protobuf_message",
      name,
      package: packageName,
      file: sourceFile,
      idlService,
      fullName: packageName ? `${packageName}.${name}` : name,
      fields: parseProtoFields(body),
    };
    localMessages[name] = message;
    messages[`${idlService}.${name}`] = message;
  }

  for (const match of text.matchAll(/service\s+([A-Za-z_]\w*)\s*\{([\s\S]*?)\n\}/g)) {
    const [, service, body] = match;
    for (const rpc of body.matchAll(
      /rpc\s+([A-Za-z_]\w*)\s*\(\s*([A-Za-z_][\w.]*)\s*\)\s+returns\s*\(\s*([A-Za-z_][\w.]*)\s*\)/g,
    )) {
      const [, name, request, response] = rpc;
      rpcs[`${idlService}.${service}.${name}`] = {
        format: "protobuf_rpc",
        service,
        rpc: name,
        package: packageName,
        file: sourceFile,
        idlService,
        request,
        response,
        requestFields: localMessages[request]?.fields ?? [],
        responseFields: localMessages[response]?.fields ?? [],
      };
    }
  }

  return { files: [sourceFile], messages, rpcs };
}

function idlServiceName(protocolsDir, file) {
  const parts = relative(protocolsDir, file).split(sep).filter(Boolean);
  const pbIndex = parts.indexOf("pb");
  if (pbIndex > 0) {
    return parts[pbIndex - 1];
  }
  return basename(dirname(dirname(file)));
}

function parseProtoFields(body) {
  const fields = [];
  for (const match of body.matchAll(
    /^\s*(optional\s+|repeated\s+)?([A-Za-z_][\w.]*|map\s*<\s*[A-Za-z_][\w.]*\s*,\s*[A-Za-z_][\w.]*\s*>)\s+([A-Za-z_]\w*)\s*=\s*(\d+)/gm,
  )) {
    const [, label, rawType, name, tag] = match;
    const type = rawType.replace(/\s+/g, "");
    fields.push({
      name,
      type,
      repeated: label?.trim() === "repeated",
      optional: label?.trim() === "optional",
      tag: Number.parseInt(tag, 10),
    });
  }
  return fields;
}
