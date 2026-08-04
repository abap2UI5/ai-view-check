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
import { ACTION_ARGS } from './frontend-actions.mjs';
import { memberSection, propertyDecl } from './properties.mjs';

/** Attribute-like names whose value carries an event handler. */
const EVENT_CALL = /client->_event(?:_client|_display|_frontend)?\s*\(/g;

/** Every string literal in the source with its kind: a backtick literal takes
 *  a backslash verbatim, a |…| template reads it as an escape. That is the
 *  whole difference between CSS that renders and CSS that kills the view. */
function literalSegments(abap) {
  const segments = [];
  let kind = null;
  let start = 0;
  for (let i = 0; i < abap.length; i++) {
    const c = abap[i];
    if (kind === '`') {
      if (c === '`') { segments.push({ kind, start, end: i }); kind = null; }
    } else if (kind === '|') {
      if (c === '\\') i++;
      else if (c === '|') { segments.push({ kind, start, end: i }); kind = null; }
    } else if (c === '`' || c === '|') {
      kind = c;
      start = i + 1;
    }
  }
  return segments;
}

/** Top-level `( … )` elements of a VALUE #( ) region - string-aware, so a
 *  bracket inside a literal never opens an element. */
function countElements(body) {
  let count = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '`' || c === '|') {
      for (i++; i < body.length; i++) {
        if (body[i] === '\\' && c === '|') i++;
        else if (body[i] === c) break;
      }
      continue;
    }
    if (c === '(') { count++; i = parenRegion(body, i).end; }
  }
  return count;
}

/** The literal t_arg elements of a `VALUE #( ( `a` ) ( `b` ) )` region, with
 *  the absolute offset of each. A non-literal element (a variable, an
 *  expression) is kept as null: its value is not statically knowable, and a
 *  rule that judged it would be guessing. */
