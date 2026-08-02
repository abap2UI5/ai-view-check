/*
 * reconstruct — z2ui5_cl_ai_xml builder calls in an ABAP class -> XML view
 * document(s) + a typed mock JSON model.
 *
 * Extracted from abap2UI5/ai-demokit scripts/render-smoke.mjs. The
 * reconstruction covers the linear factory-chain idiom (one descend/ascend
 * stack) and the handle-aware idiom (view parts built in helper methods that
 * take and return a builder handle). A class whose builder calls cannot be
 * attributed statically reports helperTokens > 0 — the caller decides whether
 * that is a warning or a failure.
 *
 * Substitutions while reconstructing (the harness controls both sides, so
 * exact framework path names do not matter):
 *   client->_bind( var )                        -> {/VAR}
 *   client->_bind( val = var path = abap_true ) -> /VAR   (bare path)
 *   client->_event*( ... )                      -> .eB()  (stub handler)
 *   z2ui5_cl_ai_xml=>as_bool( ... )             -> true
 *   |...{ expr }...| templates, `lit` && chains -> resolved statically
 */
import { scrub, parenRegion, topSplit, splitStatements, parseNamedArgs } from './abap.mjs';

export const SKIP = Symbol('skip');
const up = (s) => s.toUpperCase();

// ---------------------------------------------------------------------------
// Value expressions -> static strings
// ---------------------------------------------------------------------------
/* client->_bind( X ) / _bind_edit( X ), with X a variable or a structure
 * component. The framework turns the ABAP name into the client path itself:
 * `-` becomes `/`, a `me->` prefix drops away, and a leading `/` is added
 * (z2ui5_cl_core_srv_bind=>get_client_name). `path = abap_true` asks for the
 * bare path instead of a {binding}. */
const BIND_CALL = /^client->_bind(?:_edit)?\(\s*(?:val\s*=\s*)?((?:me->)?\w+(?:-\w+)*)\s*(?:path\s*=\s*(abap_true|abap_false)\s*)?\)$/;

export function bindingOf(expr) {
  const m = String(expr).trim().match(BIND_CALL);
  if (!m) return null;
  const name = m[1].replace(/^me->/, '');
  return {
    root: name.split('-')[0],
    path: `/${name.replace(/-/g, '/').toUpperCase()}`,
    bare: m[2] === 'abap_true',
  };
}

export function makeResolver(content, boundVars, notes) {
  // literal scalar assignments anywhere in the class, incl. multi-line
  // concatenations of pure literals: var = `a` && `b` && ... .
  const literals = new Map();
  for (const m of content.matchAll(/(?:^|\s)(?:DATA\()?(\w+)\)?\s*=\s*(`(?:[^`]|``)*`(?:\s*&&\s*`(?:[^`]|``)*`)*)\s*\.(?=\s|$)/g)) {
    const joined = [...m[2].matchAll(/`((?:[^`]|``)*)`/g)]
      .map((p) => p[1].replace(/``/g, '`')).join('');
    literals.set(m[1], joined);
  }

  const resolvePiece = (piece) => {
    const p = piece.trim();
    let m;
    if ((m = p.match(/^`((?:[^`]|``)*)`$/s))) return m[1].replace(/``/g, '`');
    if (/^cl_abap_char_utilities=>newline$/.test(p)) return '\n';
    if (/^cl_abap_char_utilities=>horizontal_tab$/.test(p)) return '\t';
    if ((m = p.match(/^cl_abap_char_utilities=>cr_lf\(1\)$/))) return '\r';
    if ((m = p.match(/^(\w+)$/))) {
      if (literals.has(m[1])) return literals.get(m[1]);
      return null;
    }
    return null;
  };

  const resolveSub = (sub) => {
    const s = sub.trim();
    let m;
    const bind = bindingOf(s);
    if (bind) {
      boundVars.add(bind.root);
      return bind.bare ? bind.path : `{${bind.path}}`;
    }
    if (/^-?\d+(\.\d+)?$/.test(s)) return s;
    const lit = resolvePiece(s);
    if (lit !== null) return lit;
    notes.push(`unresolved template expression: { ${s.slice(0, 60)} }`);
    return '';
  };

  const resolveTemplate = (tpl) => {
    // tpl includes the surrounding pipes
    let out = '';
    for (let i = 1; i < tpl.length - 1; i++) {
      const c = tpl[i];
      if (c === '\\') { out += tpl[++i] ?? ''; continue; }
      if (c === '{') {
        let depth = 1;
        let j = i + 1;
        for (; j < tpl.length && depth; j++) {
          if (tpl[j] === '{') depth++;
          else if (tpl[j] === '}') depth--;
        }
        out += resolveSub(tpl.slice(i + 1, j - 1));
        i = j - 1;
        continue;
      }
      out += c;
    }
    return out;
  };

  // one chain piece: a template, a _bind form, as_bool, or a plain literal.
  // Returns null when the piece cannot be resolved statically.
  const resolveOne = (piece) => {
    const s = piece.trim();
    let m;
    if (/^\|/.test(s)) return resolveTemplate(s);
    const bind = bindingOf(s);
    if (bind) {
      boundVars.add(bind.root);
      return bind.bare ? bind.path : `{${bind.path}}`;
    }
    if (/^z2ui5_cl_ai_xml=>as_bool\(/.test(s)) return 'true';
    return resolvePiece(s);
  };

  return function resolveExpr(expr) {
    const e = expr.trim();
    // Keep event handlers as a resolvable stub reference (.eB() resolves
    // against the harness stub controller) instead of dropping them, so UI5
    // future mode still validates the event NAME against the control — this is
    // what catches an event declared on the wrong control.
    if (/client->_event\b|client->_event_client\b/.test(e)) return '.eB()';
    // split any && chain FIRST (topSplit is template-aware, so a && inside a
    // |...| template — e.g. an expression binding — never splits)
    const pieces = topSplit(e, '&&').map(resolveOne);
    if (pieces.length && pieces.every((p) => p !== null)) return pieces.join('');
    notes.push(`unresolved value expression dropped: ${e.slice(0, 70)}`);
    return SKIP;
  };
}

