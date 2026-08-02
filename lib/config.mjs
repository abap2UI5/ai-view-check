/*
 * config — the abap2ui5lint.jsonc config file.
 *
 * The same idea as abaplint.jsonc next door: a repo pins its lint settings in
 * a committed file instead of every caller repeating CLI flags. Discovery is
 * eslint-style: an explicit --config wins, otherwise the file is searched
 * upward from the current directory and from each given path. Precedence per
 * option: explicit CLI flag > config file > built-in default.
 *
 * Recognized keys (all optional):
 *   paths        array  - files/directories to check (used only when the CLI
 *                         got no positional paths)
 *   ui5          string - UI5 floor for the property gate (alias: minUi5)
 *   distribution string - "sapui5" | "openui5"
 *   allow        array  - allowed control[.member] names despite the floor
 *   render       bool   - false skips the render gate (= --no-render)
 *   properties   bool   - false skips the property gate
 *   failOn       string - "error" | "warning" | "hint" | "never"
 *
 * An unknown key fails loudly - a typo in a config that silently changes
 * nothing is worse than an error.
 */
import fs from 'fs';
import path from 'path';

export const CONFIG_NAME = 'abap2ui5lint.jsonc';

/** JSONC -> JSON: strips // and block comments (string-aware) + trailing commas. */
export function stripJsonc(text) {
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
    } else if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
    } else if (inStr) {
      out += c;
      if (c === '\\') {
        out += n;
        i++;
      } else if (c === '"') {
        inStr = false;
      }
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && n === '/') {
      inLine = true;
    } else if (c === '/' && n === '*') {
      inBlock = true;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

/** Walk from dir upward to the filesystem root, return the first CONFIG_NAME found. */
export function findConfigFrom(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    const candidate = path.join(cur, CONFIG_NAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** Discovery order: cwd upward, then each given path's directory upward. */
export function findConfig(cwd, paths = []) {
  const found = findConfigFrom(cwd);
  if (found) return found;
  for (const p of paths) {
    const abs = path.resolve(cwd, p);
    const dir = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    const hit = findConfigFrom(dir);
    if (hit) return hit;
  }
  return null;
}

const KNOWN = new Set(['paths', 'ui5', 'minUi5', 'distribution', 'allow', 'render', 'properties', 'failOn']);

/** Parse + validate a config file. Throws with a precise message on bad input. */
export function loadConfig(file) {
  let raw;
  try {
    raw = JSON.parse(stripJsonc(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    throw new Error(`${file}: not valid JSONC - ${e.message}`);
  }
  for (const k of Object.keys(raw)) {
    if (!KNOWN.has(k)) throw new Error(`${file}: unknown key '${k}' (known: ${[...KNOWN].join(', ')})`);
  }
  const cfg = {};
  if (raw.paths !== undefined) {
    if (!Array.isArray(raw.paths) || raw.paths.some((p) => typeof p !== 'string')) {
      throw new Error(`${file}: 'paths' must be an array of strings`);
    }
    cfg.paths = raw.paths;
  }
  const ui5 = raw.ui5 ?? raw.minUi5;
  if (ui5 !== undefined) {
    if (!/^\d+\.\d+(\.\d+)?$/.test(String(ui5))) throw new Error(`${file}: 'ui5' must be a version like "1.71"`);
    cfg.minUi5 = String(ui5);
  }
  if (raw.distribution !== undefined) {
    const d = String(raw.distribution).toLowerCase();
    if (!['sapui5', 'openui5'].includes(d)) throw new Error(`${file}: 'distribution' must be "sapui5" or "openui5"`);
    cfg.distribution = d;
  }
  if (raw.allow !== undefined) {
    if (!Array.isArray(raw.allow) || raw.allow.some((p) => typeof p !== 'string')) {
      throw new Error(`${file}: 'allow' must be an array of control[.member] strings`);
    }
    cfg.allow = raw.allow;
  }
  for (const b of ['render', 'properties']) {
    if (raw[b] !== undefined) {
      if (typeof raw[b] !== 'boolean') throw new Error(`${file}: '${b}' must be true or false`);
      cfg[b] = raw[b];
    }
  }
  if (raw.failOn !== undefined) {
    const level = String(raw.failOn).toLowerCase();
    if (!['error', 'warning', 'hint', 'never'].includes(level)) {
      throw new Error(`${file}: 'failOn' must be error, warning, hint or never`);
    }
    cfg.failOn = level;
  }
  return cfg;
}

/** config under explicit CLI choices: only fills options the CLI did not set. */
export function applyConfig(opt, seen, cfg) {
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'paths') continue; // handled by the caller (positional args win)
    if (k === 'allow') {
      // allow lists merge - a config allowance and a CLI allowance are both meant
      opt.allow = [...new Set([...(cfg.allow || []), ...opt.allow])];
      continue;
    }
    if (!seen.has(k)) opt[k] = v;
  }
  return opt;
}
