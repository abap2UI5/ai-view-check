CLASS zcl_fixture_viewrules DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA name TYPE string.
ENDCLASS.

CLASS zcl_fixture_viewrules IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    DATA(view) = z2ui5_cl_ai_xml=>factory( ).
    view->open( n = `View` ns = `mvc`
        )->a( n = `xmlns`     v = `sap.m`
        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`
        )->open( `Page`
          )->leaf( `Button`
            )->a( n = `id`    v = `twice`
            )->a( n = `text`  v = `A`
            )->a( n = `press` v = client->_bind( name )
          )->leaf( `Button`
            )->a( n = `id`   v = `twice`
            )->a( n = `icon` v = `sap-icon://add`
          )->leaf( `Text`
            )->a( n = `text` v = `{= ${/NAME} === 'x' ? 'yes' : 'no' }`
          )->leaf( n = `Title` ns = `undeclared`
        )->shut(
        )->open( `content`
          )->leaf( `Text`
            )->a( n = `text` v = `first`
        )->shut(
        )->open( `content`
          )->leaf( `Text`
            )->a( n = `text` v = `second`
          )->leaf( `Bar`
            )->a( n = `translucent` v = `true` ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.
ENDCLASS.
