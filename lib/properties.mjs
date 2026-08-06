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
import { CURATED_FORMATTERS, FORMATTER_MODULE } from './formatters.mjs';

const DEFAULT_SNAPSHOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'properties.json');

/* Parsed once per path, not once per checked file: the snapshot is a 434 KB
 * JSON document and checkAbapSource/checkXmlSource load it per call - on a
 * corpus of a few hundred files the repeated parse was the bulk of the
 * property gate's time. The data is treated as immutable by every consumer. */
const snapshotCache = new Map();

export function loadSnapshot(file = DEFAULT_SNAPSHOT) {
  const cached = snapshotCache.get(file);
  if (cached) return cached;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  // the enum table and the snapshot's own UI5 version ride along on the
  // controls object so the (public) checkNodes signature stays one argument
  Object.defineProperty(raw.controls, '__enums', { value: raw.enums || {}, enumerable: false });
  // per-value @since where the enum's JSDoc carries one (additive — an older
  // snapshot without the key simply never reports enum-value-too-new)
  Object.defineProperty(raw.controls, '__enumSince', { value: raw.enumSince || {}, enumerable: false });
  Object.defineProperty(raw.controls, '__ui5Version', { value: raw.ui5Version || null, enumerable: false });
  snapshotCache.set(file, raw.controls);
  return raw.controls;
}

/** The UI5 version the metadata snapshot was generated from. Anything the
 *  target version has but this one does not simply cannot be checked. */
