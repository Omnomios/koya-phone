// SPDX-License-Identifier: MIT
#include <gio/gio.h>
#include <glib-unix.h>
#include <libevdev/libevdev.h>
#include <libudev.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <poll.h>
#include <sys/file.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <cerrno>
#include <cstring>
#include <array>
#include <deque>
#include <map>
#include <memory>
#include <string>
#include <vector>
#include "desktop.hpp"
#include "status.hpp"
#include "keyboard.hpp"
#include "notification-transport.hpp"
#include "backlight.hpp"
#include "settings.hpp"
#include "authentication.hpp"

static constexpr const char *BUS = "org.koya.Shell1", *PATH = "/org/koya/Shell1";
static constexpr const char *LOGIN = "org.freedesktop.login1", *LOGIN_PATH = "/org/freedesktop/login1";
static constexpr const char *MANAGER = "org.freedesktop.login1.Manager";
static const char XML[] = R"XML(<node><interface name="org.koya.Shell1">
 <method name="GetState"><arg name="state" type="a{sv}" direction="out"/></method>
 <method name="SetSetting"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="out"/></method>
 <method name="DesktopViewVisible"><arg type="b" direction="in"/></method>
 <method name="ShowPowerMenu"/><method name="DismissPowerMenu"/>
 <method name="PowerOff"/><method name="Reboot"/>
 <method name="Suspend"/>
 <method name="Lock"/><method name="Unlock"/>
 <method name="ShowDesktopView"><arg type="s" direction="in"/></method>
 <method name="DismissDesktopView"/>
 <method name="ToggleKeyboard"/>
 <method name="GetBrightness"><arg type="a{sv}" direction="out"/></method>
 <method name="SetBrightness"><arg type="u" direction="in"/><arg type="a{sv}" direction="out"/></method>
 <signal name="BrightnessChanged"/>
 <method name="RegisterNotifications"/>
 <method name="ReplyNotification"><arg type="u" direction="in"/><arg type="a{sv}" direction="in"/></method>
 <method name="EmitNotification"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/><arg type="u" direction="in"/></method>
 <signal name="NotificationRequest"><arg type="s"/></signal>
 <method name="Askpass"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
 <method name="AuthenticationRespond"><arg type="u" direction="in"/><arg type="s" direction="in"/></method>
 <method name="AuthenticationCancel"><arg type="u" direction="in"/></method>
 <signal name="AuthenticationBegin"><arg type="u"/><arg type="s"/><arg type="s"/><arg type="s"/></signal>
 <signal name="AuthenticationPrompt"><arg type="u"/><arg type="s"/><arg type="b"/></signal>
 <signal name="AuthenticationMessage"><arg type="u"/><arg type="s"/><arg type="b"/></signal>
 <signal name="AuthenticationEnd"><arg type="u"/></signal>
 <method name="GetApplications"><arg type="aa{sv}" direction="out"/></method>
 <method name="ResolveIcon"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
 <method name="GetDesktopState"><arg type="a{sv}" direction="out"/></method>
 <method name="LaunchApplication"><arg type="s" direction="in"/><arg type="u" direction="in"/></method>
 <method name="SwitchDesktop"><arg type="u" direction="in"/></method>
 <method name="FocusWindow"><arg type="s" direction="in"/></method>
 <method name="CloseWindow"><arg type="s" direction="in"/></method>
 <signal name="DesktopChanged"/>
 <signal name="ApplicationsChanged"/>
 <method name="Ready"><arg name="component" type="s" direction="in"/></method>
 <signal name="StateChanged"><arg name="state" type="a{sv}"/></signal>
 <signal name="HardwareButton"><arg name="event" type="a{sv}"/></signal>
 <signal name="HardwareButtonEvent"><arg name="event" type="s"/></signal>
 </interface>)XML";
// Test injection is compiled into a separate executable, never the live daemon.
static std::string protocol_xml() {
    std::string xml(XML);
#ifdef KOYA_TESTING
    xml += R"XML(<interface name="org.koya.Shell1.Test">
 <method name="Button"><arg type="u" direction="in"/><arg type="u" direction="in"/></method>
 <method name="DeviceLost"/><method name="Idle"/><method name="Activity"/><method name="PowerSupplyChanged"/>
 <method name="AuthenticationDemo"/>
 <method name="AuthenticationAnswer"><arg type="u" direction="in"/><arg type="s" direction="in"/></method>
 <method name="AuthenticationDismiss"><arg type="u" direction="in"/></method>
 </interface>)XML";
