import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { rootDir } from "../workspace.mjs";

const MODULE_REGEX = /\bmodule\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
const STRUCT_REGEX = /\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\}\s*;/g;
const INTERFACE_REGEX = /\binterface\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\}\s*;/g;
const OPERATION_REGEX = /([A-Za-z_][A-Za-z0-9_:<>, \t\r\n]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*;/g;

export async function parseDdsIdlFile(protocolsDir, file) {
  const text = await readFile(file, "utf8");
  const idlService = idlServiceName(protocolsDir, file);
  const moduleName = firstModuleName(text) || idlService;
  const sourceFile = relative(rootDir, file).replaceAll("\\", "/");
  return {
    files: [sourceFile],
    messages: parseStructs(text, idlService, moduleName, sourceFile),
    rpcs: parseInterfaces(text, idlService, moduleName, sourceFile),
  };
}

function parseStructs(text, idlService, moduleName, file) {
  const messages = {};
  for (const match of text.matchAll(STRUCT_REGEX)) {
    const name = match[1];
    const type = `${moduleName}::${name}`;
    const item = {
      format: "dds_idl",
      idlService,
      module: moduleName,
      name,
      type,
      fullName: type,
      file,
      fields: parseFields(match[2] ?? ""),
      memory: memoryHints(parseFields(match[2] ?? "")),
      aliases: [name, `${moduleName}.${name}`, type],
    };
    messages[type] = item;
    for (const alias of item.aliases) {
      messages[alias] ??= { ...item, type: alias, aliasOf: type };
    }
  }
  return messages;
}

function parseInterfaces(text, idlService, moduleName, file) {
  const rpcs = {};
  for (const ifaceMatch of text.matchAll(INTERFACE_REGEX)) {
    const service = ifaceMatch[1];
    for (const opMatch of (ifaceMatch[2] ?? "").matchAll(OPERATION_REGEX)) {
      const rpc = opMatch[2];
      const type = `${moduleName}::${service}/${rpc}`;
      const item = {
        format: "dds_idl_rpc",
        idlService,
        module: moduleName,
        service,
        rpc,
        name: rpc,
        type,
        fullName: type,
        file,
        requestFields: parseParameters(opMatch[3] ?? ""),
        responseFields: [{ name: "return", type: (opMatch[1] ?? "").trim() }],
        memory: memoryHints([
          ...parseParameters(opMatch[3] ?? ""),
          { name: "return", type: (opMatch[1] ?? "").trim() },
        ]),
        aliases: [rpc, `${service}.${rpc}`, `${moduleName}::${service}::${rpc}`, type],
      };
      rpcs[type] = item;
      for (const alias of item.aliases) {
        rpcs[alias] ??= { ...item, type: alias, aliasOf: type };
      }
    }
  }
  return rpcs;
}

function memoryHints(fields) {
  const unbounded = fields.filter((field) => isUnboundedType(field.type)).map((field) => field.name);
  return {
    bounded: unbounded.length === 0,
    loanFriendly: unbounded.length === 0,
    sharedMemoryFriendly: unbounded.length === 0,
    unboundedFields: unbounded,
  };
}

function isUnboundedType(type) {
  const value = String(type || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (value === "string" || value === "wstring") {
    return true;
  }
  const sequence = value.match(/^sequence\s*<(.+)>$/);
  if (!sequence) {
    return false;
  }
  const params = sequence[1].split(",").map((part) => part.trim()).filter(Boolean);
  return params.length < 2;
}

function parseFields(body) {
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*/, "").trim())
    .filter(Boolean)
    .map((line) => line.replace(/;$/, ""))
    .map((line, index) => {
      const parts = line.split(/\s+/);
      const name = parts.pop() ?? "";
      return { name, type: parts.join(" "), tag: index + 1 };
    })
    .filter((field) => field.name && field.type);
}

function parseParameters(value) {
  return value
    .split(",")
    .map((param) => param.trim())
    .filter(Boolean)
    .map((param, index) => {
      const parts = param.replace(/^(?:in|out|inout)\s+/, "").split(/\s+/);
      const name = parts.pop() ?? `arg${index + 1}`;
      return { name, type: parts.join(" "), tag: index + 1 };
    })
    .filter((field) => field.type);
}

function firstModuleName(text) {
  const match = MODULE_REGEX.exec(text);
  MODULE_REGEX.lastIndex = 0;
  return match?.[1] ?? "";
}

function idlServiceName(protocolsDir, file) {
  const parts = relative(protocolsDir, file).replaceAll("\\", "/").split("/").filter(Boolean);
  return parts[0] || "unknown_service";
}
