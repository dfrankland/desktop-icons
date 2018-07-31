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
const Lang = imports.lang;
const St = imports.gi.St;

const Layout = imports.ui.layout;
const Main = imports.ui.main;
const BoxPointer = imports.ui.boxpointer;
const PopupMenu = imports.ui.popupMenu;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const FileContainer = Me.imports.fileContainer;
const Queue = Me.imports.queue;
const Settings = Me.imports.settings;

var DesktopContainer = new Lang.Class(
{
    Name: 'DesktopContainer',

    _init: function (bgManager)
    {
        this._bgManager = bgManager;

        this._layout = new Clutter.GridLayout({
            orientation: Clutter.Orientation.VERTICAL,
            column_homogeneous: true,
            row_homogeneous: true
        });

        this.actor = new St.Widget({
            name: "DesktopContainer",
            layout_manager: this._layout,
            reactive: true,
            x_expand: true,
            y_expand: true,
            opacity: 255
        });
        this.actor._delegate = this;

        this._bgManager._container.add_actor(this.actor);

        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        let monitorIndex = bgManager._monitorIndex;
        this._monitorConstraint = new Layout.MonitorConstraint({
            index: monitorIndex,
            work_area: true
        });
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

        this._fileContainers = [];
        this._createPlaceholders();
    },

    _createPlaceholders: function ()
    {
        let workarea = Main.layoutManager.getWorkAreaForMonitor(this._monitorConstraint.index);
        let maxRows = Math.ceil(workarea.height / Settings.ICON_MAX_WIDTH);
        let maxColumns = Math.ceil(workarea.width / Settings.ICON_MAX_WIDTH);

        for (let i = 0; i < maxColumns; i++)
        {
            for (let j = 0; j < maxRows; j++)
            {
                let placeholder = new St.Bin({ width: Settings.ICON_MAX_WIDTH, height: Settings.ICON_MAX_WIDTH });
                /* DEBUG
                let icon = new St.Icon({ icon_name: 'window-restore-symbolic' });
                placeholder.add_actor(icon);
                */
                this._layout.attach(placeholder, i, j, 1, 1);
            }
        }
    },

    _backgroundDestroyed: function ()
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

    _onDestroy: function ()
    {
        if (this._bgDestroyedId)
        {
            this._bgManager.backgroundActor.disconnect(this._bgDestroyedId);
        }

        this._bgDestroyedId = 0;
        this._bgManager = null;
        this._rubberBand.destroy();
    },

    _onNewFolderClicked: function ()
    {
        log("New folder clicked");
    },

    _onPasteClicked: function ()
    {
        log("Paste clicked");
    },

    _onSelectAllClicked: function ()
    {
        log("Select All clicked");
    },

    _onPropertiesClicked: function ()
    {
        log("Properties clicked");
    },

    _createDesktopBackgroundMenu: function ()
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

    _openMenu: function (x, y)
    {
        Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
        this.actor._desktopBackgroundMenu.open(BoxPointer.PopupAnimation.NONE);
        //TODO: Why does it need ignoreRelease?
        this.actor._desktopBackgroundManager.ignoreRelease();
    },

    _drawRubberBand: function (currentX, currentY)
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

    _selectFromRubberband: function (currentX, currentY)
    {
        let rubberX = this._rubberBandInitialX < currentX ? this._rubberBandInitialX
            : currentX;
        let rubberY = this._rubberBandInitialY < currentY ? this._rubberBandInitialY
            : currentY;
        let rubberWidth = Math.abs(this._rubberBandInitialX - currentX);
        let rubberHeight = Math.abs(this._rubberBandInitialY - currentY);
        let selection = [];
        for (let i = 0; i < this._fileContainers.length; i++)
        {
            let fileContainer = this._fileContainers[i];
            let [containerX, containerY] = fileContainer.getInnerIconPosition();
            let [containerWidth, containerHeight] = fileContainer.getInnerSize();
            if (rectanglesIntersect(rubberX, rubberY, rubberWidth, rubberHeight,
                containerX, containerY, containerWidth, containerHeight))
            {
                selection.push(fileContainer);
            }
        }

        desktopManager.setSelection(selection);
    },

    addFileContainer: function (fileContainer, top, left)
    {
        this._fileContainers.push(fileContainer);
        this._layout.attach(fileContainer.actor, top, left, 1, 1);
    },

    removeFileContainer: function (fileContainer)
    {
        let index = this._fileContainers.indexOf(fileContainer);
        if (index > -1)
        {
            this._fileContainers.splice(index, 1);
        }
        else
        {
            log('Error removing children from container');
        }

        this.actor.remove_child(fileContainer.actor);
    },

    reset: function ()
    {
        this._fileContainers = [];
        this.actor.remove_all_children();
        this._createPlaceholders();
    },

    _onMotion: function (actor, event)
    {
        let [x, y] = event.get_coords();
        if (this._drawingRubberBand)
        {
            this._drawRubberBand(x, y);
            this._selectFromRubberband(x, y);
        }
    },

    _onButtonPress: function (actor, event)
    {
        let button = event.get_button();
        let [x, y] = event.get_coords();
        if (button == 1)
        {
            desktopManager.setSelection([]);
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

    _onButtonRelease: function (actor, event)
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

    _addDesktopBackgroundMenu: function ()
    {
        this.actor._desktopBackgroundMenu = this._createDesktopBackgroundMenu();
        this.actor._desktopBackgroundManager = new PopupMenu.PopupMenuManager({ actor: this.actor });
        this.actor._desktopBackgroundManager.addMenu(this.actor._desktopBackgroundMenu);

        let grabOpBeginId = global.display.connect('grab-op-begin', Lang.bind(this, function () {
            // this._iconsContainer._desktopBackgroundMenu.close(BoxPointer.PopupAnimation.NONE);
        }));

        this.actor.connect('destroy', Lang.bind(this, function () {
            this.actor._desktopBackgroundMenu.destroy();
            this.actor._desktopBackgroundMenu = null;
            this.actor._desktopBackgroundManager = null;
            global.display.disconnect(grabOpBeginId);
        }));
    },

    findEmptyPlace: function (left, top)
    {
        let workarea = Main.layoutManager.getWorkAreaForMonitor(this._monitorConstraint.index);
        let maxRows = Math.ceil(workarea.height / Settings.ICON_MAX_WIDTH);
        let maxColumns = Math.ceil(workarea.width / Settings.ICON_MAX_WIDTH);
        let bfsQueue = new Queue.Queue();
        bfsQueue.enqueue([left, top]);
        let bfsToVisit = [JSON.stringify([left, top])];
        let iterations = 0;
        while (!bfsQueue.isEmpty() && iterations < 1000)
        {
            let current = bfsQueue.dequeue();
            let currentChild = this._layout.get_child_at(current[0], current[1]);
            if (currentChild._delegate == undefined ||
                !(currentChild._delegate instanceof FileContainer.FileContainer))
            {
                return [currentChild, current[0], current[1]];
            }

            let adjacents = [];
            if (current[0] + 1 < maxColumns)
            {
                adjacents.push([current[0] + 1, current[1]]);
            }
            if (current[1] + 1 < maxRows)
            {
                adjacents.push([current[0], current[1] + 1]);
            }
            if (current[0] - 1 >= 0)
            {
                adjacents.push([current[0] - 1, current[1]]);
            }
            if (current[1] - 1 >= 0)
            {
                adjacents.push([current[0], current[1] - 1]);
            }
            for (let i = 0; i < adjacents.length; i++)
            {
                if (bfsToVisit.indexOf(JSON.stringify(adjacents[i])) < 0)
                {
                    bfsQueue.enqueue(adjacents[i]);
                    bfsToVisit.push(JSON.stringify(adjacents[i]));
                }
            }
            iterations++;
        }

        return null;
    },

    acceptDrop: function (source, actor, x, y, time)
    {
        desktopManager.acceptDrop(source, actor, x, y, time);

        return true;
    },

    getPosOfFileContainer: function (childToFind)
    {
        if (childToFind == null)
        {
            log("Error at getPosOfFileContainer: child cannot be null");
            return [false, -1, -1];
        }

        let children = this.actor.get_children();
        let transformedPosition = this.actor.get_transformed_position();
        let currentRow = 0;
        let currentColumn = 0;
        let child = this._layout.get_child_at(currentColumn, currentRow);
        let found = false
        while (child != null)
        {
            if (child._delegate != undefined &&
                child._delegate.file.get_uri() == childToFind.file.get_uri())
            {
                found = true;
                break;
            }

            currentColumn++;
            child = this._layout.get_child_at(currentColumn, currentRow);
            if (child == null)
            {
                currentColumn = 0;
                currentRow++;
                child = this._layout.get_child_at(currentColumn, currentRow);
            }
        }

        return [found, currentColumn, currentRow];
    },

});

/*
 * https://silentmatt.com/rectangle-intersection/
 */
function rectanglesIntersect(rect1X, rect1Y, rect1Width, rect1Height,
                             rect2X, rect2Y, rect2Width, rect2Height)
{
    return rect1X < (rect2X + rect2Width) && (rect1X + rect1Width) > rect2X &&
        rect1Y < (rect2Y + rect2Height) && (rect1Y + rect1Height) > rect2Y
}
