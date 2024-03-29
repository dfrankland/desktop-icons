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
const Pango = imports.gi.Pango;
const Meta = imports.gi.Meta;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Cogl = imports.gi.Cogl;
const GnomeDesktop = imports.gi.GnomeDesktop;

const Mainloop = imports.mainloop;
const Signals = imports.signals;

const Background = imports.ui.background;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Extension = Me.imports.extension;
const Prefs = Me.imports.prefs;
const DBusUtils = Me.imports.dbusUtils;
const DesktopIconsUtil = Me.imports.desktopIconsUtil;

const Gettext = imports.gettext;

Gettext.textdomain("desktop-icons");
Gettext.bindtextdomain("desktop-icons", ExtensionUtils.getCurrentExtension().path + "/locale");

const _ = Gettext.gettext;

const DRAG_TRESHOLD = 8;

var State = {
    NORMAL: 0,
    GONE: 1,
};

var FileItem = class {

    constructor(file, fileInfo, fileExtra) {
        this._fileExtra = fileExtra;
        this._loadThumbnailDataCancellable = null;
        this._thumbnailScriptWatch = 0;
        this._setMetadataCancellable = null;

        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        this._file = file;
        this._fileInfo = fileInfo;
        let savedCoordinates = fileInfo.get_attribute_as_string('metadata::nautilus-icon-position');

        if (savedCoordinates != null)
            this._savedCoordinates = savedCoordinates.split(',').map(x => Number(x));
        else
            this._savedCoordinates = null;

        this._attributeCanExecute = fileInfo.get_attribute_boolean('access::can-execute');
        this._fileType = fileInfo.get_file_type();
        this._isDirectory = this._fileType == Gio.FileType.DIRECTORY;
        this._isSpecial = this._fileExtra != Prefs.FILE_TYPE.NONE;
        this._attributeContentType = fileInfo.get_content_type();
        this._isDesktopFile = this._attributeContentType == 'application/x-desktop';
        this._attributeHidden = fileInfo.get_is_hidden();
        this._isSymlink = fileInfo.get_is_symlink();
        this._fileUri = this._file.get_uri();
        this._filePath = this._file.get_path();
        this._modifiedTime = this._fileInfo.get_attribute_uint64("time::modified");
        this._state = State.NORMAL;
        this._displayName = fileInfo.get_attribute_as_string('standard::display-name');

        this.actor = new St.Bin({ visible: true });
        this.actor.set_fill(true, true);
        this.actor.set_height(Prefs.get_desired_height(scaleFactor));
        this.actor.set_width(Prefs.get_desired_width(scaleFactor));
        this.actor._delegate = this;

        this._container = new St.BoxLayout({ reactive: true,
                                             track_hover: true,
                                             can_focus: true,
                                             style_class: 'file-item',
                                             x_expand: true,
                                             y_expand: true,
                                             x_align: Clutter.ActorAlign.FILL,
                                             vertical: true });
        this.actor.add_actor(this._container);
        this._icon = new St.Bin();
        this._icon.set_height(Prefs.get_icon_size() * scaleFactor);

        this._iconContainer = new St.Bin({ visible: true });
        this._iconContainer.child = this._icon;
        this._container.add_actor(this._iconContainer);

        this._label = new St.Label({
            text: this._displayName,
            style_class: 'name-label'
        });

        if (this._isDesktopFile)
            this._desktopFile = Gio.DesktopAppInfo.new_from_filename(this._file.get_path());

        this._updateIcon();

        this._container.add_actor(this._label);
        let clutterText = this._label.get_clutter_text();
        /* TODO: Convert to gobject.set for 3.30 */
        clutterText.set_line_wrap(true);
        clutterText.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        clutterText.set_ellipsize(Pango.EllipsizeMode.END);

        this._container.connect('button-press-event', (actor, event) => this._onPressButton(actor, event));
        this._container.connect('motion-event', (actor, event) => this._onMotion(actor, event));
        this._container.connect('leave-event', (actor, event) => this._onLeave(actor, event));
        this._container.connect('button-release-event', (actor, event) => this._onReleaseButton(actor, event));

        this._createMenu();

        this._isSelected = false;
        this._primaryButtonPressed = false;
        if (this._attributeCanExecute && !this._isDesktopFile)
            this._execLine = this.file.get_path();
        if (fileExtra == Prefs.FILE_TYPE.USER_DIRECTORY_TRASH) {
            // if this icon is the trash, monitor the state of the directory to update the icon
            this._trashChanged = false;
            this._trashInitializeCancellable = null;
            this._scheduleTrashRefreshId = 0;
            this._monitorTrashDir = this._file.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitorTrashId = this._monitorTrashDir.connect('changed', (obj, file, otherFile, eventType) => {
                switch(eventType) {
                    case Gio.FileMonitorEvent.DELETED:
                    case Gio.FileMonitorEvent.MOVED_OUT:
                    case Gio.FileMonitorEvent.CREATED:
                    case Gio.FileMonitorEvent.MOVED_IN:
                        if (this._queryTrashInfoCancellable || this._scheduleTrashRefreshId) {
                            if (this._scheduleTrashRefreshId)
                                GLib.source_remove(this._scheduleTrashRefreshId);
                            this._scheduleTrashRefreshId = Mainloop.timeout_add(200, () => this._refreshTrashIcon());
                        } else {
                            this._refreshTrashIcon()
                        }
                    break;
                }
            });
        }
        this.actor.connect("destroy", () => this._onDestroy());
    }

    _onDestroy() {
        /* Regular file data */
        if (this._setMetadataCancellable)
            this._setMetadataCancellable.cancel();

        /* Thumbnailing */
        if (this._thumbnailScriptWatch)
            GLib.source_remove(this._thumbnailScriptWatch);
        if (this._loadThumbnailDataCancellable)
            this._loadThumbnailDataCancellable.cancel();

        /* Trash */
        if (this._monitorTrashDirId)
            this._monitorTrashDir.disconnect(this._monitorTrashId);
        if (this._queryTrashInfoCancellable)
            this._queryTrashInfoCancellable.cancel();
        if (this._scheduleTrashRefreshId)
            GLib.source_remove(this._scheduleTrashRefreshId);
    }

    _updateIcon() {
        if (this._fileExtra == Prefs.FILE_TYPE.USER_DIRECTORY_TRASH) {
            this._icon.child = this._createEmblemedStIcon(this._fileInfo.get_icon(), null);
            return;
        }

        let thumbnailFactory = GnomeDesktop.DesktopThumbnailFactory.new(GnomeDesktop.DesktopThumbnailSize.LARGE);
        if (thumbnailFactory.can_thumbnail(this._fileUri,
                                           this._attributeContentType,
                                           this._modifiedTime)) {
            let thumbnail = thumbnailFactory.lookup(this._fileUri, this._modifiedTime);
            if (thumbnail == null) {
                if (!thumbnailFactory.has_valid_failed_thumbnail(this._fileUri,
                                                                 this._modifiedTime)) {
                    let argv = [];
                    argv.push(GLib.build_filenamev([ExtensionUtils.getCurrentExtension().path,
                                                   "createThumbnail.js"]));
                    argv.push(this._filePath);
                    let [success, pid] = GLib.spawn_async(null, argv, null,
                                                          GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD, null);
                    if (this._thumbnailScriptWatch)
                        GLib.source_remove(this._thumbnailScriptWatch);
                    this._thumbnailScriptWatch = GLib.child_watch_add(GLib.PRIORITY_DEFAULT,
                                                                      pid,
                        (pid, exitCode) => {
                            if (exitCode == 0)
                                this._updateIcon();
                            else
                                global.log("Failed to generate thumbnail for " + this._filePath);
                            GLib.spawn_close_pid(pid);
                            return false;
                        }
                    );
                }
            } else {
                if (this._loadThumbnailDataCancellable)
                    this._loadThumbnailDataCancellable.cancel();
                this._loadThumbnailDataCancellable = new Gio.Cancellable();
                let thumbnailFile = Gio.File.new_for_path(thumbnail);
                thumbnailFile.load_bytes_async(this._loadThumbnailDataCancellable,
                    (obj, res) => {
                        try {
                            let [thumbnailData, etag_out] = obj.load_bytes_finish(res);
                            let thumbnailStream = Gio.MemoryInputStream.new_from_bytes(thumbnailData);
                            let thumbnailPixbuf = GdkPixbuf.Pixbuf.new_from_stream(thumbnailStream, null);

                            if (thumbnailPixbuf != null) {
                                let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                                let thumbnailImage = new Clutter.Image();
                                thumbnailImage.set_data(thumbnailPixbuf.get_pixels(),
                                                        thumbnailPixbuf.has_alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                                                        thumbnailPixbuf.width,
                                                        thumbnailPixbuf.height,
                                                        thumbnailPixbuf.rowstride
                                );
                                let icon = new Clutter.Actor();
                                icon.set_content(thumbnailImage);
                                let width = Prefs.get_desired_width(scaleFactor);
                                let height = Prefs.get_icon_size() * scaleFactor;
                                let aspectRatio = thumbnailPixbuf.width / thumbnailPixbuf.height;
                                if ((width / height) > aspectRatio)
                                    icon.set_size(height * aspectRatio, height);
                                else
                                    icon.set_size(width, width / aspectRatio);
                                this._icon.child = icon;
                            }
                        } catch (error) {
                            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                                global.log("Error while loading thumbnail: " + error);
                                this._icon.child = this._createEmblemedStIcon(this._fileInfo.get_icon(), null);
                            }
                        }
                    }
                );
            }
        }

        if (this._isDesktopFile && this._desktopFile.has_key("Icon"))
            this._icon.child = this._createEmblemedStIcon(null, this._desktopFile.get_string('Icon'));
        else
            this._icon.child = this._createEmblemedStIcon(this._fileInfo.get_icon(), null);
        }

    _refreshTrashIcon() {
        if (this._queryTrashInfoCancellable)
            this._queryTrashInfoCancellable.cancel();
        this._queryTrashInfoCancellable = new Gio.Cancellable();

        this._file.query_info_async(DesktopIconsUtil.DEFAULT_ATTRIBUTES,
                                    Gio.FileQueryInfoFlags.NONE,
                                    GLib.PRIORITY_DEFAULT,
                                    this._queryTrashInfoCancellable,
            (source, res) => {
                try {
                    this._fileInfo = source.query_info_finish(res);
                    this._queryTrashInfoCancellable = null;
                    this._updateIcon();
                } catch(error) {
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        global.log("Error getting the number of files in the trash: " + error);
                }
            });

        this._scheduleTrashRefreshId = 0;
        return false;
    }

    get file() {
        return this._file;
    }

    _createEmblemedStIcon(icon, iconName) {

        if (icon == null) {
            if (GLib.path_is_absolute(iconName)) {
                let iconFile = Gio.File.new_for_commandline_arg(iconName);
                icon = new Gio.FileIcon({ file: iconFile });
            } else {
                icon = Gio.ThemedIcon.new_with_default_fallbacks(iconName);
            }
        }
        let itemIcon = Gio.EmblemedIcon.new(icon, null);
        if (this._isSymlink)
            itemIcon.add_emblem(Gio.Emblem.new(Gio.ThemedIcon.new("emblem-symbolic-link")));

        return new St.Icon({ gicon: itemIcon,
                             icon_size: Prefs.get_icon_size()
        });
    }

    doRename() {
        this.emit('rename-clicked');
    }

    doOpen() {
        if (this._attributeCanExecute && !this._isDirectory) {
            if (this._isDesktopFile) {
                this._desktopFile.launch_uris_as_manager([], null, GLib.SpawnFlags.SEARCH_PATH, null, null);
                return;
            }

            if (!this._execLine)
                return;

            Util.spawnCommandLine(this._execLine);
            return;
        }

        Gio.AppInfo.launch_default_for_uri_async(this.file.get_uri(),
            null, null,
            (source, res) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(res);
                } catch (e) {
                    log('Error opening file ' + this.file.get_uri() + ': ' + e.message);
                }
            }
        );
    }

    _onCopyClicked() {
        Extension.desktopManager.doCopy();
    }

    _onCutClicked() {
        Extension.desktopManager.doCut();
    }

    _onShowInFilesClicked() {

        DBusUtils.FreeDesktopFileManagerProxy.ShowItemsRemote([this.file.get_uri()], '',
            (result, error) => {
                if (error)
                    log('Error showing file on desktop: ' + error.message);
            }
        );
    }

    _onPropertiesClicked() {

        DBusUtils.FreeDesktopFileManagerProxy.ShowItemPropertiesRemote([this.file.get_uri()], '',
            (result, error) => {
                if (error)
                    log('Error showing properties: ' + error.message);
            }
        );
    }

    _onMoveToTrashClicked() {
        Extension.desktopManager.doTrash();
    }

    _onEmptyTrashClicked() {
        Extension.desktopManager.doEmptyTrash();
    }

    _createMenu() {
        this._menuManager = new PopupMenu.PopupMenuManager({ actor: this.actor });
        let side = St.Side.LEFT;
        if (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL)
            side = St.Side.RIGHT;
        this._menu = new PopupMenu.PopupMenu(this.actor, 0.5, side);
        this._menu.addAction(_('Open'), () => this.doOpen());
        switch (this._fileExtra) {
        case Prefs.FILE_TYPE.NONE:
            this._menu.addAction(_('Cut'), () => this._onCutClicked());
            this._menu.addAction(_('Copy'), () => this._onCopyClicked());
            this._menu.addAction(_('Rename'), () => this.doRename());
            this._menu.addAction(_('Move to Trash'), () => this._onMoveToTrashClicked());
            break;
        case Prefs.FILE_TYPE.USER_DIRECTORY_TRASH:
            this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._menu.addAction(_('Empty trash'), () => this._onEmptyTrashClicked());
            break;
        default:
            break;
        }
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addAction(_('Properties'), () => this._onPropertiesClicked());
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addAction(_('Show in Files'), () => this._onShowInFilesClicked());
        this._menuManager.addMenu(this._menu);

        Main.layoutManager.uiGroup.add_actor(this._menu.actor);
        this._menu.actor.hide();
    }

    _onPressButton(actor, event) {
        let button = event.get_button();
        if (button == 3) {
            if (!this.isSelected)
                this.emit('selected', false, true);
            this._menu.toggle();
            return Clutter.EVENT_STOP;
        } else if (button == 1) {
            if (event.get_click_count() == 1) {
                let [x, y] = event.get_coords();
                this._primaryButtonPressed = true;
                this._buttonPressInitialX = x;
                this._buttonPressInitialY = y;
                let shiftPressed = !!(event.get_state() & Clutter.ModifierType.SHIFT_MASK);
                let controlPressed = !!(event.get_state() & Clutter.ModifierType.CONTROL_MASK);
                if (!this.isSelected) {
                    this.emit('selected', shiftPressed || controlPressed, true);
                }
            }
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onLeave(actor, event) {
        this._primaryButtonPressed = false;
    }

    _onMotion(actor, event) {
        let [x, y] = event.get_coords();
        if (this._primaryButtonPressed) {
            let xDiff = x - this._buttonPressInitialX;
            let yDiff = y - this._buttonPressInitialY;
            let distance = Math.sqrt(Math.pow(xDiff, 2) + Math.pow(yDiff, 2));
            if (distance > DRAG_TRESHOLD) {
                // Don't need to track anymore this if we start drag, and also
                // avoids reentrance here
                this._primaryButtonPressed = false;
                let event = Clutter.get_current_event();
                let [x, y] = event.get_coords();
                Extension.desktopManager.dragStart();
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onReleaseButton(actor, event) {
        let button = event.get_button();
        if (button == 1) {
            // primaryButtonPressed is TRUE only if the user has pressed the button
            // over an icon, and if (s)he has not started a drag&drop operation
            if (this._primaryButtonPressed) {
                this._primaryButtonPressed = false;
                let shiftPressed = !!(event.get_state() & Clutter.ModifierType.SHIFT_MASK);
                let controlPressed = !!(event.get_state() & Clutter.ModifierType.CONTROL_MASK);
                if ((event.get_click_count() == 1) && Prefs.CLICK_POLICY_SINGLE && !shiftPressed && !controlPressed)
                    this.doOpen();
                this.emit('selected', shiftPressed || controlPressed, true);
                return Clutter.EVENT_STOP;
            }
            if ((event.get_click_count() == 2) && (!Prefs.CLICK_POLICY_SINGLE))
                this.doOpen();
        }
        return Clutter.EVENT_PROPAGATE;
    }

    get savedCoordinates() {
        return this._savedCoordinates;
    }

    _onSetMetadataFileFinished(source, result) {
        try {
            let [success, info] = source.set_attributes_finish(result);
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                log('Error setting metadata to desktop files ', error);
        }
    }

    set savedCoordinates(pos) {
        if (this._setMetadataCancellable)
            this._setMetadataCancellable.cancel();

        this._setMetadataCancellable = new Gio.Cancellable();
        this._savedCoordinates = [pos[0], pos[1]];
        let info = new Gio.FileInfo();
        info.set_attribute_string('metadata::nautilus-icon-position',
                                  `${pos[0]},${pos[1]}`);
        this.file.set_attributes_async(info,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            this._setMetadataCancellable,
            (source, result) => this._onSetMetadataFileFinished(source, result)
        );
    }

    intersectsWith(argX, argY, argWidth, argHeight) {
        let rect = new Meta.Rectangle({ x: argX, y: argY, width: argWidth, height: argHeight });
        let [containerX, containerY] = this._container.get_transformed_position();
        let boundingBox = new Meta.Rectangle({ x: containerX,
                                               y: containerY,
                                               width: this._container.allocation.x2 - this._container.allocation.x1,
                                               height: this._container.allocation.y2 - this._container.allocation.y1 });
        let [intersects, _] = rect.intersect(boundingBox);

        return intersects;
    }

    set isSelected(isSelected) {
        isSelected = !!isSelected;
        if (isSelected == this._isSelected)
            return;

        if (isSelected)
            this._container.add_style_pseudo_class('selected');
        else
            this._container.remove_style_pseudo_class('selected');

        this._isSelected = isSelected;
    }

    get isSelected() {
        return this._isSelected;
    }

    get isSpecial() {
        return this._isSpecial;
    }

    get state() {
        return this._state;
    }

    set state(state) {
        if (state == this._state)
            return;

        this._state = state;
    }

    get isDirectory() {
        return this._isDirectory;
    }

    get displayName() {
        return this._displayName;
    }

    acceptDrop() {
        return Extension.desktopManager.selectionDropOnFileItem(this);
    }
};
Signals.addSignalMethods(FileItem.prototype);
