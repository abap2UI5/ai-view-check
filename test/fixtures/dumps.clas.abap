CLASS zcl_fixture_dumps DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_fixture_dumps IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    " the two ways a builder chain dumps although the XML would look fine:
    "   a( ) on the bare factory root - there is no element to carry it
    "   the same attribute name twice on one control
    " z2ui5_cl_ai_xml ASSERTs on both, so the app never reaches the browser
    DATA(view) = z2ui5_cl_ai_xml=>factory( ).

    view->a( n = `title` v = `no element yet` ).

    view->open( n = `View` ns = `mvc`
        )->a( n = `xmlns`     v = `sap.m`
        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`

        )->open( `Page`
            )->a( n = `title` v = `Dumps`

            )->leaf( `Button`
                )->a( n = `text` v = `Save`
                )->a( n = `text` v = `Save and close`

        )->shut( )->shut( ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

ENDCLASS.
