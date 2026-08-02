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
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  // the enum table and the snapshot's own UI5 version ride along on the
  // controls object so the (public) checkNodes signature stays one argument
  Object.defineProperty(raw.controls, '__enums', { value: raw.enums || {}, enumerable: false });
  Object.defineProperty(raw.controls, '__ui5Version', { value: raw.ui5Version || null, enumerable: false });
  return raw.controls;
}

/** The UI5 version the metadata snapshot was generated from. Anything the
 *  target version has but this one does not simply cannot be checked. */
export function snapshotVersion(file = DEFAULT_SNAPSHOT) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).ui5Version || null;
  } catch {
    return null;
  }
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

/** Walk control + ancestors, yielding each entry that exists in the snapshot. */
function* chain(data, control) {
  let c = control;
  for (let depth = 0; c && data[c] && depth < 15; depth++) {
    yield [c, data[c]];
    c = data[c].parent;
  }
}

/** The declaration of a member across the parent chain, or null. `sets` names
 *  the metadata sections to look in. */
function memberOf(data, control, member, sets) {
  for (const [, meta] of chain(data, control)) {
    for (const set of sets) {
      const decl = meta[set]?.[member];
      if (decl) return { set, decl };
    }
  }
  return null;
}

/* UI5's own root class - it declares no members, so a chain reaching it is
 * fully known even though the snapshot carries no entry for it. */
const ROOT_CLASSES = new Set(['sap.ui.base.Object']);

/** Whether the control chain is fully known - only then can a missing member
 *  be reported. A chain ending in a control outside the snapshot (a custom
 *  base class, an unported library) might declare anything. */
function chainComplete(data, control) {
  let c = control;
  for (let depth = 0; depth < 15; depth++) {
    if (ROOT_CLASSES.has(c)) return true;
    const meta = data[c];
    if (!meta) return false;
    if (!meta.parent) return true; // reached a root class
    c = meta.parent;
  }
  return false;
}

/** true when `control` is (or inherits/implements) `type`. */
function isA(data, control, type) {
  for (const [name, meta] of chain(data, control)) {
    if (name === type) return true;
    if (meta.interfaces?.includes(type)) return true;
  }
  return false;
}

const isBinding = (v) => /[{}]/.test(String(v));

/* Libraries that ship with SAPUI5 but NOT with OpenUI5. The metadata
 * snapshot is generated from the OpenUI5 sources, so their controls can
 * never be resolved - but which of the two distributions the target system
 * serves decides whether using them is fine or a guaranteed runtime error.
 * Deliberately curated: sap.ui.commons and sap.ui.ux3 are OpenUI5 libraries
 * that merely happen to be outside the snapshot, and must not appear here. */
const SAPUI5_ONLY_LIBS = [
  'sap.ui.comp', 'sap.ui.generic', 'sap.ui.richtexteditor', 'sap.ui.export',
  'sap.ui.vk', 'sap.ui.vbm', 'sap.suite.ui.commons', 'sap.suite.ui.generic',
  'sap.suite.ui.microchart', 'sap.ushell', 'sap.fe', 'sap.collaboration',
  'sap.ndc', 'sap.me', 'sap.ca', 'sap.chart', 'sap.viz', 'sap.ovp',
  'sap.gantt', 'sap.apf', 'sap.rules', 'sap.zen', 'sap.landvisz',
  'sap.uiext.inbox', 'sap.makit',
];

/** The SAPUI5-only library a control belongs to, or null. */
function sapui5OnlyLib(control) {
  return SAPUI5_ONLY_LIBS.find((lib) => control.startsWith(`${lib}.`)) || null;
}

/** Whether a deprecation is already in effect at the target version. The
 *  version usually sits in `since`; older entries only say it in the text
 *  ("since version 1.16, replaced by ..."). Without any version the
 *  deprecation predates version tracking and always applies. */
