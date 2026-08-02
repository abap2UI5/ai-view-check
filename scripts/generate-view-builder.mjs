#!/usr/bin/env node
/*
 * generate-view-builder — z2ui5_cl_xml_view (+ _cc) -> data/xml-view.json
 *
 * The typed view builder is what most abap2UI5 apps are written with:
 *
 *   view->table( items = client->_bind( tab )
 *       )->columns( )->column( )->text( `Carrier` ).
 *
 * Every one of its 400+ control methods is the same shape —
 *
 *   METHOD button.
 *     result = me.                          " <- leaf: stays on the parent
 *     _generic( name   = `Button`
 *               ns     = ns
 *               t_prop = VALUE #( ( n = `text`  v = text )
 *                                 ( n = `press` v = press ) ... ) ).
 *
 * — so the mapping from an ABAP method and its parameters to a UI5 control
 * and its attributes can be READ from the framework instead of maintained by
 * hand. `result = _generic( ... )` instead of `result = me` means the method
 * descends into the control it just added.
 *
 * Usage:
 *   A2UI5_HOME=/path/to/abap2UI5 npm run generate-view-builder
 *   (defaults to a sibling ../abap2UI5 checkout)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function locate() {
  const candidates = [
    process.env.A2UI5_HOME,
    path.join(ROOT, '..', 'abap2UI5'),
    path.join(ROOT, '..', '..', 'abap2UI5'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'src', '99', 'z2ui5_cl_xml_view.clas.abap'))) return dir;
  }
  console.error(
    'abap2UI5 checkout not found. Clone https://github.com/abap2UI5/abap2UI5 next to this\n'
    + 'repository, or point A2UI5_HOME at it.'
  );
  process.exit(1);
}

/** Balanced-paren region, string-aware (a `…` literal may contain parens). */
function parenRegion(src, open) {
  let depth = 0;
  let str = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (str) { if (c === str) str = null; continue; }
    if (c === '`' || c === '|') { str = c; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

const methodBodies = (src, className) => {
  const impl = src.slice(src.indexOf(`CLASS ${className} IMPLEMENTATION`));
  return [...impl.matchAll(/\n {2}METHOD (\w+)\.([\s\S]*?)\n {2}ENDMETHOD\./g)]
    .map((m) => ({ name: m[1], body: m[2] }));
};

/** The IMPORTING parameters of a method, in declaration order, plus the one
 *  ABAP lets a caller pass positionally. */
function signatures(src) {
  const def = src.slice(0, src.indexOf(' IMPLEMENTATION'));
  const out = new Map();
  for (const m of def.matchAll(/\n\s*METHODS\s+(\w+)([\s\S]*?)(?=\n\s*(?:METHODS|CLASS-METHODS|ENDCLASS|PROTECTED SECTION|PRIVATE SECTION|"!|DATA|TYPES|CONSTANTS)\b)/g)) {
    const [, name, rest] = m;
    const importing = rest.match(/IMPORTING([\s\S]*?)(?=RETURNING|EXPORTING|CHANGING|RAISING|$)/);
    if (!importing) { out.set(name, { params: [], preferred: null }); continue; }
    const params = [...importing[1].matchAll(/(?:^|\n)\s*!?(\w+)\s+TYPE\b/g)].map((p) => p[1]);
    const pref = rest.match(/PREFERRED PARAMETER\s+(\w+)/);
    out.set(name, {
      params,
      // ABAP allows a positional argument for the preferred parameter, or
      // when the method takes exactly one
      preferred: pref ? pref[1] : params.length === 1 ? params[0] : null,
    });
  }
  return out;
}

/*
 * One control method -> { control, ns, descend, attrs: {abapParam: xmlAttr} }.
 * Returns null for anything that is not a plain _generic( ) wrapper — the
 * structural methods, and the handful of composites in the _cc class that
 * build a whole control tree (approve_popover), which cannot be represented
 * as one control.
 */
function readMethod({ name, body }, sig) {
  const call = body.match(/(?:^|[\s>])_generic\s*\(/);
  if (!call) return null;
  // a composite builds more than one control - not a mapping
  if ((body.match(/_generic\s*\(/g) || []).length > 1) return null;
  const region = parenRegion(body, body.indexOf('(', call.index + call[0].length - 1));
  /* Three ways the control name is written: `name = \`Button\``, positional
   * (`_generic( \`cells\` )`, how most aggregation tags are added), and -
   * twice - computed from the namespace, because sap.f spells the same tag
   * lower-case (`f:title` vs `Title`). */
  let control = region.match(/(?:^|\s)name\s*=\s*`([^`]*)`/)?.[1]
    ?? region.match(/^\s*`([^`]*)`/)?.[1]
    ?? null;
  let controlByNs = null;
  if (!control) {
    const via = region.match(/(?:^|\s)name\s*=\s*(\w+)/);
    const cond = via && body.match(new RegExp(`DATA\\(${via[1]}\\)\\s*=\\s*COND #\\(([\\s\\S]*?)\\)\\s*\\.`));
    const whens = cond ? [...cond[1].matchAll(/WHEN\s+ns\s*=\s*`([^`]*)`\s*THEN\s*`([^`]*)`/g)] : [];
    const otherwise = cond && cond[1].match(/ELSE\s*`([^`]*)`/);
    if (whens.length && otherwise) {
      control = otherwise[1];
      controlByNs = Object.fromEntries(whens.map((w) => [w[1], w[2]]));
    }
  }
  if (!control) return null;
  const nsM = region.match(/(?:^|\s)ns\s*=\s*`([^`]*)`/);
  const propM = region.match(/(?:^|\s)t_prop\s*=\s*VALUE #\s*\(/);
  const attrs = {};
  if (propM) {
    const props = parenRegion(region, region.indexOf('(', propM.index + propM[0].length - 1));
    for (const p of props.matchAll(/\(\s*n\s*=\s*`([^`]*)`\s*v\s*=\s*([\s\S]*?)\s*\)(?=\s*[()]|\s*$)/g)) {
      const [, attr, valueExpr] = p;
      // the value is the parameter itself, or a conversion of it
      // (boolean_abap_2_json( visible ) -> the `visible` parameter)
      const param = valueExpr.match(/(\w+)\s*\)*\s*$/);
      if (!param) continue;
      const abapParam = param[1].toLowerCase();
      if (!sig?.params.includes(abapParam)) continue;
      attrs[abapParam] = attr;
    }
  }
  return {
    control,
    ...(controlByNs ? { controlByNs } : {}),
    // ns = ns means "whatever the caller passed", which defaults to the
    // sap.m default namespace
    ns: nsM && nsM[1] !== 'ns' ? nsM[1] : '',
    descend: /result\s*=\s*(?:\w+->)?_generic\s*\(/.test(body),
    attrs,
    preferred: sig?.preferred ?? null,
  };
}

/** The prefix -> library table the builder writes into the root element. */
function namespaceMap(src) {
  const m = src.match(/st_ns_map\s*=\s*VALUE #\s*\(/);
  if (!m) return {};
  const region = parenRegion(src, src.indexOf('(', m.index + m[0].length - 1));
  const map = {};
  for (const p of region.matchAll(/\(\s*n\s*=\s*`([^`]*)`\s*v\s*=\s*`([^`]*)`\s*\)/g)) {
    map[p[1]] = p[2];
  }
  return map;
}

/** The root element a factory produces, with the namespaces it declares. */
function factories(src) {
  const out = {};
  for (const { name, body } of methodBodies(src, 'z2ui5_cl_xml_view')) {
    if (!name.startsWith('factory')) continue;
    const control = body.match(/mv_name\s*=\s*`([^`]*)`/);
    if (!control) continue;
    const ns = body.match(/mv_ns\s*=\s*`([^`]*)`/);
    const attrs = {};
    for (const p of body.matchAll(/\(\s*n\s*=\s*`([^`]*)`\s*v\s*=\s*`([^`]*)`\s*\)/g)) {
      attrs[p[1]] = p[2];
    }
    for (const p of body.matchAll(/INSERT VALUE #\(\s*n\s*=\s*`([^`]*)`\s*v\s*=\s*`([^`]*)`\s*\)/g)) {
      attrs[p[1]] = p[2];
    }
    out[name] = { control: control[1], ns: ns ? ns[1] : '', attrs };
  }
  return out;
}

const home = locate();
const viewSrc = fs.readFileSync(path.join(home, 'src', '99', 'z2ui5_cl_xml_view.clas.abap'), 'utf8');
const ccSrc = fs.readFileSync(path.join(home, 'src', '99', 'z2ui5_cl_xml_view_cc.clas.abap'), 'utf8');

const methods = {};
const cc = {};
let skipped = 0;
for (const [src, className, target] of [
  [viewSrc, 'z2ui5_cl_xml_view', methods],
  [ccSrc, 'z2ui5_cl_xml_view_cc', cc],
]) {
  const sigs = signatures(src);
  for (const m of methodBodies(src, className)) {
    const entry = readMethod(m, sigs.get(m.name));
    if (!entry) { skipped++; continue; }
    target[m.name] = entry;
  }
}

const out = {
  note: 'z2ui5_cl_xml_view (typed view builder) -> UI5 control mapping: per ABAP '
    + 'method the control it adds, whether it descends into it, and which of its '
    + 'parameters becomes which XML attribute. Generated by '
    + 'scripts/generate-view-builder.mjs from the abap2UI5 sources.',
  abap2ui5Version: (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(home, 'package.json'), 'utf8')).version || null;
    } catch { return null; }
  })(),
  namespaces: namespaceMap(viewSrc),
  factories: factories(viewSrc),
  methods,
  cc,
};

const dest = path.join(ROOT, 'data', 'xml-view.json');
fs.writeFileSync(dest, `${JSON.stringify(out, null, 1)}\n`);
console.log(
  `wrote ${path.relative(ROOT, dest)}: ${Object.keys(methods).length} builder methods, `
  + `${Object.keys(cc).length} custom-control methods, ${Object.keys(out.namespaces).length} namespaces `
  + `(${skipped} non-mapping methods skipped)`
);
