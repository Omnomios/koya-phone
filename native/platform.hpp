#pragma once
#include <gio/gdesktopappinfo.h>
#include <algorithm>
#include <cstring>
#include <functional>
#include <string>

// Coordinator-side RPC only. All platform resources live in the Koya worker.
struct Platform {
    GDBusConnection *bus = nullptr;
    GVariant *snapshot = nullptr;
    bool ready = false;
    ~Platform() { if (snapshot) g_variant_unref(snapshot); }
    GVariant *request(const char *method, GVariant *args = nullptr, const GVariantType *type = nullptr) {
        if (!ready || !bus) return nullptr;
        GError *error = nullptr;
        GVariant *reply = g_dbus_connection_call_sync(bus, "org.koya.Platform1", "/org/koya/Platform1", "org.koya.Platform1", method,
            args, type, G_DBUS_CALL_FLAGS_NO_AUTO_START, 3000, nullptr, &error);
        if (error) { g_warning("Platform %s: %s", method, error->message); g_error_free(error); }
        return reply;
    }
    void send(const char *method, GVariant *args = nullptr) {
        if (!ready || !bus) return;
        g_dbus_connection_call(bus, "org.koya.Platform1", "/org/koya/Platform1", "org.koya.Platform1", method, args, nullptr,
            G_DBUS_CALL_FLAGS_NO_AUTO_START, 3000, nullptr, [](GObject *object, GAsyncResult *result, gpointer) {
                GError *error = nullptr; GVariant *reply = g_dbus_connection_call_finish(G_DBUS_CONNECTION(object), result, &error);
                if (reply) g_variant_unref(reply);
                if (error) { g_warning("Platform command: %s", error->message); g_error_free(error); }
            }, nullptr);
    }
    bool boolean(const char *key) const { gboolean value = FALSE; if (snapshot) g_variant_lookup(snapshot, key, "b", &value); return value; }
    std::string text(const char *key) const { const char *value = ""; if (snapshot) g_variant_lookup(snapshot, key, "&s", &value); return value; }
    bool update(GVariant *values) {
        bool changed = !snapshot || !g_variant_equal(snapshot, values);
        if (snapshot) g_variant_unref(snapshot);
        snapshot = g_variant_ref(values); return changed;
    }
    void append(GVariantBuilder &builder) {
        if (!snapshot) return;
        GVariantIter iter; g_variant_iter_init(&iter, snapshot); const char *key; GVariant *value;
        while (g_variant_iter_next(&iter, "{&sv}", &key, &value)) {
            // Policy and component ownership cannot be overwritten by a worker.
            if (g_str_has_prefix(key, "Battery") || !strcmp(key, "ExternalPower") || g_str_has_prefix(key, "Network") || g_str_has_prefix(key, "Wifi") || g_str_has_prefix(key, "Cellular"))
                g_variant_builder_add(&builder, "{sv}", key, value);
            g_variant_unref(value);
        }
    }
    static void relay(GDBusConnection *bus, const char *destination, const char *path, const char *iface, const char *method,
                      GVariant *args, GDBusMethodInvocation *invocation, int timeout = 3000) {
        g_dbus_connection_call(bus, destination, path, iface, method, args, nullptr, G_DBUS_CALL_FLAGS_NO_AUTO_START, timeout, nullptr,
            [](GObject *object, GAsyncResult *result, gpointer data) {
                auto *invocation = static_cast<GDBusMethodInvocation *>(data); GError *error = nullptr;
                GVariant *reply = g_dbus_connection_call_finish(G_DBUS_CONNECTION(object), result, &error);
                if (reply) { g_dbus_method_invocation_return_value(invocation, reply); g_variant_unref(reply); }
                else { g_dbus_method_invocation_return_gerror(invocation, error); g_error_free(error); }
                g_object_unref(invocation);
            }, g_object_ref(invocation));
    }
};
struct Desktop {
    Platform *platform;
    bool available = false;
    struct IconMount {
        std::string cache = std::string(g_get_user_cache_dir()) + "/koya/icons";
    } icons;
    explicit Desktop(Platform *client): platform(client) {}
    void query_state(GDBusMethodInvocation *invocation) { Platform::relay(platform->bus, "org.koya.Platform1", "/org/koya/Platform1", "org.koya.Platform1", "GetDesktopState", nullptr, invocation); }
    bool operation(const char *method, GVariant *args) { GVariant *reply = platform->request(method, args); if (!reply) return false; g_variant_unref(reply); return true; }
    bool dispatch(const std::string &command) { return operation("Dispatch", g_variant_new("(s)", command.c_str())); }
    bool select_workspace(unsigned workspace) { return operation("SwitchDesktop", g_variant_new("(u)", workspace)); }
    bool launch(const char *id, unsigned workspace) { return operation("LaunchApplication", g_variant_new("(su)", id, workspace)); }
    static bool address(const char *value) {
        size_t size = strlen(value); return size > 2 && size <= 18 && value[0] == '0' && value[1] == 'x' &&
            std::all_of(value + 2, value + size, [](char c) { return g_ascii_isxdigit(c); });
    }
};
struct Keyboard {
    Platform *platform;
    explicit Keyboard(Platform *client): platform(client) {}
    bool available() { return platform->boolean("KeyboardAvailable"); }
    bool visible() { return platform->boolean("KeyboardVisible"); }
    bool pending() { return platform->boolean("KeyboardPending"); }
    std::string error() { return platform->text("KeyboardError"); }
    void set_visible(bool visible) { if (!visible) platform->send("HideKeyboard"); }
    void toggle() { platform->send("ToggleKeyboard"); }
};
struct AuthenticationProxy {
    Platform *platform;
    explicit AuthenticationProxy(Platform *client): platform(client) {}
    bool start() { GVariant *reply = platform->request("AuthenticationStart"); if (!reply) return false; g_variant_unref(reply); return true; }
    void stop() { platform->send("AuthenticationStop"); }
    void ask(const char *question, const char *mode, GDBusMethodInvocation *invocation) {
        Platform::relay(platform->bus, "org.koya.Authentication1", "/org/koya/Shell1", "org.koya.Shell1", "Askpass",
            g_variant_new("(sss)", question, mode, g_dbus_method_invocation_get_sender(invocation)), invocation, G_MAXINT);
    }
    void respond(guint id, const char *answer) {
        g_dbus_connection_call(platform->bus, "org.koya.Authentication1", "/org/koya/Shell1", "org.koya.Shell1", "AuthenticationRespond",
            g_variant_new("(us)", id, answer), nullptr, G_DBUS_CALL_FLAGS_NO_AUTO_START, 3000, nullptr, nullptr, nullptr);
    }
    void cancel(guint id) {
        g_dbus_connection_call(platform->bus, "org.koya.Authentication1", "/org/koya/Shell1", "org.koya.Shell1", "AuthenticationCancel",
            g_variant_new("(u)", id), nullptr, G_DBUS_CALL_FLAGS_NO_AUTO_START, 3000, nullptr, nullptr, nullptr);
    }
};
