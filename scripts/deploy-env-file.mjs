import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

export function readEnvValues(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    values.set(match[1], parseEnvValue(match[2]));
  }
  return values;
}

export function updateEnvText(content, values) {
  const lines = content.split(/\r?\n/).filter((line, index, all) => {
    return line.length > 0 || index < all.length - 1;
  });
  const seen = new Set();
  const next = lines.map(line => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match || !(match[1] in values)) return line;
    seen.add(match[1]);
    return `${match[1]}=${serializeEnvValue(values[match[1]])}`;
  });
  for (const [name, value] of Object.entries(values)) {
    if (!seen.has(name)) next.push(`${name}=${serializeEnvValue(value)}`);
  }
  return `${next.join("\n")}\n`;
}

export function updateEnvFile(envFile, values) {
  const current = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  writeEnvFileAtomically(envFile, updateEnvText(current, values));
}

export function removeEnvFileValues(envFile, names) {
  if (!existsSync(envFile)) return;
  const removals = new Set(names);
  const next = readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .filter(line => {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
      return !match || !removals.has(match[1]);
    })
    .join("\n");
  writeEnvFileAtomically(envFile, next.endsWith("\n") ? next : `${next}\n`);
}

function writeEnvFileAtomically(envFile, content) {
  const temporary = `${envFile}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flush: true });
    chmodSync(temporary, 0o600);
    renameSync(temporary, envFile);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function parseEnvValue(value) {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("\\'", "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function serializeEnvValue(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    throw new Error("deployment environment values cannot contain newlines");
  }
  if (/^[a-zA-Z0-9_./:@+-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "\\'")}'`;
}
