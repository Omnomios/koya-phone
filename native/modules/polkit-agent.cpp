#include "module.hpp"
#include "authentication.hpp"
#include <memory>
#include <dlfcn.h>

struct PolkitModule: NativeModule {
    GDBusConnection *bus = nullptr;
    GDBusNodeInfo *node = nullptr;
    guint registration = 0;
    std::unique_ptr<AuthenticationAgent> agent;
    using NativeModule::NativeModule;
    void shutdown() override {
        agent.reset();
        if (registration) { g_dbus_connection_unregister_object(bus, registration); registration = 0; }
        if (node) { g_dbus_node_info_unref(node); node = nullptr; }
        if (bus) { g_dbus_connection_close_sync(bus, nullptr, nullptr); g_object_unref(bus); bus = nullptr; }
    }
    static JSValue start(NativeModule *base, int, JSValueConst *) {
        auto *self = static_cast<PolkitModule *>(base);
        if (self->agent) return JS_NewBool(base->js, self->agent->start());
        GError *error = nullptr;
        gchar *address = g_dbus_address_get_for_bus_sync(G_BUS_TYPE_SESSION, nullptr, &error);
        if (address) self->bus = g_dbus_connection_new_for_address_sync(address,
            static_cast<GDBusConnectionFlags>(G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT | G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION), nullptr, nullptr, &error);
        g_free(address);
        if (!self->bus) { std::string message = error ? error->message : "Session bus unavailable"; g_clear_error(&error); return JS_ThrowInternalError(base->js, "%s", message.c_str()); }
        GVariant *reply = g_dbus_connection_call_sync(self->bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
            g_variant_new("(su)", "org.koya.Authentication1", 4u), G_VARIANT_TYPE("(u)"), G_DBUS_CALL_FLAGS_NONE, 3000, nullptr, &error);
        guint32 owner = 0; if (reply) { g_variant_get(reply, "(u)", &owner); g_variant_unref(reply); }
        if (owner != 1) { g_clear_error(&error); self->shutdown(); return JS_ThrowInternalError(base->js, "Another authentication module owns the service"); }
        self->agent = std::make_unique<AuthenticationAgent>(self->bus);
        const char *xml = R"(<node><interface name="org.koya.Shell1">
<method name="Askpass"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
<method name="AuthenticationRespond"><arg type="u" direction="in"/><arg type="s" direction="in"/></method>
<method name="AuthenticationCancel"><arg type="u" direction="in"/></method>
</interface></node>)";
        self->node = g_dbus_node_info_new_for_xml(xml, nullptr);
        static const GDBusInterfaceVTable table = {[](GDBusConnection *bus, const char *sender, const char *, const char *, const char *member, GVariant *args, GDBusMethodInvocation *invocation, gpointer data) {
            auto *self = static_cast<PolkitModule *>(data);
            // Only the coordinator may relay requests or answers to this agent.
            GVariant *reply = g_dbus_connection_call_sync(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner",
                g_variant_new("(s)", "org.koya.Shell1"), G_VARIANT_TYPE("(s)"), G_DBUS_CALL_FLAGS_NONE, 1500, nullptr, nullptr);
            const char *owner = ""; if (reply) g_variant_get(reply, "(&s)", &owner);
            bool authorized = !strcmp(owner, sender); if (reply) g_variant_unref(reply);
            if (!authorized) { g_dbus_method_invocation_return_dbus_error(invocation, "org.koya.Shell1.Error", "Authentication requires the session coordinator"); return; }
            if (!strcmp(member, "Askpass")) {
                const char *question, *mode, *origin; g_variant_get(args, "(&s&s&s)", &question, &mode, &origin);
                self->agent->ask(question, mode, invocation, origin); return;
            }
            guint id;
            if (!strcmp(member, "AuthenticationRespond")) { const char *answer; g_variant_get(args, "(u&s)", &id, &answer); self->agent->respond(id, answer); }
            else if (!strcmp(member, "AuthenticationCancel")) { g_variant_get(args, "(u)", &id); self->agent->cancel(id); }
            else { g_dbus_method_invocation_return_dbus_error(invocation, "org.freedesktop.DBus.Error.UnknownMethod", member); return; }
            g_dbus_method_invocation_return_value(invocation, nullptr);
        }, nullptr, nullptr, {nullptr}};
        self->registration = g_dbus_connection_register_object(self->bus, "/org/koya/Shell1", self->node->interfaces[0], &table, self, nullptr, &error);
        if (!self->registration) { std::string message = error->message; g_clear_error(&error); self->shutdown(); return JS_ThrowInternalError(base->js, "%s", message.c_str()); }
        return JS_NewBool(base->js, self->agent->start());
    }
    static JSValue stop_agent(NativeModule *base, int, JSValueConst *) {
        static_cast<PolkitModule *>(base)->shutdown(); return JS_UNDEFINED;
    }
};
extern "C" HELIX_PLUGIN_EXPORT int helix_plugin_integrate(JSContext *ctx, const char *name, const HelixPluginHost *host, HelixPluginInstance **out) {
    // GObject keeps this library's listener type/vtable after instances end.
    // Mark its code resident while still destroying all per-runtime resources.
    Dl_info location{};
    if (dladdr(reinterpret_cast<void *>(&helix_plugin_integrate), &location) && location.dli_fname) {
        if (void *handle = dlopen(location.dli_fname, RTLD_NOW | RTLD_LOCAL | RTLD_NODELETE)) dlclose(handle);
    }
    auto *self = new PolkitModule(ctx); self->functions = {{"start", PolkitModule::start}, {"stop", PolkitModule::stop_agent}};
    if (self->integrate(name, host, out)) return 0;
    delete self; return 1;
}
