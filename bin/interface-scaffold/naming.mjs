export function indentLines(text, spaces) {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`.trimEnd())
    .join("\n");
}

export function namespacePart(moduleName) {
  const normalized = String(moduleName ?? "module").replace(/[^A-Za-z0-9]+/g, "_");
  return normalized.replace(/^_+|_+$/g, "") || "module";
}

export function packageName(moduleName) {
  return namespacePart(moduleName).toLowerCase();
}

export function pascalToSnake(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function toCamelCase(value) {
  const pascal = toPascalCase(value);
  return pascal ? `${pascal[0].toLowerCase()}${pascal.slice(1)}` : "";
}

export function toPascalCase(value) {
  return String(value ?? "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}
