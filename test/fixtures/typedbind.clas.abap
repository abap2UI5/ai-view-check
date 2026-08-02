CLASS zcl_fixture_typedbind DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA percent  TYPE string.
    DATA lines    TYPE string.
    DATA ok       TYPE string.
    DATA real_num TYPE p LENGTH 8 DECIMALS 2.
ENDCLASS.

CLASS zcl_fixture_typedbind IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    CASE client->get_event( ).
      WHEN `PICK`.
        DATA(good) = client->get_event_arg( 1 ).
        DATA(bad)  = client->get_event_arg( 2 ).
      WHEN `PLAIN`.
        DATA(none) = client->get_event_arg( ).
    ENDCASE.

    DATA(view) = z2ui5_cl_ai_xml=>factory( ).
    view->open( n = `View` ns = `mvc`
        )->a( n = `xmlns`     v = `sap.m`
        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`
        )->open( `Page`
          )->leaf( `ProgressIndicator`
            )->a( n = `percentValue` v = client->_bind( percent )
          )->leaf( `ProgressIndicator`
            )->a( n = `percentValue` v = client->_bind( real_num )
          )->leaf( `Text`
            )->a( n = `maxLines` v = client->_bind( lines )
          )->leaf( `Button`
            )->a( n = `enabled` v = client->_bind( ok )
            )->a( n = `text`    v = `Pick`
            )->a( n = `press`   v = client->_event( val = `PICK` t_arg = VALUE #( ( `${$source>/id}` ) ) )
          )->leaf( `Button`
            )->a( n = `text`  v = `Plain`
            )->a( n = `press` v = client->_event( `PLAIN` )
        )->shut( ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.
ENDCLASS.
