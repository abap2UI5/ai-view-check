CLASS zcl_fixture_typed DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.

    TYPES:
      BEGIN OF ty_s_row,
        carrid TYPE string,
        connid TYPE string,
      END OF ty_s_row.

  PRIVATE SECTION.
    DATA name  TYPE string.
    DATA t_tab TYPE STANDARD TABLE OF ty_s_row.
ENDCLASS.


CLASS zcl_fixture_typed IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    name  = `world`.
    t_tab = VALUE #( ( carrid = `LH` connid = `0400` ) ).

    " the typed builder: the control is the METHOD name, its attributes are
    " the method's parameters. Two defects the gates still have to see
    " through the reconstruction:
    "   type = `Emphasised` - outside sap.m.ButtonType
    "   {CARID}             - not a field of ty_s_row
    DATA(view) = z2ui5_cl_xml_view=>factory( ).

    DATA(page) = view->shell( )->page( title = `Typed` ).

    page->input( value = client->_bind_edit( name )
        )->button( text  = `Post`
                   type  = `Emphasised`
                   press = client->_event( `POST` ) ).

    page->table( items = client->_bind( t_tab )
        )->columns(
            )->column( )->text( `Carrier`
        )->get_parent( )->get_parent(
        )->items(
            )->column_list_item(
                )->cells(
                    )->text( `{CARRID}`
                    )->text( `{CARID}` ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

ENDCLASS.