export function snapshotVersion(file = DEFAULT_SNAPSHOT) {
  try {
    return loadSnapshot(file).__ui5Version;
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

/* Aggregations without which the control cannot render what it is asked to.
 * Deliberately tiny and certain: a sap.m.Table bound to rows but given no
 * columns shows an empty table, no error. */
const REQUIRED_WITH = [
  { control: 'sap.m.Table', when: 'items', needs: 'columns' },
  { control: 'sap.ui.table.Table', when: 'rows', needs: 'columns' },
];

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

const knownControl = (data, control) => Boolean(data[control]);

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
/* id -> resolved control name, for every control in the tree that carries a
 * literal id. The ABAP-side rules need it: a `CONTROL_BY_ID` wire names an id,
 * and what may be done to that control depends on its TYPE.
 * -> { messageView: 'sap.m.MessageView', … } */
export function collectControlIds(root) {
  const nsMap = {};
  (function collectNs(node) {
    if (node.name !== null) Object.assign(nsMap, nsMapOf(node.attrs));
    for (const c of node.children) collectNs(c);
  })(root);
  const out = {};
  (function walk(node) {
    if (node.name !== null && !isAggregationTag(node.name)) {
      let { ns, name } = node;
      const inName = String(name).indexOf(':');
      if (inName > 0) { ns = name.slice(0, inName); name = name.slice(inName + 1); }
      const lib = nsMap[ns || ''] || null;
      const id = node.attrs.find(([n]) => n === 'id')?.[1];
      if (lib && id && !/[{}]/.test(id)) out[id] = `${lib}.${name}`;
    }
    for (const c of node.children) walk(c);
  })(root);
  return out;
}

/** The declaration of a PROPERTY across the parent chain, or null — the type
 *  decides whether a value can travel in a JSON model at all. */
export function propertyDecl(data, control, member) {
  return memberOf(data, control, member, ['properties'])?.decl || null;
}

/** Which metadata section declares `member` on `control` (walking the parent
 *  chain), or null: 'properties' | 'aggregations' | 'associations' | 'events'. */
export function memberSection(data, control, member) {
  return memberOf(data, control, member, ['properties', 'aggregations', 'associations', 'events'])?.set || null;
}

export function checkNodes(root, { data, minUi5 = '1.71', allow = [], distribution = 'sapui5', model = null, shape = null, rootFields = null } = {}) {
  /* Binding paths are judged against the SHAPE when the caller has one (all
   * declared fields), and against the render model otherwise. The two differ
   * exactly where a field is filled in code rather than by a literal seed. */
  const bindings = shape || model;
  const floor = parseVer(minUi5) || [1, 71];
  const allowed = new Set(allow.map((a) => a.toLowerCase()));
  const findings = [];
  const seen = new Set(); // dedupe repeated identical findings (row templates)
  const idsSeen = new Set();

  const report = (f) => {
    const key = `${f.type}|${f.control}|${f.member || ''}|${f.value || ''}`;
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

  /* core:require aliases: `core:require="{DateType: 'sap/ui/model/type/Date'}"`
   * declares the short name a binding's `type:`/`formatter:` then uses. Read
   * from every node - a fragment may carry its own require on an inner root. */
  const requireMap = {};
  (function collectRequire(node) {
    for (const [n, v] of node.attrs || []) {
      if (n !== 'core:require' && n !== 'require') continue;
      for (const m of String(v).matchAll(/([\w$]+)\s*:\s*'([^']+)'/g)) requireMap[m[1]] = m[2];
    }
    for (const c of node.children) collectRequire(c);
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
  const enumSince = data.__enumSince || {};

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
  function checkValue(control, attr, decl, value, offset) {
    if (value === undefined || isBinding(value)) return;
    const type = decl.type;
    if (!type) return;
    const allowed = enums[type] || primitiveValues(type);
    if (allowed) {
      if (!allowed.includes(String(value))) {
        report({
          type: 'invalid-property-value',
          control, member: attr, value: String(value), allowed, memberType: type, offset,
        });
      } else {
        /* The value exists — but since WHEN? An enum VALUE introduced after
         * the floor was invisible to every gate (the member-level @since sits
         * on the property, not the value) — ai-demokit carried this as a
         * documented residual limit and a by-policy manual check. The
         * generator now keeps the per-value @since from the enum's JSDoc. */
        const since = enumSince[type]?.[String(value)];
        if (since && !withinFloor(since, floor)) {
          report({
            type: 'enum-value-too-new',
            control, member: attr, value: String(value), memberType: type, since, minUi5, offset,
          });
        }
      }
      return;
    }
    if (isNumericType(type) && !/^[+-]?\d+(\.\d+)?$/.test(String(value).trim())) {
      report({ type: 'invalid-property-value', control, member: attr, value: String(value), memberType: type, offset });
    }
  }

  /* A binding written by the builder: client->_bind( x ) becomes {/X}.
   * Only ABSOLUTE paths are resolvable without a binding context - a
   * relative {NAME} inside an aggregation template addresses the row, so it
   * is deliberately left alone. Named models and expressions are skipped. */
  const bindingPath = (value) => {
    const v = String(value).trim();
    const m = v.match(/^\{\s*(\/[^}>=]*?)\s*\}$/);
    return m ? m[1] : null;
  };

  /* A RELATIVE binding: {NAME} or {NAME/SUB} inside a row template, which
   * addresses the row rather than the model root. Named models ({m>path}),
   * expressions ({= ... }) and complex syntax ({path: ...}) are excluded by
   * the character class - none of them mean "a field of this row". */
  const relativePath = (value) => {
    const m = String(value).trim().match(/^\{\s*([A-Za-z_]\w*(?:\/\w+)*)\s*\}$/);
    return m ? m[1] : null;
  };

  /* sap.ui.model.type.Date / DateTime / Time read a JS Date OUT of the model
   * unless formatOptions.source says otherwise. An abap2UI5 model is JSON
   * built from ABAP, so the value is always a string (or a timestamp number)
   * and there is no way to put a Date instance in it - the type then raises a
   * FormatException on the first format() and the field stays empty. Returns
   * the offending type name (the alias as written) or null.
   * -> the binding-info value, e.g. { path: '/DATE', type: 'DateType',
   *    formatOptions: { style: 'short', source: { pattern: 'yyyy-MM-dd' } } } */
  const DATE_TYPES = /^sap\.ui\.model\.type\.(Date|DateTime|Time)$/;
  const dateTypeWithoutSource = (value) => {
    const v = String(value);
    const m = v.match(/\btype\s*:\s*'([^']+)'/);
    if (!m) return null;
    // a core:require alias resolves to its module path (sap/ui/model/type/Date)
    const module = (requireMap[m[1]] || m[1]).replace(/\//g, '.');
    if (!DATE_TYPES.test(module)) return null;
    return /\bsource\s*:/.test(v) ? null : m[1];
  };

  const valueAt = (obj, p) => {
    let cur = obj;
    for (const seg of p.split('/').filter(Boolean)) {
      if (cur === null || typeof cur !== 'object') return undefined;
      if (Array.isArray(cur)) {
        cur = cur[0];
        // a NUMERIC segment is the row index itself (/T_ITEMS/9/TEXT): the
        // step into the array consumed it — which index exists is runtime
        if (/^\d+$/.test(seg)) continue;
      }
      if (!cur || !(seg in cur)) return undefined;
      cur = cur[seg];
    }
    return cur;
  };

  const hasPath = (obj, p) => {
    let cur = obj;
    for (const seg of p.split('/').filter(Boolean)) {
      if (cur === null || typeof cur !== 'object') return false;
      if (Array.isArray(cur)) {
        cur = cur[0];
        // as in valueAt: a numeric segment is the row index, consumed by the
        // array step — the fields are judged against the row's shape
        if (/^\d+$/.test(seg)) continue;
      }
      // a node whose shape the class does not declare (a DDIC structure, a
      // type from another class): we cannot know its fields, so we do not
      // claim a path under it is missing
      if (cur && cur.__unknownShape) return true;
      if (!cur || !(seg in cur)) return false;
      cur = cur[seg];
    }
    return true;
  };

  const pathInModel = (p) => hasPath(bindings, p);

  /* The row a bound aggregation hands to its template, but only when the
   * derived model KNOWS the row's shape (a structure the class declares).
   * A row assembled from a VALUE #( ) seed alone carries just the fields
   * that seed happened to set - reporting a field missing from it would be
   * a guess, and the whole point of these rules is not to guess. */
  const templateRow = (bound) => {
    const row = Array.isArray(bound) ? bound[0] : bound;
    return row && typeof row === 'object' && row.__complete ? row : null;
  };

  /* The path an AGGREGATION binding addresses, including the complex form
   * ({path: 'GROUPS', templateShareable: true}), which is how a nested
   * aggregation is usually written. Returns null when the value binds
   * something this gate cannot follow - a named model, an expression - and
   * that null is meaningful: it means the rows below are unknown, not that
   * the surrounding context still applies. */
  const aggregationPath = (value) => {
    const v = String(value).trim();
    /* The FIRST `path:` is the binding's own; a later one belongs to a NESTED
     * object - `{path:'/CATEGORIES', sorter:{path:'NAME'}}`, the usual sorted
     * aggregation. The quantifier must therefore be lazy: a greedy [^}]* runs
     * past `sorter: {` (there is no `}` before it) and captures the inner
     * path, so the aggregation resolves against a path the model does not
     * have, the row shape comes out null - and every relative field below it
     * silently stops being checked. */
    const complex = v.match(/^\{[^}]*?\bpath\s*:\s*['"]([^'"]+)['"]/);
    if (complex) return complex[1];
    return bindingPath(v) || relativePath(v);
  };

  /* {= ...} expression bindings: report only unbalanced braces/parens -
   * anything subtler is the runtime's business, and guessing produces noise. */
  const brokenExpression = (value) => {
    const v = String(value);
    if (!v.startsWith('{=')) return false;
    let braces = 0;
    let parens = 0;
    for (const c of v) {
      if (c === '{') braces++;
      else if (c === '}') braces--;
      else if (c === '(') parens++;
      else if (c === ')') parens--;
      if (braces < 0 || parens < 0) return true;
    }
    return braces !== 0 || parens !== 0;
  };

  /* What the IMMEDIATE parent node is, independent of `ownerControl` - which
   * names the nearest KNOWN control and therefore looks straight through a
   * custom or typo'd tag in between. Only the immediate parent decides
   * whether an aggregation sits where an aggregation may sit. */
  (function walk(node, ownerControl, ctx, parentKind) {
    let owner = ownerControl;
    let childCtx = ctx;
    let childKind = node.name === null ? 'root' : 'control';
    /* A tag in a FOREIGN namespace - raw XHTML (html:iframe), the abap2UI5
     * custom controls (z2ui5.cc), an in-house library - is outside what the
     * UI5 metadata can say anything about, whether it looks like a control
     * or (being lower-case) like an aggregation. Its subtree keeps no parent
     * context: a control inside it is not in some UI5 aggregation. */
    if (node.name !== null) {
      const lib = nsMap[(String(node.name).includes(':')
        ? String(node.name).split(':')[0]
        : node.ns) || ''];
      if (lib && !lib.startsWith('sap.')) {
        for (const c of node.children) walk(c, null, null, 'control');
        return;
      }
    }
    if (node.name !== null && !isAggregationTag(node.name)) {
      const full = resolve(node);
      // a prefix used but never declared: the control ends up in the wrong
      // namespace and does not load
      if (node.ns && !(node.ns in nsMap)) {
        report({ type: 'undeclared-namespace', control: node.name, member: node.ns, offset: node.offset });
      }

      const sapui5Lib = full ? sapui5OnlyLib(full) : null;
      if (sapui5Lib) {
        // not in the snapshot either way - but on OpenUI5 it simply is not
        // there, which is a runtime error waiting to happen
        if (distribution === 'openui5') {
          report({ type: 'sapui5-only-control', control: full, library: sapui5Lib, offset: node.offset });
        }
      } else if (full && !knownControl(data, full) && !BUILTIN.has(full)
          && knownLibs.has(full.slice(0, full.lastIndexOf('.')))) {
        // a typo'd control in a UI5 library the snapshot covers - the most
        // common generation error, worth failing fast without a browser
        report({ type: 'unknown-control', control: full, offset: node.offset });
      }
      if (full && knownControl(data, full)) {
        const meta = data[full];
        if (meta.since && !withinFloor(meta.since, floor)) {
          report({ type: 'control-too-new', control: full, since: meta.since, minUi5, offset: node.offset });
        }
        // deprecated only counts when it already applies to the TARGET
        // version: a control deprecated as of 1.149 is perfectly fine for a
        // 1.71 system, and warning about it would be noise
        if (meta.deprecated && deprecationApplies(meta.deprecated, floor)) {
          report({ type: 'control-deprecated', control: full, deprecated: meta.deprecated, offset: node.offset });
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
              offset: node.offset,
            });
          }
        }

        // an id written twice is a duplicate-ID error at runtime
        const idAttr = node.attrs.find(([n]) => n === 'id');
        if (idAttr && !isBinding(idAttr[1])) {
          if (idsSeen.has(idAttr[1])) {
            report({ type: 'duplicate-id', control: full, member: 'id', value: idAttr[1], offset: idAttr[2] ?? node.offset });
          }
          idsSeen.add(idAttr[1]);
        }

        for (const [attr, value, at] of node.attrs) {
          if (isFrameworkAttr(attr)) continue;
          const offset = at ?? node.offset;

          /* A formatter reference outside the curated module. UI5 resolves
           * the string at binding time; an unknown name silently yields no
           * value, so the property is simply never set — nothing red
           * anywhere. Judged only for the framework's own alias (`Formatter`
           * via core:require, or the `z2ui5.Formatter` global): when the
           * class points the alias at a module of its own, its exports are
           * not ours to know. The call form allows no space before the
           * paren, so prose mentioning a formatter never matches. */
          if (!(requireMap.Formatter && requireMap.Formatter !== FORMATTER_MODULE)) {
            for (const fm of String(value).matchAll(/(?:z2ui5\.)?Formatter\.(\w+)\(|\bformatter\s*:\s*'(?:z2ui5\.)?Formatter\.(\w+)'/g)) {
              const fn = fm[1] || fm[2];
              if (!CURATED_FORMATTERS.includes(fn)) {
                report({ type: 'uncurated-formatter', control: full, member: attr, value: fn, offset });
              }
            }
          }

          const since = sinceOf(data, full, attr);
          if (since && !withinFloor(since, floor)) {
            report({ type: 'member-too-new', control: full, member: attr, since, minUi5, offset });
            continue;
          }
          const member = memberOf(data, full, attr, ['properties', 'events', 'associations', 'aggregations']);
          if (!member) {
            if (chainComplete(data, full)) {
              report({ type: 'unknown-property', control: full, member: attr, offset });
            }
            continue;
          }

          /* The builder substitutes client->_event( ) as `.eB()` and
           * client->_bind( ) as a binding, so mixing the two up is visible
           * here: an event carrying data, or a property carrying a handler.
           * Both are silent at runtime - a dead button, or a literal
           * handler name shown as text. */
          const isHandler = String(value).trim().startsWith('.eB(');
          if (member.set === 'events' && !isHandler && isBinding(value)) {
            report({ type: 'binding-for-event', control: full, member: attr, offset });
          } else if (member.set !== 'events' && isHandler) {
            report({ type: 'event-for-property', control: full, member: attr, offset });
          }

          if (brokenExpression(value)) {
            report({ type: 'invalid-expression-binding', control: full, member: attr, value: String(value).slice(0, 80), offset });
          }

          /* A raw JSON OBJECT literal written straight into an attribute.
           * UI5 reads a leading `{` as a binding, so the value never reaches
           * the property - the classic way to lose an integration Card's
           * manifest, which is why app 118 binds it instead. `{"` is
           * unambiguous: no binding, binding-info or expression starts with a
           * quoted key, and a `{0}` message placeholder does not either. */
          if (/^\{\s*"/.test(String(value))) {
            report({ type: 'json-literal-in-attribute', control: full, member: attr, value: String(value).slice(0, 60), offset });
          }

          const dateType = dateTypeWithoutSource(value);
          if (dateType) {
            report({ type: 'date-type-without-source', control: full, member: attr, value: dateType, offset });
          }

          // a bound path the derived model does not have - a silent empty
          // field. An absolute path is checked against the model, a relative
          // one against the row the enclosing aggregation binding hands down
          if (bindings) {
            const bp = bindingPath(value);
            if (bp && !pathInModel(bp)) {
              report({ type: 'unknown-binding-path', control: full, member: attr, value: bp, offset });
            }
            /* The same existence check for ABSOLUTE paths inside complex
             * binding infos (path: '/X', parts included) and expression
             * bindings (${/X}) — the forms the simple-{/X} matcher never
             * saw. Named models are excluded by construction: their path
             * carries the model prefix before the slash, so it does not
             * START with one. */
            if (isBinding(value)) {
              for (const pm of String(value).matchAll(/\bpath\s*:\s*'(\/[^'>]*)'|\$\{\s*(\/[^}>]*)\}/g)) {
                const p = (pm[1] ?? pm[2]).trim();
                if (p && !pathInModel(p)) {
                  report({ type: 'unknown-binding-path', control: full, member: attr, value: p, offset });
                }
              }
            }
            const rp = ctx && member.set !== 'aggregations' ? relativePath(value) : null;
            if (rp && !hasPath(ctx.row, rp)) {
              report({
                type: 'unknown-binding-path',
                control: full, member: attr, value: rp, context: ctx.path, offset,
              });
            }

            /* A relative {FIELD} on a control with NO binding context at all.
             * JSONModel._getObject resolves a relative path against the
             * context and returns undefined when there is none - so the
             * control renders EMPTY, silently. Reported only when the name is
             * a field of the model ROOT, which is the flattened-element-binding
             * case (the original did bindElement('/Coll/0'), the port seeded
             * that record at the root and kept the relative form): there the
             * intent is unambiguous and client->_bind( field ) is the fix. A
             * name the root does not have is left to unknown-binding-path, and
             * a popup whose context arrives at runtime through the
             * bind_element action binds ROW fields, which are not root fields. */
            const orphan = !ctx && !ownerControl?.inTemplate && member.set !== 'aggregations' ? relativePath(value) : null;
            if (orphan && rootFields?.has(orphan.split('/')[0])) {
              report({
                type: 'relative-binding-without-context',
                control: full, member: attr, value: orphan, offset,
              });
            }
          }

          if (member.decl?.deprecated && deprecationApplies(member.decl.deprecated, floor)) {
            report({
              type: 'member-deprecated',
              control: full,
              member: attr,
              deprecated: member.decl.deprecated,
              offset,
            });
          }

          if (member.set === 'properties' && bindings) {
            const bp = bindingPath(value);
            if (bp) {
              let cur = bindings;
              for (const seg of bp.split('/').filter(Boolean)) {
                cur = cur && typeof cur === 'object' ? cur[seg] : undefined;
              }
              // only when the type is EXPLICITLY scalar - a missing type is
              // no evidence (sap.m.Table.sticky legitimately takes a list)
              const scalarType = ['string', 'int', 'float', 'boolean']
                .includes(member.decl?.type);
              if (scalarType && (Array.isArray(cur) || (cur && typeof cur === 'object'))) {
                report({
                  type: 'collection-bound-to-property',
                  control: full,
                  member: attr,
                  value: bp,
                  offset,
                });
              } else if (typeof cur === 'string' && ['int', 'float', 'boolean'].includes(member.decl?.type)) {
                /* An ABAP character field bound to a numeric or boolean UI5
                 * property. The model ships JSON, so the property receives
                 * "100" where it declared a float: 1.71 coerces it, UI5 2.x
                 * and the render gate's future mode reject the view outright
                 * ("100" is of type string, expected float). The shape's
                 * default value carries the ABAP type - '' only for a
                 * character-like field, 0 or false for the others. */
                report({
                  type: 'binding-type-mismatch',
                  control: full,
                  member: attr,
                  value: bp,
                  memberType: member.decl.type,
                  offset,
                });
              }
            }
          }

          if (member.set === 'properties') checkValue(full, attr, member.decl, value, offset);
        }

        /* Event parameters the handler reads back ($parameters>/name): they
         * are members of the control like any other, so both the version
         * floor and EXISTENCE apply — a typo'd name arrives empty with no
         * error anywhere. Existence is only judged against an event the
         * control declares ITSELF: a subclass can widen an inherited event
         * without redeclaring it (sap.m.DateRangeSelection fires `change`
         * with from/to/valid, while the metadata-declared parameters sit on
         * sap.m.InputBase and know only `value` — the exact false positive
         * the first corpus run produced). And only when that declaration
         * carries a parameters block at all: an event whose metadata names
         * none may still fire computed ones, and a miss would be a guess. */
        for (const p of node.eventParams || []) {
          // per EVENT, never against the flat member map: two events of one
          // control may declare the same parameter name with different
          // histories, and the flat map keeps only one of them
          const eventDecl = memberOf(data, full, p.member, ['events'])?.decl;
          const since = eventDecl?.params?.[p.name]?.since;
          const ownEvent = data[full]?.events?.[p.member];
          if (since && !withinFloor(since, floor)) {
            report({
              type: 'event-parameter-too-new',
              control: full,
              member: p.name,
              event: p.member,
              since,
              minUi5,
              offset: p.offset,
            });
          } else if (ownEvent?.params && !(p.name in ownEvent.params)) {
            report({
              type: 'unknown-event-parameter',
              control: full,
              member: p.name,
              event: p.member,
              allowed: Object.keys(ownEvent.params).sort(),
              offset: p.offset,
            });
          }
        }

        /* A control given its data but not the structure to show it: the
         * table renders empty, with nothing to point at. */
        for (const rule of REQUIRED_WITH) {
          if (!isA(data, full, rule.control)) continue;
          const bound = node.attrs.some(([a]) => a === rule.when)
            || node.children.some((c) => c.name === rule.when);
          const has = node.attrs.some(([a]) => a === rule.needs)
            || node.children.some((c) => c.name === rule.needs);
          if (bound && !has) {
            report({ type: 'missing-required-aggregation', control: full, member: rule.needs, offset: node.offset });
          }
        }

        /* The same aggregation opened twice under ONE control: the second
         * tag replaces the first, so half the view silently disappears.
         * Checked per node instance - two Panels each having `content` is
         * of course fine. */
        const aggHere = new Set();
        for (const child of node.children) {
          if (child.name === null || !isAggregationTag(child.name)) continue;
          if (aggHere.has(child.name)) {
            report({ type: 'duplicate-aggregation', control: full, member: child.name, offset: child.offset ?? node.offset });
          }
          aggHere.add(child.name);
        }

        /* Accessibility: only defects that are unambiguous from the markup.
         * An icon-only button and an image without alt text are unusable
         * with a screen reader. */
        const attrOf = (n) => node.attrs.find(([a]) => a === n)?.[1];
        if (isA(data, full, 'sap.m.Button') && attrOf('icon')
            && !attrOf('text') && !attrOf('tooltip')) {
          report({ type: 'missing-accessibility', control: full, member: 'tooltip', offset: node.offset });
        }
        if (isA(data, full, 'sap.m.Image') && !attrOf('alt') && !attrOf('decorative')) {
          report({ type: 'missing-accessibility', control: full, member: 'alt', offset: node.offset });
        }
        /* An aggregation binding opens a row context for the children of
         * THAT aggregation - and only of it: a {HEADER} under `columns` is
         * not addressing a row of `items`. */
        const aggRows = {};
        if (bindings) {
          for (const [attr, value] of node.attrs) {
            if (!isBinding(value)) continue;
            if (!memberOf(data, full, attr, ['aggregations'])) continue;
            /* A bound aggregation ALWAYS replaces the context for its
             * children, even when the row behind it cannot be resolved -
             * they are rows of something else now, and inheriting the
             * outer row here would report every field of the inner one as
             * missing. Unresolvable therefore means null, not "unchanged". */
            const p = aggregationPath(value);
            const bound = !p ? undefined
              : p.startsWith('/') ? valueAt(bindings, p)
                : ctx ? valueAt(ctx.row, p) : undefined;
            const row = templateRow(bound);
            aggRows[attr] = row ? { row, path: p } : null;
          }
        }
        owner = { control: full, aggregation: null, aggRows, ctx, inTemplate: ownerControl?.inTemplate || false };
        // children written directly sit in the default aggregation
        const defAgg = [...chain(data, full)].map(([, m]) => m.defaultAggregation).find(Boolean);
        childCtx = defAgg && Object.hasOwn(aggRows, defAgg) ? aggRows[defAgg] : ctx;
      }
    } else if (node.name !== null && isAggregationTag(node.name)) {
      /* An aggregation must sit inside a CONTROL. One directly inside another
       * aggregation is invalid XML and the signature of a missing shut( ):
       * the tag lands in the wrong place, and UI5 goes looking for a control
       * class by that name ("failed to load sap/ui/table/footer.js"). */
      if (parentKind === 'aggregation') {
        report({
          type: 'aggregation-in-aggregation',
          control: ownerControl?.control ?? '(unknown control)',
          member: node.name,
          parentAggregation: ownerControl?.aggregation,
          offset: node.offset,
        });
      } else if (parentKind === 'root') {
        report({
          type: 'aggregation-in-aggregation',
          control: '(view root)',
          member: node.name,
          offset: node.offset,
        });
      }
      childKind = 'aggregation';
      if (!ownerControl?.control) {
        for (const c of node.children) walk(c, owner, childCtx, childKind);
        return;
      }
      const parent = ownerControl.control;

      const since = sinceOf(data, parent, node.name);
      if (since && !withinFloor(since, floor)) {
        report({ type: 'member-too-new', control: parent, member: node.name, since, minUi5, offset: node.offset });
      } else if (!memberOf(data, parent, node.name, ['aggregations', 'associations'])) {
        if (chainComplete(data, parent)) {
          report({ type: 'unknown-aggregation', control: parent, member: node.name, offset: node.offset });
        }
      } else {
        const agg = memberOf(data, parent, node.name, ['aggregations']);
        const controlChildren = node.children.filter(
          (c) => c.name !== null && !isAggregationTag(c.name)
        ).length;
        if (agg && !agg.decl.multiple && controlChildren > 1) {
          report({
            type: 'too-many-children',
            control: parent, member: node.name, count: controlChildren, offset: node.offset,
          });
        }
      }
      /* `template` is UI5's name for a per-instance template (a
       * sap.ui.table Column.template is cloned per ROW, exactly like an
       * items template). Its context is set at runtime by the table's own
       * rows binding, which this walk does not follow into a sibling
       * aggregation - so relative bindings under it are not contextless. */
      owner = { control: parent, aggregation: node.name, aggRows: ownerControl.aggRows, ctx: ownerControl.ctx,
        inTemplate: ownerControl.inTemplate || node.name === 'template' };
      // an aggregation without its own binding stays in the context of the
      // CONTROL, never in that of a sibling aggregation's rows
      childCtx = Object.hasOwn(ownerControl.aggRows || {}, node.name)
        ? ownerControl.aggRows[node.name]
        : ownerControl.ctx ?? null;
    }
    for (const c of node.children) walk(c, owner, childCtx, childKind);
  })(root, null, null, 'root');

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
    // where the attribute section starts in the document: walk back from the
    // closing '>' over whitespace and the self-closing slash, so every
    // attribute keeps an offset a reader can jump to
    let attrsEnd = m[0].length - 1; // the '>'
    while (attrsEnd > 0 && /\s/.test(m[0][attrsEnd - 1])) attrsEnd--;
    if (selfClose) attrsEnd--;
    const attrsStart = m.index + attrsEnd - (attrSrc || '').length;
    const attrs = [];
    for (const a of (attrSrc || '').matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      attrs.push([
        a[1],
        (a[3] ?? a[4] ?? '').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
        attrsStart + a.index,
      ]);
    }
    const node = { name, ns: ns || null, attrs, children: [], offset: m.index };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}
