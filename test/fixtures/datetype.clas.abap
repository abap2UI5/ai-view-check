CLASS zcl_fixture_datetype DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA day     TYPE string.
    DATA stamp   TYPE string.
    DATA clock   TYPE string.
    DATA amount  TYPE p LENGTH 8 DECIMALS 2.
ENDCLASS.

CLASS zcl_fixture_datetype IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    DATA(view) = z2ui5_cl_ai_xml=>factory( ).
    view->open( n = `View` ns = `mvc`
        )->a( n = `xmlns`        v = `sap.m`
        )->a( n = `xmlns:mvc`    v = `sap.ui.core.mvc`
        )->a( n = `xmlns:core`   v = `sap.ui.core`
        )->a( n = `core:require` v = `{DateType: 'sap/ui/model/type/Date', TimeType: 'sap/ui/model/type/Time'}`

        )->open( `Page`

          " ok - the source format tells the type how to read the string
          )->leaf( `Text`
            )->a( n = `text` v = |\{ path: '{ client->_bind( val = day path = abap_true ) }', type: 'DateType', formatOptions: \{ style: 'short', source: \{ pattern: 'yyyy-MM-dd' \} \} \}|

          " reported - alias resolved through core:require, no source
          )->leaf( `Text`
            )->a( n = `text` v = |\{ path: '{ client->_bind( val = day path = abap_true ) }', type: 'DateType', formatOptions: \{ style: 'full' \} \}|

          " reported - the full module name, no formatOptions at all
          )->leaf( `Text`
            )->a( n = `text` v = |\{ path: '{ client->_bind( val = stamp path = abap_true ) }', type: 'sap.ui.model.type.DateTime' \}|

          " ok - a non-date type never needs a source format
          )->leaf( `Text`
            )->a( n = `text` v = |\{ path: '{ client->_bind( val = amount path = abap_true ) }', type: 'sap.ui.model.type.Float' \}|

          " reported - Time is a date type too
          )->leaf( `Text`
            )->a( n = `text` v = |\{ path: '{ client->_bind( val = clock path = abap_true ) }', type: 'TimeType' \}|

        )->shut( ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.
ENDCLASS.
