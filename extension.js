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
const Pango = imports.gi.Pango;

const Animation = imports.ui.animation;
const Background = imports.ui.background;
const Layout = imports.ui.layout;
const Main = imports.ui.main;
const Tweener = imports.ui.tweener;
const BoxPointer = imports.ui.boxpointer;
const PopupMenu = imports.ui.popupMenu;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const DESKTOP_PATH = "/home/csoriano/Desktop";
const ICON_SIZE = 96;
const ICON_MAX_WIDTH = 120;

//TODO: restore in disable
Main.layoutManager._addBackgroundMenu = function (bgManager) {};

const FileContainer = new Lang.Class (
{
    Name: 'FileContainer',

    _init: function (file, fileInfo)
    {
        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        this.file = file;
        this._coordinates = fileInfo.get_attribute_as_string('metadata::nautilus-icon-position').split(',')
                            .map(function (x)
                            {
                                return Number(x);
                            });
        let containerLayout = new Clutter.BoxLayout({ orientation: Clutter.Orientation.VERTICAL });
        this.actor = new St.Widget ({ layout_manager: containerLayout,
                                      reactive: true,
                                      track_hover: true,
                                      can_focus: true,
                                      style_class: 'file-container',
                                      x_expand: true,
                                      visible: true,
                                      x_align: Clutter.ActorAlign.CENTER });

        this.actor.width = ICON_MAX_WIDTH;

        this.actor._delegate = this;

        this._icon = new St.Icon({ gicon: info.get_icon(),
                                   icon_size: ICON_SIZE });
        this.actor.add_actor(this._icon);

        this._label = new St.Label({ text: fileInfo.get_display_name(),
                                     style_class: "name-label" });
        let clutterText = this._label.get_clutter_text();
        clutterText.set_line_wrap(true);
        clutterText.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)

        this.actor.add_actor(this._label);

        this.actor.connect('button-press-event', Lang.bind(this, this._onButtonPress));

        this._createMenu();
    },

    _onOpenClicked: function()
    {
        log ("Open clicked");
    },

    _onCopyClicked: function()
    {
        log ("Open clicked");
    },

    _createMenu: function()
    {
        this._menuManager = new PopupMenu.PopupMenuManager({ actor: this.actor });
        let side = St.Side.LEFT;
        if (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL)
        {
            side = St.Side.RIGHT;
        }
        this._menu = new PopupMenu.PopupMenu(this.actor, 0.5, side);
        this._menu.addAction(_("Open"), Lang.bind(this, this._onOpenClicked));
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addAction(_("Copy"), Lang.bind(this, this._onCopyClicked));
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menuManager.addMenu(this._menu);

        Main.layoutManager.uiGroup.add_actor(this._menu.actor);
        this._menu.actor.hide();
    },

    _onButtonPress: function(actor, event)
    {
        let button = event.get_button();
        if (button == 3)
        {
            this._menu.toggle();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    },

    getCoordinates: function ()
    {
        return this._coordinates;
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
        this._monitorConstraint = new Layout.MonitorConstraint({ index: monitorIndex,
                                                                 work_area: true });
        this.actor.add_constraint(this._monitorConstraint);

        let flowLayout = new Clutter.FlowLayout({ snap_to_grid: true,
                                                  homogeneous: true,
                                                  row_spacing: 40,
                                                  column_spacing: 40 });

        this._iconsContainer = new St.Widget({ name: "the bin thing",
                                               layout_manager: new Clutter.FlowLayout(),
                                               reactive: true,
                                               x_expand: true,
                                               y_expand: true });
        this._iconsContainer.connect('allocation-changed', Lang.bind(this, this._scheduleLayoutChildren));
        this._layoutChildrenId = 0;
        this._iconsContainer.reactive = true;
        this.actor.add_actor(this._iconsContainer);

        this._addDesktopBackgroundMenu();

        this._bgDestroyedId = bgManager.backgroundActor.connect('destroy',
                                                                Lang.bind(this, this._backgroundDestroyed));

        this._iconsContainer.connect('button-press-event', Lang.bind(this, this._onButtonPress));
        this._iconsContainer.connect('button-release-event', Lang.bind(this, this._onButtonRelease));
        this._iconsContainer.connect('motion-event', Lang.bind(this, this._onMotion));
        this._rubberBand = new St.Widget({ style_class: "rubber-band" });
        this._rubberBand.hide();
        Main.layoutManager.uiGroup.add_actor(this._rubberBand);

        this._desktopEnumerateCancellable = null;
        this._createPlaceholders();
        this._addFiles();
    },

    _scheduleLayoutChildren: function()
    {
        if (this._layoutChildrenId != 0)
        {
            return;
            GLib.source_remove(this._layoutChildrenId);
        }

        log ("scheduling");
        this._layoutChildrenId = GLib.idle_add(GLib.PRIORITY_DEFAULT, Lang.bind(this, this._layoutChildren));
    },

    _createPlaceholders: function()
    {
        let workarea = Main.layoutManager.getWorkAreaForMonitor(this._monitorConstraint.index);
        log ("work area " + workarea.width + " " + workarea.height);
        let maxFileContainers = Math.ceil((workarea.width / ICON_SIZE) * (workarea.height / ICON_SIZE));

        log ("max file containers " + maxFileContainers);
        for (let i = 0; i < maxFileContainers; i++)
        {
            let placeholder = new St.Bin({ width: ICON_SIZE, height: ICON_SIZE });
            let icon = new St.Icon({ icon_name: 'dialog-password-symbolic' });
            placeholder.add_actor(icon);
            this._iconsContainer.add_actor(placeholder);
        }
    },

    _getChildAtPos: function(x, y)
    {
        let children = this._iconsContainer.get_children();
        for (let i = 0; i < this._iconsContainer.get_n_children(); i++)
        {
            let child = children[i];
            if (child.visible)
            {
                //log ("child calc at " + child.x + " " + child.y + " " + child.widt	 + " " + child.height + " " + x + " " + y);
                if (child.x < x && (child.x + child.width) > x &&
                    child.y < y && (child.y + child.height) > y)
                {
                    return child;
                }
            }
        }
    },

    _layoutChildren: function()
    {
        log("layout changed start");
        let amountOfPlaceholders = 0;
        for (let i = 0; i < this._fileContainers.length; i++)
        {
            let fileContainer = this._fileContainers[i];
            if (fileContainer.actor.visible)
            {
                let coordinates = fileContainer.getCoordinates();
                let placeholder = this._getChildAtPos(coordinates[0], coordinates[1]);
                //log ('allocating ' + coordinates);
                if (placeholder)
                {
                    this._iconsContainer.replace_child(placeholder, fileContainer.actor);
                    amountOfPlaceholders++;
                }
            }
        }
        this._layoutChildrenId = 0;
        log ("layout changed ", amountOfPlaceholders);

        return GLib.SOURCE_REMOVE;
    },

    _addFiles: function()
    {
        log("Add files");
        this._fileContainers = [];
        if (this._desktopEnumerateCancellable)
        {
            this._desktopEnumerateCancellable.cancel();
        }

        this._desktopEnumerateCancellable = new Gio.Cancellable();
        let desktopDir = Gio.File.new_for_commandline_arg(DESKTOP_PATH);
        desktopDir.enumerate_children_async('standard::name,standard::type,standard::icon,standard::display-name,metadata::nautilus-icon-position',
                                            Gio.FileQueryInfoFlags.NONE,
                                            GLib.PRIORITY_DEFAULT,
                                            this._desktopEnumerateCancellable,
                                            Lang.bind (this, this._onDesktopEnumerateChildren));
    },

    _onDesktopEnumerateChildren: function(source, res)
    {
        let fileEnum = source.enumerate_children_finish(res);
        while ((info = fileEnum.next_file(null)))
        {
            fileContainer = new FileContainer(fileEnum.get_child(info), info);
            this._fileContainers.push(fileContainer);
        }

        log ("on desktop enumerate children");
        this._layoutChildren();
    },

    _backgroundDestroyed: function()
    {
        this._bgDestroyedId = 0;
        if (this._bgManager == null)
        {
            return;
        }

        if (this._bgManager._backgroundSource) // background swapped
        {
            this._bgDestroyedId = this._bgManager.backgroundActor.connect('destroy',
                                                                          Lang.bind(this, this._backgroundDestroyed));
        }
        else // bgManager destroyed
        {
            this.actor.destroy();
        }
    },

    _onDestroy: function()
    {
        if (this._bgDestroyedId)
        {
            this._bgManager.backgroundActor.disconnect(this._bgDestroyedId);
        }

        this._bgDestroyedId = 0;
        this._bgManager = null;
    },

    _onNewFolderClicked: function()
    {
        log("New folder clicked");
    },

    _onPasteClicked: function()
    {
        log("Paste clicked");
    },

    _onSelectAllClicked: function()
    {
        log("Select All clicked");
    },

    _onPropertiesClicked: function()
    {
        log("Properties clicked");
    },

    _createDesktopBackgroundMenu: function()
    {
        let menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor,
                                           0, St.Side.TOP);
        menu.addAction(_("New Folder"), Lang.bind(this, this._onNewFolderClicked));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_("Paste"), Lang.bind(this, this._onPasteClicked));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_("Select All"), Lang.bind(this, this._onSelectAllClicked));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_("Properties"), Lang.bind(this, this._onPropertiesClicked));

        menu.actor.add_style_class_name('background-menu');

        Main.layoutManager.uiGroup.add_actor(menu.actor);
        menu.actor.hide();

        return menu;
    },

    _openMenu: function(x, y)
    {
        Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
        this._iconsContainer._desktopBackgroundMenu.open(BoxPointer.PopupAnimation.NONE);
        //TODO: Why does it need ignoreRelease?
        this._iconsContainer._desktopBackgroundManager.ignoreRelease();
    },

    _drawRubberBand: function(currentX, currentY)
    {
        let x = this._rubberBandInitialX < currentX ? this._rubberBandInitialX
                                                    : currentX;
        let y = this._rubberBandInitialY < currentY ? this._rubberBandInitialY
                                                    : currentY;
        let width = Math.abs(this._rubberBandInitialX - currentX);
        let height = Math.abs(this._rubberBandInitialY - currentY);
        this._rubberBand.set_position(x, y);
        this._rubberBand.set_size(width, height);
        this._rubberBand.show();
    },

    _onMotion: function(actor, event)
    {
        let [x, y] = event.get_coords();
        if(this._drawingRubberBand)
        {
            this._drawRubberBand(x, y);
        }
    },

    _onButtonPress: function(actor, event)
    {
        let button = event.get_button();
        let [x, y] = event.get_coords();
        if (button == 1)
        {
            this._rubberBandInitialX = x;
            this._rubberBandInitialY = y;
            this._drawingRubberBand = true;
            this._drawRubberBand(x, y);

            return Clutter.EVENT_STOP;
        }

        if (button == 3)
        {
            this._openMenu(x, y);

            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    },

    _onButtonRelease: function(actor, event)
    {
        let button = event.get_button();
        if (button == 1)
        {
            this._drawingRubberBand = false;
            this._rubberBand.hide();

            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    },

    _addDesktopBackgroundMenu: function()
    {
        this._iconsContainer._desktopBackgroundMenu = this._createDesktopBackgroundMenu();
        this._iconsContainer._desktopBackgroundManager = new PopupMenu.PopupMenuManager({ actor: this._iconsContainer });
        this._iconsContainer._desktopBackgroundManager.addMenu(this._iconsContainer._desktopBackgroundMenu);

        let grabOpBeginId = global.display.connect('grab-op-begin', Lang.bind(this, function () {
            // this._iconsContainer._desktopBackgroundMenu.close(BoxPointer.PopupAnimation.NONE);
        }));

        this._iconsContainer.connect('destroy', Lang.bind (this, function() {
            this._iconsContainer._desktopBackgroundMenu.destroy();
            this._iconsContainer._desktopBackgroundMenu = null;
            this._iconsContainer._desktopBackgroundManager = null;
            global.display.disconnect(grabOpBeginId);
        }));
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

function destroyBackgroundMenu()
{
    forEachBackgroundManager(function(bgManager)
    {
    });
}

function init()
{
}

function enable()
{
    monitorsChangedId = Main.layoutManager.connect('monitors-changed', addDesktopIcons);
    startupPreparedId = Main.layoutManager.connect('startup-prepared', addDesktopIcons);
    addDesktopIcons();
    //TODO: restore in disable
    destroyBackgroundMenu();
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
