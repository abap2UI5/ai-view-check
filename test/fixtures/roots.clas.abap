CLASS zcl_fixture_roots DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA name TYPE string.
ENDCLASS.

CLASS zcl_fixture_roots IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    " a full view handed to the popup slot - Fragment.load, and a view has no open( )
    DATA(popup) = z2ui5_cl_ai_xml=>factory( ).
    popup->open( n = `View` ns = `mvc`
        )->a( n = `xmlns`     v = `sap.m`
        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`
        )->open( `Dialog`
          )->a( n = `title` v = `Wrong slot`
        )->shut( ).
    client->popup_display( popup->stringify( ) ).

    " and a fragment handed to the view slot - XMLView.create needs a mvc:View
    DATA(main) = z2ui5_cl_ai_xml=>factory( ).
    main->open( n = `FragmentDefinition` ns = `core`
        )->a( n = `xmlns`      v = `sap.m`
        )->a( n = `xmlns:core` v = `sap.ui.core`
        )->open( `Page`
          )->a( n = `title` v = `Wrong slot too`
        )->shut( ).
    client->view_display( main->stringify( ) ).

  ENDMETHOD.
ENDCLASS.
