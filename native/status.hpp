// SPDX-License-Identifier: MIT
// Read-only status: kernel power-supply events and cached NM/MM D-Bus proxies.
#pragma once
#include <gio/gio.h>
#include <algorithm>
#include <cstring>
#include <functional>
#include <memory>
#include <string>

class SystemStatus {
    struct Data : std::enable_shared_from_this<Data> {
        GDBusObjectManager *network = nullptr, *modems = nullptr;
        GCancellable *cancel = g_cancellable_new();
        GVariant *snapshot = nullptr;
        guint idle = 0;
        std::function<void()> notify;
        bool battery_present = false, external_power = false;
        int battery_percent = -1;
        std::string battery_state = "unknown", supplies, active_ap;
        ~Data() {
            if (idle) g_source_remove(idle);
            if (network) g_object_unref(network);
            if (modems) g_object_unref(modems);
            if (snapshot) g_variant_unref(snapshot);
            g_object_unref(cancel);
        }
        using Variant = std::unique_ptr<GVariant, decltype(&g_variant_unref)>;
        using Proxy = std::unique_ptr<GDBusInterface, decltype(&g_object_unref)>;
        static Variant property(GDBusInterface *proxy, const char *key) {
            return Variant(proxy ? g_dbus_proxy_get_cached_property(G_DBUS_PROXY(proxy), key) : nullptr, g_variant_unref);
        }
        static int number(GDBusInterface *proxy, const char *key, int fallback = -1) {
            auto value = property(proxy, key);
            if (!value) return fallback;
            if (g_variant_is_of_type(value.get(), G_VARIANT_TYPE_UINT32)) return g_variant_get_uint32(value.get());
            if (g_variant_is_of_type(value.get(), G_VARIANT_TYPE_INT32)) return g_variant_get_int32(value.get());
            if (g_variant_is_of_type(value.get(), G_VARIANT_TYPE_BYTE)) return g_variant_get_byte(value.get());
            return fallback;
        }
        static bool flag(GDBusInterface *proxy, const char *key, bool fallback = false) {
            auto value = property(proxy, key);
            return value && g_variant_is_of_type(value.get(), G_VARIANT_TYPE_BOOLEAN) ? g_variant_get_boolean(value.get()) : fallback;
        }
        static std::string string(GDBusInterface *proxy, const char *key) {
            auto value = property(proxy, key);
            return value && (g_variant_is_of_type(value.get(), G_VARIANT_TYPE_STRING) || g_variant_is_of_type(value.get(), G_VARIANT_TYPE_OBJECT_PATH))
                ? g_variant_get_string(value.get(), nullptr) : "";
        }
        static Proxy interface(GDBusObjectManager *manager, const std::string &path, const char *name) {
            return Proxy(manager ? g_dbus_object_manager_get_interface(manager, path.c_str(), name) : nullptr, g_object_unref);
        }
        static bool available(GDBusObjectManager *manager) {
            if (!manager) return false;
            gchar *owner = g_dbus_object_manager_client_get_name_owner(G_DBUS_OBJECT_MANAGER_CLIENT(manager));
            bool result = owner != nullptr; g_free(owner); return result;
        }
        static std::string file(const std::string &path) {
            gchar *text = nullptr;
            if (!g_file_get_contents(path.c_str(), &text, nullptr, nullptr)) return "";
            std::string result = g_strstrip(text); g_free(text); return result;
        }
        void read_battery() {
            battery_present = external_power = false;
            battery_percent = -1; battery_state = "unknown";
            GDir *directory = g_dir_open(supplies.c_str(), 0, nullptr);
            if (!directory) { schedule(); return; }
            const char *name;
            while ((name = g_dir_read_name(directory))) {
                std::string path = supplies + "/" + name + "/";
                if (file(path + "type") != "Battery") {
                    external_power |= file(path + "online") == "1";
                    continue;
                }
                if (battery_present || file(path + "present") == "0") continue;
                battery_present = true;
                std::string capacity = file(path + "capacity");
                char *end = nullptr;
                long percent = g_ascii_strtoll(capacity.c_str(), &end, 10);
                if (!capacity.empty() && end && !*end && percent >= 0 && percent <= 100) battery_percent = percent;
                std::string status = file(path + "status");
                battery_state = status == "Charging" ? "charging" : status == "Discharging" ? "discharging"
                    : status == "Full" ? "full" : status == "Not charging" ? "not-charging" : "unknown";
            }
            g_dir_close(directory);
            schedule();
        }
        GVariant *state() {
            GVariantBuilder result; g_variant_builder_init(&result, G_VARIANT_TYPE_VARDICT);
            auto text = [&](const char *key, const std::string &value) { g_variant_builder_add(&result, "{sv}", key, g_variant_new_string(value.c_str())); };
            auto integer = [&](const char *key, int value) { g_variant_builder_add(&result, "{sv}", key, g_variant_new_int32(value)); };
            auto boolean = [&](const char *key, bool value) { g_variant_builder_add(&result, "{sv}", key, g_variant_new_boolean(value)); };
            boolean("BatteryPresent", battery_present); integer("BatteryPercent", battery_percent);
            text("BatteryState", battery_state); boolean("ExternalPower", external_power);

            const char *NM = "org.freedesktop.NetworkManager";
            auto manager = interface(network, "/org/freedesktop/NetworkManager", NM);
            const bool online = available(network);
            const bool enabled = online && flag(manager.get(), "NetworkingEnabled");
            int state = number(manager.get(), "State"), connectivity = number(manager.get(), "Connectivity");
            boolean("NetworkAvailable", online);
            text("NetworkState", !online ? "unavailable" : !enabled ? "disabled" : state >= 50 ? "connected" : state == 40 ? "connecting" : "offline");
            text("NetworkConnectivity", connectivity == 4 ? "full" : connectivity == 3 ? "limited" : connectivity == 2 ? "portal" : connectivity == 1 ? "none" : "unknown");
            std::string type = string(manager.get(), "PrimaryConnectionType");
            text("NetworkType", type == "802-11-wireless" ? "wifi" : type == "gsm" || type == "cdma" ? "cellular"
                : type == "802-3-ethernet" ? "ethernet" : type.empty() ? "none" : "other");
            std::string wifi = "unavailable", ssid;
            int strength = -1, best = -1;
            if (online && (!enabled || !flag(manager.get(), "WirelessEnabled") || !flag(manager.get(), "WirelessHardwareEnabled"))) wifi = "disabled";
            active_ap.clear();
            GList *devices = online ? g_dbus_object_manager_get_objects(network) : nullptr;
            for (GList *entry = devices; entry; entry = entry->next) {
                auto *object = G_DBUS_OBJECT(entry->data);
                Proxy wireless(g_dbus_object_get_interface(object, "org.freedesktop.NetworkManager.Device.Wireless"), g_object_unref);
                if (!wireless || wifi == "disabled") continue;
                Proxy device(g_dbus_object_get_interface(object, "org.freedesktop.NetworkManager.Device"), g_object_unref);
                int ds = number(device.get(), "State");
                int rank = ds == 100 ? 3 : ds >= 40 && ds <= 90 ? 2 : ds >= 30 ? 1 : 0;
                if (rank <= best) continue;
                best = rank;
                wifi = rank == 3 ? "connected" : rank == 2 ? "connecting" : rank == 1 ? "disconnected" : "unavailable";
                strength = -1; ssid.clear();
                if (rank != 3) continue;
                active_ap = string(wireless.get(), "ActiveAccessPoint");
                auto ap = interface(network, active_ap, "org.freedesktop.NetworkManager.AccessPoint");
                strength = number(ap.get(), "Strength");
                auto bytes = property(ap.get(), "Ssid");
                if (bytes && g_variant_is_of_type(bytes.get(), G_VARIANT_TYPE("ay"))) {
                    gsize size = 0;
                    auto *data = static_cast<const char *>(g_variant_get_fixed_array(bytes.get(), &size, 1));
                    if (size) { gchar *utf8 = g_utf8_make_valid(data, size); ssid = utf8; g_free(utf8); }
                }
            }
            g_list_free_full(devices, g_object_unref);
            text("WifiState", wifi); integer("WifiStrength", strength); text("WifiSsid", ssid);

            std::string cellular = "unavailable", technology, operator_name;
            int quality = -1; best = -2;
            GList *objects = available(modems) ? g_dbus_object_manager_get_objects(modems) : nullptr;
            for (GList *entry = objects; entry; entry = entry->next) {
                auto *object = G_DBUS_OBJECT(entry->data);
                Proxy modem(g_dbus_object_get_interface(object, "org.freedesktop.ModemManager1.Modem"), g_object_unref);
                if (!modem) continue;
                int ms = number(modem.get(), "State");
                if (ms <= best) continue;
                best = ms;
                cellular = ms >= 8 ? "registered" : ms == 7 ? "searching" : ms == 2 ? "locked" : ms == 3 || ms == 4 ? "disabled" : ms < 0 ? "failed" : "offline";
                quality = -1; technology.clear(); operator_name.clear();
                if (ms < 8) continue;
                auto signal = property(modem.get(), "SignalQuality");
                if (signal && g_variant_is_of_type(signal.get(), G_VARIANT_TYPE("(ub)"))) {
                    guint32 percent; gboolean recent;
                    g_variant_get(signal.get(), "(ub)", &percent, &recent);
                    if (recent && percent <= 100) quality = percent;
                }
                unsigned access = number(modem.get(), "AccessTechnologies", 0);
                if (access == 0xffffffffu) access = 0;
                technology = access & (1u << 15) ? "5G" : access & ((1u << 14) | (1u << 16) | (1u << 17)) ? "4G"
                    : access & 0x3fe0 ? "3G" : access & 0x1e ? "2G" : "";
                Proxy registration(g_dbus_object_get_interface(object, "org.freedesktop.ModemManager1.Modem.Modem3gpp"), g_object_unref);
                int rs = number(registration.get(), "RegistrationState");
                if (rs == 5 || rs == 7 || rs == 10) cellular = "roaming";
                operator_name = string(registration.get(), "OperatorName");
            }
            g_list_free_full(objects, g_object_unref);
            if (online && (!enabled || !flag(manager.get(), "WwanEnabled") || !flag(manager.get(), "WwanHardwareEnabled"))) {
                cellular = "disabled"; quality = -1; technology.clear(); operator_name.clear();
            }
            text("CellularState", cellular); integer("CellularStrength", quality);
            text("CellularTechnology", technology); text("CellularOperator", operator_name);
            return g_variant_ref_sink(g_variant_builder_end(&result));
        }
        void publish() {
            GVariant *next = state();
            bool changed = !snapshot || !g_variant_equal(snapshot, next);
            if (snapshot) g_variant_unref(snapshot);
            snapshot = next;
            if (changed && notify) notify();
        }
        void schedule() {
            if (idle) return;
            idle = g_idle_add([](gpointer data) -> gboolean {
                auto *self = static_cast<Data *>(data); self->idle = 0; self->publish(); return G_SOURCE_REMOVE;
            }, this);
        }
        void attach(GDBusConnection *bus, const char *name, const char *path, bool cellular) {
            struct Request { std::shared_ptr<Data> self; bool cellular; };
            auto *request = new Request{shared_from_this(), cellular};
            g_dbus_object_manager_client_new(bus, G_DBUS_OBJECT_MANAGER_CLIENT_FLAGS_DO_NOT_AUTO_START, name, path,
                nullptr, nullptr, nullptr, cancel, [](GObject *, GAsyncResult *result, gpointer data) {
                    std::unique_ptr<Request> request(static_cast<Request *>(data));
                    GError *error = nullptr;
                    GDBusObjectManager *manager = g_dbus_object_manager_client_new_finish(result, &error);
                    g_clear_error(&error);
                    if (!manager) return;
                    auto *self = request->self.get();
                    if (g_cancellable_is_cancelled(self->cancel)) { g_object_unref(manager); return; }
                    (request->cellular ? self->modems : self->network) = manager;
                    auto object_changed = G_CALLBACK(+[](GDBusObjectManager *, GDBusObject *, gpointer data) { static_cast<Data *>(data)->schedule(); });
                    g_signal_connect(manager, "object-added", object_changed, self);
                    g_signal_connect(manager, "object-removed", object_changed, self);
                    g_signal_connect(manager, "notify::name-owner", G_CALLBACK(+[](GObject *, GParamSpec *, gpointer data) { static_cast<Data *>(data)->schedule(); }), self);
                    auto interface_changed = G_CALLBACK(+[](GDBusObjectManager *, GDBusObject *, GDBusInterface *, gpointer data) { static_cast<Data *>(data)->schedule(); });
                    g_signal_connect(manager, "interface-added", interface_changed, self);
                    g_signal_connect(manager, "interface-removed", interface_changed, self);
                    g_signal_connect(manager, "interface-proxy-properties-changed", G_CALLBACK((+[](GDBusObjectManagerClient *, GDBusObjectProxy *, GDBusProxy *proxy, GVariant *changed, const gchar *const *invalidated, gpointer data) {
                        // Scan lists, counters, addresses and unrelated AP traffic
                        // do not alter the status display.
                        static const char *keys[] = {"NetworkingEnabled", "WirelessEnabled", "WirelessHardwareEnabled", "WwanEnabled", "WwanHardwareEnabled", "State", "Connectivity", "PrimaryConnectionType", "ActiveAccessPoint", "Strength", "Ssid", "SignalQuality", "AccessTechnologies", "RegistrationState", "OperatorName"};
                        auto *self = static_cast<Data *>(data);
                        if (!strcmp(g_dbus_proxy_get_interface_name(proxy), "org.freedesktop.NetworkManager.AccessPoint") && self->active_ap != g_dbus_proxy_get_object_path(proxy)) return;
                        bool relevant = invalidated && invalidated[0];
                        for (const char *key : keys) { GVariant *value = g_variant_lookup_value(changed, key, nullptr); if (value) { relevant = true; g_variant_unref(value); break; } }
                        if (relevant) static_cast<Data *>(data)->schedule();
                    })), self);
                    self->schedule();
                }, request);
        }
    };
    std::shared_ptr<Data> data = std::make_shared<Data>();
public:
    SystemStatus(std::string supplies, std::function<void()> notify) {
        data->supplies = std::move(supplies);
        data->read_battery(); data->publish();
        data->notify = std::move(notify);
    }
    ~SystemStatus() {
        data->notify = nullptr;
        g_cancellable_cancel(data->cancel);
        if (data->idle) { g_source_remove(data->idle); data->idle = 0; }
    }
    void connect(GDBusConnection *bus) {
        data->attach(bus, "org.freedesktop.NetworkManager", "/org/freedesktop", false);
        data->attach(bus, "org.freedesktop.ModemManager1", "/org/freedesktop/ModemManager1", true);
    }
    void battery_changed() { data->read_battery(); }
    void append(GVariantBuilder &result) {
        GVariantIter iter; g_variant_iter_init(&iter, data->snapshot);
        const char *key; GVariant *value;
        while (g_variant_iter_next(&iter, "{&sv}", &key, &value)) {
            g_variant_builder_add(&result, "{sv}", key, value); g_variant_unref(value);
        }
    }
};
