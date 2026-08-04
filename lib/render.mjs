/*
 * render — headless render gate: load a view with a real XMLView.create in
 * Chromium against the OpenUI5 runtime served locally from the @openui5/*
 * npm source packages. No network needed at run time.
 *
 * Extracted from abap2UI5/ai-demokit scripts/render-smoke.mjs. What it
 * catches: invalid XML, unknown controls/aggregations/properties, strict
 * property-type violations, broken expression-binding syntax, renderer
 * crashes — with UI5 'future' mode active around view creation so silent
 * "unknown setting" warnings become reported errors. What it cannot catch:
 * event round-trips, visual/UX fidelity.
 *
 * The harness provides what the abap2UI5 runtime provides on every view slot:
 * a stub controller with the eB/eF event entry points, the device> model, an
 * empty message> model, the z2ui5/model/formatter module (mirror of the
 * framework's curated formatter contract) and metadata-only mirrors of the
 * bundled custom controls used declaratively in views.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// UI5 log messages that are environment noise, not view defects
const BENIGN = [
  /library-preload/i,
  /messagebundle/i,
  /themes?\/|library(\.css|-parameters)/i,
  /theming\.Parameters/i,
  /failed to load JavaScript resource/i,
  /Core\.applyTheme|sap\.ui\.getCore/i,
  /clone operation.*template|templateShareable/i,
];

// all installed @openui5 source packages (resolved from this package's own
// node_modules or any parent — discovery instead of a hand-kept list)
function libRoots() {
  const bases = new Set();
  try {
    const core = path.dirname(require.resolve('@openui5/sap.ui.core/package.json'));
    bases.add(path.dirname(core));
  } catch {
    /* not installed — render gate unavailable */
  }
  const roots = [];
  for (const base of bases) {
    for (const p of fs.readdirSync(base)) {
      const src = path.join(base, p, 'src');
      if (fs.existsSync(src)) roots.push(src);
    }
  }
  return roots;
}

const MIME = {
  '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.xml': 'application/xml', '.properties': 'text/plain', '.html': 'text/html',
  '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ttf': 'font/ttf',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

const HARNESS = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>view-check</title>
<script>
  window.uiErrors = [];
  window.addEventListener('error', function (e) { window.uiErrors.push('PAGEERROR: ' + e.message); });
  // Mirror of the abap2UI5 curated formatter module (model/formatter.js) - a
  // fixed public contract, provided like the device model. Registered as the
  // named module z2ui5/model/formatter in boot() (for core:require) and
  // published as the z2ui5.Formatter global. The export surface mirrors
  // lib/formatters.mjs (a test keeps the two in step); the demo-kit pack
  // (round2DP, stockStatus*, dimensions, deliveryStatusState) was REMOVED
  // upstream, so mirroring it here would render views green that break live.
  window.z2ui5 = window.z2ui5 || {};
  (function () {
    function parseYmd(d) {
      return [Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8))];
    }
    // the initial DATS value "00000000" (or any non-8-digit input) carries no
    // date - upstream yields null there, and an Invalid Date must never leak
    // (it is truthy and blows up much later inside a calendar control)
    function isNoAbapDate(d) {
      var s = String(d);
      if (!/^[0-9]{8}$/.test(s)) return true;
      return Number(s.slice(0, 4)) === 0 || Number(s.slice(4, 6)) === 0 || Number(s.slice(6, 8)) === 0;
    }
    window.z2ui5.Formatter = {
      DateCreateObject: function (s) {
        if (!s) return null;
        return new Date(s);
      },
      DateAbapDateToDateObject: function (d) {
        if (isNoAbapDate(d)) return null;
        var p = parseYmd(d); return new Date(p[0], p[1], p[2]);
      },
      DateAbapDateTimeToDateObject: function (d, t) {
        t = t || '000000';
        if (isNoAbapDate(d)) return null;
        var p = parseYmd(d);
        return new Date(p[0], p[1], p[2], Number(t.slice(0, 2)), Number(t.slice(2, 4)), Number(t.slice(4, 6)));
      },
      expandInlineIcons: function (text) {
        if (!text) return '';
        var IconPool = sap.ui.require('sap/ui/core/IconPool');
        var re = new RegExp('%%icon:(sap-icon://[^%]+)%%', 'g');
        return String(text).replace(re, function (m, uri) {
          var info = IconPool && IconPool.getIconInfo(uri);
          if (!info) return '';
          return '<span class="sapMMsgStripInlineIcon" style="font-family:' + info.fontFamily + '">' + info.content + '</span>';
        });
      },
    };
  })();
</script>
<script id="sap-ui-bootstrap" src="/resources/sap-ui-core.js"
  data-sap-ui-libs="sap.m,sap.ui.layout,sap.f,sap.ui.table,sap.uxap,sap.tnt"
  data-sap-ui-theme="sap_hcb"
  data-sap-ui-async="true"
  data-sap-ui-compatversion="edge"></script>
