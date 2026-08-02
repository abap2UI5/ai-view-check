/*
 * xml-view — the TYPED builder (z2ui5_cl_xml_view) -> XML view + mock model.
 *
 * The generic builder (z2ui5_cl_ai_xml, see reconstruct.mjs) writes UI5 tag
 * names as strings; the typed one is what most abap2UI5 apps are actually
 * written with, and writes them as ABAP methods:
 *
 *   view->table( items = client->_bind( tab )
 *       )->columns(
 *           )->column( )->text( `Carrier`
 *       )->get_parent( ).
 *
 * Which method adds which control, whether it descends into it, and which of
 * its parameters becomes which XML attribute is READ from the framework
 * sources into data/xml-view.json (scripts/generate-view-builder.mjs) rather
 * than maintained here - 441 methods, and they change with every abap2UI5
 * release.
 *
 * The result is the same node tree the generic builder produces, so the
 * property gate, the render gate and the abap2UI5 rules all apply unchanged.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scrub, parenRegion, splitStatements, parseNamedArgs } from './abap.mjs';
import { makeResolver, deriveModel, toXml, SKIP } from './reconstruct.mjs';

const DEFAULT_MAP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'xml-view.json');

let cached = null;
export function loadBuilderMap(file = DEFAULT_MAP) {
  if (!cached || file !== DEFAULT_MAP) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (file === DEFAULT_MAP) cached = raw;
    else return raw;
  }
  return cached;
}

/** The class this reconstruction understands. */
export const usesTypedBuilder = (source) => /z2ui5_cl_xml_view=>factory/i.test(source);

/* Methods that move around the tree instead of adding to it. */
const NAVIGATION = new Set(['get_parent', 'get_root', 'get', 'get_child']);

const node = (name, ns, offset) => ({ name, ns: ns || null, attrs: [], children: [], offset });

/*
 * Apply one ->method( ) call to a live stack. Returns nothing; the stack and
 * the tree are mutated, exactly like the generic builder's applyToken.
 */
function applyCall(method, body, stack, ctx) {
  const { map, resolveExpr, notes, usedNs, offset } = ctx;
  const cur = stack[stack.length - 1];

  if (method === 'stringify' || method === 'xml_get') return;
  if (NAVIGATION.has(method)) {
    if (method === 'get_parent') { if (stack.length > 1) stack.pop(); return; }
    if (method === 'get_root') { stack.length = 1; return; }
    if (method === 'get_child') {
      const ix = Number(String(body).trim().replace(/^index\s*=\s*/, ''));
      const child = cur.children.filter((c) => c.name)[ix - 1];
      if (child) stack.push(child);
      else notes.push(`get_child( ${body.trim()} ) has no such child - ignored`);
      return;
    }
    // get( `Name` ) climbs to the nearest ancestor with that tag
    const want = body.match(/`([^`]*)`/)?.[1];
    if (!want) { notes.push('get( ) with a non-literal name - tree position unknown'); return; }
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].name === want) { stack.length = i + 1; return; }
    }
    notes.push(`get( \`${want}\` ) found no such ancestor - ignored`);
    return;
  }

  /* _z2ui5( ) switches to the custom-control class for the NEXT call only;
   * the flag lives on the context because the call itself adds nothing. */
  if (method === '_z2ui5') { ctx.cc = true; return; }

  // the escape hatch: _generic( name = `X` ns = `y` ) writes a raw tag
  if (method === '_generic') {
    const args = parseNamedArgs(body);
    const name = (args.name || body).match(/`([^`]*)`/)?.[1];
    if (!name) { notes.push(`_generic( ) with a non-literal name: ${body.slice(0, 50)}`); return; }
    const ns = (args.ns || '').match(/`([^`]*)`/)?.[1] || null;
    const child = node(name, ns, offset);
    if (ns) usedNs.add(ns);
    cur.children.push(child);
    stack.push(child); // _generic returns the child
    return;
  }

  const table = ctx.cc ? map.cc : map.methods;
  ctx.cc = false;
  const entry = table[method];
  if (!entry) {
    // not a builder call at all (a model method, a helper) - the statement
    // walker only gets here for chains on a builder handle, so say so
    notes.push(`unknown builder method ->${method}( ) - ignored`);
    return;
  }

  const args = parseNamedArgs(body);
  // ABAP allows one positional argument: the PREFERRED PARAMETER, or the
  // only one the method has
  if (!Object.keys(args).length && body.trim() && entry.preferred) {
    args[entry.preferred] = body.trim();
  }

  const nsArg = args.ns ? resolveExpr(args.ns) : null;
  const ns = (nsArg && nsArg !== SKIP ? nsArg : entry.ns) || null;
  const name = (ns && entry.controlByNs?.[ns]) || entry.control;
  const child = node(name, ns, offset);
  if (ns) usedNs.add(ns);

  for (const [param, raw] of Object.entries(args)) {
    if (param === 'ns') continue;
    const attr = entry.attrs[param.toLowerCase()];
    if (!attr) {
      // a parameter that does not reach the view (t_prop, tab_index, ...)
      continue;
    }
    const value = resolveExpr(raw);
    if (value === SKIP) continue;
    // the framework skips empty attribute values (LOOP AT mt_prop WHERE
    // v <> ``), so an unpassed parameter never reaches the XML
    if (value === '') continue;
    child.attrs.push([attr, value, offset]);
  }

  cur.children.push(child);
  if (entry.descend) stack.push(child);
}

