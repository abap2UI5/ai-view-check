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
        )->a( n = `xmlns:w`   v = `sap.ui.integration.widgets`
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
          )->leaf( `Link`
            )->a( n = `text`  v = `sap.com`
            )->a( n = `press` v = client->_event_client( val   = client->cs_event-urlhelper
                                                          t_arg = VALUE #( ( `REDIRECT` ) ( |\{ URL: 'http://www.sap.com', NEW_WINDOW: true \}| ) ) )
          )->leaf( `Button`
            )->a( n = `text`  v = `Pick`
            )->a( n = `press` v = client->_event( val = `PICK` t_arg = VALUE #( ( `{BARE_BRACE}` ) ( `${RESOLVED}` ) ( `plain` ) ( `{0} selected` ) ( |{ lv_local }| ) ) )
          )->leaf( `Button`
            )->a( n = `text`  v = `Trailing`
            )->a( n = `press` v = client->_event( val = `TRAILING` t_arg = VALUE #( ( `first` ) ( `` ) ) )
          )->leaf( `Button`
            )->a( n = `text`  v = `Middle`
            )->a( n = `press` v = client->_event( val = `MIDDLE` t_arg = VALUE #( ( `first` ) ( `` ) ( `third` ) ) )
          )->leaf( n = `Card` ns = `w`
            )->a( n = `manifest` v = `{"sap.card":{"type":"List"}}` ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.
ENDCLASS.
