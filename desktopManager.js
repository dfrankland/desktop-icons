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

const DEFAULT_ATTRIBUTES = 'metadata::*,standard::*,access::*';

function getDpy() {
    return global.screen || global.display;
}

function findMonitorIndexForPos(x, y) {
    return getDpy().get_monitor_index_for_rect(new Meta.Rectangle({x, y}));
}


var DesktopManager = class {
    constructor() {
        this._layoutChildrenId = 0;
        this._scheduleDesktopsRefreshId = 0;
        this._monitorDesktopDir = null;
        this._desktopMonitorCancellable = null;
        this._desktopGrids = {};
        this._fileItemHandlers = new Map();
        this._fileItems = [];
        this._dragCancelled = false;

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._recreateDesktopIcons());

        this._addDesktopIcons();
        this._monitorDesktopFolder();

        Prefs.settings.connect("changed", () => this._recreateDesktopIcons());

        this._selection = new Set();
        this._inDrag = false;
        this._dragXStart = Number.POSITIVE_INFINITY;
        this._dragYStart = Number.POSITIVE_INFINITY;
    }

    _recreateDesktopIcons() {
        this._destroyDesktopIcons();
        this._addDesktopIcons();
    }

    _addDesktopIcons() {
        forEachBackgroundManager(bgManager => {
            let newGrid = new DesktopGrid.DesktopGrid(bgManager);
            newGrid.actor.connect("destroy", (actor) => {
                // if a grid loses its actor, remove it from the grid list
                for(let grid in this._desktopGrids)
                    if (this._desktopGrids[grid].actor == actor) {
                        delete this._desktopGrids[grid];
                        break;
                    }
                this._recreateDesktopIcons();
            });
            this._desktopGrids[bgManager._monitorIndex] = newGrid;
        });

        this._scanFiles();
    }

    _destroyDesktopIcons() {
        Object.values(this._desktopGrids).forEach(grid => grid.actor.destroy());
        this._desktopGrids = {};
    }

    async _scanFiles() {
        for (let [fileItem, id] of this._fileItemHandlers)
            fileItem.disconnect(id);
        this._fileItemHandlers = new Map();
        this._fileItems = [];

        try {
            for (let [file, info, extra] of await this._enumerateDesktop()) {
                let fileItem = new FileItem.FileItem(file, info, extra);
                this._fileItems.push(fileItem);
                let id = fileItem.connect('selected',
                                          this._onFileItemSelected.bind(this));

                this._fileItemHandlers.set(fileItem, id);
            }
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                log(`Error loading desktop files ${e.message}`);
            return;
        }

        Object.values(this._desktopGrids).forEach(grid => {
            grid.actor.connect('allocation-changed', () => this._scheduleLayoutChildren());
        });

        this._scheduleReLayoutChildren();
    }

    _enumerateDesktop() {
        return new Promise((resolve, reject) => {
            if (this._desktopEnumerateCancellable)
                this._desktopEnumerateCancellable.cancel();

            this._desktopEnumerateCancellable = new Gio.Cancellable();

            let desktopDir = DesktopIconsUtil.getDesktopDir();
            desktopDir.enumerate_children_async(DEFAULT_ATTRIBUTES,
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                this._desktopEnumerateCancellable,
                (o, res) => {
                    try {
                        let fileEnum = desktopDir.enumerate_children_finish(res);
                        let resultGenerator = function *() {
                            let info;
                            while ((info = fileEnum.next_file(null)))
                                yield [fileEnum.get_child(info), info, Prefs.FILE_TYPE.NONE];
                            for (let [newFolder, extras] of DesktopIconsUtil.getExtraFolders()) {
                                yield [newFolder, newFolder.query_info(DEFAULT_ATTRIBUTES, Gio.FileQueryInfoFlags.NONE, this._desktopEnumerateCancellable), extras];
                            }
                        }.bind(this);
                        resolve(resultGenerator());
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    _monitorDesktopFolder() {
        if (this._monitorDesktopDir) {
            this._monitorDesktopDir.cancel();
            this._monitorDesktopDir = null;
        }

        let desktopDir = DesktopIconsUtil.getDesktopDir();
        this._monitorDesktopDir = desktopDir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitorDesktopDir.set_rate_limit(1000);
        this._monitorDesktopDir.connect('changed', (obj, file, otherFile, eventType) => this._updateDesktopIfChanged(file, otherFile, eventType));
        let trashDir = Gio.File.new_for_uri("trash:///");
        this._monitorTrashDir = trashDir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitorTrashDir.set_rate_limit(1000);
        this._monitorTrashDir.connect('changed', (obj, file, otherFile, eventType) => {
            if (Prefs.settings.get_boolean("show-trash"))
                this._updateDesktopIfChanged(file, otherFile, eventType);
        });
    }

    _updateDesktopIfChanged (file, otherFile, eventType) {

        // Rate limiting isn't enough, as one action will create different events on the same file.
        // limit by adding a timeout
        if (this._scheduleDesktopsRefreshId) {
            return;
        }
        // Only get a subset of events we are interested in.
        // Note that CREATED will emit a CHANGES_DONE_HINT
        let {
            CHANGES_DONE_HINT, DELETED, RENAMED, MOVED_IN, MOVED_OUT, CREATED
        } = Gio.FileMonitorEvent;
        if (![CHANGES_DONE_HINT, DELETED, RENAMED,
            MOVED_IN, MOVED_OUT, CREATED].includes(eventType))
            return;

        this._scheduleDesktopsRefreshId = Mainloop.timeout_add(500,
            () => this._refreshDesktops(file, otherFile));
    }

    //FIXME: we don't use file/otherfile for now and stupidely refresh all desktops
    _refreshDesktops(file, otherFile) {
        Object.values(this._desktopGrids).forEach(grid => {
            grid.actor.destroy_all_children();
        });
        this._scheduleDesktopsRefreshId = 0;
        // TODO: handle DND, opened filecontainer menu…

        this._scanFiles();
        return false;
    }

    _getContainerWithChild(child) {
        let monitorIndex = Main.layoutManager.findIndexForActor(child);
        let desktopGrid = this._desktopGrids[monitorIndex];
        let children = desktopGrid.actor.get_children();

        if (children.some(x => x.child == child))
            return desktopGrid;
        else
            throw new Error("Missmatch between expected items in a desktop grid not found");
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
        let savedCoordinates = new Map();
        /* Remove all items before dropping new ones, so we can freely reposition
         * them.
         */
        for (let key in this._desktopGrids) {
            for (let item of this._selection) {
                let [itemX, itemY] = (item.savedCoordinates == null) ? [0, 0] : item.savedCoordinates;
                let monitorIndex = findMonitorIndexForPos(itemX, itemY);
                if (key == monitorIndex) {
                    savedCoordinates.set(item, item.actor.get_transformed_position());
                    this._desktopGrids[key].removeFileItem(item);
                }
            }
        }

        let [xDiff, yDiff] = [xEnd - this._dragXStart, yEnd - this._dragYStart];
        /* Set the new ideal position where the item drop should happen */
        for (let fileItem of this._selection) {
            let [fileItemX, fileItemY] = savedCoordinates.get(fileItem);
            let fileX = Math.round(xDiff + fileItemX);
            let fileY = Math.round(yDiff + fileItemY);
            fileItem.savedCoordinates = [fileX, fileY];
        }

        for (let key in this._desktopGrids) {
            /* Create list of items to drop per desktop. We want to drop them at
             * once so calculations for the dropping per grid are smoother
             */
            let itemsForDropDesktop = [...this._selection].filter(
                (x) => {
                    let [itemX, itemY] = (x.savedCoordinates == null) ? [0, 0] : x.savedCoordinates;
                    let monitorIndex = findMonitorIndexForPos(itemX, itemY);
                    return key == monitorIndex;
                }
            );

            this._desktopGrids[key].dropItems(itemsForDropDesktop);
        }

        return true;
    }

    _scheduleLayoutChildren() {
        if (this._layoutChildrenId != 0)
            return;

        this._layoutChildrenId = GLib.idle_add(GLib.PRIORITY_LOW, () => this._layoutChildren());
    }

    _scheduleReLayoutChildren() {
        if (this._layoutChildrenId != 0)
            return;

        Object.values(this._desktopGrids).forEach((grid) => grid.reset());

        this._layoutChildrenId = GLib.idle_add(GLib.PRIORITY_LOW, () => this._layoutChildren());
    }

    _addFileItemCloseTo(item) {
        let [x, y] = (item.savedCoordinates == null) ? [0, 0] : item.savedCoordinates;
        let monitorIndex = findMonitorIndexForPos(x, y);
        let desktopGrid = this._desktopGrids[monitorIndex];
        try {
            desktopGrid.addFileItemCloseTo(item, x, y);
        } catch (e) {
            log(`Error adding children to desktop: ${e.message}`);
        }
    }

    _layoutChildren() {
        /*
         * Paint the icons in two passes:
         * * first pass paints those that have their coordinates defined in the metadata
         * * second pass paints those new files that still don't have their definitive coordinates
         */
        for (let fileItem of this._fileItems) {
            if (fileItem.savedCoordinates == null)
                continue;
            this._addFileItemCloseTo(fileItem);
        }

        for (let fileItem of this._fileItems) {
            if (fileItem.savedCoordinates !== null)
                continue;
            this._addFileItemCloseTo(fileItem);
        }

        this._layoutChildrenId = 0;
        return GLib.SOURCE_REMOVE;
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
        this._fileItems.forEach(f => f.selected = this._selection.has(f));
    }

    clearSelection() {
        for (let fileItem of this._fileItems) {
            fileItem.selected = false;
        }

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
            GLib.source_remove(this._scheduleDesktopsRefreshId);
        this._scheduleDesktopsRefreshId = 0;

        if (this._monitorsChangedId)
            Main.layoutManager.disconnect(this._monitorsChangedId);
        this._monitorsChangedId = 0;

        Object.values(this._desktopGrids).forEach(grid => grid.actor.destroy());
        this._desktopGrids = {}
    }
};
Signals.addSignalMethods(DesktopManager.prototype);

function forEachBackgroundManager(func) {
    Main.layoutManager._bgManagers.forEach(func);
}