// ---------------------------------------------------------------------------
// Builder calls -> node trees
// ---------------------------------------------------------------------------
/* Attach one attribute. z2ui5_cl_ai_xml refuses a name that is already on
 * the element (`ASSERT NOT line_exists( t_pair[ n = n ] )`) — the class
 * dumps rather than render invalid XML with the attribute twice, so the
 * second write is reported and dropped, exactly as ABAP would refuse it. */
/* An event argument read from the UI5 event itself:
 *   client->_event( val = `X` t_arg = VALUE #( ( `${$parameters>/item}` ) ) )
 * The reconstruction replaces the whole _event( ) call with a stub handler,
 * so the parameter names would be lost - they are recorded on the node
 * instead, where the property gate can hold them against the control that
 * fires the event. Only the first path segment is a metadata member; what
 * follows addresses fields of the object it yields. */
function recordEventParams(target, raw, member, offset) {
  for (const m of String(raw).matchAll(/\$parameters>\/(\w+)/g)) {
    (target.eventParams ??= []).push({ name: m[1], member, offset });
  }
}

function addAttr(target, name, value, offset, structure) {
  if (target.attrs.some(([n]) => n === name)) {
    structure?.push({ type: 'duplicate-property', control: target.name, member: name, offset });
    return;
  }
  target.attrs.push([name, value, offset]);
}

