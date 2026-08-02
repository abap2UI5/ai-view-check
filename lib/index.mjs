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
import { loadSnapshot, checkNodes, parseXml } from './properties.mjs';
import { openRenderer } from './render.mjs';

const DEFAULTS = {
  minUi5: '1.71',
  distribution: 'sapui5',
  allow: [],
  render: true,
  properties: true,
  snapshot: undefined, // path override for data/properties.json
};

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
        data, minUi5: o.minUi5, allow: o.allow, distribution: o.distribution, model: prep.model,
      }));
    }
    // structural defects of the builder chain itself (an excess shut( )
    // asserts at runtime) - independent of the UI5 metadata
    result.findings.push(...(prep.structure ?? []));
    // rules that need the class itself, not just the view tree
    result.findings.push(...checkAbapRules(source));
  }
  return result;
}

export function checkXmlSource(xml, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const result = { kind: 'xml', docs: [xml], model: {}, notes: [], helperTokens: 0, findings: [], renderErrors: [], skippedRender: false };
  if (o.properties) {
    const data = loadSnapshot(o.snapshot);
    result.findings.push(...checkNodes(parseXml(xml), { data, minUi5: o.minUi5, allow: o.allow, distribution: o.distribution }));
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
    const r = isXml ? checkXmlSource(src, o) : checkAbapSource(src, o);
    r.file = file;
    results.push(r);
  }
  if (o.render) {
    const renderable = results.filter((r) => r.docs.length && (r.kind === 'xml' || r.usesBuilder));
    if (renderable.length) {
      const renderer = await openRenderer();
      try {
        for (const r of renderable) {
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
