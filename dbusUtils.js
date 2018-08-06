const Gio = imports.gi.Gio;

const NautilusFileOperationsInterface = '<node>\
<interface name="org.gnome.Nautilus.FileOperations"> \
    <method name="CopyFile"> \
        <arg name=" SourceFileURI" type="s" direction="in"/> \
        <arg name=" SourceDisplayName" type="s" direction="in"/> \
        <arg name=" DestinationDirectoryURI" type="s" direction="in"/> \
        <arg name=" DestinationDisplayName" type="s" direction="in"/> \
    </method> \
    <method name="TrashFiles"> \
        <arg name="URIs" type="as" direction="in"/> \
    </method> \
</interface> \
</node>';

const NautilusFileOperationsProxyInterface = Gio.DBusProxy.makeProxyWrapper(NautilusFileOperationsInterface);

var NautilusFileOperationsProxy = new NautilusFileOperationsProxyInterface(
    Gio.DBus.session,
    "org.gnome.NautilusDevel",
    "/org/gnome/NautilusDevel",
    (proxy, error) =>
    {
        if (error)
        {
            log("Error connecting to Nautilus");
        }
    }
);

const FreeDesktopFileManagerInterface = '<node>\
<interface name="org.freedesktop.FileManager1"> \
    <method name="ShowItems"> \
        <arg name="URIs" type="as" direction="in"/> \
        <arg name="StartupId" type="s" direction="in"/> \
    </method> \
    <method name="ShowItemProperties"> \
        <arg name="URIs" type="as" direction="in"/> \
        <arg name="StartupId" type="s" direction="in"/> \
    </method> \
</interface> \
</node>';

const FreeDesktopFileManagerProxyInterface = Gio.DBusProxy.makeProxyWrapper(FreeDesktopFileManagerInterface);

var FreeDesktopFileManagerProxy = new FreeDesktopFileManagerProxyInterface(
    Gio.DBus.session,
    "org.freedesktop.FileManager1",
    "/org/freedesktop/FileManager1",
    (proxy, error) =>
    {
        if (error)
        {
            log("Error connecting to Nautilus");
        }
    }
);
