#!/usr/bin/env python3
'''
Meson custom install script
'''

import os
from subprocess import call

PREFIX = os.environ.get('MESON_INSTALL_PREFIX', os.getcwd())

print("Installing new Schemas")
call(['glib-compile-schemas', os.path.join(PREFIX, 'schemas/')])