/** Run a `->a( )->b( )` chain against a stack. */
function processChain(chain, stack, ctx, base) {
  const tokenRe = /->\s*(\w+)\s*\(/g;
  let m;
  while ((m = tokenRe.exec(chain)) !== null) {
    const open = chain.indexOf('(', m.index + m[0].length - 1);
    const { body, end } = parenRegion(chain, open);
    // always skip past the arguments: they contain -> themselves
    // (client->_bind( ), client->_event( )) and would otherwise be read as
    // builder calls
    tokenRe.lastIndex = end;
    ctx.offset = base === null ? undefined : base + m.index;
    applyCall(m[1], body, stack, ctx);
  }
}

/*
 * Walk the class statement by statement, keeping every builder handle alive:
 *
 *   DATA(view) = z2ui5_cl_xml_view=>factory( )->shell( )   " a new tree
 *   DATA(page) = view->page( title = `x` )                 " a cursor into it
 *   page->button( text = `Go` )                            " added under page
 *   client->view_display( view->stringify( ) )             " the doc is done
 */
function extractDocs(content, resolveExpr, notes, map) {
  const handles = new Map(); // variable -> stack (root .. cursor)
  const roots = new Set();
  const docs = [];
  const usedNs = new Set();
  const ctx = { map, resolveExpr, notes, usedNs, cc: false };
  let helperTokens = 0;

  const receiver = (s) => s.match(/^(?:me->)?(\w+)\s*(->[\s\S]*)$/);

  for (const stmt of splitStatements(content)) {
    const s = stmt.text.trim();
    if (!s.includes('->') && !s.includes('=>')) continue;
    const at = stmt.offset + (stmt.text.length - stmt.text.trimStart().length);
    const tail = (group) => at + s.length - group.length;
    let m;

    // DATA(v) = z2ui5_cl_xml_view=>factory( ) [ ->chain ]
    if ((m = s.match(/^(?:DATA\()?(\w+)\)?\s*=\s*z2ui5_cl_xml_view=>(factory\w*)\s*\(([\s\S]*?)\)\s*(->[\s\S]*)?$/i))) {
      const factory = map.factories[m[2]] || map.factories.factory;
      const root = node(factory.control, factory.ns, at);
      for (const [n, v] of Object.entries(factory.attrs)) root.attrs.push([n, v, at]);
      const stack = [root];
      roots.add(root);
      if (m[4]) processChain(m[4], stack, ctx, tail(m[4]));
      handles.set(m[1], stack);
      continue;
    }

    // client->view_display( <handle>->stringify( ) ) - the document is done
    if ((m = s.match(/(?:view_display|popup_display|nav_app_call)\s*\(\s*(?:val\s*=\s*)?(?:me->)?(\w+)\s*->\s*(?:get_root\(\s*\)\s*->\s*)?stringify/))
        && handles.has(m[1])) {
      docs.push(handles.get(m[1])[0]);
      continue;
    }

    // DATA(v) = <handle>->chain   (a cursor captured mid-chain)
    if ((m = s.match(/^(?:DATA\()?(\w+)\)?\s*=\s*(?:me->)?(\w+)\s*(->[\s\S]*)$/)) && handles.has(m[2])) {
      const stack = handles.get(m[2]).slice();
      processChain(m[3], stack, ctx, tail(m[3]));
      handles.set(m[1], stack);
      continue;
    }

    // <handle>->chain
    if ((m = receiver(s)) && handles.has(m[1])) {
      const stack = handles.get(m[1]).slice();
      processChain(m[2], stack, ctx, tail(m[2]));
      continue;
    }

    /* A builder chain on something this walk cannot follow - a view part
     * built in a helper method that takes the handle as a parameter. Counted,
     * not guessed: an incomplete tree would validate the wrong view. */
    if ((m = receiver(s)) && !handles.has(m[1])
        && /->\s*(\w+)\s*\(/.test(m[2])
        && [...m[2].matchAll(/->\s*(\w+)\s*\(/g)].some((c) => map.methods[c[1]] || map.cc[c[1]])) {
      helperTokens++;
    }
  }

  // a view that was built but never handed over still gets checked
  for (const stack of handles.values()) {
    if (!docs.includes(stack[0]) && roots.has(stack[0])) docs.push(stack[0]);
  }

  /* The framework declares a namespace on the root as soon as a control uses
   * it (xml_get_parts walks mt_ns) - without that the property gate would
   * see prefixes that are nowhere declared. */
  for (const root of docs) {
    for (const prefix of usedNs) {
      const lib = map.namespaces[prefix];
      if (!lib) continue;
      if (root.attrs.some(([n]) => n === `xmlns:${prefix}`)) continue;
      root.attrs.push([`xmlns:${prefix}`, lib, root.offset]);
    }
  }

  return { docs, helperTokens };
}

/*
 * ABAP class using the typed builder -> the same result shape prepareAbap
 * returns for the generic one.
 */
export function prepareTypedAbap(abapSource, { map: mapFile } = {}) {
  const content = scrub(abapSource);
  const notes = [];
  const boundVars = new Set();
  const resolveExpr = makeResolver(content, boundVars, notes);
  const map = loadBuilderMap(mapFile);
  const { docs: nodes, helperTokens } = extractDocs(content, resolveExpr, notes, map);
  const { model, modelShape } = deriveModel(content, boundVars, notes);
  return {
    nodes,
    docs: nodes.map(toXml).filter(Boolean),
    model,
    modelShape,
    notes,
    helperTokens,
    structure: [],
    usesBuilder: usesTypedBuilder(content),
  };
}
