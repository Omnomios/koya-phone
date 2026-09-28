// SPDX-License-Identifier: MIT
#pragma once
#include <gio/gio.h>
#include <map>
#include <string>
#include <cstring>
#include <cmath>

// Temporary server-side D-Bus adapter for Module/dbus's client-only API.
// This stores RPC invocations only. Notification IDs, content, expiry, history,
// actions and presentation all belong to the Koya script.
class NotificationTransport {
    static constexpr const char *NAME = "org.freedesktop.Notifications";
    static constexpr const char *PATH = "/org/freedesktop/Notifications";
    struct Call { GDBusMethodInvocation *invocation; guint timeout; };
    GDBusConnection *bus;
    GDBusNodeInfo *node{};
    guint registration = 0, serial = 0;
    std::map<guint, Call> calls;
    std::string owner;
    static std::string quote(const char *text) {
        std::string out = "\"";
        for (const unsigned char *p = reinterpret_cast<const unsigned char *>(text); *p; ++p) {
            if (*p == '"' || *p == '\\') { out += '\\'; out += *p; }
            else if (*p < 32) { char escape[7]; g_snprintf(escape, sizeof escape, "\\u%04x", *p); out += escape; }
            else out += *p;
        }
        return out + '"';
    }
    static std::string json(GVariant *value) {
        if (g_variant_is_of_type(value, G_VARIANT_TYPE_VARIANT)) {
            GVariant *inner = g_variant_get_variant(value); auto out = json(inner); g_variant_unref(inner); return out;
        }
        switch (g_variant_classify(value)) {
        case G_VARIANT_CLASS_STRING: case G_VARIANT_CLASS_OBJECT_PATH: case G_VARIANT_CLASS_SIGNATURE:
            return quote(g_variant_get_string(value, nullptr));
        case G_VARIANT_CLASS_BOOLEAN: return g_variant_get_boolean(value) ? "true" : "false";
        case G_VARIANT_CLASS_BYTE: return std::to_string(g_variant_get_byte(value));
        case G_VARIANT_CLASS_INT16: return std::to_string(g_variant_get_int16(value));
        case G_VARIANT_CLASS_UINT16: return std::to_string(g_variant_get_uint16(value));
        case G_VARIANT_CLASS_INT32: return std::to_string(g_variant_get_int32(value));
        case G_VARIANT_CLASS_UINT32: return std::to_string(g_variant_get_uint32(value));
        case G_VARIANT_CLASS_INT64: return std::to_string(g_variant_get_int64(value));
        case G_VARIANT_CLASS_UINT64: return std::to_string(g_variant_get_uint64(value));
        case G_VARIANT_CLASS_DOUBLE: return std::isfinite(g_variant_get_double(value)) ? std::to_string(g_variant_get_double(value)) : "null";
        default: break;
        }
        bool dict = g_variant_is_of_type(value, G_VARIANT_TYPE_VARDICT);
        std::string out = dict ? "{" : "[";
        for (gsize i = 0; i < g_variant_n_children(value); ++i) {
            if (i) out += ',';
            GVariant *child = g_variant_get_child_value(value, i);
            if (dict) {
                GVariant *key = g_variant_get_child_value(child, 0), *val = g_variant_get_child_value(child, 1);
                out += json(key) + ':' + json(val); g_variant_unref(key); g_variant_unref(val);
            } else out += json(child);
            g_variant_unref(child);
        }
        return out + (dict ? '}' : ']');
    }
    void forward(const char *method, GVariant *args, GDBusMethodInvocation *invocation) {
        if (owner.empty() || calls.size() >= 128 || g_variant_get_size(args) > 1024 * 1024) {
            g_dbus_method_invocation_return_dbus_error(invocation, "org.freedesktop.Notifications.Error.Unavailable", "Notification frontend unavailable or request too large"); return;
        }
        do { ++serial; } while (!serial || calls.count(serial));
        const guint token = serial;
        struct Deadline { NotificationTransport *transport; guint token; };
        guint timer = g_timeout_add_seconds_full(G_PRIORITY_DEFAULT, 10, [](gpointer data)->gboolean {
            auto *deadline = static_cast<Deadline *>(data);
            auto &calls = deadline->transport->calls; auto entry = calls.find(deadline->token);
            if (entry != calls.end()) {
                g_dbus_method_invocation_return_dbus_error(entry->second.invocation, "org.freedesktop.Notifications.Error.Timeout", "Notification frontend did not reply");
                g_object_unref(entry->second.invocation); calls.erase(entry);
            }
            return G_SOURCE_REMOVE;
        }, new Deadline{this, token}, [](gpointer data) { delete static_cast<Deadline *>(data); });
        calls.emplace(token, Call{G_DBUS_METHOD_INVOCATION(g_object_ref(invocation)), timer});
        // The serialized request envelope is part of the frontend RPC contract.
        std::string envelope = "{\"Token\":" + std::to_string(token) + ",\"Sender\":" + quote(g_dbus_method_invocation_get_sender(invocation))
            + ",\"Method\":" + quote(method) + ",\"Arguments\":" + json(args) + "}";
        g_dbus_connection_emit_signal(bus, owner.c_str(), "/org/koya/Shell1", "org.koya.Shell1", "NotificationRequest", g_variant_new("(s)", envelope.c_str()), nullptr);
    }
public:
    explicit NotificationTransport(GDBusConnection *connection): bus(connection) {
        const char *xml = R"XML(<node><interface name="org.freedesktop.Notifications">
<method name="Notify"><arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="out"/></method>
<method name="CloseNotification"><arg type="u" direction="in"/></method>
<method name="GetCapabilities"><arg type="as" direction="out"/></method>
<method name="GetServerInformation"><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/></method>
<signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
<signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
</interface></node>)XML";
        node = g_dbus_node_info_new_for_xml(xml, nullptr);
        static const GDBusInterfaceVTable table = {+[](GDBusConnection *, const char *, const char *, const char *, const char *method, GVariant *args, GDBusMethodInvocation *i, gpointer user) {
            static_cast<NotificationTransport *>(user)->forward(method, args, i);
        }, nullptr, nullptr, {nullptr}};
        registration = g_dbus_connection_register_object(bus, PATH, node->interfaces[0], &table, this, nullptr, nullptr);
    }
    ~NotificationTransport() {
        detach();
        if (registration) g_dbus_connection_unregister_object(bus, registration);
        if (node) g_dbus_node_info_unref(node);
    }
    bool attach(const char *sender) {
        if (!registration || (!owner.empty() && owner != sender)) return false;
        GVariant *reply = g_dbus_connection_call_sync(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
            g_variant_new("(su)", NAME, 4u), G_VARIANT_TYPE("(u)"), G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, nullptr);
        guint result = 0;
        if (reply) { g_variant_get(reply, "(u)", &result); g_variant_unref(reply); }
        if (result != 1 && result != 4) return false;
        owner = sender; return true;
    }
    void detach() {
        if (owner.empty()) return;
        owner.clear();
        for (auto &entry : calls) {
            g_source_remove(entry.second.timeout);
            g_dbus_method_invocation_return_dbus_error(entry.second.invocation, "org.freedesktop.Notifications.Error.Unavailable", "Notification frontend exited");
            g_object_unref(entry.second.invocation);
        }
        calls.clear();
        if (!g_dbus_connection_is_closed(bus)) g_dbus_connection_call(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "ReleaseName",
            g_variant_new("(s)", NAME), nullptr, G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, nullptr, nullptr);
    }
    bool owns(const char *sender) const { return owner == sender; }
    bool reply(guint token, GVariant *payload) {
        auto entry = calls.find(token); if (entry == calls.end()) return false;
        auto *invocation = entry->second.invocation;
        const char *error = nullptr;
        if (g_variant_lookup(payload, "Error", "&s", &error)) {
            g_dbus_method_invocation_return_dbus_error(invocation, "org.freedesktop.Notifications.Error.InvalidNotification", error);
        } else {
            const char *method = g_dbus_method_invocation_get_method_name(invocation);
            GVariant *value = g_variant_lookup_value(payload, "Result", nullptr), *response = nullptr;
            if (!strcmp(method, "Notify") && value && g_variant_is_of_type(value, G_VARIANT_TYPE_UINT32)) response = g_variant_new("(u)", g_variant_get_uint32(value));
            else if (!strcmp(method, "CloseNotification")) response = g_variant_new("()");
            else if (value && g_variant_is_of_type(value, G_VARIANT_TYPE_STRING_ARRAY)) {
                if (!strcmp(method, "GetCapabilities")) response = g_variant_new("(@as)", g_variant_ref(value));
                else if (!strcmp(method, "GetServerInformation") && g_variant_n_children(value) == 4) {
                    const gchar **strings = g_variant_get_strv(value, nullptr);
                    response = g_variant_new("(ssss)", strings[0], strings[1], strings[2], strings[3]); g_free(strings);
                }
            }
            if (value) g_variant_unref(value);
            if (response) g_dbus_method_invocation_return_value(invocation, response);
            else g_dbus_method_invocation_return_dbus_error(invocation, "org.freedesktop.Notifications.Error.InvalidReply", "Invalid frontend reply");
        }
        g_source_remove(entry->second.timeout); g_object_unref(invocation); calls.erase(entry); return true;
    }
    bool emit(const char *destination, const char *member, guint id, const char *action, guint reason) {
        if (!destination || destination[0] != ':') return false;
        if (!strcmp(member, "ActionInvoked"))
            return g_dbus_connection_emit_signal(bus, destination, PATH, NAME, member, g_variant_new("(us)", id, action), nullptr);
        if (!strcmp(member, "NotificationClosed"))
            return g_dbus_connection_emit_signal(bus, destination, PATH, NAME, member, g_variant_new("(uu)", id, reason), nullptr);
        return false;
    }
};
