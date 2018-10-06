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

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const St = imports.gi.St;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;

const Signals = imports.signals;

const Animation = imports.ui.animation;
const Background = imports.ui.background;
const DND = imports.ui.dnd;
const Main = imports.ui.main;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const DesktopGrid = Me.imports.desktopGrid;
const FileItem = Me.imports.fileItem;
const Prefs = Me.imports.prefs;
const DBusUtils = Me.imports.dbusUtils;
const DesktopIconsUtil = Me.imports.desktopIconsUtil;

const Clipboard = St.Clipboard.get_default();
const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;

function getDpy() {
    return global.screen || global.display;
}

function findMonitorIndexForPos(x, y) {
    return getDpy().get_monitor_index_for_rect(new Meta.Rectangle({x, y}));
}


var DesktopManager = class {
    constructor() {
        this._desktopDir = DesktopIconsUtil.getDesktopDir();
        this._layoutChildrenId = 0;
        this._scheduleDesktopsRefreshId = 0;
        this._monitorDesktopDir = null;
        this._desktopMonitorCancellable = null;
        this._desktopGrids = {};
        this._fileItemHandlers = new Map();
        this._fileItems = new Map();
        this._dragCancelled = false;

        this._desktopFilesRead = false;

        this._createDesktops();
        this._monitorDesktopFolder();
        this._fillFiles();

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._createDesktops());

        this._prefsChangedId = Prefs.settings.connect("changed", (s, key) => { this._settingsChanged(key); });

        this._selection = new Set();
        this._inDrag = false;
        this._dragXStart = Number.POSITIVE_INFINITY;
        this._dragYStart = Number.POSITIVE_INFINITY;
    }

    _settingsChanged(key) {
        if (key == "icon-size") {
            for(let [fileName, fileItem] of this._fileItems)
                fileItem.changedIconSize();
            this._createDesktops();
            return;
        }
        let newState = Prefs.settings.get_boolean(key);
        if (newState) {
            for(let [fileName, fileItem] of this._fileItems) {
                if (fileItem.settingsKey == key)
                    return; // it is already enabled
            }
            let fileItem;
            for (let [newFolder, extras, settingsKey] of DesktopIconsUtil.getExtraFolders()) {
                if (settingsKey == key) {
                    fileItem = this._addFile(newFolder, null, extras, settingsKey);
                    this._addToDesktopCloseTo(fileItem);
                }
            }
        } else {
            // Remove that element
            for(let [fileName, fileItem] of this._fileItems) {
                if (fileItem.settingsKey == key) {
                    this._removeFileItem(fileName);
                    break;
                }
            }
        }
    }

    _monitorDesktopFolder() {

        let desktopDir = DesktopIconsUtil.getDesktopDir();
        this._monitorDesktopDir = desktopDir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitorDesktopDir.set_rate_limit(1000);
        this._monitorDesktopDir.connect('changed', (obj, file, otherFile, eventType) => this._updateDesktopIfChanged(file, otherFile, eventType));
    }

    _removeFileItem(fileName) {
        let fileItem = this._fileItems.get(fileName);
        Object.values(this._desktopGrids).forEach(grid => {
            try {
                grid.removeFileItem(fileItem);
            } catch(e) {
            }
        });
        this._fileItems.delete(fileName);
        fileItem.actor.destroy();
    }

    _updateDesktopIfChanged (file, otherFile, eventType) {

        if (!this._desktopFilesRead) {
            // if there is a change while still reading the desktop files during bootup, try again
            this._fillFiles();
            return;
        }
        // Only get a subset of events we are interested in.
        // Note that CREATED will emit a CHANGES_DONE_HINT
        //global.log("Fichero " + file + "; otro fichero " + otherFile + "; evento "+ eventType);
        let {
            CHANGED, DELETED, CREATED, RENAMED, MOVED_IN, MOVED_OUT
        } = Gio.FileMonitorEvent;

        if (![CHANGED, DELETED, CREATED, RENAMED, MOVED_IN, MOVED_OUT].includes(eventType))
            return;

        let fileItem;
        switch(eventType) {
        case CHANGED:
            this._fileItems.get(file.get_uri()).contentChanged();
            break;
        case DELETED:
        case MOVED_OUT:
            this._removeFileItem(file.get_uri());
        break;
        case CREATED:
        case MOVED_IN:
            fileItem = this._addFile(file, null, null);
            this._addToDesktopCloseTo(fileItem);
            break;
        case RENAMED:
            fileItem = this._fileItems.get(file.get_uri());
            this._fileItems.delete(file.get_uri());
            this._fileItems.set(otherFile.get_uri(), fileItem);
            fileItem.fileRenamed(otherFile);
        break;
        }
    }

    _createDesktops() {
        // destroy the current grids
        Object.values(this._desktopGrids).forEach(grid => grid.actor.destroy());
        this._desktopGrids = {};
        // and recreate them, one for each monitor
        forEachBackgroundManager(bgManager => {
            let newGrid = new DesktopGrid.DesktopGrid(bgManager);
            newGrid.actor.connect("destroy", (actor) => {
                // if a grid loses its actor, remove it from the grid list
                for(let grid in this._desktopGrids)
                    if (this._desktopGrids[grid].actor == actor) {
                        delete this._desktopGrids[grid];
                        break;
                    }
            });
            this._desktopGrids[bgManager._monitorIndex] = newGrid;
        });
        if (this._desktopFilesRead)
            GLib.idle_add(GLib.PRIORITY_LOW, () => this._fillDesktopsWithIcons());
            // Must be done in an idle task to ensure that the grids have been created
    }

    _fillFiles() {
        if (this._desktopEnumerateCancellable)
            this._desktopEnumerateCancellable.cancel();

        this._desktopEnumerateCancellable = new Gio.Cancellable();

        let desktopDir = DesktopIconsUtil.getDesktopDir();
        desktopDir.enumerate_children_async(DesktopIconsUtil.DEFAULT_ATTRIBUTES,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            this._desktopEnumerateCancellable,
            (o, res) => {
                let fileEnum = desktopDir.enumerate_children_finish(res);
                let info;
                while ((info = fileEnum.next_file(null))) {
                    this._addFile(fileEnum.get_child(info), info, null, null);
                }
                for (let [newFolder, extras, settingsKey] of DesktopIconsUtil.getExtraFolders()) {
                    this._addFile(newFolder, null, extras, settingsKey)
                }
                this._desktopEnumerateCancellable = null;
                this._desktopFilesRead = true;
                GLib.idle_add(GLib.PRIORITY_LOW, () => this._fillDesktopsWithIcons());
                // Must be done in an idle task to ensure that the grids have been created
            }
        );
    }

    _addFile(newFile, info, type, settingsKey) {
        if (!info)
            info = newFile.query_info(DesktopIconsUtil.DEFAULT_ATTRIBUTES, Gio.FileQueryInfoFlags.NONE, this._desktopEnumerateCancellable);
        if (!type)
            type = Prefs.FILE_TYPE.NONE
        let fileItem = new FileItem.FileItem(newFile, info, type, settingsKey);
        this._fileItems.set(newFile.get_uri(), fileItem);
        this._fileItemHandlers.set(fileItem, fileItem.connect('selected', this._onFileItemSelected.bind(this)));
        return fileItem;
    }

    _fillDesktopsWithIcons() {

        for(let [fileName, fileItem] of this._fileItems) {
            if (fileItem.savedCoordinates !== null)
               this._addToDesktopCloseTo(fileItem);
        };

        for(let [fileName, fileItem] of this._fileItems) {
            if (fileItem.savedCoordinates == null)
                this._addToDesktopCloseTo(fileItem);
        };
        return GLib.SOURCE_REMOVE;
    }

    _addToDesktopCloseTo(item) {
        let [x, y] = (item.savedCoordinates == null) ? [0, 0] : item.savedCoordinates;
        let monitorIndex = findMonitorIndexForPos(x, y);
        let desktopGrid = this._desktopGrids[monitorIndex];
        try {
            desktopGrid.addFileItemCloseTo(item, x, y);
        } catch (e) {
            log(`Error adding children to desktop: ${e.message}`);
        }
    }

    _setupDnD() {
        this._draggableContainer = new St.Widget({
            visible: true,
            width: 1,
            height: 1,
            x: 0,
            y: 0,
            style_class: 'draggable'
        });
        this._draggableContainer._delegate = this;
        this._draggable = DND.makeDraggable(this._draggableContainer,
            {
                manualMode: true,
                dragActorOpacity: 100
            });

        this._draggable.connect('drag-cancelled', () => this._onDragCancelled());
        this._draggable.connect('drag-end', () => this._onDragEnd());

        this._draggable._dragActorDropped = event => this._dragActorDropped(event);
    }

    dragStart() {
        if (this._inDrag) {
            return;
        }

        this._setupDnD();
        let event = Clutter.get_current_event();
        let [x, y] = event.get_coords();
        [this._dragXStart, this._dragYStart] = event.get_coords();
        this._inDrag = true;

        for (let fileItem of this._selection) {
            let clone = new Clutter.Clone({
                source: fileItem.actor,
                reactive: false
            });
            clone.x = fileItem.actor.get_transformed_position()[0];
            clone.y = fileItem.actor.get_transformed_position()[1];
            this._draggableContainer.add_actor(clone);
        }

        Main.layoutManager.uiGroup.add_child(this._draggableContainer);
        this._draggable.startDrag(x, y, global.get_current_time(), event.get_event_sequence());
    }

    _onDragCancelled() {
        let event = Clutter.get_current_event();
        let [x, y] = event.get_coords();
        this._dragCancelled = true;
    }

    _onDragEnd() {
        this._inDrag = false;
        Main.layoutManager.uiGroup.remove_child(this._draggableContainer);
    }

    _dragActorDropped(event) {
        let [dropX, dropY] = event.get_coords();
        let target = this._draggable._dragActor.get_stage().get_actor_at_pos(Clutter.PickMode.ALL,
                                                                             dropX, dropY);

        // We call observers only once per motion with the innermost
        // target actor. If necessary, the observer can walk the
        // parent itself.
        let dropEvent = {
            dropActor: this._draggable._dragActor,
            targetActor: target,
            clutterEvent: event
        };
        for (let dragMonitor of DND.dragMonitors) {
            let dropFunc = dragMonitor.dragDrop;
            if (dropFunc)
                switch (dropFunc(dropEvent)) {
                    case DragDropResult.FAILURE:
                    case DragDropResult.SUCCESS:
                        return true;
                    case DragDropResult.CONTINUE:
                        continue;
                }
        }

        // At this point it is too late to cancel a drag by destroying
        // the actor, the fate of which is decided by acceptDrop and its
        // side-effects
        this._draggable._dragCancellable = false;

        let destroyActor = false;
        while (target) {
            if (target._delegate && target._delegate.acceptDrop) {
                let [r, targX, targY] = target.transform_stage_point(dropX, dropY);
                if (target._delegate.acceptDrop(this._draggable.actor._delegate,
                    this._draggable._dragActor,
                    targX,
                    targY,
                    event.get_time())) {
                    // If it accepted the drop without taking the actor,
                    // handle it ourselves.
                    if (this._draggable._dragActor.get_parent() == Main.uiGroup) {
                        if (this._draggable._restoreOnSuccess) {
                            this._draggable._restoreDragActor(event.get_time());
                            return true;
                        }
                        else {
                            // We need this in order to make sure drag-end is fired
                            destroyActor = true;
                        }
                    }

                    this._draggable._dragInProgress = false;
                    getDpy().set_cursor(Meta.Cursor.DEFAULT);
                    this._draggable.emit('drag-end', event.get_time(), true);
                    if (destroyActor) {
                        this._draggable._dragActor.destroy();
                    }
                    this._draggable._dragComplete();

                    return true;
                }
            }
            target = target.get_parent();
        }

        this._draggable._cancelDrag(event.get_time());

        return true;
    }

    acceptDrop(xEnd, yEnd) {
        let [xDiff, yDiff] = [xEnd - this._dragXStart, yEnd - this._dragYStart];
        let itemsToSet = new Set(this._selection);
        for (let fileItem of itemsToSet) {
            let [fileItemX, fileItemY] = fileItem.actor.get_transformed_position();
            let fileX = Math.round(xDiff + fileItemX);
            let fileY = Math.round(yDiff + fileItemY);
            fileItem.savedCoordinates = [fileX, fileY];
        }

        this._layoutDrop([...itemsToSet]);

        return true;
    }

    _layoutDrop(fileItems) {
        let itemsGridAssociation = {}

        for (let key in this._desktopGrids) {
            let itemsForDesktop = fileItems.filter(
                (x) => {
                    let [itemX, itemY] = (x.savedCoordinates == null) ? [0, 0] : x.savedCoordinates;
                    let monitorIndex = findMonitorIndexForPos(itemX, itemY);
                    return key == monitorIndex;
                }
            );
            let desktopGrid = this._desktopGrids[key];
            itemsGridAssociation[desktopGrid] = [desktopGrid, itemsForDesktop];
        }

        /* Remove all actors from their respective parents
         * so we can place them freely
         */
        for (let hashedGrid in itemsGridAssociation) {
            let [grid, fileItems] = itemsGridAssociation[hashedGrid];
            for (let item of fileItems) {
                grid.removeFileItem(item);
            }
        }

        for (let hashedGrid in itemsGridAssociation) {
            let [grid, fileItems] = itemsGridAssociation[hashedGrid];
            try {
                grid.dropItems(fileItems);
            } catch (e) {
                log(`Error while dropping: ${e.message}`);
            }
        }
    }

    doOpen() {
        for (let fileItem of this._selection)
            fileItem.doOpen();
    }

    doTrash() {
        DBusUtils.NautilusFileOperationsProxy.TrashFilesRemote([...this._selection].map((x) => { return x.file.get_uri(); }),
            (source, error) => {
                if (error)
                    throw new Error('Error trashing files on the desktop: ' + error.message);
            }
        );
    }

    doEmptyTrash() {
        DBusUtils.NautilusFileOperationsProxy.EmptyTrashRemote( (source, error) => {
            if (error)
                throw new Error('Error trashing files on the desktop: ' + error.message);
        });
    }

    _onFileItemSelected(fileItem, addToSelection) {
        if (!addToSelection && !this._inDrag)
            this.clearSelection();

        this._selection.add(fileItem);
        for(let [fileName, f] of this._fileItems)
            f.selected = this._selection.has(f);
    }

    clearSelection() {
        for(let [fileName, fileItem] of this._fileItems)
            fileItem.selected = false;

        this._selection = new Set();
    }

    _getClipboardText(isCopy) {
        let action = isCopy ? 'copy' : 'cut';
        let text = `x-special/nautilus-clipboard\n${action}\n${
            [...this._selection].map(s => s.file.get_uri()).join('\n')
        }\n`;

        return text;
    }

    doCopy() {
        Clipboard.set_text(CLIPBOARD_TYPE, this._getClipboardText(true));
    }

    doCut() {
        Clipboard.set_text(CLIPBOARD_TYPE, this._getClipboardText(false));
    }

    destroy() {
        if (this._monitorDesktopDir)
            this._monitorDesktopDir.cancel();
        this._monitorDesktopDir = null;
        if (this._scheduleDesktopsRefreshId)
            Main.layoutManager.disconnect(this._scheduleDesktopsRefreshId);
        this._scheduleDesktopsRefreshId = 0;

        if (this._monitorsChangedId)
            Main.layoutManager.disconnect(this._monitorsChangedId);
        this._monitorsChangedId = 0;
        if (this._prefsChangedId)
            Prefs.settings.disconnect(this._prefsChangedId);
        this._prefsChangedId = 0;

        Object.values(this._desktopGrids).forEach(grid => grid.actor.destroy());
        this._desktopGrids = {}
    }
};
Signals.addSignalMethods(DesktopManager.prototype);

function forEachBackgroundManager(func) {
    Main.layoutManager._bgManagers.forEach(func);
}
