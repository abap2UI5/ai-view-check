CLASS zcl_fixture_nested DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.

    TYPES:
      BEGIN OF ty_s_amount,
        size     TYPE p LENGTH 14 DECIMALS 2,
        currency TYPE string,
      END OF ty_s_amount.
    TYPES:
      BEGIN OF ty_s_element,
        label TYPE string,
        value TYPE string,
      END OF ty_s_element.
    TYPES ty_t_element TYPE STANDARD TABLE OF ty_s_element WITH EMPTY KEY.
    TYPES:
      BEGIN OF ty_s_row,
        expense  TYPE string,
        amount   TYPE ty_s_amount,
        elements TYPE ty_t_element,
      END OF ty_s_row.

    " PUBLIC: only public attributes are serialized into the model (binding-to-nonpublic)
    DATA t_rows TYPE STANDARD TABLE OF ty_s_row.
ENDCLASS.


CLASS zcl_fixture_nested IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    t_rows = VALUE #( ( expense = `Flight`
                        amount  = VALUE #( size = 560 currency = `EUR` ) ) ).

    " a nested structure is reachable through its field path, and a nested
    " aggregation binding - here in the complex form the templates use -
    " moves the row context DOWN: {LABEL} below it is a field of
    " ty_s_element, not of ty_s_row
    DATA(view) = z2ui5_cl_ai_xml=>factory( ).

    view->open( n = `View` ns = `mvc`
        )->a( n = `xmlns`     v = `sap.m`
        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`

        )->open( `Page`
            )->a( n = `title` v = `Nested`

            )->open( `List`
                )->a( n = `items` v = client->_bind( t_rows )

                )->open( `items`
                    )->open( `CustomListItem`
                        )->leaf( `Text`
                            )->a( n = `text` v = `{AMOUNT/SIZE}`
                        )->leaf( `Text`
                            )->a( n = `text` v = `{AMOUNT/CURRENCY}`
                        )->open( `List`
                            )->a( n = `items` v = `{path: 'ELEMENTS', templateShareable: true}`
                            )->open( `items`
                                )->leaf( `StandardListItem`
                                    )->a( n = `title`       v = `{LABEL}`
                                    )->a( n = `description` v = `{EXPENSE}`
                            )->shut(
                        )->shut(
                    )->shut(
                )->shut(
            )->shut(
        )->shut( )->shut( ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

ENDCLASS.
