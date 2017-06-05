/* Desktop Icons GNOME Shell extension
 *
 * Copyright (C) 2017 Carlos Soriano <csoriano@gnome.org>
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

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const St = imports.gi.St;

const Background = imports.ui.background;
const Layout = imports.ui.layout;
const Main = imports.ui.main;
const Tweener = imports.ui.tweener;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const DESKTOP_PATH = "/home/csoriano/Desktop";

const FileContainer = new Lang.Class (
{
    Name: 'FileContainer',

    _init: function (file, fileInfo)
    {
        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        this.file = file;
        let containerLayout = new Clutter.BoxLayout({ orientation: Clutter.Orientation.VERTICAL });
        this.actor = new St.Widget ({ layout_manager: containerLayout });

        this._icon = new St.Icon({ gicon: info.get_icon() });
        this.actor.add_actor(this._icon);

        this._label = new St.Label({ text: fileInfo.get_display_name() });
        this.actor.add_actor(this._label);

        log ("New file " + this.file.get_uri());
    }
});

const DesktopContainer = new Lang.Class(
{
    Name: 'DesktopContainer',

    _init: function(bgManager)
    {
        this._bgManager = bgManager;

        this.actor = new St.Widget({ name: "DesktopContainer",
                                     layout_manager: new Clutter.BinLayout(),
                                     opacity: 255 });
        this._bgManager._container.add_actor(this.actor);

        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        let monitorIndex = bgManager._monitorIndex;
        let constraint = new Layout.MonitorConstraint({ index: monitorIndex,
                                                        work_area: true });
        this.actor.add_constraint(constraint);

        flowLayout = new Clutter.FlowLayout({ snap_to_grid: true,
                                              homogeneous: true,
                                              row_spacing: 40,
                                              column_spacing: 40 });
        this._iconsContainer = new St.Widget({ name: "the bin thing",
                                               layout_manager: flowLayout,
                                               style: "background-color: #31b0d5;",
                                               x_expand: true,
                                               y_expand: true });

        this.actor.add_actor(this._iconsContainer);

        this._desktopEnumerateCancellable = null;
        this._addFiles();

        this._bgDestroyedId = bgManager.backgroundActor.connect('destroy',
                                                                Lang.bind(this, this._backgroundDestroyed));
        log ("sizes");
        log (this._iconsContainer.width);
        log (this._iconsContainer.height);
        log (this._iconsContainer.x);
        log (this._iconsContainer.y);
    },

    _addFiles: function ()
    {
        if (this._desktopEnumerateCancellable)
        {
            this._desktopEnumerateCancellable.cancel();
        }

        this._desktopEnumerateCancellable = new Gio.Cancellable();
        let desktopDir = Gio.File.new_for_commandline_arg(DESKTOP_PATH);
        desktopDir.enumerate_children_async('standard::name,standard::type,standard::icon,standard::display-name',
                                            Gio.FileQueryInfoFlags.NONE,
                                            GLib.PRIORITY_DEFAULT,
                                            this._desktopEnumerateCancellable,
                                            Lang.bind (this, this._onDesktopEnumerateChildren));
    },

    _onDesktopEnumerateChildren: function(source, res)
    {
        fileEnum = source.enumerate_children_finish(res);
        while ((info = fileEnum.next_file(null)))
        {
            fileContainer = new FileContainer(fileEnum.get_child(info), info);
            this._iconsContainer.add_actor (fileContainer.actor);
        }
    },

    _backgroundDestroyed: function()
    {
        this._bgDestroyedId = 0;

        if (this._bgManager._backgroundSource) // background swapped
            this._bgDestroyedId =
                this._bgManager.backgroundActor.connect('destroy',
                                                        Lang.bind(this, this._backgroundDestroyed));
        else // bgManager destroyed
            this.actor.destroy();
    },

    _onDestroy: function()
    {
        if (this._bgDestroyedId)
            this._bgManager.backgroundActor.disconnect(this._bgDestroyedId);
        this._bgDestroyedId = 0;

        this._bgManager = null;
    }
});


let monitorsChangedId = 0;
let startupPreparedId = 0;
let desktopContainers = [];

function forEachBackgroundManager(func)
{
    //Main.overview._bgManagers.forEach(func);
    Main.layoutManager._bgManagers.forEach(func);
}

function addDesktopIcons()
{
    destroyDesktopIcons();
    forEachBackgroundManager(function(bgManager)
    {
        desktopContainers.push(new DesktopContainer(bgManager));
    });
}

function destroyDesktopIcons()
{
    desktopContainers.forEach(function(l) { l.actor.destroy(); });
    desktopContainers = [];
}

function init()
{
}

function enable()
{
    monitorsChangedId = Main.layoutManager.connect('monitors-changed', addDesktopIcons);
    startupPreparedId = Main.layoutManager.connect('startup-prepared', addDesktopIcons);
    addDesktopIcons();
}

function disable()
{
    if (monitorsChangedId)
    {
        Main.layoutManager.disconnect(monitorsChangedId);
    }
    monitorsChangedId = 0;

    if (startupPreparedId)
    {
        Main.layoutManager.disconnect(startupPreparedId);
    }
    startupPreparedId = 0;

    destroyDesktopIcons();
}
