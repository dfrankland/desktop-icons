project('desktop-icons',
  version: '3.30',
  license: 'GPL3'
)

prefix = get_option('prefix')
schema_dir = join_paths(prefix, 'schemas')

gnome = import ('gnome')
i18n = import('i18n')

install_data([
    'createThumbnail.js',
    'dbusUtils.js',
    'desktopGrid.js',
    'desktopIconsUtil.js',
    'desktopManager.js',
    'extension.js',
    'fileItem.js',
    'metadata.json',
    'prefs.js',
    'stylesheet.css'
  ],
  install_dir: prefix
)

install_data(
  'schemas/org.gnome.shell.extensions.desktop-icons.gschema.xml',
  install_dir : schema_dir
)

subdir(
  'po'
)

meson.add_install_script('meson_post_install.py')
