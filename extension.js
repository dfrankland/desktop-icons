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
const Queue = Me.imports.queue;

const DESKTOP_PATH = "/home/csoriano/Desktop";
const ICON_SIZE = 64;
const ICON_MAX_WIDTH = 130;

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
        log('Coordinates ', this._coordinates, file.get_uri());

        this.actor = new St.Bin({ visible:true });
        this.actor.width = ICON_MAX_WIDTH;
        this.actor.height = ICON_MAX_WIDTH;
        this.actor._delegate = this;

        let containerLayout = new Clutter.BoxLayout({ orientation: Clutter.Orientation.VERTICAL });
        this._container = new St.Widget ({ layout_manager: containerLayout,
                                           reactive: true,
                                           track_hover: true,
                                           can_focus: true,
                                           style_class: 'file-container',
                                           x_expand: true,
                                           y_expand: true,
                                           x_align: Clutter.ActorAlign.CENTER });
        this.actor.add_actor(this._container);

        this._icon = new St.Icon({ gicon: fileInfo.get_icon(),
                                   icon_size: ICON_SIZE });
        this._container.add_actor(this._icon);

        this._label = new St.Label({ text: fileInfo.get_display_name(),
                                     style_class: "name-label" });
        this._container.add_actor(this._label);
        let clutterText = this._label.get_clutter_text();
        clutterText.set_line_wrap(true);
        clutterText.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        clutterText.set_ellipsize(Pango.EllipsizeMode.END);

        this._container.connect('button-press-event', Lang.bind(this, this._onButtonPress));

        this._createMenu();
    },

    _onOpenClicked: function()
    {
        log ("Open clicked");
    },

    _onCopyClicked: function()
    {
        desktopManager.fileCopyClicked();
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
            desktopManager.fileRightClickClicked(this);
            this._menu.toggle();
            return Clutter.EVENT_STOP;
        }
        if (button == 1)
        {
            desktopManager.fileLeftClickClicked(this);
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

        this._layout = new Clutter.GridLayout({ orientation: Clutter.Orientation.VERTICAL,
                                                column_homogeneous: true,
                                                row_homogeneous: true });

        this.actor = new St.Widget({ name: "DesktopContainer",
                                     layout_manager: this._layout,
                                     reactive: true,
                                     x_expand: true,
                                     y_expand: true,
                                     opacity: 255 });

        this._bgManager._container.add_actor(this.actor);

        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        let monitorIndex = bgManager._monitorIndex;
        this._monitorConstraint = new Layout.MonitorConstraint({ index: monitorIndex,
                                                                 work_area: true });
        this.actor.add_constraint(this._monitorConstraint);

        this._addDesktopBackgroundMenu();

        this._bgDestroyedId = bgManager.backgroundActor.connect('destroy',
                                                                Lang.bind(this, this._backgroundDestroyed));

        this.actor.connect('button-press-event', Lang.bind(this, this._onButtonPress));
        this.actor.connect('button-release-event', Lang.bind(this, this._onButtonRelease));
        this.actor.connect('motion-event', Lang.bind(this, this._onMotion));
        this._rubberBand = new St.Widget({ style_class: "rubber-band" });
        this._rubberBand.hide();
        Main.layoutManager.uiGroup.add_actor(this._rubberBand);

        this._createPlaceholders();
    },

    _createPlaceholders: function()
    {
        let workarea = Main.layoutManager.getWorkAreaForMonitor(this._monitorConstraint.index);
        log ("work area " + workarea.width + " " + workarea.height);
        let maxFileContainers = Math.ceil((workarea.width / ICON_MAX_WIDTH) * (workarea.height / ICON_MAX_WIDTH));
        let maxRows = Math.ceil(workarea.height / ICON_MAX_WIDTH);
        let maxColumns = Math.ceil(workarea.width / ICON_MAX_WIDTH);

        log ("max file containers " + maxFileContainers);
/*
        for (let i = 0; i < maxRows; i++)
        {
            this._layout.insert_row(i);
        }

        for (let j = 0; j < maxColumns; j++)
        {
            this._layout.insert_column(j);
        }
*/

        for (let i = 0; i < maxColumns; i++)
        {
            for (let j = 0; j < maxRows; j++)
            {
                let placeholder = new St.Bin({ width: ICON_MAX_WIDTH, height: ICON_MAX_WIDTH });
                let icon = new St.Icon({ icon_name: 'dialog-password-symbolic' });
                placeholder.add_actor(icon);
                this._layout.attach(placeholder, i, j, 1, 1);
            }
        }
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
        this.actor._desktopBackgroundMenu.open(BoxPointer.PopupAnimation.NONE);
        //TODO: Why does it need ignoreRelease?
        this.actor._desktopBackgroundManager.ignoreRelease();
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

    _selectFromRubberband: function(currentX, currentY)
    {
        let x = this._rubberBandInitialX < currentX ? this._rubberBandInitialX
                                                    : currentX;
        let y = this._rubberBandInitialY < currentY ? this._rubberBandInitialY
                                                    : currentY;
        let width = Math.abs(this._rubberBandInitialX - currentX);
        let height = Math.abs(this._rubberBandInitialY - currentY);
        let selection = [];
        for(let i = 0; i < this._fileContainers; i++)
        {
            let fileContainer = this._fileContainers[i];
            if(fileContainer.actor.x > currentX && fileContainer.actor.x < currentX + width &&
               fileContainer.actor.y > currentY && fileContainer.actor.y < currentY + height)
            {
                selection.push(fileContainer);
            }
        }

        desktopManager.setSelection(selection);
    },

    addFileContainer: function(fileContainer, top, left)
    {
        this._containers.push(fileContainer);
        this._layout.attach(fileContainer, top, left, 1, 1);
    },

    _onMotion: function(actor, event)
    {
        let [x, y] = event.get_coords();
        if(this._drawingRubberBand)
        {
            this._drawRubberBand(x, y);
            this._selectFromRubberband(x, y);
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
        this.actor._desktopBackgroundMenu = this._createDesktopBackgroundMenu();
        this.actor._desktopBackgroundManager = new PopupMenu.PopupMenuManager({ actor: this.actor });
        this.actor._desktopBackgroundManager.addMenu(this.actor._desktopBackgroundMenu);

        let grabOpBeginId = global.display.connect('grab-op-begin', Lang.bind(this, function () {
            // this._iconsContainer._desktopBackgroundMenu.close(BoxPointer.PopupAnimation.NONE);
        }));

        this.actor.connect('destroy', Lang.bind (this, function() {
            this.actor._desktopBackgroundMenu.destroy();
            this.actor._desktopBackgroundMenu = null;
            this.actor._desktopBackgroundManager = null;
            global.display.disconnect(grabOpBeginId);
        }));
    },

    findEmptyPlace: function(left, top)
    {
        let workarea = Main.layoutManager.getWorkAreaForMonitor(this._monitorConstraint.index);
        let maxRows = Math.ceil(workarea.height / ICON_MAX_WIDTH);
        let maxColumns = Math.ceil(workarea.width / ICON_MAX_WIDTH);
        let bfsQueue = new Queue.Queue();
        bfsQueue.enqueue([[left, top]]);
        let bfsToVisit = [JSON.stringify([left, top])];
        let iterations = 0;
        while(bfsQueue.length > 0 && iterations < 1000)
        {
            let current = bfsQueue.dequeue();
            if(this._layout.get_child_at(current[0], current[1])._delegate == undefined ||
               !(this._layout.get_child_at(current[0], current[1])._delegate instanceof FileContainer))
            {
                return [this._layout.get_child_at(current[0], current[1]),
                        current[0], current[1]];
            }

            let adjacents = [];
            if(current[0] + 1 < maxColumns)
            {
                adjacents.push([current[0] + 1, current[1]]);
            }
            if(current[1] + 1 < maxRows)
            {
                adjacents.push([current[0], current[1] + 1]);
            }
            if(current[0] - 1 >= 0)
            {
                adjacents.push([current[0] - 1, current[1]]);
            }
            if(current[1] - 1 >= 0)
            {
                adjacents.push([current[0], current[1] - 1]);
            }
            for(let i = 0; i < adjacents.length; i++)
            {
                if(bfsToVisit.indexOf(JSON.stringify(adjacents[i])) < 0)
                {
                    bfsQueue.enqueue(adjacents[i]);
                    bfsToVisit.push(JSON.stringify(adjacents[i]));
                }
            }
            iterations++;
        }

        return null;
    }
});