// apply one ->open/leaf/a/shut( ) token to a live stack (mutates the tree)
function applyToken(verb, body, stack, resolveExpr, notes, structure, offset) {
  if (verb === 'shut') {
    if (stack.length > 1) stack.pop();
    // one shut( ) more than the tree is deep: z2ui5_cl_ai_xml asserts
    // `parent IS BOUND` there, so this dumps at runtime
    else structure?.push({ type: 'excess-shut', offset });
    return;
  }
  if (verb === 'a') {
    const nm = body.match(/(?:^|\s)n\s*=\s*`([^`]*)`/);
    const vm = body.match(/(?:^|\s)v\s*=\s*([\s\S]+)$/);
    if (!nm || !vm) { notes.push(`unparsed a( ) call: ${body.slice(0, 60)}`); return; }
    const cur = stack[stack.length - 1];
    const target = cur.children.length ? cur.children[cur.children.length - 1] : cur;
    // a( ) on the bare factory root: there is no element to carry the
    // attribute, and the class asserts on exactly that
    if (target.name === null) {
      structure?.push({ type: 'attribute-without-element', member: nm[1], offset });
      return;
    }
    const val = resolveExpr(vm[1]);
    if (val === SKIP) return;
    recordEventParams(target, vm[1], nm[1], offset);
    addAttr(target, nm[1], val, offset, structure);
    return;
  }
  const nm = body.match(/(?:^|\s)n\s*=\s*`([^`]*)`/) || body.match(/^\s*`([^`]*)`/);
  if (!nm) { notes.push(`unparsed ${verb}( ) call: ${body.slice(0, 60)}`); return; }
  const nsm = body.match(/(?:^|\s)ns\s*=\s*`([^`]*)`/);
  const node = { name: nm[1], ns: nsm ? nsm[1] : null, attrs: [], children: [], offset };
  // up-front attribute table: a = VALUE #( ( `k=v` ) ... )
  const am = body.match(/(?:^|\s)a\s*=\s*VALUE #\s*\(/);
  if (am) {
    const region = parenRegion(body, body.indexOf('(', am.index + am[0].length - 1)).body;
    for (const kv of region.matchAll(/`((?:[^`]|``)*)`/g)) {
      const s = kv[1].replace(/``/g, '`');
      const eq = s.indexOf('=');
      if (eq > 0) {
        recordEventParams(node, s.slice(eq + 1), s.slice(0, eq).trim(), offset);
        addAttr(node, s.slice(0, eq).trim(), s.slice(eq + 1), offset, structure);
      }
    }
  }
  const cur = stack[stack.length - 1];
  cur.children.push(node);
  if (verb === 'open') stack.push(node);
}

