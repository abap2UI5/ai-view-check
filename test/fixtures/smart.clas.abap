CLASS zcl_fixture_smart DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
ENDCLASS.

CLASS zcl_fixture_smart IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    " SmartTable lives in sap.ui.comp - SAPUI5 only, absent from OpenUI5
    DATA(view) = z2ui5_cl_ai_xml=>factory( ).
    view->open( n = `View` ns = `mvc`
        )->a( n = `xmlns`      v = `sap.m`
        )->a( n = `xmlns:mvc`  v = `sap.ui.core.mvc`
        )->a( n = `xmlns:smart` v = `sap.ui.comp.smarttable`
        )->leaf( n = `SmartTable` ns = `smart` ).
    client->view_display( view->stringify( ) ).

  ENDMETHOD.
ENDCLASS.
