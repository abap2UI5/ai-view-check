/*
 * abap-rules — checks that need the ABAP class, not just the view tree.
 *
 * These are the abap2UI5-specific defects: the ones that stay silent at
 * runtime because nothing throws. A button whose event nobody handles does
 * nothing; a value bound to a local variable is gone after the roundtrip.
 * No UI5 tooling can see them - they only exist in the relationship
 * between the class and the view it builds.
 */
import { scrub } from './abap.mjs';

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

/** Literal event names in client->_event( `X` ) / ( 'X' ) / ( |X| ). */
function eventNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/client->_event(?:_client)?\s*\(\s*(?:val\s*=\s*)?[`'|]([A-Z0-9_]+)[`'|]/gi)) {
    names.add(m[1].toUpperCase());
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

  // _bind_edit is obsolete - _bind covers it
  for (const m of src.matchAll(/client->(_bind_edit)\s*\(/g)) {
    report({ type: 'obsolete-binder', member: m[1] });
  }

  // a value bound to a local variable is lost after the roundtrip: the
  // instance is serialized, the method stack is not
  const locals = localVariables(src);
  const attrs = instanceAttributes(src);
  for (const m of src.matchAll(/client->_bind(?:_edit)?\s*\(\s*(?:val\s*=\s*)?(\w+)\s*[)\s]/g)) {
    const name = m[1].toUpperCase();
    if (locals.has(name) && !attrs.has(name)) {
      report({ type: 'binding-to-local', member: m[1] });
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
    for (const name of raised) {
      if (!handled.has(name)) {
        report({ type: 'event-without-handler', value: name });
      }
    }
  }

  return findings;
}
