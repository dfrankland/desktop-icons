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
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;

const Signals = imports.signals;

const Animation = imports.ui.animation;
const Background = imports.ui.background;
const DND = imports.ui.dnd;
const Main = imports.ui.main;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const DesktopContainer = Me.imports.desktopContainer;
const FileItem = Me.imports.fileItem;
const Settings = Me.imports.settings;
const DBusUtils = Me.imports.dbusUtils;

const Clipboard = St.Clipboard.get_default();
const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;


var DesktopManager = new Lang.Class(
{
    Name: 'DesktopManager',

    _init() {
        this._layoutChildrenId = 0;
        this._scheduleDesktopsRefreshId = 0
        this._monitorDesktopDir = null;
        this._desktopMonitorCancellable = null;
        this._desktopContainers = [];
        this._dragCancelled = false;

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._addDesktopIcons());
        this._startupPreparedId = Main.layoutManager.connect('startup-prepared', () => this._addDesktopIcons());

        this.connect('new-file-set', () => this._scheduleReLayoutChildren());

        this._addDesktopIcons();
        this._monitorDesktopFolder();

        this._selection = [];
        this._onDrag = false;
        this._dragXStart = Number.POSITIVE_INFINITY;
        this._dragYStart = Number.POSITIVE_INFINITY;
        this._setMetadataCancellable = new Gio.Cancellable();
    },

    _addDesktopIcons() {
        this._destroyDesktopIcons();
        forEachBackgroundManager(bgManager => {
            this._desktopContainers.push(new DesktopContainer.DesktopContainer(bgManager));
        });

        this._scanFiles();
    },

    _destroyDesktopIcons() {
        this._desktopContainers.forEach((l) => l.actor.destroy());
        this._desktopContainers = [];
    },

    _scanFiles() {
        this._fileItems = [];
        if (this._desktopEnumerateCancellable)
            this._desktopEnumerateCancellable.cancel();

        this._desktopEnumerateCancellable = new Gio.Cancellable();
        let desktopPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP);
        let desktopDir = Gio.File.new_for_commandline_arg(desktopPath);
        desktopDir.enumerate_children_async('metadata::*,standard::*,access::*',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            this._desktopEnumerateCancellable,
            (source, res) => this._onDesktopEnumerateChildrenFinished(source, res));
    },

    _onDesktopEnumerateChildrenFinished(source, res) {
        let fileEnum;
        try {
            fileEnum = source.enumerate_children_finish(res);
        } catch (error) {
            if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                return;
            } else {
                log('Error loading Desktop files');
                return;
            }
        }

        let info;
        while ((info = fileEnum.next_file(null))) {
            let file = fileEnum.get_child(info);
            let fileItem = new FileItem.FileItem(file, info);
            this._fileItems.push(fileItem);
        }

        this._desktopContainers.forEach((item, index) => {
            item.actor.connect('allocation-changed', () => this._scheduleLayoutChildren());
        });
        this.emit('new-file-set');
    },


    _monitorDesktopFolder() {
        if (this._monitorDesktopDir) {
            this._monitorDesktopDir.cancel();
            this._monitorDesktopDir = null;
        }

        let desktopPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP);
        let desktopDir = Gio.File.new_for_path(desktopPath);

        this._monitorDesktopDir = desktopDir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitorDesktopDir.set_rate_limit(1000);
        this._monitorDesktopDir.connect('changed',
            (obj, file, otherFile, eventType) => {
                // Rate limiting isn't enough, as one action will create different events on the same file.
                // limit by adding a timeout
                if (this._scheduleDesktopsRefreshId) {
                    return;
                }
                // Only get a subset of events we are interested in.
                // Note that CREATED will emit a CHANGES_DONE_HINT
                if (eventType != Gio.FileMonitorEvent.CHANGES_DONE_HINT &&
                    eventType != Gio.FileMonitorEvent.DELETED && eventType != Gio.FileMonitorEvent.RENAMED &&
                    eventType != Gio.FileMonitorEvent.MOVED_IN && eventType != Gio.FileMonitorEvent.MOVED_OUT) {
                    return;
                }
                this._scheduleDesktopsRefreshId = Mainloop.timeout_add(500,
                    () => this._refreshDesktops(file, otherFile));
            });
    },

    //FIXME: we don't use file/otherfile for now and stupidely refresh all desktops
    _refreshDesktops(file, otherFile) {
        this._scheduleDesktopsRefreshId = 0;
        // TODO: handle DND, opened filecontainer menu…

        this._scanFiles();
    },

    _getContainerWithChild(child) {
        for (let i = 0; i < this._desktopContainers.length; i++) {
            let children = this._desktopContainers[i].actor.get_children();

            if (children.indexOf(child) != -1) {
                return this._desktopContainers[i];
            }
        }

        return null;
    },

    _setupDnD() {
        this._draggableContainer = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            visible: true,
            width: 1,
            height: 1,
            x: 0,
            y: 0,
            style_class: 'dragabble'
        });
        this._draggableContainer._delegate = this;
        this._draggable = DND.makeDraggable(this._draggableContainer,
            {
                manualMode: true,
                dragActorOpacity: 100
            });

        this._draggable.connect('drag-cancelled', () => this._onDragCancelled());
        this._draggable.connect('drag-end', () => this._onDragEnd());

        this._draggable['_dragActorDropped'] = event => this._dragActorDropped(event);
        this._draggable['_finishAnimation'] = () => this._finishAnimation();
    },

    dragStart() {
        if (this._onDrag) {
            return;
        }

        this._setupDnD();
        let event = Clutter.get_current_event();
        let [x, y] = event.get_coords();
        [this._dragXStart, this._dragYStart] = event.get_coords();
        this._onDrag = true;

        for (let i = 0; i < this._selection.length; i++) {
            let fileItem = this._selection[i];
            let clone = new Clutter.Clone({
                source: this._selection[i].actor,
                reactive: false
            });
            clone.x = this._selection[i].actor.get_transformed_position()[0];
            clone.y = this._selection[i].actor.get_transformed_position()[1];
            this._draggableContainer.add_actor(clone);
        }

        let desktopContainer = this._getContainerWithChild(this._selection[0].actor);
        if (desktopContainer == null) {
            log('Error in DnD searching for the container of the dragged item');
            return;
        }

        Main.layoutManager.uiGroup.add_child(this._draggableContainer);
        this._draggable.startDrag(x, y, global.get_current_time(), event.get_event_sequence());
    },

    _onDragCancelled() {
        let event = Clutter.get_current_event();
        let [x, y] = event.get_coords();
        this._dragCancelled = true;
    },

    _onDragEnd() {
        this._onDrag = false;
        Main.layoutManager.uiGroup.remove_child(this._draggableContainer);
    },

    _finishAnimation() {
        if (!this._draggable._animationInProgress) {
            return;
        }

        this._draggable._animationInProgress = false;
        if (!this._draggable._buttonDown) {
            this._draggable._dragComplete();
        }

        global.screen.set_cursor(Meta.Cursor.DEFAULT);
    },

    _dragActorDropped(event) {
        let [dropX, dropY] = event.get_coords();
        let target = this._draggable._dragActor.get_stage().get_actor_at_pos(Clutter.PickMode.ALL,
            dropX, dropY);

        // We call observers only once per motion with the innermost
        // target actor. If necessary, the observer can walk the
        // parent itself.
        let dropEvent =
        {
            dropActor: this._draggable._dragActor,
            targetActor: target,
            clutterEvent: event
        };
        for (let i = 0; i < DND.dragMonitors.length; i++) {
            let dropFunc = DND.dragMonitors[i].dragDrop;
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
                    global.screen.set_cursor(Meta.Cursor.DEFAULT);
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
    },

    acceptDrop(dragSource, actor, target, xEnd, yEnd, time) {
        let [xDiff, yDiff] = [xEnd - this._dragXStart, yEnd - this._dragYStart];
        this._setMetadataCancellable.cancel();
        this._setMetadataCancellable = new Gio.Cancellable();
        let itemsToSet = this._selection.slice(0);
        let itemsCount = 0;
        for (let k = 0; k < itemsToSet.length; k++) {
            let fileItem = this._selection[k];
            let info = new Gio.FileInfo();
            let [fileItemX, fileItemY] = fileItem.actor.get_transformed_position();
            let fileX = Math.round(xDiff + fileItemX);
            let fileY = Math.round(yDiff + fileItemY);
            fileItem.setCoordinates(fileX, fileY);
            info.set_attribute_string('metadata::nautilus-icon-position',
                fileX.toString().concat(',').concat(fileY.toString()));
            let gioFile = Gio.File.new_for_uri(fileItem.file.get_uri());
            gioFile.set_attributes_async(info,
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                this._setMetadataCancellable,
                (source, result) => {
                    this._onSetMetadataFileFinished(source, result);
                    itemsCount++;
                    if (itemsCount == itemsToSet.length) {
                        this._layoutDrop(itemsToSet);
                    }
                }
            );
        }

        return true;
    },

    _layoutDrop(fileItems) {
        let fileItemDestinations = [];
        /* TODO: We should optimize this... */
        for (let i = 0; i < fileItems.length; i++) {
            let fileItem = fileItems[i];
            for (let j = 0; j < this._desktopContainers.length; j++) {
                let desktopContainerOrig = this._desktopContainers[j];
                let [found, leftOrig, topOrig] = desktopContainerOrig.getPosOfFileItem(fileItem);

                if (!found) {
                    continue;
                }

                let [containerX, containerY] = fileItem.getCoordinates();
                let [placeholder, dropDesktopContainer, left, top] = this._getClosestChildToPos(containerX, containerY);
                if (placeholder._delegate != undefined &&
                    placeholder._delegate instanceof FileItem.FileItem) {
                    if (fileItem.file.get_uri() == placeholder._delegate.file.get_uri()) {
                        /* Dropping in the same place as it was, so do nothing. */
                    }
                    else if (fileItems.filter(w => w.file.get_uri() ==
                        placeholder._delegate.file.get_uri())
                        .length > 0) {
                        /* Dropping were another dragged item is placed, nothing
                            * to do except check if there is any collision
                            */

                        let collision = fileItemDestinations.filter(w =>
                            (w[0] == dropDesktopContainer &&
                                w[2] == left &&
                                w[3] == top));
                        if (collision.length > 0) {
                            log('Error: Cannot place file, collision with\
                                one of the dragged items '
                                + placeholder._delegate.file.get_uri() +
                                ' ' + left + ' ' + top);
                            break;
                        }
                    }
                    else {
                        /* Dropping were another item is placed, need to search
                            * for an empty space close by
                            */

                        let result = dropDesktopContainer.findEmptyPlace(left, top);
                        if (result == null) {
                            log('Error: No empty space in the desktop for another icon');
                            break;
                        }
                        placeholder = result[0];
                        left = result[1];
                        top = result[2];

                        /* If a dragged item has been assigned the same
                            * position as this one means we have a colision,
                            * either the items were dragged out of the screen
                            * and they are trying to fill the same position
                            * on-screen or a resolution for collision in the
                            * past assigned this place already.
                            */
                        let collision = fileItemDestinations.filter(w =>
                            (w[0] == dropDesktopContainer &&
                                w[2] == left &&
                                w[3] == top));
                        if (collision.length > 0) {
                            log('Error: Cannot place file, collision with\
                                one of the dragged items when searching \
                                for an empty place ' + placeholder._delegate.file.get_uri() +
                                ' ' + left + ' ' + top);
                            break;
                        }

                        placeholder.destroy();
                    }
                }
                else {
                    placeholder.destroy();
                }
                fileItemDestinations.push([dropDesktopContainer, fileItem, left, top]);
                break;
            }
        }

        /* First remove all from the desktop containers to avoid collisions */
        for (let i = 0; i < fileItemDestinations.length; i++) {
            let [desktopContainer, fileItem, left, top] = fileItemDestinations[i];
            desktopContainer.removeFileItem(fileItem);
        }

        /* Place them in the appropriate places */
        for (let i = 0; i < fileItemDestinations.length; i++) {
            let [desktopContainer, fileItem, left, top] = fileItemDestinations[i];
            desktopContainer.addFileItem(fileItem, left, top);
        }

        /* Fill the empty places with placeholders */
        for (let i = 0; i < this._desktopContainers.length; i++) {
            let desktopContainer = this._desktopContainers[i];

            let maxColumns = desktopContainer.getMaxColumns();
            let maxRows = desktopContainer.getMaxRows();
            for (let column = 0; column < maxColumns; column++) {
                for (let row = 0; row < maxRows; row++) {
                    let child = desktopContainer.layout.get_child_at(column, row);
                    if (child == null) {
                        let newPlaceholder = new St.Bin({ width: Settings.ICON_MAX_WIDTH, height: Settings.ICON_MAX_WIDTH });
                        /* DEBUG
                        let icon = new St.Icon({ icon_name: 'window-restore-symbolic' });
                        newPlaceholder.add_actor(icon);
                        */
                        desktopContainer.layout.attach(newPlaceholder, column, row, 1, 1);
                    }
                }
            }
        }
    },

    _onSetMetadataFileFinished(source, result) {
        try {
            let [success, info] = source.set_attributes_finish(result);
        }
        catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                log('Error setting metadata to desktop files ', error);
        }
    },

    _getClosestChildToPos(x, y) {
        let minDistance = Number.POSITIVE_INFINITY;
        let closestChild = null;
        let closestDesktopContainer = null;
        let left = 0;
        let top = 0;
        for (let k = 0; k < this._desktopContainers.length; k++) {
            let desktopContainer = this._desktopContainers[k];

            let maxColumns = desktopContainer.getMaxColumns();
            let maxRows = desktopContainer.getMaxRows();
            for (let column = 0; column < maxColumns; column++) {
                for (let row = 0; row < maxRows; row++) {
                    let child = desktopContainer.layout.get_child_at(column, row);
                    // It's used by other dragged item, so it has been destroyed
                    if (child == null)
                        continue;

                    let [proposedX, proposedY] = child.get_transformed_position();
                    let distance = distanceBetweenPoints(proposedX, proposedY, x, y);
                    if (distance < minDistance) {
                        closestChild = child;
                        minDistance = distance;
                        closestDesktopContainer = desktopContainer;
                        left = column;
                        top = row;
                    }
                }
            }
        }

        return [closestChild, closestDesktopContainer, left, top];
    },

    _scheduleLayoutChildren() {
        if (this._layoutChildrenId != 0)
            GLib.source_remove(this._layoutChildrenId);

        this._layoutChildrenId = GLib.idle_add(GLib.PRIORITY_LOW, () => this._layoutChildren());
    },

    _scheduleReLayoutChildren() {
        if (this._layoutChildrenId != 0)
            GLib.source_remove(this._layoutChildrenId);

        for (let i = 0; i < this._desktopContainers.length; i++) {
            let desktopContainer = this._desktopContainers[i];
            desktopContainer.reset();
        }

        this._layoutChildrenId = GLib.idle_add(GLib.PRIORITY_LOW, () => this._relayoutChildren());
    },


    _relayoutChildren() {
        this._layoutChildren();
    },

    _layoutChildren() {
        for (let i = 0; i < this._fileItems.length; i++) {
            let fileItem = this._fileItems[i];
            if (fileItem.actor.visible) {
                let [containerX, containerY] = fileItem.getCoordinates();
                let result = this._getClosestChildToPos(containerX, containerY);
                let placeholder = result[0];
                let desktopContainer = result[1];
                let left = result[2];
                let top = result[3];
                if (placeholder._delegate != undefined && placeholder._delegate instanceof FileItem.FileItem) {
                    result = desktopContainer.findEmptyPlace(left, top);
                    if (result == null) {
                        log('WARNING: No empty space in the desktop for another icon');
                        this._layoutChildrenId = 0;
                        return GLib.SOURCE_REMOVE;
                    }
                    placeholder = result[0];
                    left = result[1];
                    top = result[2];
                }
                placeholder.destroy();
                desktopContainer.addFileItem(fileItem, left, top);
            }
        }

        this._layoutChildrenId = 0;
        return GLib.SOURCE_REMOVE;
    },

    _findByFile(fileItem, uri) {
        return fileItem.file.get_uri() == uri;
    },

    doOpen() {
        for (let i = 0; i < this._selection.length; i++)
            this._selection[i].doOpen();
    },

    doTrash() {
        DBusUtils.NautilusFileOperationsProxy.TrashFilesRemote(this._selection.map((x) => { return x.file.get_uri(); }),
            (source, error) => {
                if (error)
                    log('Error trashing files on the desktop: ' + error.message);
            }
        );
    },

    fileLeftClickPressed(fileItem) {
        let event = Clutter.get_current_event();
        let event_state = event.get_state();
        let selection = []

        let desktopContainer = this._getContainerWithChild(fileItem.actor);
        if (desktopContainer == null) {
            log('Error in left click pressed, child not found');
            return;
        }
        desktopContainer.actor.grab_key_focus();
        // In this case we just do nothing because it could be the start of a drag.
        let alreadySelected = this._selection.find(x => x.file.get_uri() == fileItem.file.get_uri()) != null;
        if (alreadySelected)
            return;

        if (event_state & Clutter.ModifierType.SHIFT_MASK)
            selection = this._selection;

        selection.push(fileItem);
        this.setSelection(selection);
    },

    fileLeftClickReleased(fileItem) {
        let event = Clutter.get_current_event();
        let event_state = event.get_state();
        if (!this._onDrag && !(event_state & Clutter.ModifierType.SHIFT_MASK)) {
            this.setSelection([this._selection[this._selection.length - 1]]);
        }
    },

    fileRightClickClicked(fileItem) {
        if (fileItem == null) {
            this.setSelection([]);

            return;
        }

        if (this._selection.map((x) => { return x.file.get_uri(); }).indexOf(fileItem.file.get_uri()) < 0)
            this.setSelection([fileItem]);
    },

    setSelection(selection) {
        for (let i = 0; i < this._fileItems.length; i++) {
            let fileItem = this._fileItems[i];
            fileItem.setSelected(selection.map((x) => { return x.file.get_uri(); }).indexOf(fileItem.file.get_uri()) >= 0);
        }

        this._selection = selection;
    },

    doCopy() {
        let nautilusClipboard = 'x-special/nautilus-clipboard\n';
        nautilusClipboard += 'copy\n';
        for (let i = 0; i < this._selection.length; i++)
            nautilusClipboard += this._selection[i].file.get_uri() + '\n';

        Clipboard.set_text(CLIPBOARD_TYPE, nautilusClipboard);
    },

    doCut() {
        let nautilusClipboard = 'x-special/nautilus-clipboard\n';
        nautilusClipboard += 'cut\n';
        for (let i = 0; i < this._selection.length; i++)
            nautilusClipboard += this._selection[i].file.get_uri() + '\n';

        Clipboard.set_text(CLIPBOARD_TYPE, nautilusClipboard);
    },

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

        if (this._startupPreparedId)
            Main.layoutManager.disconnect(this._startupPreparedId);
        this._startupPreparedId = 0;

        this._desktopContainers.forEach(w => w.actor.destroy());
    }
});
Signals.addSignalMethods(DesktopManager.prototype);

function distanceBetweenPoints(x, y, x2, y2) {
    return Math.sqrt(Math.pow(x - x2, 2) + Math.pow(y - y2, 2));
}

function forEachBackgroundManager(func) {
    Main.layoutManager._bgManagers.forEach(func);
}