export function extractDocs(content, resolveExpr, notes, structure) {
  const docs = [];
  let helperTokens = 0; // builder calls outside any factory chain
  let stack = null;
  const tokenRe = /z2ui5_cl_ai_xml=>factory\(\s*\)|->\s*(open|leaf|a|shut|stringify)\s*\(/g;
  let m;
  while ((m = tokenRe.exec(content)) !== null) {
    if (m[0].startsWith('z2ui5_cl_ai_xml=>factory')) {
      stack = [{ name: null, ns: null, attrs: [], children: [], offset: m.index }];
      continue;
    }
    if (!stack) { helperTokens++; continue; }
    const verb = m[1];
    if (verb === 'shut') {
      applyToken('shut', '', stack, resolveExpr, notes, structure, m.index);
      continue;
    }
    if (verb === 'stringify') {
      // levels left open are harmless - render( ) walks the tree from its
      // root, so the XML closes either way; only note them
      if (stack.length > 1 && structure) {
        structure.push({ type: 'open-levels', depth: stack.length - 1, note: true });
      }
      docs.push(stack[0]);
      stack = null;
      continue;
    }
    const open = content.indexOf('(', m.index + m[0].length - 1);
    const { body, end } = parenRegion(content, open);
    tokenRe.lastIndex = verb === 'a' ? end : tokenRe.lastIndex;
    applyToken(verb, body, stack, resolveExpr, notes, structure, m.index);
  }
  return { docs, helperTokens };
}

/* Process a chain of ->open/leaf/a/shut( ) calls against `stack` (mutates
 * it). `base` is the offset of the chain inside the class source, so the
 * offsets recorded on nodes and attributes stay file-absolute. */
function processChain(chain, stack, resolveExpr, notes, structure, base = null) {
  const tokenRe = /->\s*(open|leaf|a|shut|stringify)\s*\(/g;
  let m;
  while ((m = tokenRe.exec(chain)) !== null) {
    const verb = m[1];
    if (verb === 'stringify') continue;
    const at = base === null ? undefined : base + m.index;
    if (verb === 'shut') {
      applyToken('shut', '', stack, resolveExpr, notes, structure, at);
      continue;
    }
    const open = chain.indexOf('(', m.index + m[0].length - 1);
    const { body, end } = parenRegion(chain, open);
    if (verb === 'a') tokenRe.lastIndex = end;
    applyToken(verb, body, stack, resolveExpr, notes, structure, at);
  }
}

// helper methods that take a handle and RETURN one
function parseHelpers(content) {
  const helpers = new Map();
  const defRe = /METHODS\s+(\w+)\s+IMPORTING([\s\S]*?)RETURNING\s+VALUE\(\w+\)\s+TYPE REF TO z2ui5_cl_ai_xml\s*\./g;
  let d;
  while ((d = defRe.exec(content)) !== null) {
    const name = d[1];
    const params = [...d[2].matchAll(/(\w+)\s+TYPE\b/g)].map((x) => x[1]);
    const implM = content.match(new RegExp('METHOD\\s+' + name + '\\s*\\.([\\s\\S]*?)\\bENDMETHOD\\b'));
    if (!implM) continue;
    const resStmt = splitStatements(implM[1]).find((s) => /^\s*result\s*=/.test(s.text));
    if (!resStmt) continue;
    const rm = resStmt.text.match(/^\s*result\s*=\s*(\w+)\s*(->[\s\S]*)$/);
    if (!rm) continue;
    helpers.set(name, { entryParam: rm[1], bodyChain: rm[2], params });
  }
  return helpers;
}

export function extractDocsWithHelpers(content, resolveExpr, notes, structure) {
  const helpers = parseHelpers(content);
  const vdM = content.match(/METHOD\s+\w+\s*\.([\s\S]*?z2ui5_cl_ai_xml=>factory[\s\S]*?)\bENDMETHOD\b/);
  if (!vdM) return { docs: [], helperTokens: 1 };
  // where the method BODY starts in the file — statement offsets are relative
  // to it, and only the sum is a position a reader can jump to
  const bodyBase = vdM.index + vdM[0].match(/^METHOD\s+\w+\s*\./)[0].length;
  const handles = new Map(); // var -> stack (array of node refs, root..cursor)
  const docs = [];
  let helperTokens = 0;
  for (const stmt of splitStatements(vdM[1])) {
    const s = stmt.text.trim();
    if (!s) continue;
    // offset of the trimmed statement in the file; a chain group always runs
    // to the end of the statement, so its start is simply the tail position
    const at = bodyBase + stmt.offset + (stmt.text.length - stmt.text.trimStart().length);
    const tail = (group) => at + s.length - group.length;
    let m;
    // DATA(v) = z2ui5_cl_ai_xml=>factory( ) [ ->chain ]
    if ((m = s.match(/^(?:DATA\()?(\w+)\)?\s*=\s*z2ui5_cl_ai_xml=>factory\(\s*\)\s*(->[\s\S]*)?$/))) {
      const stack = [{ name: null, ns: null, attrs: [], children: [], offset: at }];
      if (m[2]) processChain(m[2], stack, resolveExpr, notes, structure, tail(m[2]));
      handles.set(m[1], stack);
      continue;
    }
    // DATA(v) = <handleVar>->chain   (capture a handle mid-chain)
    if ((m = s.match(/^(?:DATA\()?(\w+)\)?\s*=\s*(\w+)\s*(->[\s\S]*)$/)) && handles.has(m[2])) {
      const stack = handles.get(m[2]).slice();
      processChain(m[3], stack, resolveExpr, notes, structure, tail(m[3]));
      handles.set(m[1], stack);
      continue;
    }
    // client->view_display( <var>->stringify( ) )   -> emit the doc
    if ((m = s.match(/view_display\(\s*(\w+)\s*->\s*stringify/)) && handles.has(m[1])) {
      docs.push(handles.get(m[1])[0]);
      continue;
    }
    // <helper>( args )->chain   (inline the helper, re-anchored to its arg handle)
    if ((m = s.match(/^(\w+)\s*\(/)) && helpers.has(m[1])) {
      const h = helpers.get(m[1]);
      const open = s.indexOf('(', m[1].length);
      const { body: argBody, end } = parenRegion(s, open);
      const args = parseNamedArgs(argBody);
      const entryVar = (args[h.entryParam] || '').trim();
      if (!handles.has(entryVar)) { helperTokens++; continue; }
      const stack = handles.get(entryVar).slice();
      let hchain = h.bodyChain;
      for (const p of h.params) {
        if (p === h.entryParam || args[p] === undefined) continue;
        hchain = hchain.replace(new RegExp('\\b' + p + '\\b', 'g'), () => args[p]);
      }
      // the helper body is textually inlined with its parameters substituted,
      // so nothing in it maps back to a position: pass no base rather than a
      // plausible-looking wrong one, and let the finding stay position-less
      processChain(hchain, stack, resolveExpr, notes, structure, null);
      const cont = s.slice(end + 1);
      if (cont.trim()) processChain(cont, stack, resolveExpr, notes, structure, at + end + 1);
      continue;
    }
    // any other statement (local DATA, model calls) is not builder-relevant
  }
  return { docs, helperTokens };
}

const XML_ESC = (v) => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;').replace(/\t/g, '&#x9;');

export function toXml(node) {
  if (node.name === null) return node.children.map(toXml).join('');
  const q = node.ns ? `${node.ns}:${node.name}` : node.name;
  const attrs = node.attrs.map(([n, v]) => ` ${n}="${XML_ESC(v)}"`).join('');
  return node.children.length
    ? `<${q}${attrs}>${node.children.map(toXml).join('')}</${q}>`
    : `<${q}${attrs}/>`;
}

// ---------------------------------------------------------------------------
// Mock model from TYPES / DATA / model_init seeds
// ---------------------------------------------------------------------------
const NUMERIC = /^(i|int1|int2|int8|f|p|decfloat16|decfloat34)\b/;

function parseTypes(content) {
  const structs = new Map(); // ty_s_x -> [{name, type}]
  for (const m of content.matchAll(/BEGIN OF (\w+)\s*,([\s\S]*?)END OF \1/g)) {
    const fields = [];
    // the type may be qualified (z2ui5_cl_x=>ty_t_y, if_x~ty_z) - dropping
    // such a field would make every binding path through it look wrong
    for (const f of m[2].matchAll(/(\w+)\s+TYPE\s+([\w~ ]+(?:=>[\w~]+)?)\s*?(?:LENGTH\s+\d+)?\s*(?:DECIMALS\s+\d+)?\s*[,.]/g)) {
      fields.push({ name: f[1], type: f[2].trim() });
    }
    structs.set(m[1], fields);
  }
  const tables = new Map(); // ty_t_x -> row type name
  for (const m of content.matchAll(/TYPES\s+(\w+)\s+TYPE\s+STANDARD TABLE OF (\w+)/g)) {
    tables.set(m[1], m[2]);
  }
  return { structs, tables };
}

function parseData(content) {
  const vars = new Map(); // var -> { kind: 'scalar'|'table', type, value? }
  for (const m of content.matchAll(/^\s*DATA\s+(\w+)\s+TYPE\s+(?:(STANDARD TABLE OF\s+(\w+))|REF TO\s+\w+|(\w+))\s*(?:LENGTH\s+\d+)?\s*(?:DECIMALS\s+\d+)?\s*(?:WITH EMPTY KEY\s*)?(?:VALUE\s+(`(?:[^`]|``)*`|abap_true|abap_false|-?\d+(?:\.\d+)?))?\s*\.\s*$/gm)) {
    if (m[3]) vars.set(m[1], { kind: 'table', type: m[3] });
    else if (m[4]) vars.set(m[1], { kind: 'scalar', type: m[4].trim(), value: m[5] });
  }
  return vars;
}

const scalarDefault = (type) =>
  type === 'abap_bool' ? false : NUMERIC.test(type) ? 0 : '';

/* A row whose shape comes from a declared structure, not from whatever a
 * VALUE #( ) seed happened to set. Non-enumerable, so it never reaches the
 * JSON model the renderer is handed. */
const markComplete = (row) => Object.defineProperty(row, '__complete', { value: true });

/* The initial value of a field, following the class's own TYPES: a nested
 * structure is an object with its fields, a nested table one row of them -
 * not the empty string a scalar would get. That is what makes a deep path
 * like {TRANSACTION_AMOUNT/SIZE} resolvable, and what makes a nested
 * aggregation binding hand its template a row instead of a string. */
function defaultFor(type, types, depth = 0) {
  if (depth > 5) return ''; // a self-referential type has to end somewhere
  if (types.structs.has(type)) {
    return markComplete(Object.fromEntries(
      types.structs.get(type).map((f) => [up(f.name), defaultFor(f.type, types, depth + 1)])
    ));
  }
  const rowType = types.tables.get(type);
  if (rowType) {
    return types.structs.has(rowType) ? [defaultFor(rowType, types, depth + 1)] : [];
  }
  return scalarDefault(type);
}

const coerceScalar = (raw, type) =>
  raw === 'abap_true' ? true
    : raw === 'abap_false' ? false
      : raw.startsWith('`') ? (NUMERIC.test(type) ? Number(raw.slice(1, -1)) || 0 : raw.slice(1, -1).replace(/``/g, '`'))
        : NUMERIC.test(type) ? Number(raw) : raw;

/* Parse one VALUE #( ... ) region into JS rows, typed by the row's fields.
 * `shape` decides what an unseeded field becomes: with it, the field is
 * present with its initial value and the row is marked as a known shape;
 * without it, the row carries only what the seed actually set. The two are
 * needed for different jobs - see buildModel. */
function parseRows(region, rowType, types, shape = false) {
  const fields = types.structs.get(rowType) || [];
  const fType = (n) => fields.find((f) => f.name.toLowerCase() === n.toLowerCase())?.type || 'string';
  const rows = [];
  let depth = 0;
  let str = null;
  let start = -1;
  for (let i = 0; i < region.length; i++) {
    const c = region[i];
    if (str === '`') { if (c === '`') str = null; continue; }
    if (c === '`') { str = c; continue; }
    if (c === '(') { if (depth === 0) start = i + 1; depth++; }
    else if (c === ')') {
      depth--;
      if (depth === 0 && start >= 0) {
        rows.push(region.slice(start, i));
        start = -1;
      }
    }
  }
  /* An ABAP structure always has ALL its fields - a VALUE #( ) seed that
   * sets two of five does not make the other three absent, it leaves them
   * at their initial value. Starting from the field defaults keeps the mock
   * faithful (a binding to an unseeded field renders empty instead of
   * breaking) and marks the row as a KNOWN shape, which is what lets the
   * property gate judge a relative binding path at all. */
  const complete = shape && fields.length > 0;
  return rows.map((rowSrc) => {
    const row = complete
      ? Object.fromEntries(fields.map((f) => [up(f.name), defaultFor(f.type, types)]))
      : {};
    if (complete) markComplete(row);
    const pairRe = /(\w+)\s*=\s*(`(?:[^`]|``)*`|VALUE #\s*\(|abap_true|abap_false|-?\d+(?:\.\d+)?|\w+)/g;
    let p;
    while ((p = pairRe.exec(rowSrc)) !== null) {
      const [, name, raw] = p;
      const t = fType(name);
      if (raw.startsWith('VALUE #')) {
        const open = rowSrc.indexOf('(', p.index + p[0].length - 1);
        const sub = parenRegion(rowSrc, open);
        if (types.structs.has(t)) {
          // a nested STRUCTURE, not a table: VALUE #( a = 1 b = 2 ) is one
          // row, not a list of them - wrapping it in the parens a row would
          // have makes it parse as exactly that
          row[up(name)] = parseRows(`(${sub.body})`, t, types, shape)[0]
            ?? (shape ? defaultFor(t, types) : {});
        } else {
          const subRow = types.tables.get(t) || t;
          row[up(name)] = parseRows(sub.body, subRow, types, shape);
        }
        pairRe.lastIndex = sub.end + 1;
      } else if (raw.startsWith('`')) {
        const text = raw.slice(1, -1).replace(/``/g, '`');
        row[up(name)] = NUMERIC.test(t) ? Number(text) || 0 : text;
      } else if (raw === 'abap_true') row[up(name)] = true;
      else if (raw === 'abap_false') row[up(name)] = false;
      else if (/^-?\d/.test(raw)) row[up(name)] = NUMERIC.test(t) ? Number(raw) : raw;
      // bare identifiers (derived values) keep the field default:
      else row[up(name)] = shape ? defaultFor(t, types) : scalarDefault(t);
    }
    return row;
  });
}

function buildModel(content, boundVars, types, vars, notes, shape = false) {
  const model = {};
  const scalarSeed = new Map();
  for (const m of content.matchAll(/^\s*(\w+)\s*=\s*(`(?:[^`]|``)*`|abap_true|abap_false|-?\d+(?:\.\d+)?)\s*\.\s*$/gm)) {
    scalarSeed.set(m[1], m[2]);
  }
  const tableSeed = new Map();
  for (const m of content.matchAll(/^\s*(\w+)\s*=\s*VALUE #\s*\(/gm)) {
    const open = content.indexOf('(', m.index + m[0].length - 1);
    tableSeed.set(m[1], parenRegion(content, open).body);
  }
  // derived seeds like `selected = t_items[ 1 ]-text.`
  const derivedSeed = [...content.matchAll(/^\s*(\w+)\s*=\s*(\w+)\[\s*(\d+)\s*\]-(\w+)\s*\.\s*$/gm)]
    .map((m) => ({ target: m[1], table: m[2], index: +m[3], field: m[4] }));
  for (const v of boundVars) {
    const decl = vars.get(v);
    if (!decl) { notes.push(`bound variable ${v} has no DATA declaration — mocked as string`); model[up(v)] = ''; continue; }
    if (decl.kind === 'table') {
      const rowType = decl.type.startsWith('ty_') && types.structs.has(decl.type)
        ? decl.type : (types.tables.get(decl.type) || decl.type);
      model[up(v)] = tableSeed.has(v)
        ? parseRows(tableSeed.get(v), rowType, types, shape)
        : types.structs.has(rowType)
          ? [shape ? defaultFor(rowType, types)
            : Object.fromEntries(types.structs.get(rowType).map((f) => [up(f.name), scalarDefault(f.type)]))]
          // scalar-row table bound to an array property: an empty array — a {}
          // row would fail strict property validation
          : [];
    } else if (types.structs.has(decl.type)) {
      /* A bound STRUCTURE: the framework flattens ms_x-field to /MS_X/FIELD,
       * so the model needs the object. Its fields are only known from the
       * type - what a seed assigns to a single component is not followed - so
       * the render model gets an empty object (bindings resolve to the
       * control's default) and the shape gets the declared fields. */
      model[up(v)] = shape ? defaultFor(decl.type, types) : {};
    } else {
      const t = decl.type;
      if (scalarSeed.has(v)) {
        model[up(v)] = coerceScalar(scalarSeed.get(v), t);
      } else if (decl.value != null) {
        model[up(v)] = coerceScalar(decl.value, t);
      } else {
        const d = derivedSeed.find((s) => s.target === v);
        const rows = d && tableSeed.has(d.table)
          ? parseRows(tableSeed.get(d.table),
            (vars.get(d.table)?.kind === 'table' && (types.structs.has(vars.get(d.table).type)
              ? vars.get(d.table).type : types.tables.get(vars.get(d.table).type))) || '', types)
          : null;
        model[up(v)] = rows?.[d.index - 1]?.[up(d.field)] ?? scalarDefault(t);
      }
    }
  }
  return model;
}

// ---------------------------------------------------------------------------
// ABAP class source -> { nodes, docs, model, notes, helperTokens }
// ---------------------------------------------------------------------------
export function prepareAbap(abapSource) {
  const content = scrub(abapSource);
  const notes = [];
  const boundVars = new Set();
  const resolveExpr = makeResolver(content, boundVars, notes);
  const hasBuilderHelper = /RETURNING\s+VALUE\(\w+\)\s+TYPE REF TO z2ui5_cl_ai_xml/.test(content);
  const structure = [];
  const { docs: nodes, helperTokens } = hasBuilderHelper
    ? extractDocsWithHelpers(content, resolveExpr, notes, structure)
    : extractDocs(content, resolveExpr, notes, structure);
  for (const s of structure) {
    if (s.type === 'open-levels') notes.push(`${s.depth} level(s) left open at stringify( ) - harmless, render( ) closes the tree`);
  }
  const docs = nodes.map(toXml).filter(Boolean);
  const { model, modelShape } = deriveModel(content, boundVars, notes);
  return {
    nodes, docs, model, modelShape, notes, helperTokens,
    structure: structure.filter((s) => !s.note),
    usesBuilder: /z2ui5_cl_ai_xml=>factory/.test(content),
  };
}

/* Two views of the same data, for two different jobs.
   *
   * `model` is what the RENDERER gets: only what a seed actually sets. A
   * field the class fills in code (a LOOP in model_init) cannot be followed
   * statically, and inventing an empty string for it makes UI5's strict mode
   * reject a perfectly good view - `state=""` is not a ValueState.
   *
 * `modelShape` is what the property gate ASKS ABOUT: every declared field
 * of every declared structure, so a binding path can be judged against
 * what the row HAS rather than against what the seed happened to set.
 *
 * (Kept as its own function so the two pictures are always built from the
 * same parse of the class.) */
export function deriveModel(content, boundVars, notes) {
  const types = parseTypes(content);
  const vars = parseData(content);
  return {
    model: buildModel(content, boundVars, types, vars, notes),
    modelShape: buildModel(content, boundVars, types, vars, [], true),
  };
}
