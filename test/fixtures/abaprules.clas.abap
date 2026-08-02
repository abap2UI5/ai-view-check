CLASS zcl_fixture_rules DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA name TYPE string.
ENDCLASS.

CLASS zcl_fixture_rules IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    DATA(lv_local) = `scratch`.

    DATA(view) = z2ui5_cl_ai_xml=>factory( ).
    view->open( n = `View` ns = `mvc`
        )->a( n = `xmlns`     v = `sap.m`
        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`
        )->open( `Page`
          )->leaf( `Input`
            )->a( n = `value` v = client->_bind_edit( name )
          )->leaf( `Input`
            )->a( n = `value` v = client->_bind( lv_local )
          )->leaf( `Text`
            )->a( n = `text` v = `{/TYPOED_PATH}`
          )->leaf( `Panel`
            )->a( n = `expanded` v = abap_true
          )->leaf( `Button`
            )->a( n = `text`  v = `Go`
            )->a( n = `press` v = client->_event( `NO_HANDLER` ) )
          )->leaf( `Button`
            )->a( n = `text`  v = `Pick`
            )->a( n = `press` v = client->_event( val = `PICK` t_arg = VALUE #( ( `{BARE_BRACE}` ) ( `${RESOLVED}` ) ( `plain` ) ( `{0} selected` ) ) ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.
ENDCLASS.
