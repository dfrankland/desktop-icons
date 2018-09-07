
/* Desktop Icons GNOME Shell extension
 *
 * Copyright (C) 2017 Carlos Soriano <csoriano@redhat.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

const Gtk = imports.gi.Gtk;
const GObject = imports.gi.GObject;
const Gio = imports.gi.Gio;
const GioSSS = Gio.SettingsSchemaSource;
const ExtensionUtils = imports.misc.extensionUtils;
const Gettext = imports.gettext;

var _ = Gettext.gettext;

const SCHEMA_NAUTILUS = "org.gnome.nautilus.preferences";
const SCHEMA = 'org.gnome.shell.extensions.desktop-icons';

const ICON_SIZE = [48, 64, 96, 128];
const ICON_WIDTH = [120, 130, 130, 130];
const ICON_HEIGHT = [120, 130, 164, 220];

var FILE_TYPE = {
    NONE: null,
    USER_DIRECTORY_HOME: "show-home",
    USER_DIRECTORY_TRASH: "show-trash",
}

var nautilusSettings;
var settings;
// This is already in Nautilus settings, so it should not be made tweakable here
var CLICK_POLICY_SINGLE = false;

function init() {
    let schemaSource = GioSSS.get_default();
    let schemaObj = schemaSource.lookup(SCHEMA_NAUTILUS, true);
    if (!schemaObj) {
        nautilusSettings = null;
    } else {
        nautilusSettings = new Gio.Settings({ settings_schema: schemaObj });;
        nautilusSettings.connect('changed', _onNautilusSettingsChanged);
        _onNautilusSettingsChanged();
    }
    settings = get_schema(SCHEMA);
}

function get_schema(schema) {
    let extension = ExtensionUtils.getCurrentExtension();

    // check if this extension was built with "make zip-file", and thus
    // has the schema files in a subfolder
    // otherwise assume that extension has been installed in the
    // same prefix as gnome-shell (and therefore schemas are available
    // in the standard folders)
    let schemaDir = extension.dir.get_child('schemas');
    let schemaSource;
    if (schemaDir.query_exists(null))
        schemaSource = GioSSS.new_from_directory(schemaDir.get_path(), GioSSS.get_default(), false);
    else
        schemaSource = GioSSS.get_default();

    let schemaObj = schemaSource.lookup(schema, true);
    if (!schemaObj)
        throw new Error('Schema ' + schema + ' could not be found for extension ' + extension.metadata.uuid + '. Please check your installation.');

    return new Gio.Settings({ settings_schema: schemaObj });
}

function buildPrefsWidget() {

    let frame = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, border_width: 10, spacing: 10 });

    frame.add(buildSelector('icon-size', _("Icon size")));
    frame.add(buildSwitcher('show-home', _("Show the personal folder in the desktop")));
    frame.add(buildSwitcher('show-trash', _("Show the trashcan in the desktop")));
    frame.show_all();
    return frame;
}

function buildSpinButton(key, labeltext, minimum, maximum) {
    let hbox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });
    let label = new Gtk.Label({ label: labeltext, xalign: 0 });
    let adjust = new Gtk.Adjustment({ lower: minimum, upper: maximum, value: settings.get_int(key), step_increment: 1 });
    let spin = new Gtk.SpinButton({ digits: 0, adjustment: adjust });
    settings.bind(key, adjust, 'value', 3);
    hbox.pack_start(label, true, true, 0);
    hbox.add(spin);
    return hbox;
}

function buildSwitcher(key, labeltext) {
    let hbox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });
    let label = new Gtk.Label({ label: labeltext, xalign: 0 });
    let switcher = new Gtk.Switch({ active: settings.get_boolean(key) });
    settings.bind(key, switcher, 'active', 3);
    hbox.pack_start(label, true, true, 0);
    hbox.add(switcher);
    return hbox;
}

function buildSelector(key, labeltext) {
    let listStore = new Gtk.ListStore();
    listStore.set_column_types ([GObject.TYPE_STRING]);
    let schemaKey = settings.settings_schema.get_key(key);
    let values = schemaKey.get_range().get_child_value(1).get_child_value(0).get_strv();
    for(let val in values) {
        let iter = listStore.append();
        listStore.set (iter, [0], [values[val]]);
    }
    let hbox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });
    let label = new Gtk.Label({ label: labeltext, xalign: 0 });
    let combo = new Gtk.ComboBox({model: listStore});
    let rendererText = new Gtk.CellRendererText();
    combo.pack_start (rendererText, false);
    combo.add_attribute (rendererText, "text", 0);
    combo.set_id_column(0);
    settings.bind(key, combo, 'active-id', 3);
    hbox.pack_start(label, true, true, 0);
    hbox.add(combo);
    return hbox;
}

function _onNautilusSettingsChanged() {
    CLICK_POLICY_SINGLE = nautilusSettings.get_string("click-policy") == "single";
}

function get_icon_size() {
    return ICON_SIZE[settings.get_enum("icon-size")];
}

function get_max_width() {
    return ICON_WIDTH[settings.get_enum("icon-size")];
}

function get_max_height() {
    return ICON_HEIGHT[settings.get_enum("icon-size")];
}