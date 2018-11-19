# Desktop Icons
## What  is it?
A GNOME Shell extension for providing desktop icons.

# Requirements
* GNOME Shell >= 3.28
* Nautilus >= 3.30

## How to contribute?
* Download the code at ~/.local/share/gnome-shell/extensions
* Activate the extension in GNOME Tweaks

## Tasks & known issues
Take a look at the proposed possible tasks and known issues for the 1.0 release
at the [MVP issue](https://gitlab.gnome.org/World/ShellExtensions/desktop-icons/issues/1)

## Built with meson
```
meson --prefix="${PREFIX}" "${BUILD_DIR}"
# With custom localedir
meson --prefix="${PREFIX}" --localedir=locale "${BUILD_DIR}"

ninja -C "${BUILD_DIR}" install
```
### Export extension ZIP file for extensions.gnome.org
```
./export-zip.sh
# creates
./desktop-icons@csoriano.zip
```
