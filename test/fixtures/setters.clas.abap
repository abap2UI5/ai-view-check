CLASS zcl_fixture_setters DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA expanded TYPE abap_bool.
ENDCLASS.

CLASS zcl_fixture_setters IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    CASE client->get( )-event.

      WHEN `TOGGLE`.
        " reported - sap.m.Panel.expanded is a bindable property
        client->follow_up_action( val   = client->cs_event-control_by_id
                                  t_arg = VALUE #( ( `panel` ) ( `setExpanded` ) ( `true` ) ) ).

      WHEN `SECTION`.
        " not reported - selectedSection is an ASSOCIATION, it cannot be bound
        client->follow_up_action( val   = client->cs_event-control_by_id
                                  t_arg = VALUE #( ( `objectPage` ) ( `setSelectedSection` ) ( `sec1` ) ) ).

      WHEN `URLS`.
        " not reported - asyncURLHandler is a function property, no JSON model
        " can carry a live callback
        client->follow_up_action( val   = client->cs_event-control_by_id
                                  t_arg = VALUE #( ( `msgPopover` ) ( `setAsyncURLHandler` ) ( `ALLOW_ALL` ) ) ).

      WHEN `FOCUS`.
        " not reported - not a setter at all
        client->follow_up_action( val   = client->cs_event-control_by_id
                                  t_arg = VALUE #( ( `panel` ) ( `focus` ) ) ).

    ENDCASE.

    DATA(view) = z2ui5_cl_ai_xml=>factory( ).
    view->open( n = `View` ns = `mvc`
        )->a( n = `xmlns`       v = `sap.m`
        )->a( n = `xmlns:mvc`   v = `sap.ui.core.mvc`
        )->a( n = `xmlns:uxap`  v = `sap.uxap`

        )->open( `Panel`
          )->a( n = `id` v = `panel`

          )->leaf( `MessagePopover`
            )->a( n = `id` v = `msgPopover`

        )->shut(

        )->leaf( n = `ObjectPageLayout` ns = `uxap`
            )->a( n = `id` v = `objectPage` ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.
ENDCLASS.
