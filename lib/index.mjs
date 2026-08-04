/*
 * index — the public library API of @abap2ui5/view-check.
 *
 *   checkAbapSource(source, opts)  ABAP class using z2ui5_cl_ai_xml -> result
 *   checkXmlSource(xml, opts)      raw .view.xml / .fragment.xml -> result
 *   checkFiles(paths, opts)        CLI backbone: mixed file list -> results
 *
 * A result: { file?, kind, findings: [...], renderErrors: [...], notes,
 * docs, skippedRender }. Findings come from the property gate (see
 * properties.mjs types); renderErrors from the headless XMLView.create gate.
 */
import fs from 'fs';
import path from 'path';
import { prepareAbap } from './reconstruct.mjs';
import { checkAbapRules } from './abap-rules.mjs';
import { loadSnapshot, checkNodes, parseXml, collectControlIds } from './properties.mjs';
import { annotate, applyRules, applyDirectives, renderRuleConfig } from './findings.mjs';
import { openRenderer } from './render.mjs';

/* The conventional prefix -> library pairs an undeclared-namespace fix may
 * assume. Closed by convention: anything else could mean any library, and a
 * fix that has to guess is worse than the finding. */
const KNOWN_NS = {
  core: 'sap.ui.core', mvc: 'sap.ui.core.mvc',
  l: 'sap.ui.layout', layout: 'sap.ui.layout', form: 'sap.ui.layout.form',
  f: 'sap.f', table: 'sap.ui.table', u: 'sap.ui.unified', unified: 'sap.ui.unified',
  uxap: 'sap.uxap', tnt: 'sap.tnt', html: 'http://www.w3.org/1999/xhtml', cc: 'z2ui5.cc',
};

const DEFAULTS = {
  minUi5: '1.71',
  distribution: 'sapui5',
  allow: [],
  render: true,
  properties: true,
  rules: {},           // per-rule off/severity/exclude, see findings.mjs
  file: '',            // the path the source came from - `rules.*.exclude` matches it
  snapshot: undefined, // path override for data/properties.json
};

/** Everything a repo can say about a finding after the gate produced it:
 *  the `rules` block first (off / another severity / excluded file), then
 *  the source directives. Both need the annotation to have run. */
const settle = (findings, source, o) =>
  applyDirectives(applyRules(findings, o.rules, o.file), source);

