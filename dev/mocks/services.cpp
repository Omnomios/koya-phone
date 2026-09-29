// Phone services on the local development bus. No host hardware or networking.
#include <gio/gio.h>
#include <glib-unix.h>
#include <map>
#include <string>
#include <vector>
#include <cstring>
#include <signal.h>

static constexpr const char *NM = "org.freedesktop.NetworkManager";
static constexpr const char *ROOT = "/org/freedesktop/NetworkManager";
static constexpr const char *DEVICE = "/org/freedesktop/NetworkManager/Devices/1";
static constexpr const char *WIRELESS = "org.freedesktop.NetworkManager.Device.Wireless";
static constexpr const char *DEV = "org.freedesktop.NetworkManager.Device";
static constexpr const char *PROFILE = "org.freedesktop.NetworkManager.Settings.Connection";
static constexpr const char *ACTIVE = "/org/freedesktop/NetworkManager/ActiveConnection/1";
static constexpr const char *LOGIN = "org.freedesktop.login1";
static constexpr const char *SESSION = "/org/freedesktop/login1/session/localdev";

static bool own(GDBusConnection *bus, const char *name) {
    GError *error = nullptr;
    GVariant *reply = g_dbus_connection_call_sync(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus",
        "org.freedesktop.DBus", "RequestName", g_variant_new("(su)", name, 4u), G_VARIANT_TYPE("(u)"),
        G_DBUS_CALL_FLAGS_NONE, 2000, nullptr, &error);
    guint result = 0;
    if (reply) { g_variant_get(reply, "(u)", &result); g_variant_unref(reply); }
    if (error) { g_printerr("%s\n", error->message); g_error_free(error); }
    return result == 1;
}

static GVariant *paths(const std::vector<std::string> &values) {
    GVariantBuilder result; g_variant_builder_init(&result, G_VARIANT_TYPE("ao"));
    for (const auto &value : values) g_variant_builder_add(&result, "o", value.c_str());
    return g_variant_builder_end(&result);
}

