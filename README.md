# Desktop Icons
## What  is it?
A GNOME Shell extension for providing desktop icons.

# Requirements
* GNOME Shell >= 3.28
* Nautilus >= 3.30

## How to contribute?
* Download the code
* Build with Meson (see at the next section)
* Activate the extension in GNOME Tweaks

## Build with meson
```
meson --prefix="${PREFIX}" "${BUILD_DIR}"
# With custom localedir
meson --prefix="${PREFIX}" --localedir=locale "${BUILD_DIR}"

ninja -C "${BUILD_DIR}" install
```
The usual prefix to make it work locally would be ~/.local/share/gnome-shell/extensions/desktop-icons@csoriano

### Export extension ZIP file for extensions.gnome.org
```
./export-zip.sh
# creates
./desktop-icons@csoriano.zip
```
