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
 *   $schema      string - JSON-schema URL, for editor completion only
 *   paths        array  - files/directories to check (used only when the CLI
 *                         got no positional paths)
 *   ui5          string - UI5 floor for the property gate (alias: minUi5)
 *   distribution string - "sapui5" | "openui5"
 *   allow        array  - allowed control[.member] names despite the floor
 *   render       bool   - false skips the render gate (= --no-render)
 *   properties   bool   - false skips the property gate
 *   failOn       string - "error" | "warning" | "hint" | "never"
 *   rules        object - per rule id: false to switch it off, a severity
 *                         string, or { severity, exclude } (see findings.mjs)
 *
 * An unknown key - or an unknown rule id - fails loudly: a typo in a config
 * that silently changes nothing is worse than an error.
 */
import fs from 'fs';
import path from 'path';
import { RULES, SEVERITIES, RENDER_RULE } from './findings.mjs';

/** Both spellings are discovered, jsonc first - the same courtesy
 *  abaplint.json / abaplint.jsonc extend next door. */
export const CONFIG_NAMES = ['abap2ui5lint.jsonc', 'abap2ui5lint.json'];
export const CONFIG_NAME = CONFIG_NAMES[0];

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

/** Walk from dir upward to the filesystem root, return the first config found. */
export function findConfigFrom(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(cur, name);
      if (fs.existsSync(candidate)) return candidate;
    }
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

const KNOWN = new Set(['$schema', 'paths', 'ui5', 'minUi5', 'distribution', 'allow', 'render', 'properties', 'failOn', 'rules']);

/** Validate the `rules` block against the rule registry. Returns it as given -
 *  findings.mjs is what interprets it, this only refuses nonsense early. */
function loadRules(file, raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${file}: 'rules' must be an object keyed by rule id`);
  }
  const bad = (id, what) => new Error(`${file}: rules['${id}'] ${what}`);
  for (const [id, value] of Object.entries(raw)) {
    // render-error is the render gate's pseudo-rule: not in RULES (no emit
    // site classifies it), but a repo may waive or downgrade the gate per
    // file here instead of switching it off wholesale with `render: false`
    if (!RULES.includes(id) && id !== RENDER_RULE) {
      throw new Error(`${file}: unknown rule '${id}' in 'rules' (see the rule table in the README)`);
    }
    if (typeof value === 'boolean') continue;
    if (typeof value === 'string') {
      if (!SEVERITIES.includes(value.toLowerCase())) throw bad(id, `must be a severity (${SEVERITIES.join(', ')}), false, or an object`);
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw bad(id, `must be false, a severity string, or an object`);
    }
    for (const k of Object.keys(value)) {
      if (!['severity', 'exclude'].includes(k)) throw bad(id, `has unknown key '${k}' (known: severity, exclude)`);
    }
    if (value.severity !== undefined && !SEVERITIES.includes(String(value.severity).toLowerCase())) {
      throw bad(id, `severity must be one of ${SEVERITIES.join(', ')}`);
    }
    if (value.exclude !== undefined) {
      if (!Array.isArray(value.exclude) || value.exclude.some((p) => typeof p !== 'string')) {
        throw bad(id, `exclude must be an array of file regex patterns`);
      }
      for (const p of value.exclude) {
        try { new RegExp(p); } catch (e) { throw bad(id, `exclude pattern '${p}' is not a valid regex - ${e.message}`); }
      }
    }
  }
  return raw;
}

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
    if (![...SEVERITIES, 'never'].includes(level)) {
      throw new Error(`${file}: 'failOn' must be ${SEVERITIES.join(', ')} or never`);
    }
    cfg.failOn = level;
  }
  if (raw.rules !== undefined) cfg.rules = loadRules(file, raw.rules);
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
