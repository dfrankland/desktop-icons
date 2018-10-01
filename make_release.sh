#!/bin/bash
glib-compile-schemas schemas/
mkdir -p locale/es/LC_MESSAGES
msgfmt po/es.po -o locale/es/LC_MESSAGES/desktop-icons.mo