class Services {
    using Properties = std::map<std::string, GVariant *>;
    using Interfaces = std::map<std::string, Properties>;
    GDBusConnection *bus;
    std::map<std::string, Interfaces> objects;
    std::map<std::string, GVariant *> profiles;
    std::map<std::string, guint> profile_registrations;
    unsigned serial = 1;
    gint64 scan = 1;
    void set(const std::string &path, const std::string &iface, const std::string &name, GVariant *value, bool emit = false) {
        auto &slot = objects[path][iface][name];
        if (slot) g_variant_unref(slot);
        slot = g_variant_take_ref(value);
        if (emit) {
            GVariantBuilder changes; g_variant_builder_init(&changes, G_VARIANT_TYPE_VARDICT);
            g_variant_builder_add(&changes, "{sv}", name.c_str(), slot);
            g_dbus_connection_emit_signal(bus, nullptr, path.c_str(), "org.freedesktop.DBus.Properties", "PropertiesChanged",
                g_variant_new("(sa{sv}as)", iface.c_str(), &changes, nullptr), nullptr);
        }
    }
    void available_profiles() {
        std::vector<std::string> values;
        for (const auto &profile : profiles) values.push_back(profile.first);
        set(DEVICE, DEV, "AvailableConnections", paths(values), true);
    }
    void connected(const char *ap) {
        const bool connected = strcmp(ap, "/") != 0;
        set(DEVICE, WIRELESS, "ActiveAccessPoint", g_variant_new_object_path(ap), true);
        set(DEVICE, DEV, "ActiveConnection", g_variant_new_object_path(connected ? ACTIVE : "/"), true);
        set(DEVICE, DEV, "State", g_variant_new_uint32(connected ? 100 : 30), true);
        set(ROOT, NM, "State", g_variant_new_uint32(connected ? 70 : 30), true);
        set(ROOT, NM, "Connectivity", g_variant_new_uint32(connected ? 4 : 1), true);
    }
    GVariant *managed() {
        GVariantBuilder result; g_variant_builder_init(&result, G_VARIANT_TYPE("a{oa{sa{sv}}}"));
        for (const auto &object : objects) {
            GVariantBuilder interfaces; g_variant_builder_init(&interfaces, G_VARIANT_TYPE("a{sa{sv}}"));
            for (const auto &interface : object.second) {
                GVariantBuilder properties; g_variant_builder_init(&properties, G_VARIANT_TYPE_VARDICT);
                for (const auto &property : interface.second) g_variant_builder_add(&properties, "{sv}", property.first.c_str(), property.second);
                g_variant_builder_add(&interfaces, "{sa{sv}}", interface.first.c_str(), &properties);
            }
            g_variant_builder_add(&result, "{oa{sa{sv}}}", object.first.c_str(), &interfaces);
        }
        return g_variant_new("(a{oa{sa{sv}}})", &result);
    }
    guint register_interface(const char *path, const std::string &xml) {
        GError *error = nullptr;
        GDBusNodeInfo *node = g_dbus_node_info_new_for_xml(("<node>" + xml + "</node>").c_str(), &error);
        if (!node) g_error("Service XML: %s", error->message);
        static const GDBusInterfaceVTable table = {method, property, set_property, {nullptr}};
        guint id = g_dbus_connection_register_object(bus, path, node->interfaces[0], &table, this, nullptr, &error);
        g_dbus_node_info_unref(node);
        if (!id) g_error("Service registration: %s", error->message);
        return id;
    }
    void add_profile(const std::string &path, GVariant *settings) {
        auto previous = profiles.find(path);
        if (previous != profiles.end()) g_variant_unref(previous->second);
        profiles[path] = g_variant_take_ref(settings);
        if (!profile_registrations.count(path)) profile_registrations[path] = register_interface(path.c_str(),
            std::string("<interface name=\"") + PROFILE + "\"><method name=\"GetSettings\"><arg type=\"a{sa{sv}}\" direction=\"out\"/></method>"
            "<method name=\"Update\"><arg type=\"a{sa{sv}}\" direction=\"in\"/></method><method name=\"Delete\"/></interface>");
        available_profiles();
    }
    static GVariant *property(GDBusConnection*, const gchar*, const gchar *path, const gchar *iface, const gchar *name, GError**, gpointer data) {
        auto *self = static_cast<Services *>(data);
        return g_variant_ref(self->objects.at(path).at(iface).at(name));
    }
    static gboolean set_property(GDBusConnection*, const gchar*, const gchar *path, const gchar *iface, const gchar *name, GVariant *value, GError**, gpointer data) {
        auto *self = static_cast<Services *>(data);
        if (strcmp(iface, NM) || strcmp(name, "WirelessEnabled")) return FALSE;
        self->set(path, iface, name, g_variant_ref(value), true);
        if (!g_variant_get_boolean(value)) self->connected("/");
        return TRUE;
    }
    static void method(GDBusConnection*, const gchar*, const gchar *path, const gchar *iface, const gchar *member, GVariant *args, GDBusMethodInvocation *invocation, gpointer data) {
        auto *self = static_cast<Services *>(data);
        GVariant *result = nullptr;
        const std::string name(member);
        if (name == "GetSessionByPID") result = g_variant_new("(o)", SESSION);
        else if (name == "CanSuspend") result = g_variant_new("(s)", "na");
        else if (name == "CanPowerOff" || name == "CanReboot") result = g_variant_new("(s)", "yes");
        else if (name == "PowerOff" || name == "Reboot") g_print("Mock %s (host unchanged)\n", member);
        else if (name == "SetBrightness") {
            const char *subsystem, *device; guint level;
            g_variant_get(args, "(&s&su)", &subsystem, &device, &level);
            const char *base = g_getenv("KOYA_TEST_BACKLIGHT_DIR");
            if (!base || strcmp(subsystem, "backlight") || strcmp(device, "fixture") || level < 1 || level > 100 ||
                !g_file_set_contents((std::string(base) + "/fixture/brightness").c_str(), std::to_string(level).c_str(), -1, nullptr)) {
                g_dbus_method_invocation_return_dbus_error(invocation, "org.koya.Dev.InvalidBrightness", "Invalid simulated brightness"); return;
            }
        } else if (name == "GetManagedObjects") result = self->managed();
        else if (name == "GetDevices") result = g_variant_new("(@ao)", paths({DEVICE}));
        else if (name == "RequestScan") self->set(DEVICE, WIRELESS, "LastScan", g_variant_new_int64(++self->scan), true);
        else if (name == "Disconnect") self->connected("/");
        else if (name == "GetSettings") result = g_variant_new("(@a{sa{sv}})", g_variant_ref(self->profiles.at(path)));
        else if (name == "Delete") {
            g_variant_unref(self->profiles.at(path)); self->profiles.erase(path);
            g_dbus_connection_unregister_object(self->bus, self->profile_registrations.at(path));
            self->profile_registrations.erase(path); self->available_profiles();
        } else if (name == "Update" || name == "AddAndActivateConnection") {
            GVariant *settings = g_variant_get_child_value(args, 0);
            GVariant *security = g_variant_lookup_value(settings, "802-11-wireless-security", G_VARIANT_TYPE_VARDICT);
            GVariant *password = security ? g_variant_lookup_value(security, "psk", G_VARIANT_TYPE_STRING) : nullptr;
            const bool bad = password && strcmp(g_variant_get_string(password, nullptr), "test-password");
            if (password) g_variant_unref(password);
            if (security) g_variant_unref(security);
            if (bad) {
                g_variant_unref(settings);
                g_dbus_method_invocation_return_dbus_error(invocation, "org.freedesktop.NetworkManager.NoSecrets", "Password rejected"); return;
            }
            if (name == "Update") self->add_profile(path, settings);
            else {
                GVariant *ap = g_variant_get_child_value(args, 2);
                const char *target = g_variant_get_string(ap, nullptr);
                if (!self->objects.count(target)) {
                    g_variant_unref(settings); g_variant_unref(ap);
                    g_dbus_method_invocation_return_dbus_error(invocation, "org.freedesktop.NetworkManager.UnknownAccessPoint", "Unknown simulated network"); return;
                }
                std::string profile = std::string(ROOT) + "/Settings/" + std::to_string(++self->serial);
                self->add_profile(profile, settings); self->connected(target);
                result = g_variant_new("(oo)", profile.c_str(), ACTIVE); g_variant_unref(ap);
            }
        } else if (name == "ActivateConnection") {
            const char *profile, *device, *ap; g_variant_get(args, "(&o&o&o)", &profile, &device, &ap);
            if (strcmp(device, DEVICE) || !self->objects.count(ap) ||
                (!strcmp(profile, "/") && g_variant_get_uint32(self->objects.at(ap).begin()->second.at("RsnFlags")) != 0)) {
                g_dbus_method_invocation_return_dbus_error(invocation, "org.freedesktop.NetworkManager.UnknownConnection", "Select the simulated network and enter its password"); return;
            }
            self->connected(ap); result = g_variant_new("(o)", ACTIVE);
        } else {
            g_dbus_method_invocation_return_dbus_error(invocation, "org.freedesktop.DBus.Error.UnknownMethod", iface); return;
        }
        g_dbus_method_invocation_return_value(invocation, result);
    }
public:
    explicit Services(GDBusConnection *connection): bus(connection) {
        set(SESSION, "org.freedesktop.login1.Session", "Active", g_variant_new_boolean(TRUE));
        register_interface("/org/freedesktop/login1", "<interface name=\"org.freedesktop.login1.Manager\">"
            "<method name=\"GetSessionByPID\"><arg type=\"u\" direction=\"in\"/><arg type=\"o\" direction=\"out\"/></method>"
            "<method name=\"CanPowerOff\"><arg type=\"s\" direction=\"out\"/></method><method name=\"CanReboot\"><arg type=\"s\" direction=\"out\"/></method>"
            "<method name=\"CanSuspend\"><arg type=\"s\" direction=\"out\"/></method>"
            "<method name=\"PowerOff\"><arg type=\"b\" direction=\"in\"/></method><method name=\"Reboot\"><arg type=\"b\" direction=\"in\"/></method></interface>");
        set(ROOT, NM, "WirelessEnabled", g_variant_new_boolean(TRUE));
        set(ROOT, NM, "WirelessHardwareEnabled", g_variant_new_boolean(TRUE));
        set(ROOT, NM, "NetworkingEnabled", g_variant_new_boolean(TRUE));
        set(ROOT, NM, "PrimaryConnectionType", g_variant_new_string("802-11-wireless"));
        set(ROOT, NM, "State", g_variant_new_uint32(70));
        set(ROOT, NM, "Connectivity", g_variant_new_uint32(4));
        set(DEVICE, DEV, "DeviceType", g_variant_new_uint32(2));
        set(DEVICE, DEV, "StateReason", g_variant_new("(uu)", 100u, 0u));
        set(DEVICE, DEV, "AvailableConnections", paths({}));
        set(DEVICE, WIRELESS, "LastScan", g_variant_new_int64(scan));
        std::vector<std::string> points;
        const char *names[] = {"Home", "Grün", "Open", "Office", "WPA3"};
        const guint flags[] = {0x100, 0x100, 0, 0x200, 0x400};
        for (unsigned i = 0; i < 5; ++i) {
            std::string path = std::string(ROOT) + "/AccessPoint/" + std::to_string(i + 1);
            points.push_back(path);
            std::string interface = std::string(NM) + ".AccessPoint";
            set(path, interface, "Ssid", g_variant_new_fixed_array(G_VARIANT_TYPE_BYTE, names[i], strlen(names[i]), 1));
            set(path, interface, "Strength", g_variant_new_byte(90 - i * 10));
            set(path, interface, "Flags", g_variant_new_uint32(flags[i] != 0));
            set(path, interface, "RsnFlags", g_variant_new_uint32(flags[i]));
            set(path, interface, "WpaFlags", g_variant_new_uint32(0));
        }
        set(DEVICE, WIRELESS, "AccessPoints", paths(points));
        connected(points.front().c_str());
        for (const auto &object : objects) for (const auto &interface : object.second) {
            std::string xml = "<interface name=\"" + interface.first + "\">";
            for (const auto &property : interface.second) xml += "<property name=\"" + property.first + "\" type=\"" +
                g_variant_get_type_string(property.second) + "\" access=\"" + (property.first == "WirelessEnabled" ? "readwrite" : "read") + "\"/>";
            if (interface.first == NM) xml += "<method name=\"GetDevices\"><arg type=\"ao\" direction=\"out\"/></method>"
                "<method name=\"ActivateConnection\"><arg type=\"o\" direction=\"in\"/><arg type=\"o\" direction=\"in\"/><arg type=\"o\" direction=\"in\"/><arg type=\"o\" direction=\"out\"/></method>"
                "<method name=\"AddAndActivateConnection\"><arg type=\"a{sa{sv}}\" direction=\"in\"/><arg type=\"o\" direction=\"in\"/><arg type=\"o\" direction=\"in\"/><arg type=\"o\" direction=\"out\"/><arg type=\"o\" direction=\"out\"/></method>";
            if (interface.first == WIRELESS) xml += "<method name=\"RequestScan\"><arg type=\"a{sv}\" direction=\"in\"/></method>";
            if (interface.first == DEV) xml += "<method name=\"Disconnect\"/>";
            if (object.first == SESSION) xml += "<method name=\"SetBrightness\"><arg type=\"s\" direction=\"in\"/><arg type=\"s\" direction=\"in\"/><arg type=\"u\" direction=\"in\"/></method>";
            register_interface(object.first.c_str(), xml + "</interface>");
        }
        register_interface("/org/freedesktop", "<interface name=\"org.freedesktop.DBus.ObjectManager\"><method name=\"GetManagedObjects\"><arg type=\"a{oa{sa{sv}}}\" direction=\"out\"/></method></interface>");
    }
    ~Services() {
        for (const auto &object : objects) for (const auto &interface : object.second)
            for (const auto &property : interface.second) g_variant_unref(property.second);
        for (const auto &profile : profiles) g_variant_unref(profile.second);
    }
};

int main() {
    const char *session = g_getenv("DBUS_SESSION_BUS_ADDRESS"), *system = g_getenv("DBUS_SYSTEM_BUS_ADDRESS");
    if (!session || !system || strcmp(session, system)) {
        g_printerr("Development services require identical private session/system bus addresses\n"); return 1;
    }
    GError *error = nullptr;
    GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &error);
    if (!bus) { g_printerr("%s\n", error->message); g_error_free(error); return 1; }
    Services services(bus);
    if (!own(bus, LOGIN) || !own(bus, NM)) { g_object_unref(bus); return 1; }
    GMainLoop *loop = g_main_loop_new(nullptr, FALSE);
    for (int sig : {SIGTERM, SIGINT}) g_unix_signal_add(sig, [](gpointer data)->gboolean {
        g_main_loop_quit(static_cast<GMainLoop *>(data)); return G_SOURCE_REMOVE;
    }, loop);
    g_print("Private development services ready\n");
    g_main_loop_run(loop);
    g_main_loop_unref(loop); g_object_unref(bus);
    return 0;
}