<script>
  window.uiReady = new Promise(function (resolve) {
    function boot() {
      sap.ui.define('z2ui5/model/formatter', [], function () { return window.z2ui5.Formatter; });
      // Metadata-only mirrors of the bundled abap2UI5 custom controls used
      // declaratively in views - the harness only validates view creation.
      sap.ui.define('z2ui5/cc/MultiInputExt', ['sap/ui/core/Control'], function (Control) {
        return Control.extend('z2ui5.cc.MultiInputExt', {
          metadata: {
            properties: {
              MultiInputId: { type: 'string' },
              MultiInputName: { type: 'string' },
              addedTokens: { type: 'object' },
              checkInit: { type: 'boolean', defaultValue: false },
              removedTokens: { type: 'object' },
            },
            events: { change: { allowPreventDefault: true, parameters: {} } },
          },
          renderer: { apiVersion: 2, render: function () {} },
        });
      });
      sap.ui.define('z2ui5/cc/MessageManager', ['sap/ui/core/Control'], function (Control) {
        return Control.extend('z2ui5.cc.MessageManager', {
          metadata: {
            properties: {
              items: { type: 'object' },
              checkInit: { type: 'boolean', defaultValue: false },
            },
            events: { change: { allowPreventDefault: true, parameters: {} } },
          },
          renderer: { apiVersion: 2, render: function () {} },
        });
      });
      sap.ui.require(['sap/ui/core/Core', 'sap/base/Log'], function (Core, Log) {
        Log.addLogListener({ onLogEntry: function (e) {
          if (e.level <= Log.Level.ERROR) window.uiErrors.push('LOG: ' + e.message);
        } });
        Core.ready(resolve);
      });
    }
    if (window.sap && sap.ui) boot(); else window.addEventListener('load', boot);
  });
  window.renderDoc = async function (input) {
    await window.uiReady;
    var from = window.uiErrors.length;
    var errs = [];
    try {
      var mods = await new Promise(function (res, rej) {
        sap.ui.require(['sap/ui/core/mvc/XMLView', 'sap/ui/core/Fragment',
          'sap/ui/model/json/JSONModel', 'sap/ui/Device',
          'sap/ui/core/mvc/Controller', 'sap/base/future'], function () { res(arguments); }, rej);
      });
      var XMLView = mods[0], Fragment = mods[1], JSONModel = mods[2], Device = mods[3];
      var Controller = mods[4], future = mods[5];
      // stub controller with the abap2UI5 event entry points, so declarative
      // handlers resolve and UI5 'future' mode can be active around creation
      window._smokeCtl = window._smokeCtl ||
        Controller.extend('z2ui5.smoke.StubController', { eB: function () {}, eF: function () {} });
      var model = new JSONModel(input.model);
      var device = new JSONModel(Device); device.setDefaultBindingMode('OneWay');
      var prevFuture = future.active;
      future.active = true;
      try {
        if (input.kind === 'fragment') {
          var res = await Fragment.load({ definition: input.xml, controller: new window._smokeCtl() });
          (Array.isArray(res) ? res : [res]).forEach(function (c) {
            if (c.setModel) { c.setModel(model); c.setModel(device, 'device'); }
            c.destroy();
          });
        } else {
          var view = await XMLView.create({ definition: input.xml, controller: new window._smokeCtl() });
          view.setModel(model); view.setModel(device, 'device');
          view.setModel(new JSONModel([]), 'message');
          view.placeAt('content');
          await new Promise(function (r) { setTimeout(r, 120); });
          view.destroy();
        }
      } finally {
        future.active = prevFuture;
      }
    } catch (e) {
      errs.push('CREATE: ' + (e && e.message ? e.message : String(e)));
    }
    return errs.concat(window.uiErrors.slice(from));
  };
</script>
</head><body><div id="content"></div></body></html>`;

function startServer(roots) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/harness.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HARNESS);
      return;
    }
    if (u.pathname.startsWith('/resources/')) {
      const rel = u.pathname.slice('/resources/'.length);
      for (const root of roots) {
        const full = path.join(root, rel);
        if (full.startsWith(root) && fs.existsSync(full) && fs.statSync(full).isFile()) {
          res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
          res.end(fs.readFileSync(full));
          return;
        }
      }
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launchBrowser() {
  const { chromium } = await import('playwright');
  try {
    return await chromium.launch();
  } catch (e) {
    for (const exe of [process.env.CHROMIUM_BIN, '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
      if (exe && fs.existsSync(exe)) return chromium.launch({ executablePath: exe });
    }
    throw e;
  }
}

/*
 * Session over multiple render calls: start once, render many docs, close.
 *   const r = await openRenderer();
 *   const errs = await r.render({ xml, model });   // filtered, [] = clean
 *   await r.close();
 * Throws when the @openui5 packages are not installed.
 */
export async function openRenderer() {
  const roots = libRoots();
  if (!roots.length) {
    throw new Error('no @openui5/* source packages found — install the package dependencies (npm ci) to enable the render gate');
  }
  const server = await startServer(roots);
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
  return {
    async render({ xml, model = {} }) {
      const kind = /^<core:FragmentDefinition/.test(xml) ? 'fragment' : 'view';
      let raw;
      try {
        raw = await page.evaluate((input) => window.renderDoc(input), { xml, model, kind });
      } catch (e) {
        raw = [`HARNESS: ${e.message}`];
      }
      return raw.filter((e) => !BENIGN.some((re) => re.test(e)));
    },
    async close() {
      await browser.close();
      server.close();
    },
  };
}
