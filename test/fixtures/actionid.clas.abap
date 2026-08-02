CLASS zcl_fixture_actionid DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA name TYPE string.
ENDCLASS.

CLASS zcl_fixture_actionid IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    CASE client->get( )-event.

      WHEN `OK`.
        " the id the view declares
        client->follow_up_action( val   = client->cs_event-control_by_id
                                  t_arg = VALUE #( ( `messageView` ) ( `navigateBack` ) ) ).

      WHEN `TYPO`.
        " same control, wrong case - the frontend resolves nothing
        client->follow_up_action( val   = client->cs_event-control_by_id
                                  t_arg = VALUE #( ( `messageview` ) ( `navigateBack` ) ) ).

      WHEN `DYNAMIC`.
        " an id that arrives from the event is not a literal - not judged
        client->follow_up_action( val   = client->cs_event-control_by_id
                                  t_arg = VALUE #( ( client->get_event_arg( ) ) ( `focus` ) ) ).

    ENDCASE.

    DATA(view) = z2ui5_cl_ai_xml=>factory( ).
    view->open( n = `View` ns = `mvc`
        )->a( n = `xmlns`     v = `sap.m`
        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`

        )->open( `Page`
          )->a( n = `id` v = `mainPage`

          )->leaf( `Input`
            )->a( n = `id`    v = `messageView`
            )->a( n = `value` v = client->_bind( name )

        )->shut( ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.
ENDCLASS.