export function checkAbapSource(source, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const prep = prepareAbap(source);
  const result = {
    kind: 'abap',
    usesBuilder: prep.usesBuilder,
    docs: prep.docs,
    model: prep.model,
    notes: prep.notes,
    helperTokens: prep.helperTokens,
    findings: [],
    renderErrors: [],
    skippedRender: false,
  };
  if (!prep.usesBuilder) return result;
  if (o.properties) {
    const data = loadSnapshot(o.snapshot);
    for (const nodeRoot of prep.nodes) {
      result.findings.push(...checkNodes(nodeRoot, {
        data,
        minUi5: o.minUi5,
        allow: o.allow,
        distribution: o.distribution,
        model: prep.model,
        shape: prep.modelShape,
        rootFields: prep.rootFields,
      }));
    }
    // structural defects of the builder chain itself (an excess shut( )
    // asserts at runtime) - independent of the UI5 metadata
    result.findings.push(...(prep.structure ?? []));
    // rules that need the class itself, not just the view tree. The id->control
    // map comes from its own views, so an ABAP-side rule can judge what may be
    // done to the control a wire names.
    const controlIds = {};
    for (const nodeRoot of prep.nodes) Object.assign(controlIds, collectControlIds(nodeRoot));
    result.findings.push(...checkAbapRules(source, { data, controlIds }));
    /* undeclared-namespace is autofixable when the prefix is conventional:
     * the declaration is inserted as a sibling attribute call right before
     * the root's first xmlns write — a single-line insertion, nothing to
     * guess. ABAP sources only; raw XML rarely misses one and has its own
     * insertion grammar. */
    for (const f of result.findings) {
      if (f.type !== 'undeclared-namespace') continue;
      const lib = KNOWN_NS[f.member];
      if (!lib) continue;
      const anchor = source.match(/->a\(\s*(?=n\s*=\s*`xmlns`)/);
      if (!anchor) continue;
      const at = anchor.index + anchor[0].length;
      f.fixes = [{ start: at, end: at, text: `n = \`xmlns:${f.member}\` v = \`${lib}\` )->a( ` }];
    }
    // severity, wording and the line/column each offset points at
    annotate(result.findings, source);
    result.findings = settle(result.findings, source, o);
  }
  return result;
}

export function checkXmlSource(xml, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const result = { kind: 'xml', docs: [xml], model: {}, notes: [], helperTokens: 0, findings: [], renderErrors: [], skippedRender: false };
  if (o.properties) {
    const data = loadSnapshot(o.snapshot);
    result.findings.push(...checkNodes(parseXml(xml), { data, minUi5: o.minUi5, allow: o.allow, distribution: o.distribution }));
    annotate(result.findings, xml);
    result.findings = settle(result.findings, xml, o);
  }
  return result;
}

/*
 * Check a mixed list of files (.clas.abap with builder views, .view.xml,
 * .fragment.xml). Runs the property gate per file, then — unless render is
 * disabled — renders every reconstructable doc in ONE browser session.
 */
export async function checkFiles(files, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const results = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const isXml = /\.(view|fragment)\.xml$/.test(file) || /^\s*</.test(src);
    // the file travels with the options so `rules.*.exclude` can match on it
    const r = isXml ? checkXmlSource(src, { ...o, file }) : checkAbapSource(src, { ...o, file });
    r.file = file;
    results.push(r);
  }
  if (o.render) {
    const renderable = results.filter((r) => r.docs.length && (r.kind === 'xml' || r.usesBuilder));
    if (renderable.length) {
      /* A page POOL, workers pulling results off a shared cursor: on a corpus
       * the render gate is the wall clock, and one page rendering hundreds of
       * views serially was almost all of it. Documents of ONE result still
       * render in order on whatever page the worker holds, so a result's
       * renderErrors keep their document order. */
      const workers = Math.min(4, renderable.length);
      const renderer = await openRenderer({ pages: workers });
      try {
        let cursor = 0;
        await Promise.all(Array.from({ length: workers }, async () => {
          for (;;) {
            const r = renderable[cursor++];
            if (!r) return;
            if (r.kind === 'abap' && r.helperTokens > 0) {
              // view parts built in non-handle helper methods are not statically
              // attributable — an incomplete reconstruction would render a WRONG
              // view, so skip and say so instead of failing on an artifact
              r.skippedRender = true;
              continue;
            }
            for (const xml of r.docs) {
              r.renderErrors.push(...(await renderer.render({ xml, model: r.model })));
            }
          }
        }));
      } finally {
        await renderer.close();
      }
    }
    for (const r of results) {
      if (r.kind === 'abap' && r.usesBuilder && !r.docs.length && !r.helperTokens) {
        r.renderErrors.push('no view reconstructed from builder calls');
      }
      if (r.kind === 'abap' && r.helperTokens > 0 && !r.skippedRender) r.skippedRender = true;
    }
    /* The `rules` block can address the render gate too — as `render-error`,
     * the pseudo-rule its failures are reported under. `false`/`exclude`
     * waive the errors (the render still RAN, so an excluded file that comes
     * back clean is called out as a stale waiver instead of silently
     * passing), a severity decides what a render error counts as. */
    const rc = renderRuleConfig(o.rules);
    if (rc) {
      for (const r of results) {
        const excluded = rc.off || rc.exclude?.some((re) => re.test(r.file || ''));
        if (excluded) {
          if (r.renderErrors.length) {
            r.notes.push(`${r.renderErrors.length} render error(s) waived by rules['render-error']`);
            r.renderErrors = [];
          } else if (!rc.off && !r.skippedRender && r.docs.length) {
            r.notes.push(`stale render-error waiver: the view renders clean — remove this file from rules['render-error'].exclude`);
          }
        } else if (rc.severity) {
          r.renderSeverity = rc.severity;
        }
      }
    }
  }
  return results;
}

/*
 * Recursively collect checkable files under the given paths: ABAP classes
 * that call the z2ui5_cl_ai_xml builder, plus raw view/fragment XML files.
 */
export function collectFiles(paths) {
  const out = [];
  const visit = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) {
        if (e === 'node_modules' || e.startsWith('.')) continue;
        visit(path.join(p, e));
      }
      return;
    }
    if (/\.(view|fragment)\.xml$/.test(p)) { out.push(p); return; }
    if (p.endsWith('.clas.abap') && !p.endsWith('.testclasses.abap')) {
      const src = fs.readFileSync(p, 'utf8');
      if (src.includes('z2ui5_cl_ai_xml=>factory')) out.push(p);
    }
  };
  for (const p of paths) visit(p);
  return out;
}
