#!/usr/bin/gjs
const GnomeDesktop = imports.gi.GnomeDesktop;
const Gio = imports.gi.Gio;

let thumbnailFactory = GnomeDesktop.DesktopThumbnailFactory.new(GnomeDesktop.DesktopThumbnailSize.NORMAL);

let file = Gio.File.new_for_path(ARGV[0]);
let fileUri = file.get_uri();

let fileInfo = file.query_info("standard::content-type,time::modified", Gio.FileQueryInfoFlags.NONE, null);
let accessTime = fileInfo.get_attribute_uint64("time::modified");
let thumbnailPixbuf = thumbnailFactory.generate_thumbnail(fileUri, fileInfo.get_content_type());
if (thumbnailPixbuf == null)
    thumbnailFactory.create_failed_thumbnail(fileUri, accessTime);
else
    thumbnailFactory.save_thumbnail(thumbnailPixbuf, fileUri, accessTime);
