export type YamlValue = string | number | boolean | null | YamlObject | YamlValue[];
export type YamlObject = { [key: string]: YamlValue };

export function parseYamlSubset(text: string): YamlObject {
  const root: YamlObject = {};
  const lines = text.split(/\r?\n/);
  const stack: Array<{ indent: number; value: YamlObject | YamlValue[] }> = [{ indent: -1, value: root }];

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const line = stripComment(raw).replace(/\s+$/, "");
    if (!line.trim()) continue;

    const indent = raw.length - raw.trimStart().length;
    while (stack.length > 0 && indent <= (stack.at(-1)?.indent ?? -1)) {
      stack.pop();
    }

    const parent = stack.at(-1)?.value;
    const stripped = line.trim();

    if (stripped.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        throw new Error("YAML subset parser found a list item outside a list");
      }
      const child = parseListItem(stripped.slice(2).trim());
      parent.push(child);
      if (isContainer(child)) {
        stack.push({ indent, value: child });
      }
      continue;
    }

    const [key, value] = parseKeyValue(stripped);
    if (value === "") {
      const child: YamlObject | YamlValue[] = nextChildIsList(lines, index, indent) ? [] : {};
      assign(parent, key, child);
      stack.push({ indent, value: child });
    } else {
      assign(parent, key, parseScalar(value));
    }
  }

  return root;
}

export function asObject(value: YamlValue | undefined): YamlObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

export function asArray(value: YamlValue | undefined): YamlValue[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: YamlValue | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function parseListItem(text: string): YamlValue {
  if (!text) return {};
  if (!text.includes(":")) return parseScalar(text);
  const [key, value] = parseKeyValue(text);
  return { [key]: parseScalar(value) };
}

function nextChildIsList(lines: string[], index: number, parentIndent: number) {
  for (const raw of lines.slice(index + 1)) {
    const line = stripComment(raw).replace(/\s+$/, "");
    if (!line.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent <= parentIndent) return false;
    return line.trim().startsWith("- ");
  }
  return false;
}

function stripComment(line: string) {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (char === "#" && !inSingle && !inDouble) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseKeyValue(text: string): [string, string] {
  const separator = text.indexOf(":");
  if (separator < 0) throw new Error(`YAML subset parser expected key/value: ${text}`);
  return [text.slice(0, separator).trim(), text.slice(separator + 1).trim()];
}

function parseScalar(value: string): YamlValue {
  const unquoted = value.replace(/^["']|["']$/g, "");
  if (unquoted === "{}") return {};
  if (unquoted === "[]") return [];
  if (unquoted === "null" || unquoted === "~") return null;
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (/^-?\d+$/.test(unquoted)) return Number.parseInt(unquoted, 10);
  if (/^-?\d+\.\d+$/.test(unquoted)) return Number.parseFloat(unquoted);
  return unquoted;
}

function assign(parent: YamlObject | YamlValue[] | undefined, key: string, value: YamlValue) {
  if (!parent || Array.isArray(parent) || typeof parent !== "object") {
    throw new Error("YAML subset parser can only assign keys inside mappings");
  }
  parent[key] = value;
}

function isContainer(value: YamlValue): value is YamlObject | YamlValue[] {
  return value !== null && typeof value === "object";
}
