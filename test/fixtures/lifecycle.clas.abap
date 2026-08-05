CLASS zcl_fixture_lifecycle DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA picked TYPE string.
ENDCLASS.

CLASS zcl_fixture_lifecycle IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    IF client->check_on_init( ).
      DATA(view) = z2ui5_cl_ai_xml=>factory( ).
      view->open( n = `View` ns = `mvc`
          )->a( n = `xmlns`     v = `sap.m`
          )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`
          )->open( `Page`
            )->leaf( `Button`
              )->a( n = `text`  v = `Call sub app`
              )->a( n = `press` v = client->_event( `CALL` )
          )->shut( ).
      client->view_display( view->stringify( ) ).
    ENDIF.

    IF client->check_on_navigated( ).
      picked = `returned`.
    ENDIF.

    CASE client->get_event( ).
      WHEN `CALL`.
        client->nav_app_call( zcl_fixture_sub=>factory( ) ).
    ENDCASE.

  ENDMETHOD.
ENDCLASS.
