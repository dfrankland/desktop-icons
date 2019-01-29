# Desktop Icons
## What  is it?
A GNOME Shell extension for providing desktop icons.

# Requirements
* GNOME Shell >= 3.30
* Nautilus >= 3.30.4

## How to contribute?
* Download the code
* Build with Meson (see at the next section)
* Log out & log in from your user session. Alternatively, just restart the computer.
* Activate the extension in GNOME Tweaks

## Build with Meson
The project uses a build system called [Meson](https://mesonbuild.com/). You can install
in most Linux distributions as "meson".

It's possible to read more information in the Meson docs to tweak the configuration if needed.

For a regular use and local development these are the steps to build the
project and install it:
```
meson --prefix=$HOME/.local/ --localedir=share/gnome-shell/extensions/desktop-icons@csoriano/locale .build
ninja -C .build install
```

It is strongly recommended to delete the destination folder
($HOME/.local/share/gnome-shell/extensions/desktop-icons@csoriano) before doing this, to ensure that no old
data is kept.

### Export extension ZIP file for extensions.gnome.org
```
./export-zip.sh
# creates
./desktop-icons@csoriano.zip
```
