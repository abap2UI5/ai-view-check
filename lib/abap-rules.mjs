/*
 * abap-rules — checks that need the ABAP class, not just the view tree.
 *
 * These are the abap2UI5-specific defects: the ones that stay silent at
 * runtime because nothing throws. A button whose event nobody handles does
 * nothing; a value bound to a local variable is gone after the roundtrip.
 * No UI5 tooling can see them - they only exist in the relationship
 * between the class and the view it builds.
 */
import { scrub, parenRegion } from './abap.mjs';

/** Attribute-like names whose value carries an event handler. */
const EVENT_CALL = /client->_event(?:_client|_display|_frontend)?\s*\(/g;

/** Instance data survives the roundtrip; a local does not. */
function instanceAttributes(src) {
  const names = new Set();
  // DATA name TYPE ... / DATA: a TYPE x, b TYPE y - in the class definition
  const defEnd = src.search(/\bENDCLASS\b/i);
  const head = defEnd > 0 ? src.slice(0, defEnd) : src;
  for (const m of head.matchAll(/^\s*(?:CLASS-)?DATA:?\s+([\s\S]*?)(?=^\s*(?:CLASS-)?DATA\b|^\s*(?:METHODS|CLASS-METHODS|TYPES|CONSTANTS|INTERFACES|PUBLIC SECTION|PROTECTED SECTION|PRIVATE SECTION|ENDCLASS)\b)/gim)) {
    for (const d of m[1].split(',')) {
      const n = d.trim().match(/^(\w+)/);
      if (n) names.add(n[1].toUpperCase());
    }
  }
  return names;
}

/** Variables declared inline or with DATA inside a method body. */
function localVariables(src) {
  const names = new Set();
  for (const m of src.matchAll(/\bDATA\(\s*(\w+)\s*\)/gi)) names.add(m[1].toUpperCase());
  for (const m of src.matchAll(/\bFIELD-SYMBOLS?\s*<\s*(\w+)\s*>/gi)) names.add(m[1].toUpperCase());
  // DATA lv_x TYPE ... written inside a METHOD ... ENDMETHOD block
  for (const body of src.matchAll(/\bMETHOD\b[\s\S]*?\bENDMETHOD\b/gi)) {
    for (const m of body[0].matchAll(/^\s*DATA\s+(\w+)\s+TYPE\b/gim)) names.add(m[1].toUpperCase());
  }
  return names;
}

/** Literal event names in client->_event( `X` ) / ( 'X' ) / ( |X| ),
 *  mapped to where they are raised. */
function eventNames(src) {
  const names = new Map();
  for (const m of src.matchAll(/client->_event(?:_client)?\s*\(\s*(?:val\s*=\s*)?[`'|]([A-Z0-9_]+)[`'|]/gi)) {
    const name = m[1].toUpperCase();
    if (!names.has(name)) names.set(name, m.index);
  }
  return names;
}

/** Event names the class reacts to: check_on_event( `X` ), and constants
 *  compared against get_event( ). A constant reference on either side means
 *  we cannot resolve the name statically - handled by the caller. */
function handledEvents(src) {
  const names = new Set();
  for (const m of src.matchAll(/check_on_event\s*\(\s*(?:val\s*=\s*)?[`'|]([A-Z0-9_]+)[`'|]/gi)) {
    names.add(m[1].toUpperCase());
  }
  for (const m of src.matchAll(/get_event\s*\(\s*\)\s*=\s*[`'|]([A-Z0-9_]+)[`'|]/gi)) {
    names.add(m[1].toUpperCase());
  }
  // WHEN `X`. inside a CASE over the event
  for (const m of src.matchAll(/\bWHEN\s+[`'|]([A-Z0-9_]+)[`'|]/gi)) names.add(m[1].toUpperCase());
  return names;
}

/*
 * Run the ABAP-level rules over one class source. Returns findings in the
 * shape the property gate uses, so callers can treat them alike.
 */
export function checkAbapRules(source) {
  const src = scrub(source);
  const findings = [];
  const seen = new Set();
  const report = (f) => {
    const key = `${f.type}|${f.control || ''}|${f.member || ''}|${f.value || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };

  /* _bind_edit is obsolete - _bind is two-way as well. With one exception,
   * documented in z2ui5_if_client itself: "_bind has no
   * custom_mapper_back/custom_filter_back parameters - keep using _bind_edit
   * while you pass those". A call that passes one of them is not a leftover,
   * it is the only way to say what it says. */
  for (const m of src.matchAll(/client->(_bind_edit)\s*\(/g)) {
    const open = src.indexOf('(', m.index + m[0].length - 1);
    const { body } = parenRegion(src, open);
    if (/\bcustom_(mapper|filter)_back\b/.test(body)) continue;
    report({ type: 'obsolete-binder', member: m[1], offset: m.index });
  }

  // a value bound to a local variable is lost after the roundtrip: the
  // instance is serialized, the method stack is not
  const locals = localVariables(src);
  const attrs = instanceAttributes(src);
  for (const m of src.matchAll(/client->_bind(?:_edit)?\s*\(\s*(?:val\s*=\s*)?(\w+)\s*[)\s]/g)) {
    const name = m[1].toUpperCase();
    if (locals.has(name) && !attrs.has(name)) {
      report({ type: 'binding-to-local', member: m[1], offset: m.index });
    }
  }

  /* ABAP booleans are 'X' and ' ', UI5 wants "true"/"false". Writing one
   * into an attribute without z2ui5_cl_ai_xml=>as_bool( ) puts an 'X' in
   * the view - UI5 then reads a non-empty string, so `visible = ' '`
   * (abap_false!) turns the control VISIBLE. The classic silent inversion. */
  const boolVars = new Set();
  for (const m of src.matchAll(/\b(?:DATA|CLASS-DATA)\s+(\w+)\s+TYPE\s+(?:abap_bool|abap_boolean|boolean|xfeld|flag)\b/gi)) {
    boolVars.add(m[1].toUpperCase());
  }
  for (const m of src.matchAll(/\bDATA:\s*(\w+)\s+TYPE\s+(?:abap_bool|abap_boolean|boolean)\b/gi)) {
    boolVars.add(m[1].toUpperCase());
  }
  // ->a( n = `x` v = <expr> ) with the value not wrapped in as_bool( )
  for (const m of src.matchAll(/->\s*a\s*\(\s*n\s*=\s*[`'|]([\w:]+)[`'|]\s*v\s*=\s*([^)]*?)\s*\)/g)) {
    const [, attr, rawValue] = m;
    const value = rawValue.trim();
    if (/as_bool\s*\(/.test(value) || /_bind\w*\s*\(/.test(value)) continue;
    const isAbapBool =
      /^abap_(true|false|undefined)$/i.test(value) ||
      boolVars.has(value.toUpperCase()) ||
      /^client->check_\w+\s*\(\s*\)$/.test(value) ||
      /^xsdbool\s*\(/i.test(value) ||
      /^boolc\s*\(/i.test(value);
    if (isAbapBool) {
      report({ type: 'unconverted-abap-boolean', member: attr, value: value.slice(0, 40), offset: m.index });
    }
  }

  /* An event raised in the view that nothing handles is usually a dead
   * control - but not always: in abap2UI5 an event also forces a roundtrip,
   * which alone synchronises the model back into ABAP. That makes this a
   * hint, never an error, and it is skipped entirely when handler names
   * are not literals (a constant or variable is not statically knowable). */
  const raised = eventNames(src);
  const handled = handledEvents(src);
  const dynamicHandling = /check_on_event\s*\(\s*(?:val\s*=\s*)?[a-z_]\w*[-\s)]/i.test(src);
  if (!dynamicHandling) {
    for (const [name, offset] of raised) {
      if (!handled.has(name)) {
        report({ type: 'event-without-handler', value: name, offset });
      }
    }
  }

  /* A view that is built but never handed to the client renders nothing -
   * an empty page with no error anywhere. Only reported when the class
   * builds a view itself and no display/handover call appears at all. */
  const factory = src.match(/z2ui5_cl_ai_xml=>factory\s*\(/);
  if (factory
      && !/(view_display|popup_display|nav_app_call|nav_app_leave)\s*\(/.test(src)) {
    report({ type: 'view-never-displayed', offset: factory.index });
  }

  /* A t_arg value the app expects the CLIENT to resolve must be $-prefixed:
   * the runtime (z2ui5_cl_core_srv_event=>get_t_arg) sends `$...` and `{...}`
   * entries to the frontend verbatim, but only a $-prefixed expression is
   * resolved by UI5 before the roundtrip - a bare-brace `{COL}` is neither
   * resolved nor quoted, so get_event_arg( ) receives an EMPTY value with no
   * error anywhere. The one legitimate bare-brace form is a client-composed
   * template that STARTS with a {N} placeholder ({0}, {1?...}), which the
   * runtime quotes as a plain string. */
  for (const m of src.matchAll(/\bt_arg\s*=\s*VALUE\s+#?\s*\(/g)) {
    const open = src.indexOf('(', m.index + m[0].length - 1);
    const { body } = parenRegion(src, open);
    for (const el of body.matchAll(/\(\s*[`'|]([^`'|]*)[`'|]\s*\)/g)) {
      const lit = el[1].trim();
      if (!lit.startsWith('{')) continue;
      if (/^\{\d+[?}]/.test(lit)) continue; // {N} template placeholder - quoted, fine
      report({ type: 'event-arg-unresolved', value: lit.slice(0, 40), offset: m.index + el.index });
    }
  }

  return findings;
}