const DesktopManager = new Lang.Class(
{
    Name: 'DesktopManager',

    _init: function()
    {
        this._layoutChildrenId = 0;
        this._desktopEnumerateCancellable = null;
        this._desktopContainers = [];

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', Lang.bind(this, this._addDesktopIcons));
        this._startupPreparedId = Main.layoutManager.connect('startup-prepared', Lang.bind(this, this._addDesktopIcons));

        this._addDesktopIcons();

        this._selection = [];
    },

    _addDesktopIcons: function()
    {
        this._destroyDesktopIcons();
        forEachBackgroundManager(Lang.bind(this, function(bgManager)
        {
            this._desktopContainers.push(new DesktopContainer(bgManager));
        }));

        this._addFiles();
    },

    _destroyDesktopIcons: function()
    {
        this._desktopContainers.forEach(function(l) { l.actor.destroy(); });
        this._desktopContainers = [];
    },

    _addFiles: function()
    {
        this._fileContainers = [];
        if (this._desktopEnumerateCancellable)
        {
            this._desktopEnumerateCancellable.cancel();
        }

        this._desktopEnumerateCancellable = new Gio.Cancellable();
        let desktopDir = Gio.File.new_for_commandline_arg(DESKTOP_PATH);
        desktopDir.enumerate_children_async("metadata::*, standard::name,standard::type,standard::icon,standard::display-name",
                                            Gio.FileQueryInfoFlags.NONE,
                                            GLib.PRIORITY_DEFAULT,
                                            this._desktopEnumerateCancellable,
                                            Lang.bind (this, this._onDesktopEnumerateChildren));
    },

    _onDesktopEnumerateChildren: function(source, res)
    {
        let fileEnum;
        try
        {
            fileEnum = source.enumerate_children_finish(res);
        }
        catch(error)
        {
            if(error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            {
                return;
            }
            else
            {
                log("Error loading Desktop files");
                return;
            }
        }

        let info;
        while ((info = fileEnum.next_file(null)))
        {
            file = fileEnum.get_child(info);
            fileContainer = new FileContainer(file, info);
            this._fileContainers.push(fileContainer);
        }

        this._desktopContainers.forEach(Lang.bind(this,
            function(item, index)
            {
                item.actor.connect('allocation-changed', Lang.bind(this, this._scheduleLayoutChildren));
            }));
        this._scheduleLayoutChildren();
    },

    _getChildAtPos: function(x, y)
    {
        let minDistance = Number.POSITIVE_INFINITY;
        let closestChild = null;
        let closestDesktopContainer = null;
        let left = -1;
        let top = -1;
        for (let k = 0; k < this._desktopContainers.length; k++)
        {
            let desktopContainer = this._desktopContainers[k];

            let workarea = Main.layoutManager.getWorkAreaForMonitor(desktopContainer._monitorConstraint.index);
            let maxRows = Math.ceil(workarea.height / ICON_MAX_WIDTH);
            let maxColumns = Math.ceil(workarea.width / ICON_MAX_WIDTH);
            let maxFileContainers = maxRows * maxColumns;

            let children = desktopContainer.actor.get_children();
            let transformedPosition = desktopContainer.actor.get_transformed_position();
            for (let i = 0; i < maxRows; i++)
            {
                for (let j = 0; j < maxColumns; j++)
                {
                    let child = children[i];
                    let proposedPosition = [];
                    proposedPosition[0] = Math.floor(transformedPosition[0] + j * ICON_MAX_WIDTH);
                    proposedPosition[1] = Math.floor(transformedPosition[1] + i * ICON_MAX_WIDTH);
                    if (child.visible)
                    {
                        let distance = distanceBetweenPoints(proposedPosition[0], proposedPosition[1], x, y);
                        if (distance < minDistance)
                        {
                            closestChild = desktopContainer._layout.get_child_at(j, i);
                            minDistance = distance;
                            closestDesktopContainer = desktopContainer;
                            left = j;
                            top = i;
                        }
                    }
                }
            }
        }

        return [closestChild, closestDesktopContainer, left, top];
    },

    _scheduleLayoutChildren: function()
    {
        if (this._layoutChildrenId != 0)
        {
            GLib.source_remove(this._layoutChildrenId);
        }

        this._layoutChildrenId = GLib.idle_add(GLib.PRIORITY_LOW, Lang.bind(this, this._layoutChildren));
    },


    _layoutChildren: function()
    {
        for (let i = 0; i < this._fileContainers.length; i++)
        {
            let fileContainer = this._fileContainers[i];
            if (fileContainer.actor.visible)
            {
                let coordinates = fileContainer.getCoordinates();
                let result = this._getChildAtPos(coordinates[0], coordinates[1]);
                let placeholder = result[0];
                let desktopContainer = result[1];
                let left = result[2];
                let top = result[3];
                if(placeholder._delegate != undefined && placeholder._delegate instanceof FileContainer)
                {
                    result = desktopContainer.findEmptyPlace(left, top);
                    if (result == null)
                    {
                        log("WARNING: No empty space in the desktop for another icon");
                        this._layoutChildrenId = 0;
                        return GLib.SOURCE_REMOVE;
                    }
                    placeholder = result[0];
                    left = result[1];
                    top = result[2];
                }
                placeholder.destroy();
                desktopContainer.addFileContainer(fileContainer, left, top);
            }
        }

        this._layoutChildrenId = 0;
        return GLib.SOURCE_REMOVE;
    },

    fileLeftClickClicked: function(fileContainer)
    {
        this._setSelection([fileContainer]);
    },

    fileRightClickClicked: function(fileContainer)
    {
        if(fileContainer == null)
        {
            this._setSelection([]);

            return;
        }

        if(!this._selection.indexOf(fileContainer))
        {
            this._setSelection([fileContainer]);
        }
    },

    _setSelection: function(selection)
    {
        for(let i = 0; i < this._fileContainers.length; i++)
        {
            let fileContainer = this._fileContainers[i];
            if(selection.indexOf(fileContainer) >= 0)
            {
                fileContainer._container.add_style_pseudo_class('selected');
                log('adding style pseudo class');
            }
            else
            {
                fileContainer._container.remove_style_pseudo_class('selected');
            }
        }

        this._selection = selection;
    },

    fileCopyClicked: function()
    {
        log("Manager File copy clicked");
    },

    destroy: function()
    {
        if (this._monitorsChangedId)
        {
            Main.layoutManager.disconnect(this._monitorsChangedId);
        }
        this._monitorsChangedId = 0;

        if (this._startupPreparedId)
        {
            Main.layoutManager.disconnect(this._startupPreparedId);
        }
        this._startupPreparedId = 0;
    }
});

function centerOfRectangle(x, y, width, height)
{
    return [x + width/2, y + height/2];
}

function distanceBetweenPoints(x, y, x2, y2)
{
    return Math.sqrt(Math.pow(x - x2, 2) + Math.pow(y - y2, 2));
}

let injections = {};

function forEachBackgroundManager(func)
{
    //Main.overview._bgManagers.forEach(func);
    Main.layoutManager._bgManagers.forEach(func);
}

function removeBackgroundMenu()
{
    injections['_addBackgroundMenu'] = Main.layoutManager._addBackgroundMenu;
    Main.layoutManager._addBackgroundMenu = function (bgManager) {};
}

function init()
{
}

desktopManager = null;

function enable()
{
    removeBackgroundMenu();
    desktopManager = new DesktopManager();
}

function disable()
{
    desktopManager.destroy();
    for (prop in injections)
    {
        Main.layoutManager[prop] = injections[prop];
    }
}
