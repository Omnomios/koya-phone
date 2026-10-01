#include "module.hpp"
#include "backlight.hpp"
#include <libevdev/libevdev.h>
#include <libudev.h>
#include <unistd.h>
#include <fcntl.h>
#include <array>
#include <map>
#include <memory>
#include <vector>
#include <cstring>
#include <cerrno>
struct LinuxDevice;
struct Device {
    LinuxDevice *owner;
    std::string path;
    int fd;
    libevdev *ev{};
    guint source{};
    bool sync = false;
    std::array<bool, 3> blocked{};
    ~Device();
};
struct LinuxDevice: NativeModule {
    bool active = false;
    udev *udev_context = nullptr;
    udev_monitor *monitor = nullptr;
    guint monitor_source = 0;
    std::map<std::string, std::unique_ptr<Device>> devices;
    using NativeModule::NativeModule;
    void event(const char *kind, unsigned code = 0, unsigned value = 0, const char *message = "") {
        JSValue data = JS_NewObject(js);
        JS_SetPropertyStr(js, data, "kind", JS_NewString(js, kind));
        JS_SetPropertyStr(js, data, "code", JS_NewUint32(js, code));
        JS_SetPropertyStr(js, data, "value", JS_NewUint32(js, value));
        JS_SetPropertyStr(js, data, "message", JS_NewString(js, message));
        emit(data);
    }
    void reset_input() { event("reset"); }
    void button(unsigned code, unsigned value) { event("button", code, value); }
    void log_error(const std::string &message) { event("error", 0, 0, message.c_str()); }
    void shutdown() override {
        active = false; devices.clear(); remove(monitor_source);
        if (monitor) { udev_monitor_unref(monitor); monitor = nullptr; }
        if (udev_context) { udev_unref(udev_context); udev_context = nullptr; }
    }
    void add_device(const char*path) {
#ifndef KOYA_TESTING
        if (!active || !path || devices.count(path)) {
            return;
        }
        int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
        if (fd < 0) {
            g_warning("Cannot open input %s: %s", path, strerror(errno));
            return;
        }
        auto d = std::make_unique<Device>();
        d->owner = this;
        d->path = path;
        d->fd = fd;
        if (libevdev_new_from_fd(fd, &d->ev) < 0) {
            return;
        }
        const char*name = libevdev_get_name(d->ev);
        if (!name || (strcmp(name, "pm8941_pwrkey") && strcmp(name, "Volume keys"))) {
            return;
        }
        bool relevant = false;
        for (unsigned code = 0; code <= KEY_MAX; code++)
            if (libevdev_has_event_code(d->ev, EV_KEY, code)) {
                if (code < KEY_VOLUMEDOWN || code > KEY_POWER) {
                    return;
                }
                relevant = true;
            }
        if (!relevant) {
            return;
        }
        if (libevdev_grab(d->ev, LIBEVDEV_GRAB) < 0) {
            log_error(std::string("Cannot capture ") + name);
            return;
        }
        for (unsigned k = KEY_VOLUMEDOWN; k <= KEY_POWER; k++) {
            d->blocked[k - KEY_VOLUMEDOWN] = libevdev_get_event_value(d->ev, EV_KEY, k) != 0;
        }
        d->source = watch(fd, static_cast<GIOCondition>(G_IO_IN | G_IO_HUP | G_IO_ERR), [](gint, GIOCondition cond, gpointer p)->gboolean{
            auto*d = static_cast<Device*>(p); auto*s = d->owner;
            if (cond & (G_IO_HUP | G_IO_ERR)) {
                std::string path = d->path;
                d->source = 0;
                s->reset_input();
                s->devices.erase(path);
                return G_SOURCE_REMOVE;
            }
            input_event event{}; int rc;
            while (true) {
                rc = libevdev_next_event(d->ev, d->sync ? LIBEVDEV_READ_FLAG_SYNC : LIBEVDEV_READ_FLAG_NORMAL, &event);
                if (rc == LIBEVDEV_READ_STATUS_SYNC) {
                    d->sync = true;
                    s->reset_input();
                    continue;
                }
                if (rc == -EAGAIN && d->sync) {
                    d->sync = false;
                    for (unsigned k = KEY_VOLUMEDOWN; k <= KEY_POWER; k++) {
                        d->blocked[k - KEY_VOLUMEDOWN] = libevdev_get_event_value(d->ev, EV_KEY, k) != 0;
                    }
                    continue;
                }
                if (rc < 0) {
                    break;
                }
                if (event.type == EV_KEY && event.code >= KEY_VOLUMEDOWN && event.code <= KEY_POWER) {
                    if (d->blocked[event.code - KEY_VOLUMEDOWN]) {
                        if (event.value == 0) {
                            d->blocked[event.code - KEY_VOLUMEDOWN] = false;
                        }
                        continue;
                    }
                    s->button(event.code, event.value);
                }
            }
            if (rc != -EAGAIN) {
                std::string path = d->path;
                d->source = 0;
                s->reset_input();
                s->devices.erase(path);
                return G_SOURCE_REMOVE;
            }
            return G_SOURCE_CONTINUE;
        }, d.get());
        g_message("Capturing %s (%s)", name, path);
        devices.emplace(path, std::move(d));
#else
        (void)path;
#endif
    }
    void scan() {
        if (!active || !udev_context) {
            return;
        }
        udev_enumerate*e = udev_enumerate_new(udev_context);
        udev_enumerate_add_match_subsystem(e, "input");
        udev_enumerate_scan_devices(e);
        udev_list_entry*entry;
        udev_list_entry_foreach(entry, udev_enumerate_get_list_entry(e)) {
            udev_device*d = udev_device_new_from_syspath(udev_context, udev_list_entry_get_name(entry));
            if (d) {
                add_device(udev_device_get_devnode(d));
                udev_device_unref(d);
            }
        }
        udev_enumerate_unref(e);
    }

