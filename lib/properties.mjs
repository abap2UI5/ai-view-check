/*
 * properties — the UI5 version/deprecation gate over a view's node tree.
 *
 * Generalized from abap2UI5/ai-demokit scripts/property-check.mjs (the corpus
 * 1.71 property gate). Checks every control and every written attribute of a
 * reconstructed (or raw XML) view against data/properties.json — per control:
 * parent class, class-level @since/@deprecated, and every member with a JSDoc
 * @since, walking the parent chain.
 *
 * Findings:
 *   control-too-new      the control itself is newer than the floor
 *   control-deprecated   the control is deprecated in current UI5
 *   member-too-new       a written property/aggregation/association/event is
 *                        newer than the floor
 *
 * Members without @since are older than version tracking and count as
 * always-available; controls absent from the snapshot are skipped (the
 * snapshot covers the OpenUI5 libraries it was generated from).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_SNAPSHOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'properties.json');

export function loadSnapshot(file = DEFAULT_SNAPSHOT) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).controls;
}

const parseVer = (s) => {
  const m = String(s).match(/(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2]] : null;
};

const withinFloor = (since, floor) => {
  const v = parseVer(since);
  if (!v) return true; // no/unparsable @since -> predates version tracking
  return v[0] < floor[0] || (v[0] === floor[0] && v[1] <= floor[1]);
};

// member since via the parent chain; null = unknown/old
function sinceOf(data, control, member) {
  let c = control;
  for (let depth = 0; c && data[c] && depth < 15; depth++) {
    if (data[c].members[member] !== undefined) return data[c].members[member];
    c = data[c].parent;
  }
  return null;
}

function knownControl(data, control) {
  let c = control;
  for (let depth = 0; c && data[c] && depth < 15; depth++) c = data[c].parent;
  return Boolean(data[control]);
}

// xmlns prefix map from the root node's attributes; '' = default namespace
function nsMapOf(rootAttrs) {
  const map = {};
  for (const [n, v] of rootAttrs) {
    const m = n.match(/^xmlns(?::(\w+))?$/);
    if (m) map[m[1] || ''] = v;
  }
  return map;
}

const isAggregationTag = (name) => /^[a-z]/.test(name);

/*
 * Walk one node tree (shape: { name, ns, attrs: [[n, v]], children }, root
 * name === null for the document wrapper). Returns findings.
 */
export function checkNodes(root, { data, minUi5 = '1.71', allow = [] } = {}) {
  const floor = parseVer(minUi5) || [1, 71];
  const allowed = new Set(allow.map((a) => a.toLowerCase()));
  const findings = [];
  const seen = new Set(); // dedupe repeated identical findings (row templates)

  const report = (f) => {
    const key = `${f.type}|${f.control}|${f.member || ''}`;
    if (seen.has(key)) return;
    if (allowed.has(`${f.control}.${f.member || ''}`.toLowerCase()) || allowed.has(f.control.toLowerCase())) return;
    seen.add(key);
    findings.push(f);
  };

  // collect xmlns from every node (the builder writes them on the mvc:View)
  const nsMap = {};
  (function collectNs(node) {
    if (node.name !== null) Object.assign(nsMap, nsMapOf(node.attrs));
    for (const c of node.children) collectNs(c);
  })(root);

  const resolve = (node) => {
    const lib = nsMap[node.ns || ''] || null;
    return lib ? `${lib}.${node.name}` : null;
  };

  // libraries the snapshot actually covers - only inside those can a missing
  // control be called out (custom namespaces stay out of scope, no guessing)
  const knownLibs = new Set();
  for (const key of Object.keys(data)) {
    knownLibs.add(key.slice(0, key.lastIndexOf('.')));
  }

  // document infrastructure that is legitimately not in the control snapshot
  const BUILTIN = new Set(['sap.ui.core.mvc.View', 'sap.ui.core.FragmentDefinition']);

  (function walk(node, ownerControl) {
    let owner = ownerControl;
    if (node.name !== null && !isAggregationTag(node.name)) {
      const full = resolve(node);
      if (full && !knownControl(data, full) && !BUILTIN.has(full)
          && knownLibs.has(full.slice(0, full.lastIndexOf('.')))) {
        // a typo'd control in a UI5 library the snapshot covers - the most
        // common generation error, worth failing fast without a browser
        report({ type: 'unknown-control', control: full });
      }
      if (full && knownControl(data, full)) {
        owner = full;
        const meta = data[full];
        if (meta.since && !withinFloor(meta.since, floor)) {
          report({ type: 'control-too-new', control: full, since: meta.since, minUi5 });
        }
        if (meta.deprecated) {
          report({ type: 'control-deprecated', control: full, deprecated: meta.deprecated });
        }
        for (const [attr] of node.attrs) {
          if (/^xmlns(:|$)/.test(attr) || attr === 'id' || attr === 'class') continue;
          const since = sinceOf(data, full, attr);
          if (since && !withinFloor(since, floor)) {
            report({ type: 'member-too-new', control: full, member: attr, since, minUi5 });
          }
        }
      }
    } else if (node.name !== null && isAggregationTag(node.name) && owner) {
      // aggregation tag: verify it exists (by @since) on the owning control
      const since = sinceOf(data, owner, node.name);
      if (since && !withinFloor(since, floor)) {
        report({ type: 'member-too-new', control: owner, member: node.name, since, minUi5 });
      }
    }
    for (const c of node.children) walk(c, owner);
  })(root, null);

  return findings;
}

/*
 * Light XML -> node tree parser for raw .view.xml / .fragment.xml input.
 * Element + attribute nodes only (text nodes are ignored) — sufficient for
 * the property gate and for handing the ORIGINAL xml string to the renderer.
 */
export function parseXml(xml) {
  const root = { name: null, ns: null, attrs: [], children: [] };
  const stack = [root];
  const tagRe = /<\s*(\/)?\s*(?:(\w+):)?([\w.]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/)?\s*>|<!--[\s\S]*?-->/g;
  let m;
  while ((m = tagRe.exec(xml)) !== null) {
    if (m[0].startsWith('<!--')) continue;
    const [, close, ns, name, attrSrc, selfClose] = m;
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs = [];
    for (const a of (attrSrc || '').matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      attrs.push([a[1], (a[3] ?? a[4] ?? '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')]);
    }
    const node = { name, ns: ns || null, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}
