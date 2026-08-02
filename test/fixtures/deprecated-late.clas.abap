CLASS zcl_fixture_dep_late DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
ENDCLASS.

CLASS zcl_fixture_dep_late IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    " ActionSheet is deprecated as of 1.149 - fine for a 1.71 target,
    " a finding once the target reaches 1.149
    DATA(view) = z2ui5_cl_ai_xml=>factory( ).
    view->open( n = `View` ns = `mvc`
        )->a( n = `xmlns`     v = `sap.m`
        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`
        )->leaf( `ActionSheet` ).
    client->view_display( view->stringify( ) ).

  ENDMETHOD.
ENDCLASS.