function deprecationApplies(deprecated, floor) {
  const since = typeof deprecated === 'object'
    ? deprecated.since ?? String(deprecated.text || '').match(/since\s+version\s+([\d.]+)/i)?.[1]
    : String(deprecated).match(/since\s+version\s+([\d.]+)/i)?.[1];
  if (!since) return true;
  return withinFloor(since, floor);
}

/** Values UI5 accepts for a primitive property type, or null when the type
 *  is free-form (string, CSSSize, URI, ...). */
function primitiveValues(type) {
  if (type === 'boolean') return ['true', 'false'];
  return null;
}

const isNumericType = (t) => t === 'int' || t === 'float';

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

/* Aggregation tags start lower-case; a name carrying its own prefix
 * (`core:Icon`, written that way by the builder instead of via ns) is a
 * control, never an aggregation. */
const isAggregationTag = (name) => /^[a-z]/.test(name) && !name.includes(':');

/*
 * Walk one node tree (shape: { name, ns, attrs: [[n, v]], children }, root
 * name === null for the document wrapper). Returns findings.
 */
export function checkNodes(root, { data, minUi5 = '1.71', allow = [], distribution = 'sapui5' } = {}) {
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
    // the builder can carry the prefix inside the name (`core:Icon`) instead
    // of in ns - then that prefix wins over the default namespace
    let { ns, name } = node;
    const inName = String(name).indexOf(':');
    if (inName > 0) {
      ns = name.slice(0, inName);
      name = name.slice(inName + 1);
    }
    const lib = nsMap[ns || ''] || null;
    return lib ? `${lib}.${name}` : null;
  };

  // libraries the snapshot actually covers - only inside those can a missing
  // control be called out (custom namespaces stay out of scope, no guessing)
  const knownLibs = new Set();
  for (const key of Object.keys(data)) {
    // only real UI5 namespaces - JSDoc examples in the sources leave
    // artefacts like `sample.Foo`, and treating those as known libraries
    // would turn every other `sample.*` tag into a bogus finding
    if (key.startsWith('sap.')) knownLibs.add(key.slice(0, key.lastIndexOf('.')));
  }

  /* Legitimately absent from the snapshot: the view/fragment document roots,
   * and CustomData, which UI5 creates dynamically
   * (Element.getMetadata().getAggregation("customData").defaultClass) rather
   * than with an .extend() the generator could read. */
  const BUILTIN = new Set([
    'sap.ui.core.mvc.View', 'sap.ui.core.FragmentDefinition', 'sap.ui.core.CustomData',
  ]);

  const enums = data.__enums || {};

  /* Attributes the XML view framework itself handles, on every control -
   * they are not declared in any control's metadata. Plus namespace
   * declarations and anything in a foreign namespace (custom data,
   * core:require, template instructions). */
  const SPECIAL_ATTRS = new Set([
    'id', 'class', 'binding', 'models', 'objectBindings', 'stashed', 'require',
  ]);
  const isFrameworkAttr = (attr) =>
    /^xmlns(:|$)/.test(attr) || SPECIAL_ATTRS.has(attr) || attr.includes(':');

  /** Property value check: enum members and booleans are closed sets, ints
   *  must parse. Bindings and expressions are skipped - their value is only
   *  known at runtime. */
  function checkValue(control, attr, decl, value) {
    if (value === undefined || isBinding(value)) return;
    const type = decl.type;
    if (!type) return;
    const allowed = enums[type] || primitiveValues(type);
    if (allowed) {
      if (!allowed.includes(String(value))) {
        report({
          type: 'invalid-property-value',
          control, member: attr, value: String(value), allowed, memberType: type,
        });
      }
      return;
    }
    if (isNumericType(type) && !/^[+-]?\d+(\.\d+)?$/.test(String(value).trim())) {
      report({ type: 'invalid-property-value', control, member: attr, value: String(value), memberType: type });
    }
  }

  (function walk(node, ownerControl) {
    let owner = ownerControl;
    if (node.name !== null && !isAggregationTag(node.name)) {
      const full = resolve(node);
      const sapui5Lib = full ? sapui5OnlyLib(full) : null;
      if (sapui5Lib) {
        // not in the snapshot either way - but on OpenUI5 it simply is not
        // there, which is a runtime error waiting to happen
        if (distribution === 'openui5') {
          report({ type: 'sapui5-only-control', control: full, library: sapui5Lib });
        }
      } else if (full && !knownControl(data, full) && !BUILTIN.has(full)
          && knownLibs.has(full.slice(0, full.lastIndexOf('.')))) {
        // a typo'd control in a UI5 library the snapshot covers - the most
        // common generation error, worth failing fast without a browser
        report({ type: 'unknown-control', control: full });
      }
      if (full && knownControl(data, full)) {
        const meta = data[full];
        if (meta.since && !withinFloor(meta.since, floor)) {
          report({ type: 'control-too-new', control: full, since: meta.since, minUi5 });
        }
        // deprecated only counts when it already applies to the TARGET
        // version: a control deprecated as of 1.149 is perfectly fine for a
        // 1.71 system, and warning about it would be noise
        if (meta.deprecated && deprecationApplies(meta.deprecated, floor)) {
          report({ type: 'control-deprecated', control: full, deprecated: meta.deprecated });
        }

        // is this control allowed where it sits? (parent = an aggregation tag,
        // or a control whose default aggregation takes it)
        if (ownerControl && knownControl(data, ownerControl.control)) {
          const agg = ownerControl.aggregation
            ? memberOf(data, ownerControl.control, ownerControl.aggregation, ['aggregations'])
            : (() => {
              const def = [...chain(data, ownerControl.control)]
                .map(([, m]) => m.defaultAggregation).find(Boolean);
              return def ? memberOf(data, ownerControl.control, def, ['aggregations']) : null;
            })();
          // only for aggregation types that are known CLASSES: an interface
          // type (sap.m.IBar) can be implemented in ways the snapshot does
          // not capture, and a false "not allowed here" is worse than a miss
          if (agg?.decl.type && knownControl(data, agg.decl.type)
              && chainComplete(data, full) && !isA(data, full, agg.decl.type)) {
            report({
              type: 'invalid-aggregation-child',
              control: full,
              parentControl: ownerControl.control,
              member: ownerControl.aggregation ?? '(default aggregation)',
              expected: agg.decl.type,
            });
          }
        }

        for (const [attr, value] of node.attrs) {
          if (isFrameworkAttr(attr)) continue;
          const since = sinceOf(data, full, attr);
          if (since && !withinFloor(since, floor)) {
            report({ type: 'member-too-new', control: full, member: attr, since, minUi5 });
            continue;
          }
          const member = memberOf(data, full, attr, ['properties', 'events', 'associations', 'aggregations']);
          if (!member) {
            if (chainComplete(data, full)) {
              report({ type: 'unknown-property', control: full, member: attr });
            }
            continue;
          }
          if (member.set === 'properties') checkValue(full, attr, member.decl, value);
        }
        owner = { control: full, aggregation: null };
      }
    } else if (node.name !== null && isAggregationTag(node.name) && ownerControl?.control) {
      const parent = ownerControl.control;
      const since = sinceOf(data, parent, node.name);
      if (since && !withinFloor(since, floor)) {
        report({ type: 'member-too-new', control: parent, member: node.name, since, minUi5 });
      } else if (!memberOf(data, parent, node.name, ['aggregations', 'associations'])) {
        if (chainComplete(data, parent)) {
          report({ type: 'unknown-aggregation', control: parent, member: node.name });
        }
      } else {
        const agg = memberOf(data, parent, node.name, ['aggregations']);
        const controlChildren = node.children.filter(
          (c) => c.name !== null && !isAggregationTag(c.name)
        ).length;
        if (agg && !agg.decl.multiple && controlChildren > 1) {
          report({
            type: 'too-many-children',
            control: parent, member: node.name, count: controlChildren,
          });
        }
      }
      owner = { control: parent, aggregation: node.name };
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