function literalElements(body, base) {
  const elements = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '(') continue;
    const { body: inner, end } = parenRegion(body, i);
    const literal = inner.match(/^\s*(?:([`'])((?:[^`'])*)\1|\|([^|]*)\|)\s*$/);
    elements.push({ value: literal ? (literal[2] ?? literal[3]) : null, offset: base + i });
    i = end;
  }
  return elements;
}

/* Where a handler for a named event begins: the three literal forms a class
 * dispatches with. A `get_event_arg( )` after one of them is read in that
 * event's handler - the nearest preceding marker wins.
 *
 * ENDMETHOD is a marker too, with no event: dispatch does not survive a
 * method boundary, and without that barrier a `get_event_arg( )` in some
 * later view-building method inherits the last WHEN of the handler method.
 * (Both of those were real false positives on the ai-demokit corpus.) */
function eventScopes(src) {
  const scopes = [];
  const add = (re, event = (m) => m[1].toUpperCase()) => {
    for (const m of src.matchAll(re)) scopes.push({ at: m.index, event: event(m) });
  };
  add(/check_on_event\s*\(\s*(?:val\s*=\s*)?[`'|]([A-Z0-9_]+)[`'|]/gi);
  add(/get_event\s*\(\s*\)\s*=\s*[`'|]([A-Z0-9_]+)[`'|]/gi);
  add(/\bWHEN\s+[`'|]([A-Z0-9_]+)[`'|]/gi);
  add(/\bENDMETHOD\b/gi, () => null);
  return scopes.sort((a, b) => a.at - b.at);
}

/* Where the branch opened by an IF/ELSEIF condition ending at `from` ends:
 * the next ELSEIF/ELSE/ENDIF at ITS OWN nesting level (inner IFs open and
 * close below it), or ENDMETHOD as the hard stop. Both lifecycle rules read
 * branches with this. */
function ifBranchEnd(src, from) {
  const tokenRe = /\b(IF|ELSEIF|ELSE|ENDIF|ENDMETHOD)\b/gi;
  tokenRe.lastIndex = from;
  let depth = 0;
  let t;
  while ((t = tokenRe.exec(src)) !== null) {
    const kind = t[1].toUpperCase();
    if (kind === 'IF') depth++;
    else if (kind === 'ENDIF') {
      if (depth === 0) return t.index;
      depth--;
    } else if ((kind === 'ELSEIF' || kind === 'ELSE') && depth === 0) {
      return t.index;
    } else if (kind === 'ENDMETHOD') return t.index;
  }
  return src.length;
}

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

/** The PUBLIC SECTION's own DATA names. Only these are serialized into the
 *  model and shipped to the browser (z2ui5_cl_core_srv_model filters on
 *  visibility = public), which is what makes them the transport surface. */
function publicAttributes(src) {
  const section = src.match(/\bPUBLIC\s+SECTION\s*\.([\s\S]*?)(?=\b(?:PROTECTED\s+SECTION|PRIVATE\s+SECTION|ENDCLASS)\b)/i);
  if (!section) return [];
  const names = [];
  for (const m of section[1].matchAll(/^\s*(?:CLASS-)?DATA:?\s+([\s\S]*?)(?=^\s*(?:CLASS-)?DATA\b|^\s*(?:METHODS|CLASS-METHODS|TYPES|CONSTANTS|INTERFACES|ALIASES)\b|$)/gim)) {
    for (const declaration of m[1].split(',')) {
      const name = declaration.trim().match(/^(\w+)/);
      if (name) names.push({ name: name[1], offset: section.index + section[1].indexOf(name[1], m.index) });
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
/* opts.data        the metadata snapshot (optional — without it the rules that
 *                  need UI5 knowledge stay silent)
 * opts.controlIds  id -> control name, from the class's own views */
export function checkAbapRules(source, { data = null, controlIds = null } = {}) {
  const src = scrub(source);
  const findings = [];
  const seen = new Map();
  /* Repeated identical findings collapse into one (a row template reports the
   * same defect once), but their FIXES do not: every occurrence carries its
   * own span, or `--fix` would need one run per call site. */
  const report = (f) => {
    const key = `${f.type}|${f.control || ''}|${f.member || ''}|${f.value || ''}`;
    const prev = seen.get(key);
    if (prev) {
      if (f.fixes) (prev.fixes ??= []).push(...f.fixes);
      return;
    }
    seen.set(key, f);
    findings.push(f);
  };

  /* The ids this class hands out in its views: `)->a( n = `id` v = `x` )`.
   * -> a Set of literal ids, or null when ANY id attribute is built at
   * runtime (a template, a variable, a concatenation) — then the set is not
   * the full truth and no id may be called unknown. */
  const viewIds = (() => {
    const ids = new Set();
    for (const m of src.matchAll(/\ba\(\s*n\s*=\s*`id`\s+v\s*=\s*([^\n]*)/g)) {
      const literal = m[1].match(/^\s*`([^`]*)`/);
      if (!literal) return null;
      ids.add(literal[1]);
    }
    return ids.size ? ids : null;
  })();

  /* _bind_edit is obsolete - _bind is two-way as well. With one exception,
   * documented in z2ui5_if_client itself: "_bind has no
   * custom_mapper_back/custom_filter_back parameters - keep using _bind_edit
   * while you pass those". A call that passes one of them is not a leftover,
   * it is the only way to say what it says. */
  for (const m of src.matchAll(/client->(_bind_edit)\s*\(/g)) {
    const open = src.indexOf('(', m.index + m[0].length - 1);
    const { body } = parenRegion(src, open);
    if (/\bcustom_(mapper|filter)_back\b/.test(body)) continue;
    // autofixable: the call is identical apart from the method name
    const token = m.index + m[0].indexOf(m[1]);
    report({
      type: 'obsolete-binder', member: m[1], offset: m.index,
      fixes: [{ start: token, end: token + m[1].length, text: '_bind' }],
    });
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
  for (const m of src.matchAll(/->\s*a\s*\(\s*n\s*=\s*[`'|]([\w:]+)[`'|]\s*v\s*=\s*([^)]*?)\s*\)/gd)) {
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
      /* Autofixable only for a bare token (abap_true, a declared flag): those
       * wrap without changing what is evaluated. An expression is left alone -
       * a fix that has to guess where the value ends is not a fix. */
      const span = /^\w+$/.test(value) ? m.indices[2] : null;
      report({
        type: 'unconverted-abap-boolean', member: attr, value: value.slice(0, 40), offset: m.index,
        ...(span ? { fixes: [{ start: span[0], end: span[1], text: `z2ui5_cl_ai_xml=>as_bool( ${value} )` }] } : {}),
      });
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
  // ONLY client->_event( ) - a BACKEND event, whose t_arg values travel back
  // and are read with get_event_arg( ). client->_event_client( ) and
  // follow_up_action( ) are FRONTEND actions: their t_arg is the argument list
  // of the action itself, and a brace object there is the documented way to
  // hand a parameter set to the frontend (cs_event-urlhelper takes
  // |\{ URL: '…', NEW_WINDOW: true \}|). Flagging those would be wrong.
  /* How many t_arg values each event actually sends, by name - the arity
   * get_event_arg( ) is read against below. The maximum wins when one name is
   * raised from several places: the reader is right as long as ANY raise site
   * sends that many. */
  const arity = new Map();
  for (const ev of src.matchAll(/client->_event\s*\(/g)) {
    const evOpen = src.indexOf('(', ev.index + ev[0].length - 1);
    const { body: evBody } = parenRegion(src, evOpen);
    const nameMatch = evBody.match(/^\s*(?:val\s*=\s*)?[`'|]([A-Z0-9_]+)[`'|]/i);
    const tm = evBody.match(/\bt_arg\s*=\s*VALUE\s+#?\s*\(/);
    if (nameMatch) {
      let count = 0;
      if (tm) {
        const argOpen = evBody.indexOf('(', tm.index + tm[0].length - 1);
        count = countElements(parenRegion(evBody, argOpen).body);
      }
      const name = nameMatch[1].toUpperCase();
      arity.set(name, Math.max(arity.get(name) ?? 0, count));
    }
    if (!tm) continue;
    const open = evBody.indexOf('(', tm.index + tm[0].length - 1);
    const { body } = parenRegion(evBody, open);
    const m = { index: evOpen + evBody.indexOf(tm[0]) };
    // Only a `backtick` / 'quoted' literal hands its braces to the frontend
    // verbatim. A |…| STRING TEMPLATE is ABAP: |{ badgemin }| interpolates the
    // variable server-side and sends its value - perfectly correct, and not
    // this rule's business. A template only reaches the frontend with braces
    // when they are escaped (|\{COL\}|), which is the bad form again.
    for (const el of body.matchAll(/\(\s*(?:([`'])([^`']*)\1|\|([^|]*)\|)\s*\)/g)) {
      const isTemplate = el[3] !== undefined;
      const raw = isTemplate ? el[3] : el[2];
      const lit = raw.trim();
      const bad = isTemplate ? lit.startsWith('\\{') : lit.startsWith('{');
      if (!bad) continue;
      const shown = lit.replace(/\\/g, '');
      if (/^\{\d+[?}]/.test(shown)) continue; // {N} template placeholder - quoted, fine
      /* Autofixable in the literal form: the missing `$` is a pure insertion
       * in front of the brace. body[i] is src[evOpen + open + 2 + i], and the
       * literal starts one character past its own quote. A |…| template is
       * left alone - there the braces are escaped ABAP, not a UI5 expression. */
      let fixes;
      if (!isTemplate) {
        const brace = evOpen + open + 2 + el.index + el[0].indexOf(el[1]) + 1 + raw.indexOf('{');
        fixes = [{ start: brace, end: brace, text: '$' }];
      }
      report({ type: 'event-arg-unresolved', value: shown.slice(0, 40), offset: m.index + el.index, ...(fixes ? { fixes } : {}) });
    }
  }

  /* Reading past the t_arg the event declares. The args are static - they are
   * written at the raise site - so `get_event_arg( 3 )` in the handler of an
   * event that sends two is never anything but a mistake: it returns initial
   * in ABAP and 500s in the transpiled runtime, and either way the value the
   * handler works with is not the one the author meant. Only a literal index
   * is judged (a variable one is not statically knowable), and only inside
   * the handler of an event this class raises itself. */
  if (arity.size) {
    const scopes = eventScopes(src);
    for (const m of src.matchAll(/get_event_arg\s*\(\s*(?:v\s*=\s*)?(\d*)\s*\)/gi)) {
      const read = m[1] ? Number(m[1]) : 1; // the interface default is 1
      let scope = null;
      for (const s of scopes) {
        if (s.at < m.index) scope = s; else break;
      }
      /* The NEAREST preceding marker decides, whatever event it names - and
       * if that is a method boundary, or an event this class does not raise
       * with client->_event( ), the call is not judged at all. An event can
       * also arrive from a message_box_display( onclose = ) callback or a
       * frontend action, and those carry args from a source this pass cannot
       * see; skipping there is the difference between a rule and a guess. */
      if (!scope?.event || !arity.has(scope.event)) continue;
      const sent = arity.get(scope.event);
      if (read > sent) {
        report({ type: 'event-arg-out-of-range', value: scope.event, member: String(read), count: sent, offset: m.index });
      }
    }
  }

  /* Frontend actions: a wire the browser rejects at dispatch.
   *
   * `client->_event_client( )` and `client->follow_up_action( )` name an
   * action and hand it positional t_arg values. FrontendAction resolves the
   * global object, the method and the binding method against closed
   * whitelists, and a miss is a console log - no exception, no failed render,
   * nothing the property or render gate can see. The button simply does
   * nothing when pressed.
   *
   * Only closed sets are judged (see frontend-actions.mjs) and only literal
   * arguments; CONTROL_BY_ID's method list is open by design and is left
   * alone, except for the one shape that is unambiguously wrong: an empty
   * second element. That slot used to carry the view and is now inserted by
   * the runtime, so an empty one shifts the method out of its position and
   * the frontend logs "method '' not allowed". */
  for (const call of src.matchAll(/client->(?:_event_client|follow_up_action)\s*\(/g)) {
    const open = src.indexOf('(', call.index + call[0].length - 1);
    const { body: callBody } = parenRegion(src, open);
    const base = open + 1;
    const token = callBody.match(/cs_event-(\w+)/);
    const tm = callBody.match(/\bt_arg\s*=\s*VALUE\s+#?\s*\(/);
    if (!token || !tm) continue;
    const argOpen = callBody.indexOf('(', tm.index + tm[0].length - 1);
    const args = literalElements(parenRegion(callBody, argOpen).body, base + argOpen + 1);
    const action = token[1].toLowerCase();

    /* CONTROL_BY_ID addresses a control by the id the view gave it. A literal
     * id that no view of this class declares resolves to nothing: the
     * frontend logs "control not found" and the wire silently does nothing —
     * no exception, no failed render, and the property gate never sees the
     * ABAP side of it. Only judged when every id attribute in the class is a
     * literal (see viewIds), so a class that builds ids dynamically is left
     * alone rather than guessed at. */
    if (action === 'control_by_id' && viewIds && args[0]?.value && !viewIds.has(args[0].value)) {
      report({
        type: 'frontend-action-unknown-id', control: 'CONTROL_BY_ID', member: 'id',
        value: args[0].value, allowed: [...viewIds].sort(), offset: args[0].offset,
      });
      continue;
    }

    /* An imperative setter where the control has a bindable PROPERTY of that
     * name. Binding it two-way keeps the state in the model, where it survives
     * a view rebuild and a draft restore — an action does not — and it is the
     * project rule ("prefer a bindable property over a frontend action").
     * Only PROPERTIES qualify: an association (ObjectPageLayout.selectedSection)
     * and an aggregation cannot be data-bound, so driving those imperatively is
     * the only way and is never reported. */
    if (action === 'control_by_id' && data && controlIds) {
      const setter = String(args[1]?.value ?? '').match(/^set([A-Z]\w*)$/);
      const control = args[0]?.value ? controlIds[args[0].value] : null;
      if (setter && control) {
        const prop = setter[1][0].toLowerCase() + setter[1].slice(1);
        /* A property whose type is a live JS value (a callback, a DOM node)
         * cannot travel in a JSON model — sap.m.MessagePopover.asyncURLHandler
         * is exactly that, which is why the framework names a built-in policy
         * instead. Those stay imperative by nature, not by choice. */
        const decl = propertyDecl(data, control, prop);
        const bindable = decl && !['function', 'object', 'any'].includes(decl.type);
        if (bindable && memberSection(data, control, prop) === 'properties') {
          report({
            type: 'settable-property-via-action', control, member: prop,
            value: args[1].value, offset: args[1].offset,
          });
        }
      }
    }

    if (action === 'control_by_id' && args[1]?.value === '') {
      report({
        type: 'invalid-frontend-action', control: 'CONTROL_BY_ID', member: 'view slot',
        value: '', offset: args[1].offset,
      });
      continue;
    }
    for (const slot of ACTION_ARGS[action] ?? []) {
      const arg = args[slot.at];
      if (!arg || arg.value === null) continue; // absent or not a literal
      const allowed = slot.allowed(args.map((a) => a?.value));
      if (!allowed) continue; // the earlier slot is already wrong - one finding is enough
      if (!allowed.includes(arg.value)) {
        report({
          type: 'invalid-frontend-action', control: action.toUpperCase(), member: slot.name,
          value: arg.value, allowed, offset: arg.offset,
        });
        break;
      }
    }
  }

  /* Literal CSS braces in a view. UI5's XMLView parser reads an unescaped
   * `{` in an attribute value as the start of a binding, so a stylesheet
   * injected through a core:HTML content attribute takes the whole view down
   * with a binding parse error. Every brace has to be written `\{` / `\}`.
   * Caught the hard way in ai-demokit (apps 026, 028 and 031, all by the
   * render gate).
   *
   * The unit is the span between <style> and </style>, not the literal and
   * not the statement. A stylesheet is written as a `&&` chain whose first
   * literal alone carries the opening tag, so checking literal by literal
   * sees that line and misses every rule below it - and a whole builder chain
   * is ONE ABAP statement, so widening to the statement swallows the entire
   * view (on the ai-demokit corpus that produced ten false positives at once:
   * `{0}` toast templates and `${$parameters>/…}` wires that merely shared a
   * statement with a stylesheet). Between the two tags there is only CSS. */
  for (const open of src.matchAll(/<style>/g)) {
    const from = open.index + open[0].length;
    const to = src.indexOf('</style>', from);
    if (to === -1) continue; // no closing tag in sight - not a stylesheet we can bound
    // one finding per stylesheet, at its first unescaped brace: a sheet with
    // twenty rules has forty braces and exactly one thing to do about them
    const css = src.slice(from, to);
    const first = css.search(/(?<!\\)[{}]/);
    if (first === -1) continue;
    const count = (css.match(/(?<!\\)[{}]/g) || []).length;
    report({
      type: 'unescaped-brace-in-style',
      count,
      value: css.slice(Math.max(0, first - 15), first + 25).replace(/\s+/g, ' ').trim(),
      offset: from + first,
    });
  }

  /* A PUBLIC attribute nothing in the class ever touches. Every one of them
   * is serialized into the model and shipped to the browser on every
   * roundtrip, so one that is never bound, never read and never written is
   * pure transport weight.
   *
   * Deliberately NARROWER than "not bound in any view": a PUBLIC attribute
   * used only in ABAP code is not dead, it is state - PUBLIC is precisely how
   * a value survives the roundtrip, so demanding a binding for it would
   * report the correct way to keep state. Only a name that appears exactly
   * once in the whole class, its own declaration, is judged. A hint, because
   * an attribute can still be read from outside the class (a called app
   * reaching into the caller's instance), which no single source can see. */
  for (const attribute of publicAttributes(src)) {
    const uses = src.match(new RegExp(`\\b${attribute.name}\\b`, 'gi'));
    if (uses && uses.length === 1) {
      report({ type: 'unused-public-attribute', member: attribute.name, offset: attribute.offset });
    }
  }

  /* popover_display imports XML, not VAL — the one asymmetry in the display
   * family (popup_display takes val). A `val =` guessed by analogy does not
   * compile, but nothing in a systemless pipeline says so before activation:
   * abaplint has no signature knowledge of z2ui5_if_client, and the render
   * gate never sees the class fail. One of the most common first-try
   * mistakes in generated code (ai-demokit hold-out probes 607/613/617). */
  for (const m of src.matchAll(/popover_display\s*\(\s*(val)\s*=/gd)) {
    const [start, end] = m.indices[1];
    report({
      type: 'popover-display-val', member: 'val', offset: m.index,
      fixes: [{ start, end, text: 'xml' }],
    });
  }

  /* The same FOR iterator name twice in one method. Fine on 7.50+, where the
   * iterator is local to its VALUE #( ) expression — but a 7.02 downport
   * (abaplint --fix, and the transpiler behind the e2e runtime) materializes
   * each one as `DATA <name> TYPE i` in the method body, and the second
   * declaration fails activation with "variable already defined". */
  for (const mm of src.matchAll(/\bMETHOD\b[\s\S]*?\bENDMETHOD\b/gi)) {
    const iterators = new Set();
    for (const m of mm[0].matchAll(/\bFOR\s+(\w+)\s*=/g)) {
      if (iterators.has(m[1])) {
        report({ type: 'duplicate-for-iterator', member: m[1], offset: mm.index + m.index });
      } else {
        iterators.add(m[1]);
      }
    }
  }

  /* Lifecycle checks split into separate IF blocks instead of one IF/ELSEIF
   * chain. The lifecycle flags are not all mutually exclusive, so separate
   * blocks can execute more than one branch on a single roundtrip — the
   * classic symptom is work done twice after a navigation. An ELSEIF chain
   * makes the branches exclusive by construction (the spelling has no word
   * boundary before its IF, so it never counts here). The one other
   * exclusive form is the GUARD idiom — an IF block that leaves the method
   * (`IF client->check_on_event( \`GO\` ). … RETURN. ENDIF.`): control never
   * flows from it into the next block, so it does not count either. */
  for (const mm of src.matchAll(/\bMETHOD\b[\s\S]*?\bENDMETHOD\b/gi)) {
    const open = [];
    for (const c of mm[0].matchAll(/\bIF\s+client->(check_on_\w+)\s*\(/gi)) {
      const end = ifBranchEnd(mm[0], c.index + c[0].length);
      if (!/\bRETURN\b|\bLEAVE\b/i.test(mm[0].slice(c.index, end))) open.push(c);
    }
    if (open.length >= 2) {
      report({
        type: 'separate-lifecycle-ifs', member: open[1][1],
        count: open.length, offset: mm.index + open[1].index,
      });
    }
  }

  /* A check_on_navigated( ) branch that never hands a view back. When the
   * called app leaves, the browser still shows ITS view — the caller has to
   * re-display its own (view_display, or view_model_update when the view
   * instance survives). A branch that only reads the result and returns
   * leaves the screen showing the wrong app, with no error anywhere. */
  {
    const REDISPLAY = /\b(?:view_display|view_model_update|nest2?_view_display|popup_display|popover_display|nav_app_call|nav_app_leave)\s*\(/i;
    for (const m of src.matchAll(/\b(?:ELSE)?IF\s+client->check_on_navigated\s*\(/gi)) {
      const end = ifBranchEnd(src, m.index + m[0].length);
      if (!REDISPLAY.test(src.slice(m.index, end))) {
        report({ type: 'missing-view-display-on-navigated', offset: m.index });
      }
    }
  }

  /* An absolute binding path written as TEXT — `{/PATH}` in a literal, or
   * `path: '/PATH'` in a binding-info string. The runtime only registers what
   * client->_bind( ) was given, so a textual path either addresses nothing
   * (caught as unknown-binding-path) or duplicates a bind that exists — and
   * then silently breaks the moment the attribute is renamed, because no
   * compiler follows a string. Derive it instead: client->_bind( var ), or
   * the bare-path form `_bind( val = var path = abap_true )` interpolated
   * into the binding-info template.
   *
   * Two shapes stay out: an OData ENTITY path with a key predicate
   * (`{/Products('4711')}`) in a class that switches its default model to an
   * OData service — that path addresses the service, not an ABAP variable,
   * so there is nothing to derive it from. And anything between <style> and
   * </style>, where `{/` is a CSS brace meeting a CSS comment, not a path. */
  {
    const odata = /switch_default_model_path/.test(src);
    const styleSpans = [...src.matchAll(/<style>/g)].map((o) => {
      const to = src.indexOf('</style>', o.index);
      return { from: o.index, to: to === -1 ? src.length : to };
    });
    const inStyle = (i) => styleSpans.some((s) => i >= s.from && i <= s.to);
    for (const m of src.matchAll(/\{\/[^}\n]{0,60}\}?|\bpath\s*:\s*'(\/[^'\n]{0,60})'?/g)) {
      if (inStyle(m.index)) continue;
      const text = m[0];
      if (odata && /^(?:\{|path\s*:\s*')\/\w+\([^)]*\)/.test(text)) continue;
      report({ type: 'hardcoded-binding-path', value: text.slice(0, 40), offset: m.index });
    }
  }

  /* The other half of the same defect. An escape only survives to the
   * serialized attribute when the backslash is taken verbatim - which is what
   * a `backtick` literal does. Inside a |…| template the backslash is ABAP's
   * own escape: `\{` collapses to a bare `{` before the builder ever sees it,
   * and the view crashes exactly as if nothing had been escaped. Written in a
   * template the form has to be `\\\{`.
   *
   * Invisible to the rule above, which reads the SOURCE and sees a backslash
   * in front of every brace. Only the literal's kind tells the two apart. */
  const templates = literalSegments(src).filter((s) => s.kind === '|');
  for (const open of src.matchAll(/<style>/g)) {
    const from = open.index + open[0].length;
    const to = src.indexOf('</style>', from);
    if (to === -1) continue;
    for (const segment of templates) {
      if (segment.end <= from || segment.start >= to) continue;
      const text = src.slice(Math.max(segment.start, from), Math.min(segment.end, to));
      const at = text.search(/(?<!\\)\\[{}]/);
      if (at === -1) continue;
      report({
        type: 'collapsed-brace-in-style',
        count: (text.match(/(?<!\\)\\[{}]/g) || []).length,
        value: text.slice(Math.max(0, at - 15), at + 25).replace(/\s+/g, ' ').trim(),
        offset: Math.max(segment.start, from) + at,
      });
      break; // one finding per stylesheet, as above
    }
  }

  return findings;
}