    static JSValue start(NativeModule *base, int argc, JSValueConst *argv) {
        auto *self = static_cast<LinuxDevice *>(base);
        if (argc != 1 || !JS_IsFunction(base->js, argv[0])) return JS_ThrowTypeError(base->js, "start expects an event callback");
        self->shutdown(); self->subscribe(argv[0]);
#ifndef KOYA_TESTING
        self->udev_context = udev_new();
        if (!self->udev_context) return JS_ThrowInternalError(base->js, "Cannot initialize udev");
        self->monitor = udev_monitor_new_from_netlink(self->udev_context, "udev");
        if (!self->monitor) return JS_ThrowInternalError(base->js, "Cannot monitor udev");
        for (const char *subsystem : {"input", "power_supply", "backlight"}) udev_monitor_filter_add_match_subsystem_devtype(self->monitor, subsystem, nullptr);
        udev_monitor_enable_receiving(self->monitor);
        self->monitor_source = self->watch(udev_monitor_get_fd(self->monitor), G_IO_IN, [](gint, GIOCondition, gpointer data)->gboolean {
            auto *self = static_cast<LinuxDevice *>(data); udev_device *device;
            while ((device = udev_monitor_receive_device(self->monitor))) {
                const char *subsystem = udev_device_get_subsystem(device);
                if (subsystem && !strcmp(subsystem, "backlight")) self->event("brightness");
                else if (subsystem && !strcmp(subsystem, "power_supply")) self->event("battery");
                else {
                    const char *path = udev_device_get_devnode(device), *action = udev_device_get_action(device);
                    if (path && action) {
                        if (!strcmp(action, "remove")) { if (self->devices.erase(path)) self->reset_input(); }
                        else if (!strcmp(action, "add") || !strcmp(action, "change")) self->add_device(path);
                    }
                }
                udev_device_unref(device);
            }
            return G_SOURCE_CONTINUE;
        }, self);
#endif
        return JS_UNDEFINED;
    }
    static JSValue set_active(NativeModule *base, int argc, JSValueConst *argv) {
        auto *self = static_cast<LinuxDevice *>(base);
        if (argc != 1 || !JS_IsBool(argv[0])) return JS_ThrowTypeError(base->js, "setActive expects a boolean");
        bool value = JS_ToBool(base->js, argv[0]);
        if (self->active != value) { self->active = value; self->devices.clear(); self->reset_input(); if (value) self->scan(); }
        return JS_UNDEFINED;
    }
    static std::string file(const std::string &path) {
        gchar *text = nullptr; if (!g_file_get_contents(path.c_str(), &text, nullptr, nullptr)) return "";
        std::string result = g_strstrip(text); g_free(text); return result;
    }
    static JSValue battery(NativeModule *base, int, JSValueConst *) {
        std::string supplies = "/sys/class/power_supply";
#ifdef KOYA_TESTING
        supplies = g_getenv("KOYA_TEST_POWER_SUPPLY_DIR") ? g_getenv("KOYA_TEST_POWER_SUPPLY_DIR") : "/nonexistent/koya-test-power-supply";
#endif
        bool present = false, external = false; int percent = -1; std::string state = "unknown";
        GDir *dir = g_dir_open(supplies.c_str(), 0, nullptr);
        if (dir) {
            while (const char *name = g_dir_read_name(dir)) {
                std::string path = supplies + "/" + name + "/";
                if (file(path + "type") != "Battery") { external |= file(path + "online") == "1"; continue; }
                if (present || file(path + "present") == "0") continue;
                present = true; std::string capacity = file(path + "capacity"); char *end = nullptr;
                long number = g_ascii_strtoll(capacity.c_str(), &end, 10);
                if (!capacity.empty() && end && !*end && number >= 0 && number <= 100) percent = number;
                std::string value = file(path + "status");
                state = value == "Charging" ? "charging" : value == "Discharging" ? "discharging" : value == "Full" ? "full" : value == "Not charging" ? "not-charging" : "unknown";
            }
            g_dir_close(dir);
        }
        JSValue result = JS_NewObject(base->js);
        JS_SetPropertyStr(base->js, result, "BatteryPresent", JS_NewBool(base->js, present));
        JS_SetPropertyStr(base->js, result, "BatteryPercent", JS_NewInt32(base->js, percent));
        JS_SetPropertyStr(base->js, result, "BatteryState", JS_NewString(base->js, state.c_str()));
        JS_SetPropertyStr(base->js, result, "ExternalPower", JS_NewBool(base->js, external));
        return result;
    }
    static JSValue brightness(NativeModule *base, int, JSValueConst *) {
        Backlight device = Backlight::read(); GVariant *state = g_variant_ref_sink(device.variant());
        JSValue result = variant(base->js, state); g_variant_unref(state);
        JS_SetPropertyStr(base->js, result, "Maximum", JS_NewUint32(base->js, device.maximum));
        return result;
    }
};
Device::~Device() { owner->remove(source); if (ev) libevdev_free(ev); close(fd); }
extern "C" HELIX_PLUGIN_EXPORT int helix_plugin_integrate(JSContext *ctx, const char *name, const HelixPluginHost *host, HelixPluginInstance **out) {
    auto *self = new LinuxDevice(ctx);
    self->functions = {{"start", LinuxDevice::start}, {"setActive", LinuxDevice::set_active}, {"battery", LinuxDevice::battery}, {"brightness", LinuxDevice::brightness}};
    if (self->integrate(name, host, out)) return 0;
    delete self; return 1;
}
