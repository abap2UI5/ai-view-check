CLASS zcl_fixture_corpus DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES: BEGIN OF ty_s_row,
             descr TYPE string,
             price TYPE string,
             date  TYPE string,
           END OF ty_s_row.
    DATA t_rows TYPE STANDARD TABLE OF ty_s_row WITH EMPTY KEY.
    DATA t_more TYPE STANDARD TABLE OF ty_s_row WITH EMPTY KEY.
    DATA title TYPE string.
ENDCLASS.

CLASS zcl_fixture_corpus IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    model_init( ).

    DATA(view) = z2ui5_cl_ai_xml=>factory( ).
    view->open( n = `View` ns = `mvc`
        )->a( n = `xmlns`      v = `sap.m`
        )->a( n = `xmlns:mvc`  v = `sap.ui.core.mvc`
        )->a( n = `xmlns:core` v = `sap.ui.core`
        )->a( n = `core:require` v = `{Formatter: 'z2ui5/model/formatter'}`
        )->open( `Page`
          )->a( n = `title` v = `{/TITLE}`
          )->open( `List`
            )->a( n = `items` v = client->_bind( t_rows )
            )->open( `items`
              )->leaf( `ObjectListItem`
                )->a( n = `title`  v = `{DESCR}`
                )->a( n = `number` v = |\{ path: 'PRICE', formatter: 'Formatter.round2DP' \}|
                )->a( n = `intro`  v = |\{ path: 'DATE', formatter: 'Formatter.DateCreateObject' \}|
        )->shut( )->shut( )->shut( ).
    client->view_display( view->stringify( ) ).

    DATA(popover) = z2ui5_cl_ai_xml=>factory( ).
    popover->open( n = `FragmentDefinition` ns = `core`
        )->a( n = `xmlns:core` v = `sap.ui.core`
        )->a( n = `xmlns`      v = `sap.m`
        )->leaf( `Text`
          )->a( n = `text` v = `Details` ).
    client->popover_display( val = popover->stringify( ) ).

  ENDMETHOD.
  METHOD model_init.
    title = `Products`.
    t_rows = VALUE #( FOR i = 1 UNTIL i > 3 ( descr = `Notebook` price = `10` date = `2024-01-01` ) ).
    t_more = VALUE #( FOR i = 1 UNTIL i > 2 ( descr = `Mouse` price = `20` date = `2024-01-02` ) ).
  ENDMETHOD.
ENDCLASS.
