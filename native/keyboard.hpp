// SPDX-License-Identifier: MIT
#pragma once
#include <gio/gio.h>
#include <functional>
#include <memory>
#include <optional>
#include <string>

// Visibility is reported by Squeekboard, including automatic Wayland activation.
// All calls are asynchronous; rapid presses coalesce behind the current call.
class Keyboard {
    struct Data {
        GDBusProxy *proxy{};
        GCancellable *cancel = g_cancellable_new();
        std::function<void()> notify;
        bool initialized = false, available = false, visible = false, pending = false, sent = false;
        std::optional<bool> target;
        std::string error;
        ~Data() {
            if (proxy) g_object_unref(proxy);
            g_object_unref(cancel);
        }
        void refresh() {
            char *owner = g_dbus_proxy_get_name_owner(proxy);
            bool present = owner != nullptr;
            g_free(owner);
            GVariant *value = g_dbus_proxy_get_cached_property(proxy, "Visible");
            bool shown = present && value && g_variant_is_of_type(value, G_VARIANT_TYPE_BOOLEAN) && g_variant_get_boolean(value);
            if (value) g_variant_unref(value);
            bool changed = !initialized || present != available || shown != visible;
            initialized = true;
            available = present; visible = shown;
            if (!available) target.reset();
            if (changed && notify) notify();
        }
    };
    std::shared_ptr<Data> data = std::make_shared<Data>();
    static void pump(const std::shared_ptr<Data> &d) {
        if (!d->notify || !d->available || d->pending || !d->target) return;
        d->sent = *d->target; d->target.reset(); d->pending = true;
        d->error.clear();
        g_dbus_proxy_call(d->proxy, "SetVisible", g_variant_new("(b)", d->sent),
            G_DBUS_CALL_FLAGS_NO_AUTO_START, 1500, d->cancel,
            [](GObject *object, GAsyncResult *result, gpointer user) {
                std::unique_ptr<std::shared_ptr<Data>> holder(static_cast<std::shared_ptr<Data> *>(user));
                auto d = *holder;
                GError *error = nullptr;
                GVariant *reply = g_dbus_proxy_call_finish(G_DBUS_PROXY(object), result, &error);
                if (reply) g_variant_unref(reply);
                d->pending = false;
                if (error && !g_error_matches(error, G_IO_ERROR, G_IO_ERROR_CANCELLED)) d->error = error->message;
                g_clear_error(&error);
                if (d->notify) d->notify();
                pump(d);
            }, new std::shared_ptr<Data>(d));
        d->notify();
    }
public:
    Keyboard(GDBusConnection *bus, std::function<void()> notify) {
        data->notify = std::move(notify);
        g_dbus_proxy_new(bus, G_DBUS_PROXY_FLAGS_DO_NOT_AUTO_START, nullptr,
            "sm.puri.OSK0", "/sm/puri/OSK0", "sm.puri.OSK0", data->cancel,
            [](GObject *, GAsyncResult *result, gpointer user) {
                std::unique_ptr<std::shared_ptr<Data>> holder(static_cast<std::shared_ptr<Data> *>(user));
                auto d = *holder;
                GError *error = nullptr;
                GDBusProxy *proxy = g_dbus_proxy_new_finish(result, &error);
                if (!d->notify) {
                    if (proxy) g_object_unref(proxy);
                    g_clear_error(&error); return;
                }
                if (!proxy) {
                    d->initialized = true;
                    d->error = error ? error->message : "Cannot connect to keyboard";
                    g_clear_error(&error); d->notify(); return;
                }
                d->proxy = proxy;
                g_signal_connect(proxy, "g-properties-changed", G_CALLBACK(+[](GDBusProxy *, GVariant *, const gchar *const *, gpointer user) {
                    static_cast<Data *>(user)->refresh();
                }), d.get());
                g_signal_connect(proxy, "notify::g-name-owner", G_CALLBACK(+[](GObject *, GParamSpec *, gpointer user) {
                    static_cast<Data *>(user)->refresh();
                }), d.get());
                d->refresh();
            }, new std::shared_ptr<Data>(data));
    }
    ~Keyboard() {
        data->notify = {};
        g_cancellable_cancel(data->cancel);
        if (data->proxy) g_signal_handlers_disconnect_by_data(data->proxy, data.get());
    }
    bool available() const { return data->available; }
    bool visible() const { return data->visible; }
    bool pending() const { return data->pending; }
    const std::string &error() const { return data->error; }
    void set_visible(bool value) {
        if (!data->available) return;
        if (data->target == value || (data->pending && data->sent == value && !data->target)) return;
        if (!data->pending && data->visible == value) return;
        data->target = value;
        pump(data);
    }
    void toggle() { set_visible(!data->target.value_or(data->pending ? data->sent : data->visible)); }
};
