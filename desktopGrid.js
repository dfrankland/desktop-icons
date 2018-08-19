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
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const Layout = imports.ui.layout;
const Main = imports.ui.main;
const BoxPointer = imports.ui.boxpointer;
const PopupMenu = imports.ui.popupMenu;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Extension = Me.imports.extension;
const FileItem = Me.imports.fileItem;
const Settings = Me.imports.settings;
const DBusUtils = Me.imports.dbusUtils;
const DesktopIconsUtil = Me.imports.desktopIconsUtil;
const Util = imports.misc.util;

const Clipboard = St.Clipboard.get_default();
const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;


/* From NautilusFileUndoManagerState */
var UndoStatus = {
    NONE: 0,
    UNDO: 1,
    REDO: 2,
};

var DesktopGrid = new Lang.Class(
{
    Name: 'DesktopGrid',

    _init(bgManager) {
        this._bgManager = bgManager;

        this.layout = new Clutter.GridLayout({
            orientation: Clutter.Orientation.VERTICAL,
            column_homogeneous: true,
            row_homogeneous: true
        });

        this.actor = new St.Widget({
            name: 'DesktopGrid',
            layout_manager: this.layout,
            reactive: true,
            x_expand: true,
            y_expand: true,
            can_focus: true,
            opacity: 255
        });
        this.actor._delegate = this;

        this._bgManager._container.add_actor(this.actor);

        this.actor.connect('destroy', () => this._onDestroy());

        let monitorIndex = bgManager._monitorIndex;
        this._monitorConstraint = new Layout.MonitorConstraint({
            index: monitorIndex,
            work_area: true
        });
        this.actor.add_constraint(this._monitorConstraint);

        this._addDesktopBackgroundMenu();

        this._bgDestroyedId = bgManager.backgroundActor.connect('destroy',
            () => this._backgroundDestroyed());

        this.actor.connect('button-press-event', (actor, event) => this._onPressButton(actor, event));
        this.actor.connect('button-release-event', (actor, event) => this._onReleaseButton(actor, event));
        this.actor.connect('motion-event', (actor, event) => this._onMotion(actor, event));
        this.actor.connect('leave-event', (actor, event) => this._onLeave(actor, event));
        this._rubberBand = new St.Widget({ style_class: 'rubber-band' });
        this._rubberBand.hide();
        Main.layoutManager.uiGroup.add_actor(this._rubberBand);

        this._fileItems = [];
        this._createPlaceholders();
        this.actor.connect('key-press-event', this._onKeyPress.bind(this));
    },

    _onKeyPress(actor, event) {
        if (global.stage.get_key_focus() != actor)
            return Clutter.EVENT_PROPAGATE;
            
        let symbol = event.get_key_symbol();
        let isCtrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) != 0;
        let isShift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) != 0;
        if (isCtrl && isShift && [Clutter.Z, Clutter.z].indexOf(symbol) > -1) {
            this._doRedo();
            return Clutter.EVENT_STOP;
        }
        else if (isCtrl && [Clutter.Z, Clutter.z].indexOf(symbol) > -1) {
            this._doUndo();
            return Clutter.EVENT_STOP;
        }
        else if (isCtrl && [Clutter.C, Clutter.c].indexOf(symbol) > -1) {
            Extension.desktopManager.doCopy();
            return Clutter.EVENT_STOP;
        }
        else if (isCtrl && [Clutter.X, Clutter.x].indexOf(symbol) > -1) {
            Extension.desktopManager.doCut();
            return Clutter.EVENT_STOP;
        }
        else if (isCtrl && [Clutter.V, Clutter.v].indexOf(symbol) > -1) {
            this._doPaste();
            return Clutter.EVENT_STOP;
        }
        else if (symbol == Clutter.Return) {
            Extension.desktopManager.doOpen();
            return Clutter.EVENT_STOP;
        }
        else if (symbol == Clutter.Delete) {
            Extension.desktopManager.doTrash();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    },

    _createPlaceholders() {
        let maxRows = this.getMaxRows();
        let maxColumns = this.getMaxColumns();

        for (let i = 0; i < maxColumns; i++) {
            for (let j = 0; j < maxRows; j++) {
                let placeholder = new St.Bin({ width: Settings.ICON_MAX_WIDTH, height: Settings.ICON_MAX_WIDTH });
                /* DEBUG
                let icon = new St.Icon({ icon_name: 'window-restore-symbolic' });
                placeholder.add_actor(icon);
                */
                this.layout.attach(placeholder, i, j, 1, 1);
            }
        }
    },

    _backgroundDestroyed() {
        this._bgDestroyedId = 0;
        if (this._bgManager == null)
            return;

        if (this._bgManager._backgroundSource) {
            this._bgDestroyedId = this._bgManager.backgroundActor.connect('destroy',
                () => this._backgroundDestroyed());
        } else {
            this.actor.destroy();
        }
    },

    _onDestroy() {
        if (this._bgDestroyedId)
            this._bgManager.backgroundActor.disconnect(this._bgDestroyedId);

        this._bgDestroyedId = 0;
        this._bgManager = null;
        this._rubberBand.destroy();
    },

    _omNewFolderClicked() {
        let dir = DesktopIconsUtil.getDesktopDir().get_child(_('New Folder'));
        DBusUtils.NautilusFileOperationsProxy.CreateFolderRemote(dir.get_uri(),
            (result, error) => {
                if (error)
                    log('Error creating new folder: ' + error.message);
            }
        );
    },

    _parseClipboardText(text) {
        let lines = text.split('\n')
        let [mime, action, ...files] = lines;

        if (mime != 'x-special/nautilus-clipboard')
            return [false, false, null];

        if (!(['copy', 'cut'].includes(action)))
            return [false, false, null];
        let isCut = action == 'cut';
        
        /* Last line is empty due to the split */
        if (files.length <= 1)
            return [false, false, null];
        /* Remove last line */
        files.pop();

        return [true, isCut, lines];
    },

    _doPaste() {
        Clipboard.get_text(CLIPBOARD_TYPE,
            (clipboard, text) => {
                let [valid, is_cut, files] = this._parseClipboardText(text);
                if (!valid)
                    return;

                let desktop_dir = `file://${DesktopIconsUtil.getDesktopDir().get_uri()}`;
                if (is_cut) {
                    DBusUtils.NautilusFileOperationsProxy.MoveURIsRemote(files, desktop_dir,
                        (result, error) => {
                            if (error)
                                log('Error moving files: ' + error.message);
                        }
                    );
                }
                else {
                    DBusUtils.NautilusFileOperationsProxy.CopyURIsRemote(files, desktop_dir,
                        (result, error) => {
                            if (error)
                                log('Error copying files: ' + error.message);
                        }
                    );
                }
            }
        );
    },

    _onPasteClicked() {
        this._doPaste();
    },

    _doUndo() {
        DBusUtils.NautilusFileOperationsProxy.UndoRemote(
            (result, error) => {
                if (error)
                    log('Error performing undo: ' + error.message);
            }
        );
    },

    _onUndoClicked() {
        this._doUndo();
    },

    _doRedo() {
        DBusUtils.NautilusFileOperationsProxy.RedoRemote(
            (result, error) => {
                if (error)
                    log('Error performing redo: ' + error.message);
            }
        );
    },

    _onRedoClicked() {
        this._doRedo();
    },

    _onOpenDesktopInFilesClicked() {
        Gio.AppInfo.launch_default_for_uri_async(DesktopIconsUtil.getDesktopDir().get_uri(),
            null, null,
            (source, res) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(res);
                } catch (e) {
                    log('Error opening Desktop in Files: ' + e.message);
                }
            }
        );
    },

    _onOpenTerminalClicked() {
        let desktopPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP);
        Util.spawnCommandLine('gnome-terminal --working-directory=' + desktopPath);
    },

    _syncUndoRedo() {
        this._undoMenuItem.actor.visible = DBusUtils.NautilusFileOperationsProxy.UndoStatus == UndoStatus.UNDO;
        this._redoMenuItem.actor.visible = DBusUtils.NautilusFileOperationsProxy.UndoStatus == UndoStatus.REDO;
    },

    _undoStatusChanged(proxy, properties, test) {
        if ('UndoStatus' in properties.deep_unpack())
            this._syncUndoRedo();
    },

    _createDesktopBackgroundMenu() {
        let menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor,
            0, St.Side.TOP);
        menu.addAction(_('New Folder'), () => this._omNewFolderClicked());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._pasteMenuItem = menu.addAction(_('Paste'), () => this._onPasteClicked());
        this._undoMenuItem = menu.addAction(_('Undo'), () => this._onUndoClicked());
        this._redoMenuItem = menu.addAction(_('Redo'), () => this._onRedoClicked());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_('Open Desktop in Files'), () => this._onOpenDesktopInFilesClicked());
        menu.addAction(_('Open Terminal'), () => this._onOpenTerminalClicked());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addSettingsAction(_('Change Background…'), 'gnome-background-panel.desktop');
        menu.addSettingsAction(_('Display Settings'), 'gnome-display-panel.desktop');
        menu.addSettingsAction(_('Settings'), 'gnome-control-center.desktop');

        menu.actor.add_style_class_name('background-menu');

        Main.layoutManager.uiGroup.add_actor(menu.actor);
        menu.actor.hide();

        menu._propertiesChangedId = DBusUtils.NautilusFileOperationsProxy.connect('g-properties-changed',
            this._undoStatusChanged.bind(this));
        this._syncUndoRedo();

        menu.connect('destroy',
            () => DBusUtils.NautilusFileOperationsProxy.disconnect(menu._propertiesChangedId));
        menu.connect('open-state-changed',
            (popupm, isOpen) => {
                if (isOpen) {
                    Clipboard.get_text(CLIPBOARD_TYPE,
                        (clipBoard, text) => {
                            let [valid, is_cut, files] = this._parseClipboardText(text);
                            this._pasteMenuItem.actor.visible = valid;
                        }
                    );
                }
            }
        );

        return menu;
    },

    _openMenu(x, y) {
        Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
        this.actor._desktopBackgroundMenu.open(BoxPointer.PopupAnimation.NONE);
        //TODO: Why does it need ignoreRelease?
        this.actor._desktopBackgroundManager.ignoreRelease();
    },

    _drawRubberBand(currentX, currentY) {
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

    _selectFromRubberband(currentX, currentY) {
        let rubberX = this._rubberBandInitialX < currentX ? this._rubberBandInitialX
            : currentX;
        let rubberY = this._rubberBandInitialY < currentY ? this._rubberBandInitialY
            : currentY;
        let rubberWidth = Math.abs(this._rubberBandInitialX - currentX);
        let rubberHeight = Math.abs(this._rubberBandInitialY - currentY);
        let selection = [];
        for (let i = 0; i < this._fileItems.length; i++) {
            let fileItem = this._fileItems[i];
            let [containerX, containerY] = fileItem.getInnerIconPosition();
            let [containerWidth, containerHeight] = fileItem.getInnerSize();
            if (rectanglesIntersect(rubberX, rubberY, rubberWidth, rubberHeight,
                containerX, containerY, containerWidth, containerHeight)) {
                selection.push(fileItem);
            }
        }

        Extension.desktopManager.setSelection(selection);
    },

    addFileItem(fileItem, top, left) {
        this._fileItems.push(fileItem);
        this.layout.attach(fileItem.actor, top, left, 1, 1);
    },

    removeFileItem(fileItem) {
        let index = this._fileItems.indexOf(fileItem);
        if (index > -1)
            this._fileItems.splice(index, 1);
        else
            log('Error removing children from container');

        this.actor.remove_child(fileItem.actor);
    },

    reset() {
        this._fileItems = [];
        this.actor.remove_all_children();
        this._createPlaceholders();
    },

    _onMotion(actor, event) {
        let [x, y] = event.get_coords();
        if (this._drawingRubberBand) {
            this._drawRubberBand(x, y);
            this._selectFromRubberband(x, y);
        }
    },

    _onPressButton(actor, event) {
        let button = event.get_button();
        let [x, y] = event.get_coords();
        if (button == 1) {
            Extension.desktopManager.setSelection([]);
            this._rubberBandInitialX = x;
            this._rubberBandInitialY = y;
            this._drawingRubberBand = true;
            this._drawRubberBand(x, y);

            return Clutter.EVENT_STOP;
        }

        if (button == 3) {
            this._openMenu(x, y);

            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    },

    _onReleaseButton(actor, event) {
        this.actor.grab_key_focus();

        let button = event.get_button();
        if (button == 1) {
            this._drawingRubberBand = false;
            this._rubberBand.hide();

            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    },

    _onLeave(actor, event) {
        let containerMap = this._fileItems.map(function (container) { return container._container });
        let relatedActor = event.get_related();

        if (!containerMap.includes(relatedActor) && relatedActor !== this.actor) {
            this._drawingRubberBand = false;
            this._rubberBand.hide();
        }

        return Clutter.EVENT_PROPAGATE;
    },

    _addDesktopBackgroundMenu() {
        this.actor._desktopBackgroundMenu = this._createDesktopBackgroundMenu();
        this.actor._desktopBackgroundManager = new PopupMenu.PopupMenuManager({ actor: this.actor });
        this.actor._desktopBackgroundManager.addMenu(this.actor._desktopBackgroundMenu);

        this.actor.connect('destroy', () => {
            this.actor._desktopBackgroundMenu.destroy();
            this.actor._desktopBackgroundMenu = null;
            this.actor._desktopBackgroundManager = null;
        });
    },

    getMaxColumns() {
        let workarea = Main.layoutManager.getWorkAreaForMonitor(this._monitorConstraint.index);
        return Math.ceil(workarea.width / Settings.ICON_MAX_WIDTH);
    },

    getMaxRows() {
        let workarea = Main.layoutManager.getWorkAreaForMonitor(this._monitorConstraint.index);
        return Math.ceil(workarea.height / Settings.ICON_MAX_WIDTH);
    },

    findEmptyPlace(left, top) {
        let maxRows = this.getMaxRows();
        let maxColumns = this.getMaxColumns();
        let bfsQueue = [];
        bfsQueue.push([left, top]);
        let bfsToVisit = [JSON.stringify([left, top])];
        let iterations = 0;
        while (bfsQueue.length != 0) {
            let current = bfsQueue.shift();
            let currentChild = this.layout.get_child_at(current[0], current[1]);
            if (currentChild != null &&
                (currentChild._delegate == undefined ||
                    !(currentChild._delegate instanceof FileItem.FileItem))) {
                return [currentChild, current[0], current[1]];
            }

            let adjacents = [];
            if (current[0] + 1 < maxColumns)
                adjacents.push([current[0] + 1, current[1]]);
            if (current[1] + 1 < maxRows)
                adjacents.push([current[0], current[1] + 1]);
            if (current[0] - 1 >= 0)
                adjacents.push([current[0] - 1, current[1]]);
            if (current[1] - 1 >= 0)
                adjacents.push([current[0], current[1] - 1]);

            for (let i = 0; i < adjacents.length; i++) {
                if (bfsToVisit.indexOf(JSON.stringify(adjacents[i])) < 0) {
                    bfsQueue.push(adjacents[i]);
                    bfsToVisit.push(JSON.stringify(adjacents[i]));
                }
            }
            iterations++;
        }

        return null;
    },

    acceptDrop(source, actor, x, y, time) {
        Extension.desktopManager.acceptDrop(source, actor, this, x, y, time);

        return true;
    },

    getPosOfFileItem(childToFind) {
        if (childToFind == null) {
            log('Error at getPosOfFileItem: child cannot be null');
            return [false, -1, -1];
        }

        let found = false
        let maxColumns = this.getMaxColumns();
        let maxRows = this.getMaxRows();
        let column = 0;
        let row = 0;
        for (column = 0; column < maxColumns; column++) {
            for (row = 0; row < maxRows; row++) {
                let child = this.layout.get_child_at(column, row);
                // It's used by other dragged item, so it has been destroyed
                if (child == null)
                    continue;

                if (child._delegate != undefined &&
                    child._delegate.file.get_uri() == childToFind.file.get_uri()) {
                    found = true;
                    break;
                }
            }

            if (found)
                break;
        }

        return [found, column, row];
    },
});

/*
 * https://silentmatt.com/rectangle-intersection/
 */
function rectanglesIntersect(rect1X, rect1Y, rect1Width, rect1Height,
    rect2X, rect2Y, rect2Width, rect2Height) {
    return rect1X < (rect2X + rect2Width) && (rect1X + rect1Width) > rect2X &&
        rect1Y < (rect2Y + rect2Height) && (rect1Y + rect1Height) > rect2Y
}