#endif
    return xml + "</node>";
}
class Session;
struct Component {
    Session *owner{};
    std::string name, status = "stopped";
    GSubprocess *process{};
    guint retry{}, deadline{}, kill_timer{};
    guint32 pid = 0;
    bool expected = false;
    std::deque<gint64> restarts;
};
struct Device {
    Session *owner;
    std::string path;
    int fd;
    libevdev *ev{};
    guint source{};
    bool sync = false;
    std::array<bool, 3> blocked{};
    ~Device() {
        if (source) {
            g_source_remove(source);
        }
        if (ev) {
            libevdev_free(ev);
        }
        close(fd);
    }
};
static void remove_timer(guint &id) {
    if (id) {
        g_source_remove(id);
        id = 0;
    }
}
static void fail(GDBusMethodInvocation *i, const char *message) {
    g_dbus_method_invocation_return_dbus_error(i, "org.koya.Shell1.Error", message);
}
class Session {
  public:
    GMainLoop *loop = g_main_loop_new(nullptr, FALSE);
    GDBusConnection *bus{}, *system{};
    GDBusNodeInfo *node{};
    std::array<Component, 7> components;
    Desktop desktop;
    std::unique_ptr<SystemStatus> status;
    std::unique_ptr<Keyboard> keyboard;
    std::unique_ptr<NotificationTransport> notification_transport;
    std::unique_ptr<AuthenticationAgent> authentication;
    guint authentication_retry{};
    bool keyboard_available = false, keyboard_visible = false;
    std::string desktop_view = "closed";
    bool desktop_mapped = false;
    std::string root, executable = "/usr/bin/koya", assets = "/usr/share/koya/assets", fixture;
    std::string session_path, menu = "closed", error, power_cap = "unknown", reboot_cap = "unknown", suspend_cap = "unknown", screen = "unlocked";
    bool active = false, stopping = false, power_down = false, pending = false;
    bool display_off = false, preparing_sleep = false, suspend_pending = false;
    gint64 wake_key_until = 0;
    unsigned resume_count = 0;
    guint hold{}, unlock_timer{}, display_source{}, idle_dispatch{}, system_watch{}, properties_watch{}, system_retry{};
    guint sleep_watch{};
    unsigned login_generation = 0, idle_generation = 0;
    unsigned idle_lock_seconds = 120, idle_screen_seconds = 30, idle_suspend_seconds = 180, configured_idle = G_MAXUINT;
    // Configuration transport only; volume policy, subscriptions and UI are in Koya.
    bool volume_buttons = true, volume_indicator = true, volume_locked = true;
    unsigned volume_step = 5, volume_max = 100, volume_timeout = 1800, volume_margin = 16, volume_position = 50;
    std::string volume_side = "left", volume_sink;
    bool haptics_enabled = true;
    bool auto_rotate = true;
    unsigned haptics_interval = 45, brightness_minimum = 5;
    std::string wallpaper_id = "earthy-green";
    int lock_fd = -1, display_fd = -1;
    udev *udev_context{};
    udev_monitor *monitor{};
    guint monitor_source{};
    std::map<std::string, std::unique_ptr<Device>> devices;
    Session(std::string dir): desktop(dir), root(std::move(dir)) {
        const char *names[] = {"wallpaper", "top-bar", "power-menu", "lock-screen", "navigation", "keyboard", "authentication"};
        for (unsigned i = 0; i < components.size(); i++) {
            components[i].owner = this;
            components[i].name = names[i];
        }
    }
    ~Session() {
        remove_timer(authentication_retry);
        authentication.reset();
        notification_transport.reset();
        keyboard.reset();
        status.reset();
        remove_timer(system_retry);
        remove_timer(unlock_timer);
        remove_timer(idle_dispatch);
        remove_timer(display_source);
        if (display_fd >= 0) close(display_fd);
        devices.clear();
        if (monitor_source) {
            g_source_remove(monitor_source);
        }
        if (monitor) {
            udev_monitor_unref(monitor);
        }
        if (udev_context) {
            udev_unref(udev_context);
        }
        if (system_watch) {
            g_bus_unwatch_name(system_watch);
        }
        if (properties_watch) {
            g_dbus_connection_signal_unsubscribe(system, properties_watch);
        }
        if (sleep_watch) g_dbus_connection_signal_unsubscribe(system, sleep_watch);
        if (node) {
            g_dbus_node_info_unref(node);
        }
        if (system) {
            g_object_unref(system);
        }
        if (bus) {
            g_object_unref(bus);
        }
        if (lock_fd >= 0) {
            close(lock_fd);
        }
        g_main_loop_unref(loop);
    }
    GVariant *state() {
        GVariantBuilder b;
        g_variant_builder_init(&b, G_VARIANT_TYPE_VARDICT);
        auto s = [&](const char*k, const std::string & v) {
            g_variant_builder_add(&b, "{sv}", k, g_variant_new_string(v.c_str()));
        };
        g_variant_builder_add(&b, "{sv}", "Active", g_variant_new_boolean(active));
        s("PowerMenuState", menu);
        s("ScreenState", screen);
        g_variant_builder_add(&b, "{sv}", "DisplayOff", g_variant_new_boolean(display_off));
        g_variant_builder_add(&b, "{sv}", "PreparingForSleep", g_variant_new_boolean(preparing_sleep));
        g_variant_builder_add(&b, "{sv}", "SuspendPending", g_variant_new_boolean(suspend_pending));
        g_variant_builder_add(&b, "{sv}", "ResumeCount", g_variant_new_uint32(resume_count));
        s("DesktopView", desktop_view);
        g_variant_builder_add(&b, "{sv}", "DesktopViewMapped", g_variant_new_boolean(desktop_mapped));
        g_variant_builder_add(&b, "{sv}", "DesktopAvailable", g_variant_new_boolean(desktop.available));
        g_variant_builder_add(&b, "{sv}", "KeyboardAvailable", g_variant_new_boolean(keyboard && keyboard->available()));
        g_variant_builder_add(&b, "{sv}", "KeyboardVisible", g_variant_new_boolean(keyboard && keyboard->visible()));
        g_variant_builder_add(&b, "{sv}", "KeyboardPending", g_variant_new_boolean(keyboard && keyboard->pending()));
        g_variant_builder_add(&b, "{sv}", "IdleLockSeconds", g_variant_new_uint32(idle_lock_seconds));
        g_variant_builder_add(&b, "{sv}", "IdleScreenSeconds", g_variant_new_uint32(idle_screen_seconds));
        g_variant_builder_add(&b, "{sv}", "IdleSuspendSeconds", g_variant_new_uint32(idle_suspend_seconds));
        g_variant_builder_add(&b, "{sv}", "VolumeButtonsEnabled", g_variant_new_boolean(volume_buttons));
        g_variant_builder_add(&b, "{sv}", "VolumeIndicatorEnabled", g_variant_new_boolean(volume_indicator));
        g_variant_builder_add(&b, "{sv}", "VolumeWhileLocked", g_variant_new_boolean(volume_locked));
        g_variant_builder_add(&b, "{sv}", "VolumeStepPercent", g_variant_new_uint32(volume_step));
        g_variant_builder_add(&b, "{sv}", "VolumeMaxPercent", g_variant_new_uint32(volume_max));
        g_variant_builder_add(&b, "{sv}", "VolumeIndicatorTimeoutMs", g_variant_new_uint32(volume_timeout));
        g_variant_builder_add(&b, "{sv}", "VolumeIndicatorMargin", g_variant_new_uint32(volume_margin));
        g_variant_builder_add(&b, "{sv}", "VolumeIndicatorPositionPercent", g_variant_new_uint32(volume_position));
        s("VolumeIndicatorSide", volume_side); s("VolumeSink", volume_sink);
        g_variant_builder_add(&b, "{sv}", "HapticsEnabled", g_variant_new_boolean(haptics_enabled));
        g_variant_builder_add(&b, "{sv}", "HapticsMinIntervalMs", g_variant_new_uint32(haptics_interval));
        g_variant_builder_add(&b, "{sv}", "BrightnessMinPercent", g_variant_new_uint32(brightness_minimum));
        s("Wallpaper", wallpaper_id);
        g_variant_builder_add(&b, "{sv}", "AutoRotateEnabled", g_variant_new_boolean(auto_rotate));
        s("LastError", error);
        s("CanPowerOff", power_cap);
        s("CanReboot", reboot_cap);
        s("CanSuspend", suspend_cap);
        if (status) status->append(b);
        for (auto &c : components) {
            s((c.name + "Status").c_str(), c.status);
            guint32 pid = c.pid;
            g_variant_builder_add(&b, "{sv}", (c.name + "Pid").c_str(), g_variant_new_uint32(pid));
        }
        return g_variant_builder_end(&b);
    }
    void changed() {
        update_idle();
        if (bus && !g_dbus_connection_is_closed(bus)) {
            g_dbus_connection_emit_signal(bus, nullptr, PATH, BUS, "StateChanged", g_variant_new("(@a{sv})", state()), nullptr);
        }
    }
    void log_error(const std::string &value) {
        error = value;
        g_warning("%s", value.c_str());
        changed();
    }
    Component &overlay() {
        return components[2];
    }
    void cancel_hold() {
        remove_timer(hold);
        power_down = false;
    }
    void button(unsigned key, unsigned value) {
        if (!active || stopping || key < KEY_VOLUMEDOWN || key > KEY_POWER || value > 2) {
            return;
        }
        if (value == 1 || value == 2) update_idle(true);
        const char *name = key == KEY_POWER ? "power" : key == KEY_VOLUMEUP ? "volume-up" : "volume-down";
        const char *edge = value == 0 ? "released" : value == 1 ? "pressed" : "repeat";
        GVariantBuilder event;
        g_variant_builder_init(&event, G_VARIANT_TYPE_VARDICT);
        g_variant_builder_add(&event, "{sv}", "Button", g_variant_new_string(name));
        g_variant_builder_add(&event, "{sv}", "State", g_variant_new_string(edge));
        g_dbus_connection_emit_signal(bus, nullptr, PATH, BUS, "HardwareButton", g_variant_new("(@a{sv})", g_variant_builder_end(&event)), nullptr);
        // Retain the JSON mirror for older external clients. The shell uses
        // the typed HardwareButton signal with build 888's decoded args.
        std::string json = std::string("{\"Button\":\"") + name + "\",\"State\":\"" + edge + "\"}";
        g_dbus_connection_emit_signal(bus, nullptr, PATH, BUS, "HardwareButtonEvent", g_variant_new("(s)", json.c_str()), nullptr);
        if (key != KEY_POWER) {
            return;
        }
        // Consume the waking press/release, including events queued before
        // PrepareForSleep(false). It must not turn the restored panel off.
        if (preparing_sleep || g_get_monotonic_time() < wake_key_until) {
            cancel_hold(); return;
        }
        if (value == 0) {
            const bool short_press = power_down && hold;
            cancel_hold();
            if (short_press && !pending) {
                lock_screen(screen == "off" ? "locked" : "off");
            }
            return;
        }
        if (value != 1 || power_down) {
            return;
        }
        power_down = true;
        hold = g_timeout_add(1000, [](gpointer p)->gboolean {
            auto*s = static_cast<Session*>(p); s->hold = 0;
            if (s->power_down && s->active) { s->show(); }
            return G_SOURCE_REMOVE;
        }, this);
    }
    void set_active(bool value) {
        if (active == value) {
            return;
        }
        ++login_generation;
        active = value;
        suspend_pending = false;
        cancel_hold();
        devices.clear();
        if (active) {
            scan();
        } else {
            hide_keyboard();
            dismiss(true);
            dismiss_desktop();
            if (screen == "off") { screen = "locked"; display_power(true); }
        }
        changed();
    }
    void discover_session() {
        ++login_generation;
        session_path.clear();
        set_active(false);
        GError *e = nullptr;
        GVariant *r = g_dbus_connection_call_sync(system, LOGIN, LOGIN_PATH, MANAGER, "GetSessionByPID",
                      g_variant_new("(u)", static_cast<guint32>(getpid())), G_VARIANT_TYPE("(o)"), G_DBUS_CALL_FLAGS_NONE, 3000, nullptr, &e);
        if (!r) {
            log_error(e ? e->message : "No login session");
            g_clear_error(&e);
            return;
        }
        const char*p;
        g_variant_get(r, "(&o)", &p);
        session_path = p;
        g_variant_unref(r);
        read_active();
        caps();
    }
    void read_active() {
        if (session_path.empty()) {
            return;
        }
        GError*e = nullptr;
        GVariant*r = g_dbus_connection_call_sync(system, LOGIN, session_path.c_str(), "org.freedesktop.DBus.Properties", "Get",
                     g_variant_new("(ss)", "org.freedesktop.login1.Session", "Active"), G_VARIANT_TYPE("(v)"), G_DBUS_CALL_FLAGS_NONE, 3000, nullptr, &e);
        if (r) {
            GVariant*v;
            g_variant_get(r, "(v)", &v);
            set_active(g_variant_get_boolean(v));
            g_variant_unref(v);
            g_variant_unref(r);
        } else {
            set_active(false);
            log_error(e ? e->message : "Cannot determine active session");
            g_clear_error(&e);
        }
    }
    void caps() {
        if (!system) {
            return;
        }
        struct Query {
            Session*s;
            unsigned kind;
            unsigned generation;
        };
        const char *methods[] = {"CanPowerOff", "CanReboot", "CanSuspend"};
        for (unsigned kind = 0; kind < 3; ++kind) {
            auto*q = new Query{this, kind, login_generation};
            g_dbus_connection_call(system, LOGIN, LOGIN_PATH, MANAGER, methods[kind], nullptr,
            G_VARIANT_TYPE("(s)"), G_DBUS_CALL_FLAGS_NONE, 3000, nullptr, [](GObject * o, GAsyncResult * r, gpointer p) {
                std::unique_ptr<Query>q(static_cast<Query*>(p));
                GError*e = nullptr;
                GVariant*v = g_dbus_connection_call_finish(G_DBUS_CONNECTION(o), r, &e);
                if (q->generation == q->s->login_generation) {
                    const char*cap = "unavailable";
                    if (v) {
                        g_variant_get(v, "(&s)", &cap);
                    }
                    (q->kind == 2 ? q->s->suspend_cap : q->kind == 1 ? q->s->reboot_cap : q->s->power_cap) = cap;
                    q->s->changed();
                }
                if (v) {
                    g_variant_unref(v);
                }
                g_clear_error(&e);
            }, q);
        }
    }
    bool caller_is(GDBusMethodInvocation*i, Component&c) {
        if (!c.process) {
            return false;
        }
        GError*e = nullptr;
        GVariant*r = g_dbus_connection_call_sync(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                     "GetConnectionUnixProcessID", g_variant_new("(s)", g_dbus_method_invocation_get_sender(i)), G_VARIANT_TYPE("(u)"),
                     G_DBUS_CALL_FLAGS_NONE, 2000, nullptr, &e);
        guint32 pid = 0;
        if (r) {
            g_variant_get(r, "(u)", &pid);
            g_variant_unref(r);
        }
        g_clear_error(&e);
        return pid == c.pid;
    }
    static void child_setup(gpointer parent) {
        prctl(PR_SET_PDEATHSIG, SIGTERM);
        if (getppid() != GPOINTER_TO_INT(parent)) {
            _exit(125);
        }
    }
    void start(Component&c) {
        if (stopping || c.process) {
            return;
        }
        c.expected = false;
        // Populate icons before Koya indexes its asset mounts.
        if (c.name == "navigation") g_variant_unref(desktop.applications());
        c.status = "starting";
        if (c.name == "power-menu") {
            menu = "starting";
        }
        GSubprocessLauncher*l = g_subprocess_launcher_new(G_SUBPROCESS_FLAGS_NONE);
        g_subprocess_launcher_set_child_setup(l, child_setup, GINT_TO_POINTER(getpid()), nullptr);
        if (c.name == "authentication") g_subprocess_launcher_unsetenv(l, "KOYA_DBUS_DEBUG");
        std::string logdir = std::string(g_get_user_state_dir()) + "/koya-shell";
        g_mkdir_with_parents(logdir.c_str(), 0700);
        int logfd = open((logdir + "/" + c.name + ".log").c_str(), O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
        if (logfd < 0) {
            g_object_unref(l);
            log_error("Cannot open component log");
            exited(c);
            return;
        }
        g_subprocess_launcher_take_stdout_fd(l, dup(logfd));
        g_subprocess_launcher_take_stderr_fd(l, logfd);
        std::string script = "apps/" + c.name + ".js";
        std::vector<const char*>args;
        if (c.name == "keyboard") {
#ifdef KOYA_TESTING
            args = {g_getenv("KOYA_TEST_KEYBOARD_FIXTURE"), nullptr};
#else
            args = {"/usr/bin/squeekboard", nullptr};
            g_subprocess_launcher_setenv(l, "GTK_THEME", "Adwaita:dark", TRUE);
#endif
        } else
#ifdef KOYA_TESTING
        if (!fixture.empty())
            args = {fixture.c_str(), c.name.c_str(), nullptr};
        else
#endif
            args = {executable.c_str(), "-n", "/usr/lib", "-m", assets.c_str(), "-m", root.c_str(), "-m", desktop.icons.cache.c_str(), "-i", script.c_str(), nullptr};
        GError*e = nullptr;
        c.process = g_subprocess_launcher_spawnv(l, args.data(), &e);
        g_object_unref(l);
        if (!c.process) {
            c.status = "failed";
            log_error(e ? e->message : "Cannot start component");
            g_clear_error(&e);
            exited(c);
            return;
        }
        c.pid = strtoul(g_subprocess_get_identifier(c.process), nullptr, 10);
        g_message("Started %s pid=%u", c.name.c_str(), c.pid);
        g_subprocess_wait_async(c.process, nullptr, [](GObject * o, GAsyncResult * r, gpointer p) {
            auto&c = *static_cast<Component*>(p);
            GError*e = nullptr;
            g_subprocess_wait_finish(G_SUBPROCESS(o), r, &e);
            g_clear_error(&e);
            g_object_unref(c.process);
            c.process = nullptr;
            c.pid = 0;
            remove_timer(c.deadline);
            remove_timer(c.kill_timer);
            c.owner->exited(c);
        }, &c);
        c.deadline = g_timeout_add_seconds(12, [](gpointer p)->gboolean {
            auto&c = *static_cast<Component*>(p); c.deadline = 0; c.owner->log_error(c.name + " did not become ready");
            c.owner->terminate(c, false); return G_SOURCE_REMOVE;
        }, &c);
        changed();
    }
    void exited(Component&c) {
        c.status = "stopped";
        if (c.name == "authentication" && authentication) {
            remove_timer(authentication_retry);
            authentication->stop();
        }
        if (c.name == "top-bar" && notification_transport) notification_transport->detach();
        if (c.name == "navigation") {
            desktop_view = "closed";
            desktop_mapped = false;
            if (!c.expected && !stopping) error = "Navigation exited unexpectedly";
        }
        if (c.name == "power-menu") {
            menu = "closed";
            if (!c.expected && !stopping) {
                error = "Power menu exited unexpectedly";
            }
        } else if (c.name == "lock-screen" && screen == "unlocked") {
            // On-demand visual overlay; an intentional unlock ends its process.
        } else if (c.name == "lock-screen" && c.expected && !stopping) {
            // A new lock arrived while the old overlay was being reaped.
            start(c);
        } else if (!stopping && !c.expected) {
            gint64 now = g_get_monotonic_time();
            while (!c.restarts.empty() && now - c.restarts.front() > 60 * G_USEC_PER_SEC) {
                c.restarts.pop_front();
            }
            if (c.restarts.size() < 3) {
                c.restarts.push_back(now);
                c.status = "restarting";
                c.retry = g_timeout_add_seconds(3, [](gpointer p)->gboolean {auto&c = *static_cast<Component*>(p); c.retry = 0; c.owner->start(c); return G_SOURCE_REMOVE;}, &c);
            } else {
                c.status = "failed";
                error = c.name + " exceeded restart limit";
                g_warning("%s", error.c_str());
            }
        }
        changed();
        if (stopping) {
            bool live = false;
            for (auto&other : components) {
                live |= other.process != nullptr;
            }
            if (!live) {
                g_main_loop_quit(loop);
            }
        }
    }
    void terminate(Component&c, bool expected = true) {
        c.expected = expected;
        remove_timer(c.retry);
        remove_timer(c.deadline);
        if (c.process) {
            g_subprocess_send_signal(c.process, SIGTERM);
            if (!c.kill_timer)
                c.kill_timer = g_timeout_add_seconds(2, [](gpointer p)->gboolean{auto&c = *static_cast<Component*>(p); c.kill_timer = 0; if (c.process)g_subprocess_force_exit(c.process); return G_SOURCE_REMOVE;}, &c);
        }
    }
    void set_setting(GDBusMethodInvocation *invocation, const char *name, const char *value) {
        if (!active || screen != "unlocked" || stopping || pending || preparing_sleep) {
            fail(invocation, "Settings require an active unlocked session"); return;
        }
        struct Setting {
            const char *name, *group, *key;
            unsigned *number; bool *boolean;
            unsigned low, high;
        };
        const Setting settings[] = {
            {"AutoRotateEnabled", "screen", "auto-rotate", nullptr, &auto_rotate, 0, 0},
            {"IdleLockSeconds", "idle", "lock-seconds", &idle_lock_seconds, nullptr, 0, 86400},
            {"IdleScreenSeconds", "idle", "lock-screen-seconds", &idle_screen_seconds, nullptr, 0, 86400},
            {"IdleSuspendSeconds", "idle", "suspend-seconds", &idle_suspend_seconds, nullptr, 0, 86400},
            {"HapticsEnabled", "haptics", "enabled", nullptr, &haptics_enabled, 0, 0},
            {"HapticsMinIntervalMs", "haptics", "minimum-interval-ms", &haptics_interval, nullptr, 0, 1000},
            {"BrightnessMinPercent", "brightness", "minimum-percent", &brightness_minimum, nullptr, 1, 30},
            {"VolumeButtonsEnabled", "volume", "buttons-enabled", nullptr, &volume_buttons, 0, 0},
            {"VolumeIndicatorEnabled", "volume", "indicator-enabled", nullptr, &volume_indicator, 0, 0},
            {"VolumeWhileLocked", "volume", "while-locked", nullptr, &volume_locked, 0, 0},
            {"VolumeStepPercent", "volume", "step-percent", &volume_step, nullptr, 1, 25},
            {"VolumeMaxPercent", "volume", "maximum-percent", &volume_max, nullptr, 1, 100},
            {"VolumeIndicatorTimeoutMs", "volume", "timeout-ms", &volume_timeout, nullptr, 300, 10000},
            {"VolumeIndicatorMargin", "volume", "margin", &volume_margin, nullptr, 0, 100},
            {"VolumeIndicatorPositionPercent", "volume", "position-percent", &volume_position, nullptr, 0, 100}
        };
        auto persist = [&](const char *group, const char *key) {
            std::string message;
            if (ShellSettings::save(group, key, value, message)) return true;
            fail(invocation, message.c_str()); return false;
        };
        bool matched = false;
        for (const auto &setting : settings) {
            if (strcmp(name, setting.name)) continue;
            matched = true;
            unsigned number = 0;
            if (setting.boolean) {
                if (strcmp(value, "true") && strcmp(value, "false")) { fail(invocation, "Expected true or false"); return; }
            } else {
                if (!*value || strspn(value, "0123456789") != strlen(value)) { fail(invocation, "Expected a whole number"); return; }
                errno = 0;
                guint64 parsed = g_ascii_strtoull(value, nullptr, 10);
                if (errno || parsed < setting.low || parsed > setting.high) { fail(invocation, "Setting is outside its allowed range"); return; }
                number = static_cast<unsigned>(parsed);
            }
            if (!persist(setting.group, setting.key)) return;
            if (setting.boolean) *setting.boolean = !strcmp(value, "true");
            else *setting.number = number;
            break;
        }
        if (!matched) {
            if (!strcmp(name, "Wallpaper")) {
                if (!ShellSettings::wallpaper_available(root, value)) { fail(invocation, "Wallpaper is unavailable"); return; }
                if (!persist("appearance", "wallpaper")) return;
                wallpaper_id = value;
            } else if (!strcmp(name, "VolumeIndicatorSide")) {
                if (strcmp(value, "left") && strcmp(value, "right")) { fail(invocation, "Expected left or right"); return; }
                if (!persist("volume", "side")) return;
                volume_side = value;
            } else { fail(invocation, "Unknown shell setting"); return; }
        }
        changed();
        g_dbus_method_invocation_return_value(invocation, g_variant_new("(@a{sv})", state()));
    }
    void read_idle_config() {
        GKeyFile *config = g_key_file_new();
        std::string path = root + "/session.conf";
        GError *e = nullptr;
        const bool loaded = g_key_file_load_from_file(config, path.c_str(), G_KEY_FILE_NONE, &e);
        if (!loaded && !g_error_matches(e, G_FILE_ERROR, G_FILE_ERROR_NOENT))
            g_warning("Cannot read session settings: %s", e->message);
        g_clear_error(&e);
        ShellSettings::merge(config);
        {
            if (g_key_file_has_key(config, "screen", "auto-rotate", nullptr)) {
                GError *error = nullptr;
                gboolean enabled = g_key_file_get_boolean(config, "screen", "auto-rotate", &error);
                if (!error) auto_rotate = enabled;
                else g_warning("Invalid auto-rotate setting; using default");
                g_clear_error(&error);
            }
            gchar *wallpaper = g_key_file_get_string(config, "appearance", "wallpaper", nullptr);
            if (wallpaper && ShellSettings::wallpaper_available(root, wallpaper)) wallpaper_id = wallpaper;
            g_free(wallpaper);
            auto read = [&](const char *key, unsigned &value) {
                GError *error = nullptr;
                if (!g_key_file_has_key(config, "idle", key, nullptr)) return;
                gint seconds = g_key_file_get_integer(config, "idle", key, &error);
                if (!error && seconds >= 0 && seconds <= 86400) value = seconds;
                else g_warning("Invalid idle setting %s; using %u seconds", key, value);
                g_clear_error(&error);
            };
            read("lock-seconds", idle_lock_seconds);
            read("lock-screen-seconds", idle_screen_seconds);
            if (g_key_file_has_key(config, "idle", "suspend-seconds", nullptr)) read("suspend-seconds", idle_suspend_seconds);
            auto setting = [&](const char *group, const char *key, unsigned &value, unsigned low, unsigned high) {
                if (!g_key_file_has_key(config, group, key, nullptr)) return;
                GError *error = nullptr; gint number = g_key_file_get_integer(config, group, key, &error);
                if (!error && number >= static_cast<gint>(low) && number <= static_cast<gint>(high)) value = number;
                else g_warning("Invalid %s setting %s; using %u", group, key, value);
                g_clear_error(&error);
            };
            setting("haptics", "minimum-interval-ms", haptics_interval, 0, 1000);
            setting("brightness", "minimum-percent", brightness_minimum, 1, 30);
            if (g_key_file_has_key(config, "haptics", "enabled", nullptr)) {
                GError *error = nullptr;
                gboolean enabled = g_key_file_get_boolean(config, "haptics", "enabled", &error);
                if (!error) haptics_enabled = enabled;
                else g_warning("Invalid haptics enabled setting; using default");
                g_clear_error(&error);
            }
            if (g_key_file_has_group(config, "volume")) {
                auto integer = [&](const char *key, unsigned &value, unsigned low, unsigned high) {
                    if (!g_key_file_has_key(config, "volume", key, nullptr)) return;
                    GError *error = nullptr;
                    gint number = g_key_file_get_integer(config, "volume", key, &error);
                    if (!error && number >= static_cast<gint>(low) && number <= static_cast<gint>(high)) value = number;
                    else g_warning("Invalid volume setting %s; using %u", key, value);
                    g_clear_error(&error);
                };
                auto boolean = [&](const char *key, bool &value) {
                    if (!g_key_file_has_key(config, "volume", key, nullptr)) return;
                    GError *error = nullptr;
                    gboolean setting = g_key_file_get_boolean(config, "volume", key, &error);
                    if (!error) value = setting;
                    else g_warning("Invalid volume setting %s; using default", key);
                    g_clear_error(&error);
                };
                integer("step-percent", volume_step, 1, 25);
                integer("maximum-percent", volume_max, 1, 100);
                integer("timeout-ms", volume_timeout, 300, 10000);
                integer("margin", volume_margin, 0, 100);
                integer("position-percent", volume_position, 0, 100);
                boolean("buttons-enabled", volume_buttons);
                boolean("indicator-enabled", volume_indicator);
                boolean("while-locked", volume_locked);
                gchar *side = g_key_file_get_string(config, "volume", "side", nullptr);
                if (side && (!strcmp(side, "left") || !strcmp(side, "right"))) volume_side = side;
                else if (side) g_warning("Invalid volume side; using left");
                g_free(side);
                gchar *sink = g_key_file_get_string(config, "volume", "sink", nullptr);
                if (sink) volume_sink = g_strstrip(sink);
                g_free(sink);
            }
        }
        g_clear_error(&e);
        g_key_file_unref(config);
#ifdef KOYA_TESTING
        if (const char *v = g_getenv("KOYA_TEST_IDLE_LOCK_SECONDS")) idle_lock_seconds = atoi(v);
        if (const char *v = g_getenv("KOYA_TEST_IDLE_SCREEN_SECONDS")) idle_screen_seconds = atoi(v);
        // Private UI tests opt in only when a fake feedback service is present.
        haptics_enabled = g_getenv("KOYA_TEST_HAPTICS") && !strcmp(g_getenv("KOYA_TEST_HAPTICS"), "1");
#endif
    }
    void idle_expired() {
        if (!active || stopping || pending || screen == "off") return;
        lock_screen("off");
    }
    void idle_event(const char *packet) {
        if (packet[0] != 'T' || packet[1] != ' ') return;
        unsigned generation = strtoul(packet + 2, nullptr, 10);
        if (generation != idle_generation || !configured_idle) return;
        // Dispatch after any outstanding command reply; this avoids nested
        // display requests and invalidates expired events when policy changes.
        if (!idle_dispatch) idle_dispatch = g_idle_add([](gpointer p)->gboolean {
            auto *s = static_cast<Session*>(p);
            s->idle_dispatch = 0;
            s->idle_expired();
            return G_SOURCE_REMOVE;
        }, this);
    }
    void close_display() {
        remove_timer(display_source);
        if (display_fd >= 0) close(display_fd);
        display_fd = -1;
        display_off = false;
    }
    bool display_request(const std::string &packet, char expected) {
#ifdef KOYA_TESTING
        if (g_str_has_suffix(fixture.c_str(), "component.sh")) return true;
#endif
        if (display_fd < 0) {
            struct sockaddr_un address{};
            address.sun_family = AF_UNIX;
            std::string path = std::string(g_get_user_runtime_dir()) + "/koya-display.sock";
            if (path.size() >= sizeof(address.sun_path)) return false;
            strcpy(address.sun_path, path.c_str());
            display_fd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
            if (display_fd < 0 || ::connect(display_fd, reinterpret_cast<sockaddr*>(&address), sizeof(address))) {
                close_display();
                error = "Display module unavailable; screen remains on";
                g_warning("%s", error.c_str());
                return false;
            }
            display_source = g_unix_fd_add(display_fd, GIOCondition(G_IO_IN | G_IO_HUP | G_IO_ERR),
                [](gint fd, GIOCondition condition, gpointer p)->gboolean {
                    auto *s = static_cast<Session*>(p);
                    if (condition & (G_IO_HUP | G_IO_ERR)) {
                        s->display_source = 0;
                        s->close_display();
                        s->log_error("Display module disconnected");
                        return G_SOURCE_REMOVE;
                    }
                    char packet[64] = {};
                    ssize_t length = recv(fd, packet, sizeof(packet) - 1, 0);
                    if (length > 0) s->idle_event(packet);
                    else if (length == 0) {
                        s->display_source = 0;
                        s->close_display();
                        s->log_error("Display module disconnected");
                        return G_SOURCE_REMOVE;
                    }
                    return G_SOURCE_CONTINUE;
                }, this);
        }
        if (send(display_fd, packet.data(), packet.size(), MSG_NOSIGNAL) == static_cast<ssize_t>(packet.size())) {
            gint64 deadline = g_get_monotonic_time() + 500000;
            while (g_get_monotonic_time() < deadline) {
                struct pollfd pfd{display_fd, POLLIN, 0};
                int remaining = (deadline - g_get_monotonic_time() + 999) / 1000;
                if (poll(&pfd, 1, remaining) <= 0) break;
                char response[64] = {};
                ssize_t length = recv(display_fd, response, sizeof(response) - 1, 0);
                if (length == 1 && response[0] == expected) return true;
                if (length > 1 && response[0] == 'T') { idle_event(response); continue; }
                break;
            }
        }
        close_display();
        error = "Display request failed; screen restored";
        g_warning("%s", error.c_str());
        return false;
    }
    bool display_power(bool on) {
        const bool ok = display_request(on ? "1" : "0", on ? '1' : '0');
        if (ok) display_off = !on;
        return ok;
    }
    void update_idle(bool force = false) {
        const unsigned seconds = !active || stopping || pending || preparing_sleep || screen == "off" ? 0
            : screen == "locked" ? idle_screen_seconds : idle_lock_seconds;
        if (!active && display_fd < 0) return;
        if (!force && seconds == configured_idle) return;
        configured_idle = seconds;
        remove_timer(idle_dispatch);
        ++idle_generation;
        display_request("t " + std::to_string(seconds) + " " + std::to_string(idle_generation), 't');
    }
    void lock_screen(const std::string &next) {
        if (!active || stopping || pending || (preparing_sleep && next != "off")) return;
        remove_timer(unlock_timer);
        screen = next;
        hide_keyboard();
        dismiss();
        dismiss_desktop();
        if (!components[3].process) start(components[3]);
        if (next != "off") display_power(true);
        else if (components[3].status == "ready" && !display_power(false)) screen = "locked";
        changed();
    }
    void show() {
        if (!active || stopping || pending || preparing_sleep || overlay().process) {
            return;
        }
        error.clear();
        hide_keyboard();
        dismiss_desktop();
        update_idle(true);
        if (screen == "off") { screen = "locked"; display_power(true); }
        caps();
        start(overlay());
    }
    void dismiss(bool force = false) {
        if (pending && !force) {
            return;
        }
        if (overlay().process) {
            menu = "closing";
            terminate(overlay());
            changed();
        }
    }
    void dismiss_desktop() {
        desktop_view = "closed";
        // The persistent UI receives StateChanged and hides its layer window.
    }
    bool desktop_allowed() {
        return desktop.available && active && !stopping && !pending && !preparing_sleep && screen == "unlocked" && !overlay().process;
    }
    void hide_keyboard() {
        if (keyboard) keyboard->set_visible(false);
    }
    void init_keyboard() {
#ifdef KOYA_TESTING
        // Other integration tests never launch a keyboard on the host display.
        if (!g_getenv("KOYA_TEST_KEYBOARD_FIXTURE")) return;
#else
        // Squeekboard honours this accessibility setting for auto activation.
        GSettingsSchemaSource *source = g_settings_schema_source_get_default();
        GSettingsSchema *schema = source ? g_settings_schema_source_lookup(source, "org.gnome.desktop.a11y.applications", TRUE) : nullptr;
        if (schema) {
            GSettings *settings = g_settings_new_full(schema, nullptr, nullptr);
            if (g_settings_schema_has_key(schema, "screen-keyboard-enabled") && !g_settings_get_boolean(settings, "screen-keyboard-enabled"))
                g_settings_set_boolean(settings, "screen-keyboard-enabled", TRUE);
            g_object_unref(settings); g_settings_schema_unref(schema);
        }
#endif
        keyboard = std::make_unique<Keyboard>(bus, [this] {
            if (stopping) return;
            auto &c = components[5];
            bool became_visible = keyboard->visible() && (!keyboard_visible || !keyboard_available);
            keyboard_available = keyboard->available(); keyboard_visible = keyboard->visible();
            if (keyboard->available()) {
                remove_timer(c.deadline);
                c.status = c.process ? "ready" : "external";
                if (became_visible && (!desktop_allowed() || desktop_view != "closed")) hide_keyboard();
            } else if (!c.process && (c.status == "stopped" || c.status == "external")) {
                start(c);
            }
            if (!keyboard->error().empty()) error = keyboard->error();
            changed();
        });
    }
    void stop() {
        if (stopping) {
            return;
        }
        stopping = true;
        remove_timer(authentication_retry);
        if (authentication) authentication->stop();
        hide_keyboard();
        update_idle();
        remove_timer(idle_dispatch);
        remove_timer(system_retry);
        remove_timer(unlock_timer);
        cancel_hold();
        devices.clear();
        bool live = false;
        for (auto&c : components) {
            live |= c.process != nullptr;
            terminate(c);
        }
        if (!live) {
            g_main_loop_quit(loop);
        }
    }
    struct Action {
        Session*s;
        GDBusMethodInvocation*i;
        bool reboot;
        unsigned generation;
        bool interactive = false;
    };
    void action(GDBusMethodInvocation*i, bool reboot) {
        if (!active || pending || menu != "open" || !caller_is(i, overlay())) {
            fail(i, "Power actions require the active power menu and no pending action");
            return;
        }
        pending = true;
        menu = "pending";
        error.clear();
        changed();
        auto*a = new Action{this, G_DBUS_METHOD_INVOCATION(g_object_ref(i)), reboot, login_generation};
        g_dbus_connection_call(system, LOGIN, LOGIN_PATH, MANAGER, reboot ? "CanReboot" : "CanPowerOff", nullptr, G_VARIANT_TYPE("(s)"),
        G_DBUS_CALL_FLAGS_NONE, 5000, nullptr, [](GObject * o, GAsyncResult * r, gpointer p) {
            auto*a = static_cast<Action*>(p);
            GError*e = nullptr;
            GVariant*v = g_dbus_connection_call_finish(G_DBUS_CONNECTION(o), r, &e);
            const char*cap = "unavailable";
            if (v) {
                g_variant_get(v, "(&s)", &cap);
            }
            a->interactive = !strcmp(cap, "challenge");
            bool allowed = (!strcmp(cap, "yes") || a->interactive) && a->s->active && a->generation == a->s->login_generation && !a->s->stopping;
            std::string why = e ? e->message : "Action is unavailable in this session";
            if (v) {
                g_variant_unref(v);
            }
            g_clear_error(&e);
            if (!allowed) {
                a->s->finish_action(a, why.c_str());
                return;
            }
            g_dbus_connection_call(a->s->system, LOGIN, LOGIN_PATH, MANAGER, a->reboot ? "Reboot" : "PowerOff", g_variant_new("(b)", a->interactive),
            nullptr, a->interactive ? G_DBUS_CALL_FLAGS_ALLOW_INTERACTIVE_AUTHORIZATION : G_DBUS_CALL_FLAGS_NONE,
            a->interactive ? 120000 : 10000, nullptr, [](GObject * o, GAsyncResult * r, gpointer p) {
                auto*a = static_cast<Action*>(p);
                GError*e = nullptr;
                GVariant*v = g_dbus_connection_call_finish(G_DBUS_CONNECTION(o), r, &e);
                a->s->finish_action(a, e ? e->message : nullptr);
                if (v) {
                    g_variant_unref(v);
                }
                g_clear_error(&e);
            }, a);
        }, a);
    }
    void finish_action(Action*a, const char*why) {
        if (why) {
            pending = false;
            menu = overlay().process ? "open" : "closed";
            log_error(why);
            fail(a->i, why);
        } else {
            g_dbus_method_invocation_return_value(a->i, nullptr);
        }
        g_object_unref(a->i);
        delete a;
    }
    bool sleep_ready() const {
        return system && active && !stopping && !pending && !preparing_sleep &&
            screen == "off" && display_off && components[3].status == "ready" && !components[3].expected;
    }
    struct SleepRequest {
        Session *session;
        GDBusMethodInvocation *invocation;
        unsigned generation;
    };
    void finish_suspend(SleepRequest *request, const char *why) {
        if (request->generation == login_generation) {
            suspend_pending = false;
            if (why) log_error(why);
            else changed();
        }
        if (why) fail(request->invocation, why);
        else g_dbus_method_invocation_return_value(request->invocation, nullptr);
        g_object_unref(request->invocation);
        delete request;
    }
    void suspend(GDBusMethodInvocation *invocation) {
        if (suspend_pending || !sleep_ready() || !caller_is(invocation, components[1])) {
            fail(invocation, "Suspend requires the owned active top bar, a ready lock screen and confirmed display-off"); return;
        }
        suspend_pending = true;
        auto *request = new SleepRequest{this, G_DBUS_METHOD_INVOCATION(g_object_ref(invocation)), login_generation};
        changed();
        // Check from the graphical session, without displaying an auth dialog.
        // Recheck readiness after the asynchronous reply so a wake cancels it.
        g_dbus_connection_call(system, LOGIN, LOGIN_PATH, MANAGER, "CanSuspend", nullptr,
            G_VARIANT_TYPE("(s)"), G_DBUS_CALL_FLAGS_NONE, 5000, nullptr,
            [](GObject *object, GAsyncResult *result, gpointer data) {
                auto *request = static_cast<SleepRequest *>(data);
                auto *session = request->session;
                GError *error = nullptr;
                GVariant *reply = g_dbus_connection_call_finish(G_DBUS_CONNECTION(object), result, &error);
                const char *capability = "unavailable";
                if (reply) g_variant_get(reply, "(&s)", &capability);
                const bool allowed = !strcmp(capability, "yes");
                std::string reason = error ? error->message : !strcmp(capability, "challenge")
                    ? "Suspend requires authorization in the graphical session" : "Suspend is unavailable or inhibited";
                if (reply) g_variant_unref(reply);
                g_clear_error(&error);
                if (request->generation != session->login_generation || !session->sleep_ready()) {
                    session->finish_suspend(request, "Suspend cancelled because the session or display changed"); return;
                }
                if (!allowed) { session->finish_suspend(request, reason.c_str()); return; }
                // elogind enforces sleep inhibitors and prepares network/modem
                // services. Never bypass inhibitors or write /sys/power/state.
                g_dbus_connection_call(session->system, LOGIN, LOGIN_PATH, MANAGER, "Suspend", g_variant_new("(b)", FALSE),
                    nullptr, G_DBUS_CALL_FLAGS_NONE, 10000, nullptr,
                    [](GObject *object, GAsyncResult *result, gpointer data) {
                        auto *request = static_cast<SleepRequest *>(data);
                        GError *error = nullptr;
                        GVariant *reply = g_dbus_connection_call_finish(G_DBUS_CONNECTION(object), result, &error);
                        request->session->finish_suspend(request, error ? error->message : nullptr);
                        if (reply) g_variant_unref(reply);
                        g_clear_error(&error);
                    }, request);
            }, request);
    }
    void sleep_event(bool preparing) {
        const bool was_preparing = preparing_sleep;
        preparing_sleep = preparing;
        cancel_hold();
        if (preparing) {
            // Also cover suspend requested outside Koya. This remains a visual
            // lock, not a compositor-enforced security boundary.
            lock_screen("off");
        } else if (was_preparing) {
            suspend_pending = false;
            ++resume_count;
            wake_key_until = g_get_monotonic_time() + 750000;
            if (active && !stopping && !pending) lock_screen("locked");
            caps();
        }
        changed();
    }
    static void method(GDBusConnection*, const char*, const char*, const char*iface, const char*name, GVariant*args, GDBusMethodInvocation*i, gpointer data) {
        auto&s = *static_cast<Session*>(data);
#ifdef KOYA_TESTING
        if (!strcmp(iface, "org.koya.Shell1.Test")) {
            if (!strcmp(name, "Button")) {
                guint32 key, value;
                g_variant_get(args, "(uu)", &key, &value);
                s.button(key, value);
            } else if (!strcmp(name, "AuthenticationDemo")) {
                g_dbus_connection_emit_signal(s.bus, nullptr, PATH, BUS, "AuthenticationBegin",
                    g_variant_new("(usss)", G_MAXUINT, "org.koya.Test", "Authenticate to test the Koya dialog", "user"), nullptr);
                g_dbus_connection_emit_signal(s.bus, nullptr, PATH, BUS, "AuthenticationPrompt",
                    g_variant_new("(usb)", G_MAXUINT, "Password:", FALSE), nullptr);
            } else if (!strcmp(name, "AuthenticationAnswer")) {
                guint id; const char *answer;
                g_variant_get(args, "(u&s)", &id, &answer);
                s.authentication->respond(id, answer);
            } else if (!strcmp(name, "AuthenticationDismiss")) {
                guint id; g_variant_get(args, "(u)", &id);
                s.authentication->cancel(id);
            } else if (!strcmp(name, "Activity")) {
                s.display_request("a", 'a');
            } else if (!strcmp(name, "Idle")) {
                s.idle_expired();
            } else if (!strcmp(name, "PowerSupplyChanged")) {
                s.status->battery_changed();
            } else {
                s.cancel_hold();
            }
            g_dbus_method_invocation_return_value(i, nullptr);
            return;
        }
#else
        (void)iface;
#endif
        if (!strcmp(name, "GetState")) {
            g_dbus_method_invocation_return_value(i, g_variant_new("(@a{sv})", s.state()));
            return;
        }
        if (!strcmp(name, "SetSetting")) {
            const char *setting, *value; g_variant_get(args, "(&s&s)", &setting, &value);
            s.set_setting(i, setting, value); return;
        }
        if (!strcmp(name, "Suspend")) { s.suspend(i); return; }
        if (!strcmp(name, "GetBrightness")) {
            g_dbus_method_invocation_return_value(i, g_variant_new("(@a{sv})", Backlight::read().variant())); return;
        }
        if (!strcmp(name, "SetBrightness")) {
            guint percent; g_variant_get(args, "(u)", &percent);
            if (!s.active || s.screen != "unlocked" || s.stopping || !s.caller_is(i, s.components[1])) {
                fail(i, "Brightness requires the active unlocked top bar"); return;
            }
            if (percent < 1 || percent > 100) { fail(i, "Brightness must be between 1 and 100 percent"); return; }
            auto device = Backlight::read();
            if (!device.maximum || !s.system || s.session_path.empty()) { fail(i, "Display brightness unavailable"); return; }
            guint level = std::max(1u, static_cast<guint>((guint64(device.maximum) * percent + 50) / 100));
            // elogind already has the privilege and verifies the session's seat.
            // The shell needs neither a root helper nor writable sysfs files.
            struct Request { GDBusMethodInvocation *invocation; };
            g_dbus_connection_call(s.system, LOGIN, s.session_path.c_str(), "org.freedesktop.login1.Session", "SetBrightness",
                g_variant_new("(ssu)", "backlight", device.name.c_str(), level), nullptr,
                G_DBUS_CALL_FLAGS_NONE, 1500, nullptr, [](GObject *object, GAsyncResult *result, gpointer data) {
                    std::unique_ptr<Request> request(static_cast<Request *>(data));
                    GError *error = nullptr;
                    GVariant *reply = g_dbus_connection_call_finish(G_DBUS_CONNECTION(object), result, &error);
                    if (reply) {
                        g_variant_unref(reply);
                        g_dbus_method_invocation_return_value(request->invocation, g_variant_new("(@a{sv})", Backlight::read().variant()));
                    } else fail(request->invocation, error ? error->message : "Cannot change brightness");
                    g_clear_error(&error); g_object_unref(request->invocation);
                }, new Request{G_DBUS_METHOD_INVOCATION(g_object_ref(i))});
            return;
        }
        if (!strcmp(name, "RegisterNotifications")) {
            if (!s.caller_is(i, s.components[1]) || !s.notification_transport->attach(g_dbus_method_invocation_get_sender(i))) {
                fail(i, "Cannot register notification frontend; another server may own the notification name"); return;
            }
            g_dbus_method_invocation_return_value(i, nullptr); return;
        }
        if (!strcmp(name, "Askpass")) {
            if (!s.authentication || s.components[6].status != "ready" || s.stopping) {
                fail(i, "Koya authentication dialog is unavailable"); return;
            }
            const char *question, *mode;
            g_variant_get(args, "(&s&s)", &question, &mode);
            s.authentication->ask(question, mode, i);
            return;
        }
        if (!strcmp(name, "AuthenticationRespond") || !strcmp(name, "AuthenticationCancel")) {
            if (!s.authentication || !s.caller_is(i, s.components[6])) {
                fail(i, "Authentication requires the owned Koya dialog"); return;
            }
            guint id;
            if (!strcmp(name, "AuthenticationRespond")) {
                const char *response;
                g_variant_get(args, "(u&s)", &id, &response);
#ifdef KOYA_TESTING
                if (id == G_MAXUINT) {
                    g_dbus_connection_emit_signal(s.bus, nullptr, PATH, BUS, "AuthenticationEnd", g_variant_new("(u)", id), nullptr);
                    g_dbus_method_invocation_return_value(i, nullptr); return;
                }
#endif
                s.authentication->respond(id, response);
            } else {
                g_variant_get(args, "(u)", &id);
#ifdef KOYA_TESTING
                if (id == G_MAXUINT) {
                    g_dbus_connection_emit_signal(s.bus, nullptr, PATH, BUS, "AuthenticationEnd", g_variant_new("(u)", id), nullptr);
                    g_dbus_method_invocation_return_value(i, nullptr); return;
                }
#endif
                s.authentication->cancel(id);
            }
            g_dbus_method_invocation_return_value(i, nullptr); return;
        }
        if (!strcmp(name, "ReplyNotification") || !strcmp(name, "EmitNotification")) {
            if (!s.notification_transport->owns(g_dbus_method_invocation_get_sender(i))) { fail(i, "Notification transport requires the registered frontend"); return; }
            bool ok = false;
            if (!strcmp(name, "ReplyNotification")) {
                guint token; GVariant *payload; g_variant_get(args, "(u@a{sv})", &token, &payload);
                ok = s.notification_transport->reply(token, payload); g_variant_unref(payload);
            } else {
                const char *destination, *member, *action; guint id, reason;
                g_variant_get(args, "(&s&su&su)", &destination, &member, &id, &action, &reason);
                ok = s.notification_transport->emit(destination, member, id, action, reason);
            }
            if (!ok) { fail(i, "Invalid notification transport request"); return; }
            g_dbus_method_invocation_return_value(i, nullptr); return;
        }
        if (!strcmp(name, "GetApplications")) {
            g_dbus_method_invocation_return_value(i, g_variant_new("(@aa{sv})", s.desktop.applications()));
            return;
        }
        if (!strcmp(name, "ResolveIcon")) {
            const char *description; g_variant_get(args, "(&s)", &description);
            GIcon *icon = g_icon_new_for_string(description, nullptr);
            std::string texture = icon ? s.desktop.icons.resolve(icon) : "";
            if (icon) g_object_unref(icon);
            g_dbus_method_invocation_return_value(i, g_variant_new("(s)", texture.c_str())); return;
        }
        if (!strcmp(name, "GetDesktopState")) {
            if (!s.desktop.available) { fail(i, "Hyprland is unavailable"); return; }
            s.desktop.query_state(i);
            return;
        }
        if (!strcmp(name, "ToggleKeyboard")) {
            if (!s.keyboard || !s.keyboard->available() || !s.desktop_allowed() || !s.caller_is(i, s.components[4])) {
                fail(i, "Keyboard controls require the owned navigation process and an unlocked session"); return;
            }
            s.dismiss_desktop(); s.keyboard->toggle(); s.changed();
        } else if (!strcmp(name, "DesktopViewVisible")) {
            gboolean visible; g_variant_get(args, "(b)", &visible);
            if (!s.caller_is(i, s.components[4]) || (visible && (!s.desktop_allowed() || s.desktop_view == "closed"))) {
                fail(i, "Desktop visibility requires the owned drawer"); return;
            }
            s.desktop_mapped = visible; s.changed();
        } else if (!strcmp(name, "DismissDesktopView")) {
            s.dismiss_desktop(); s.changed();
        } else if (!strcmp(name, "ShowDesktopView")) {
            const char *view; g_variant_get(args, "(&s)", &view);
            if (!s.desktop_allowed() || (strcmp(view, "apps") && strcmp(view, "desktops"))) {
                fail(i, "Desktop view is unavailable"); return;
            }
            if (s.components[4].process && s.components[4].expected) { fail(i, "Navigation is closing"); return; }
            s.desktop_view = view;
            s.hide_keyboard();
            s.start(s.components[4]); s.changed();
        } else if (!strcmp(name, "LaunchApplication") || !strcmp(name, "SwitchDesktop") ||
                   !strcmp(name, "FocusWindow") || !strcmp(name, "CloseWindow")) {
            if (!s.desktop_allowed()) { fail(i, "Desktop controls require an unlocked session"); return; }
            bool ok = false;
            if (!strcmp(name, "LaunchApplication")) {
                const char *id; guint32 workspace; g_variant_get(args, "(&su)", &id, &workspace);
                if (!s.caller_is(i, s.components[4]) &&
                    !(std::string(id) == "koya-wifi.desktop" && s.caller_is(i, s.components[1]))) {
                    fail(i, "Application launch requires navigation or the owned Wi-Fi shortcut"); return;
                }
                ok = s.desktop.launch(id, workspace);
            } else if (!strcmp(name, "SwitchDesktop")) {
                guint32 workspace; g_variant_get(args, "(u)", &workspace);
                if (workspace >= 1 && workspace <= 10000) ok = s.desktop.select_workspace(workspace);
                if (ok && workspace == 1) s.hide_keyboard();
            } else {
                const char *address; g_variant_get(args, "(&s)", &address);
                if (Desktop::address(address)) ok = s.desktop.dispatch(std::string(!strcmp(name, "FocusWindow") ? "focuswindow address:" : "closewindow address:") + address);
            }
            if (!ok) { fail(i, "Hyprland rejected the desktop action"); return; }
            // The navigation window keeps launch feedback visible until the
            // new application surface arrives, then sends FocusWindow.
            if (strcmp(name, "CloseWindow") && strcmp(name, "LaunchApplication")) s.dismiss_desktop();
            s.changed();
        } else
        if (!strcmp(name, "PowerOff") || !strcmp(name, "Reboot")) {
            s.action(i, !strcmp(name, "Reboot"));
            return;
        }
        if (!strcmp(name, "Lock")) {
            if (!s.active || s.pending) { fail(i, "Session is inactive or busy"); return; }
            s.lock_screen("locked");
        } else if (!strcmp(name, "Unlock")) {
            if (!s.active || s.screen != "locked" || s.pending || s.preparing_sleep || !s.caller_is(i, s.components[3])) {
                fail(i, "Unlock requires the visible lock screen"); return;
            }
            s.screen = "unlocked";
            // Return the D-Bus result before terminating its calling process.
            s.unlock_timer = g_timeout_add(100, [](gpointer p)->gboolean {
                auto *session = static_cast<Session*>(p);
                session->unlock_timer = 0;
                if (session->screen == "unlocked") session->terminate(session->components[3]);
                return G_SOURCE_REMOVE;
            }, &s);
            s.changed();
        } else if (!strcmp(name, "ShowPowerMenu")) {
            if (!s.active) {
                fail(i, "Graphical session is inactive");
                return;
            }
            s.show();
        } else if (!strcmp(name, "DismissPowerMenu")) {
            if (s.pending) {
                fail(i, "A power action is pending");
                return;
            }
            s.dismiss();
        } else if (!strcmp(name, "Ready")) {
            const char*component;
            g_variant_get(args, "(&s)", &component);
            bool matched = false;
            for (auto&c : s.components)
                if (c.name != "keyboard" && c.name == component && s.caller_is(i, c)) {
                    matched = true;
                    remove_timer(c.deadline);
                    c.status = "ready";
                    // Map navigation first so the OSK honours its bottom reservation.
                    if (c.name == "navigation" && !s.keyboard) s.init_keyboard();
                    if (c.name == "lock-screen" && s.screen == "off" && !s.display_power(false)) s.screen = "locked";
                    if (c.name == "power-menu" && s.menu == "starting") {
                        s.menu = "open";
                    }
                    if (c.name == "authentication" && s.authentication && !s.authentication->start() && !s.authentication_retry) {
                        s.authentication_retry = g_timeout_add_seconds(3, [](gpointer data)->gboolean {
                            auto *session = static_cast<Session*>(data);
                            if (session->stopping || session->components[6].status != "ready" || session->authentication->start()) {
                                session->authentication_retry = 0; return G_SOURCE_REMOVE;
                            }
                            return G_SOURCE_CONTINUE;
                        }, &s);
                    }
                    s.changed();
                }
            if (!matched) {
                fail(i, "Component does not belong to this coordinator");
                return;
            }
        }
        g_dbus_method_invocation_return_value(i, nullptr);
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
        d->source = g_unix_fd_add(fd, static_cast<GIOCondition>(G_IO_IN | G_IO_HUP | G_IO_ERR), [](gint, GIOCondition cond, gpointer p)->gboolean{
            auto*d = static_cast<Device*>(p); auto*s = d->owner;
            if (cond & (G_IO_HUP | G_IO_ERR)) {
                std::string path = d->path;
                d->source = 0;
                s->cancel_hold();
                s->devices.erase(path);
                return G_SOURCE_REMOVE;
            }
            input_event event{}; int rc;
            while (true) {
                rc = libevdev_next_event(d->ev, d->sync ? LIBEVDEV_READ_FLAG_SYNC : LIBEVDEV_READ_FLAG_NORMAL, &event);
                if (rc == LIBEVDEV_READ_STATUS_SYNC) {
                    d->sync = true;
                    s->cancel_hold();
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
                s->cancel_hold();
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
    void retry_system() {
        if (stopping || system_retry) {
            return;
        }
        system_retry = g_timeout_add_seconds(3, [](gpointer p)->gboolean{
            auto*s = static_cast<Session*>(p); s->system_retry = 0; s->connect_system(); return G_SOURCE_REMOVE;
        }, this);
    }
    void connect_system() {
        GError *e = nullptr;
        system = g_bus_get_sync(G_BUS_TYPE_SYSTEM, nullptr, &e);
        if (system) {
            status->connect(system);
            g_dbus_connection_set_exit_on_close(system, FALSE);
            g_signal_connect(system, "closed", G_CALLBACK(+[](GDBusConnection*, gboolean, GError*, gpointer p) {
                auto*s = static_cast<Session*>(p);
                s->set_active(false);
                ++s->login_generation;
                if (s->system_watch) {
                    g_bus_unwatch_name(s->system_watch);
                    s->system_watch = 0;
                }
                if (s->properties_watch) {
                    g_dbus_connection_signal_unsubscribe(s->system, s->properties_watch);
                    s->properties_watch = 0;
                }
                if (s->sleep_watch) {
                    g_dbus_connection_signal_unsubscribe(s->system, s->sleep_watch);
                    s->sleep_watch = 0;
                }
                g_object_unref(s->system);
                s->system = nullptr;
                s->init_status();
                s->power_cap = s->reboot_cap = s->suspend_cap = "unavailable";
                s->preparing_sleep = s->suspend_pending = false;
                s->changed();
                s->retry_system();
            }), this);
            properties_watch = g_dbus_connection_signal_subscribe(system, LOGIN, "org.freedesktop.DBus.Properties", "PropertiesChanged", nullptr, nullptr,
            G_DBUS_SIGNAL_FLAGS_NONE, [](GDBusConnection*, const char*, const char*path, const char*, const char*, GVariant*, gpointer p) {
                auto*s = static_cast<Session*>(p);
                if (s->session_path == path) {
                    s->read_active();
                }
            }, this, nullptr);
            sleep_watch = g_dbus_connection_signal_subscribe(system, LOGIN, MANAGER, "PrepareForSleep", LOGIN_PATH, nullptr,
                G_DBUS_SIGNAL_FLAGS_NONE, [](GDBusConnection*, const char*, const char*, const char*, const char*, GVariant *args, gpointer data) {
                    gboolean preparing;
                    g_variant_get(args, "(b)", &preparing);
                    static_cast<Session *>(data)->sleep_event(preparing);
                }, this, nullptr);
            system_watch = g_bus_watch_name_on_connection(system, LOGIN, G_BUS_NAME_WATCHER_FLAGS_NONE,
            [](GDBusConnection*, const char*, const char*, gpointer p) {
                static_cast<Session*>(p)->discover_session();
            },
            [](GDBusConnection*, const char*, gpointer p) {
                auto*s = static_cast<Session*>(p);
                ++s->login_generation;
                s->set_active(false);
                s->power_cap = s->reboot_cap = s->suspend_cap = "unavailable";
                s->preparing_sleep = s->suspend_pending = false;
                s->changed();
            }, this, nullptr);
        } else {
            log_error(e ? e->message : "System bus unavailable");
            g_clear_error(&e);
            retry_system();
        }
    }
    void init_status() {
        std::string supplies = "/sys/class/power_supply";
#ifdef KOYA_TESTING
        supplies = g_getenv("KOYA_TEST_POWER_SUPPLY_DIR") ? g_getenv("KOYA_TEST_POWER_SUPPLY_DIR") : "/nonexistent/koya-test-power-supply";
#endif
        status = std::make_unique<SystemStatus>(supplies, [this] { changed(); });
    }
    bool init() {
        const char*runtime = g_getenv("XDG_RUNTIME_DIR");
        if (!runtime) {
            g_printerr("XDG_RUNTIME_DIR is required\n");
            return false;
        }
        lock_fd = open((std::string(runtime) + "/koya-shell.lock").c_str(), O_WRONLY | O_CREAT | O_CLOEXEC, 0600);
        if (lock_fd < 0 || flock(lock_fd, LOCK_EX | LOCK_NB) < 0) {
            g_printerr("Another phone shell owns the session lock\n");
            return false;
        }
        GError*e = nullptr;
        bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &e);
        if (!bus) {
            g_printerr("Session bus: %s\n", e->message);
            g_clear_error(&e);
            return false;
        }
        GVariant*r = g_dbus_connection_call_sync(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
                     g_variant_new("(su)", BUS, 4u), G_VARIANT_TYPE("(u)"), G_DBUS_CALL_FLAGS_NONE, 3000, nullptr, &e);
        guint32 result = 0;
        if (r) {
            g_variant_get(r, "(u)", &result);
            g_variant_unref(r);
        }
        g_clear_error(&e);
        if (result != 1) {
            g_printerr("Another coordinator owns %s\n", BUS);
            return false;
        }
        node = g_dbus_node_info_new_for_xml(protocol_xml().c_str(), &e);
        if (!node) {
            g_printerr("Invalid D-Bus interface: %s\n", e->message);
            g_clear_error(&e);
            return false;
        }
        static const GDBusInterfaceVTable vtable = {method, nullptr, nullptr, {nullptr}};
        for (unsigned n = 0; node && node->interfaces[n]; n++)
            if (!g_dbus_connection_register_object(bus, PATH, node->interfaces[n], &vtable, this, nullptr, &e)) {
                g_printerr("D-Bus export failed: %s\n", e->message);
                g_clear_error(&e);
                return false;
            }
        g_dbus_connection_set_exit_on_close(bus, FALSE);
        notification_transport = std::make_unique<NotificationTransport>(bus);
        authentication = std::make_unique<AuthenticationAgent>(bus);
        g_signal_connect(bus, "closed", G_CALLBACK(+[](GDBusConnection*, gboolean, GError*, gpointer p) {
            static_cast<Session*>(p)->stop();
        }), this);
#ifndef KOYA_TESTING
        udev_context = udev_new();
        if (!udev_context) {
            g_printerr("udev initialization failed\n");
            return false;
        }
        monitor = udev_monitor_new_from_netlink(udev_context, "udev");
        if (!monitor) {
            return false;
        }
        udev_monitor_filter_add_match_subsystem_devtype(monitor, "input", nullptr);
        udev_monitor_filter_add_match_subsystem_devtype(monitor, "power_supply", nullptr);
        udev_monitor_filter_add_match_subsystem_devtype(monitor, "backlight", nullptr);
        udev_monitor_enable_receiving(monitor);
        monitor_source = g_unix_fd_add(udev_monitor_get_fd(monitor), G_IO_IN, [](gint, GIOCondition, gpointer p)->gboolean {
            auto*s = static_cast<Session*>(p); udev_device*d;
            while ((d = udev_monitor_receive_device(s->monitor))) {
                const char *subsystem = udev_device_get_subsystem(d);
                if (subsystem && !strcmp(subsystem, "backlight")) {
                    g_dbus_connection_emit_signal(s->bus, nullptr, PATH, BUS, "BrightnessChanged", nullptr, nullptr);
                    udev_device_unref(d); continue;
                }
                if (subsystem && !strcmp(subsystem, "power_supply")) {
                    s->status->battery_changed(); udev_device_unref(d); continue;
                }
                const char*path = udev_device_get_devnode(d), *action = udev_device_get_action(d);
                if (path && action) {
                    if (!strcmp(action, "remove")) {
                        if (s->devices.erase(path)) {
                            s->cancel_hold();
                        }
                    } else if (!strcmp(action, "add") || !strcmp(action, "change")) {
                        s->add_device(path);
                    }
                }
                udev_device_unref(d);
            }
            return G_SOURCE_CONTINUE;
        }, this);
#endif
        read_idle_config();
        init_status();
        connect_system();
        for (int sig : {
                    SIGTERM, SIGINT, SIGHUP
                })g_unix_signal_add(sig, [](gpointer p)->gboolean{static_cast<Session*>(p)->stop(); return G_SOURCE_REMOVE;}, this);
        start(components[0]);
        start(components[1]);
        start(components[6]);
        desktop.home_selected = [this] { hide_keyboard(); };
        if (desktop.init([this](bool applications) {
            if (applications) g_dbus_connection_emit_signal(bus, nullptr, PATH, BUS, "ApplicationsChanged", nullptr, nullptr);
            g_dbus_connection_emit_signal(bus, nullptr, PATH, BUS, "DesktopChanged", nullptr, nullptr);
        })) {
            start(components[4]);
        }
        g_message("Session coordinator ready");
        return true;
    }
};
int main(int argc, char**argv) {
    if (argc < 2) {
        g_printerr("Usage: koya-session APP_ROOT\n");
        return 2;
    }
    Session session(argv[1]);
#ifdef KOYA_TESTING
    if (argc == 3) {
        session.fixture = argv[2];
    }
#endif
    if (!session.init()) {
        return 1;
    }
    g_main_loop_run(session.loop);
    return 0;
}
