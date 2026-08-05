/*
 * frontend-actions — the closed sets the abap2UI5 runtime accepts on the wire.
 *
 * A frontend action (`client->_event_client( )`, `client->follow_up_action( )`)
 * is dispatched in the browser by name, and a name outside the whitelist is
 * not an exception anywhere: FrontendAction logs to the console and the wire
 * does nothing. Nothing in ABAP, nothing in the view and nothing in the render
 * gate can see that, which is exactly the kind of defect this linter exists
 * for.
 *
 * HAND-MAINTAINED, unlike data/properties.json. The source of truth is
 * abap2UI5's `z2ui5_cl_app_frontendaction_js` — a JavaScript module embedded
 * in an ABAP string concatenation, which is not something to parse. Refresh
 * by reading these constants there:
 *
 *   GLOBAL_TARGETS   the global objects and their allowed methods
 *   BINDING_METHODS  the binding methods BINDING_CALL may build
 *
 * Only closed sets belong here. CONTROL_BY_ID's method list is deliberately
 * absent: the runtime allows any public control method that does not match a
 * deny prefix, so it is open by design and a static whitelist would report
 * correct code.
 */

/** Global object -> the methods FrontendAction lets CONTROL_GLOBAL call.
 *  ABAP side: t_arg = VALUE #( ( `GLOBAL` ) ( `method` ) ( params… ) ). */
export const GLOBAL_TARGETS = {
  MESSAGE_TOAST: ['show'],
  MESSAGE_BOX: ['show', 'information', 'warning', 'error', 'success'],
  BUSY_INDICATOR: ['show', 'hide'],
  THEMING: ['setTheme'],
  // sap.ui.core.Popup.setWithinArea — confine every popup to the control whose
  // id is passed instead of to the window; an EMPTY argument releases it again
  POPUP: ['setWithinArea'],
  // sap.ui.core.InvisibleMessage (@since 1.78) — announce(text, mode) reads a
  // text out to a screen reader without rendering it. A singleton, so there is
  // no control id and CONTROL_BY_ID cannot reach it
  INVISIBLE_MESSAGE: ['announce'],
  // sap.ui.core.Formatting (@since 1.120) — global formatting configuration;
  // custom currency codes/digits for the standard sap.ui.model.type.Currency
  FORMATTING: ['setCustomCurrencies', 'addCustomCurrency'],
};

/** CONTROL_BY_ID's `css` pseudo-method writes ONE declaration onto the
 *  control's own DOM node, for a value no property carries (sap.m.Page has no
 *  width). The frontend accepts only these properties and logs an error for
 *  anything else - a wire with a different property looks fine in the source
 *  and silently does nothing.
 *  Mirrors CSS_PROPERTIES in app/webapp/core/FrontendAction.js. */
export const CSS_PROPERTIES = [
  'width', 'min-width', 'max-width',
  'height', 'min-height', 'max-height',
  'color', 'background-color', 'font-size', 'opacity',
];

/** The binding methods BINDING_CALL can build.
 *  ABAP side: t_arg = VALUE #( ( `id` ) ( `aggregation` ) ( `method` ) … ). */
export const BINDING_METHODS = ['filter', 'sort'];

/*
 * Which t_arg position carries what, per action token — ABAP-side positions,
 * 0-based. The runtime prepends the action itself and, for CONTROL_BY_ID,
 * inserts the view slot at index 2 on the server (get_event_client), so the
 * JS `args` indices in FrontendAction.js are NOT these.
 */
export const ACTION_ARGS = {
  control_global: [
    { at: 0, name: 'global object', allowed: () => Object.keys(GLOBAL_TARGETS) },
    { at: 1, name: 'method', allowed: (args) => GLOBAL_TARGETS[String(args[0]).toUpperCase()] },
  ],
  binding_call: [
    { at: 2, name: 'binding method', allowed: () => BINDING_METHODS },
  ],
  control_by_id: [
    // only the `css` pseudo-method has a closed argument set; every other
    // control method is open by design (any public, non-denylisted method)
    {
      at: 2,
      name: 'css property',
      allowed: (args) => (String(args[1] ?? '').toLowerCase() === 'css' ? CSS_PROPERTIES : null),
    },
  ],
};
