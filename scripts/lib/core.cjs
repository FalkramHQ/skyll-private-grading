const fs = require('fs');
const path = require('path');

function getArg(args, flag, fallback = null) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function listArg(args, flag, fallback = '') {
  return String(getArg(args, flag, fallback) || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeSubject(value) {
  if (!value) return null;
  const clean = String(value).toLowerCase();
  if (clean.includes('math')) return 'Maths';
  if (clean.includes('sci')) return 'Science';
  return String(value);
}

function normalizeGrade(value) {
  if (!value) return null;
  const match = String(value).match(/\d+/);
  return match ? match[0] : null;
}

function slugify(value) {
  return String(value || '')
    .trim()
    .replace(/\.pdf$/i, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'Unknown';
}

function questionKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/question/g, 'q')
    .replace(/[^a-z0-9]/g, '');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonSafe(filePath, fallback = null) {
  try {
    return readJson(filePath, fallback);
  } catch {
    return fallback;
  }
}

function atomicWriteFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

function writeJson(filePath, value) {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonWithBackup(filePath, value) {
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, `${filePath}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
  }
  writeJson(filePath, value);
}

function parseJson(raw, label = 'model response') {
  const text = String(raw || '').trim();
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch (firstErr) {
    const start = unfenced.search(/[\[{]/);
    if (start === -1) throw new Error(`${label} returned no JSON: ${unfenced.slice(0, 500)}`);
    const opener = unfenced[start];
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < unfenced.length; i += 1) {
      const char = unfenced[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === opener) depth += 1;
      else if (char === closer) depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(unfenced.slice(start, i + 1));
        } catch (secondErr) {
          throw new Error(`${label} returned malformed JSON: ${secondErr.message}; initial parse: ${firstErr.message}`);
        }
      }
    }
    throw new Error(`${label} returned unclosed JSON: ${unfenced.slice(0, 500)}`);
  }
}

function formatMark(value) {
  const num = Number(value || 0);
  return Number.isInteger(num) ? String(num) : String(Number(num.toFixed(2)));
}

function listDirs(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter((entry) => fs.lstatSync(path.join(dirPath, entry)).isDirectory())
    .sort();
}

module.exports = {
  atomicWriteFile,
  ensureDir,
  formatMark,
  getArg,
  hasFlag,
  listArg,
  listDirs,
  normalizeGrade,
  normalizeSubject,
  parseJson,
  questionKey,
  readJson,
  readJsonSafe,
  slugify,
  writeJson,
  writeJsonWithBackup,
};
