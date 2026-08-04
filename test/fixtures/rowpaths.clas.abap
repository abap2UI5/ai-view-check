CLASS zcl_fixture_rowpaths DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.

    TYPES:
      BEGIN OF ty_s_row,
        carrid   TYPE string,
        connid   TYPE string,
        seatsmax TYPE i,
      END OF ty_s_row.

    " PUBLIC: only public attributes are serialized into the model (binding-to-nonpublic)
    DATA t_flights TYPE STANDARD TABLE OF ty_s_row.
ENDCLASS.


CLASS zcl_fixture_rowpaths IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    t_flights = VALUE #( ( carrid = `LH` connid = `0400` ) ).

    " inside a bound aggregation a relative {NAME} addresses the ROW, so the
    " fields of ty_s_row are what can be written there:
    "   {CARRID}   - fine, even though the seed above never set every field
    "   {SEATSMAX} - fine, declared but unseeded
    "   {CARID}    - the classic typo: the column just stays empty
    "   {CARRID} under `columns` - not a row context at all, the header of a
    "               column is bound against the view, not against a row
    DATA(view) = z2ui5_cl_ai_xml=>factory( ).

    view->open( n = `View` ns = `mvc`
        )->a( n = `xmlns`     v = `sap.m`
        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`

        )->open( `Page`
            )->a( n = `title` v = `Rows`

            )->open( `Table`
                )->a( n = `items` v = client->_bind( t_flights )

                )->open( `columns`
                    )->open( `Column`
                        )->leaf( `Text`
                            )->a( n = `text` v = `Carrier`
                    )->shut(
                )->shut(

                )->open( `items`
                    )->open( `ColumnListItem`
                        )->leaf( `Text`
                            )->a( n = `text` v = `{CARRID}`
                        )->leaf( `Text`
                            )->a( n = `text` v = `{SEATSMAX}`
                        )->leaf( `Text`
                            )->a( n = `text` v = `{CARID}`
                    )->shut(
                )->shut(
            )->shut(
        )->shut( )->shut( ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

ENDCLASS.
