// SPDX-License-Identifier: MIT
// Hyprland commands are bounded, on demand; its event socket drives updates.
#pragma once
#include <gio/gdesktopappinfo.h>
#include <functional>
#include <algorithm>
#include "icons.hpp"

class Desktop {
    std::string instance, buffer;
    int events = -1;
    guint source = 0, notification = 0;
    GAppInfoMonitor *monitor = nullptr;
    gulong monitor_handler = 0;
    std::function<void(bool)> notify;
    bool applications_dirty = false;
public:
    bool available = false;
    std::function<void()> home_selected;
    std::string root;
    Icons icons;
    std::map<std::string, GDesktopAppInfo *> apps;
    explicit Desktop(std::string directory): root(std::move(directory)), icons(root) {}
    ~Desktop() {
        if (source) g_source_remove(source);
        if (notification) g_source_remove(notification);
        if (events >= 0) close(events);
        if (monitor) { g_signal_handler_disconnect(monitor, monitor_handler); g_object_unref(monitor); }
        clear_apps();
    }
    void clear_apps() { for (auto &app : apps) g_object_unref(app.second); apps.clear(); }
    void changed() {
        if (!notification) notification = g_idle_add([](gpointer data)->gboolean {
            auto *d = static_cast<Desktop *>(data); d->notification = 0;
            bool applications = d->applications_dirty; d->applications_dirty = false;
            d->notify(applications); return G_SOURCE_REMOVE;
        }, this);
    }
    static int connect_socket(const std::string &path) {
        sockaddr_un address{}; address.sun_family = AF_UNIX;
        if (path.size() >= sizeof(address.sun_path)) return -1;
        strcpy(address.sun_path, path.c_str());
        int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
        if (fd >= 0 && connect(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address))) { close(fd); return -1; }
        return fd;
    }
    bool init(std::function<void(bool)> callback) {
        const char *signature = g_getenv("HYPRLAND_INSTANCE_SIGNATURE");
        if (!signature || !*signature) return false;
        notify = std::move(callback);
        instance = std::string(g_getenv("XDG_RUNTIME_DIR")) + "/hypr/" + signature;
        events = connect_socket(instance + "/.socket2.sock");
        if (events < 0) return false;
        available = true;
        source = g_unix_fd_add(events, static_cast<GIOCondition>(G_IO_IN | G_IO_HUP | G_IO_ERR),
            [](gint fd, GIOCondition condition, gpointer data)->gboolean {
                auto *d = static_cast<Desktop *>(data);
                char bytes[4096]; ssize_t size;
                while ((size = recv(fd, bytes, sizeof(bytes), 0)) > 0) {
                    d->buffer.append(bytes, size);
                    size_t end;
                    while ((end = d->buffer.find('\n')) != std::string::npos) {
                        std::string event = d->buffer.substr(0, end); d->buffer.erase(0, end + 1);
                        const std::string name = event.substr(0, event.find(">>"));
                        if (event.compare(0, 15, "workspacev2>>1,") == 0 && d->home_selected) d->home_selected();
                        if (name == "workspacev2" || name == "createworkspacev2" || name == "destroyworkspacev2" ||
                            name == "openwindow" || name == "closewindow" || name == "movewindowv2" ||
                            name == "activewindowv2" || name == "windowtitlev2" || name == "monitoraddedv2" || name == "monitorremoved") d->changed();
                    }
                    if (d->buffer.size() > 65536) d->buffer.clear();
                }
                if (size == 0 || condition & (G_IO_HUP | G_IO_ERR)) {
                    d->available = false; d->source = 0; d->changed(); return G_SOURCE_REMOVE;
                }
                return G_SOURCE_CONTINUE;
            }, this);
        monitor = g_app_info_monitor_get();
        monitor_handler = g_signal_connect(monitor, "changed", G_CALLBACK(+[](GAppInfoMonitor *, gpointer data) {
            auto *desktop = static_cast<Desktop *>(data);
            desktop->icons.invalidate(); desktop->applications_dirty = true; desktop->changed();
        }), this);
        return true;
    }
    static std::string request(const std::string &path, const std::string &command) {
        int fd = connect_socket(path);
        if (fd < 0) return {};
        std::string result;
        if (send(fd, command.data(), command.size(), MSG_NOSIGNAL) != static_cast<ssize_t>(command.size())) { close(fd); return {}; }
        gint64 deadline = g_get_monotonic_time() + 300000;
        bool complete = false;
        while (g_get_monotonic_time() < deadline) {
            pollfd pfd{fd, POLLIN, 0};
            int remaining = (deadline - g_get_monotonic_time() + 999) / 1000;
            if (poll(&pfd, 1, remaining) <= 0) break;
            char bytes[4096]; ssize_t size = recv(fd, bytes, sizeof(bytes), 0);
            if (!size) { complete = true; break; }
            if (size < 0) { if (errno == EAGAIN || errno == EINTR) continue; break; }
            result.append(bytes, size);
            if (result.size() > 4 * 1024 * 1024) break;
        }
        close(fd);
        return complete ? result : std::string{};
    }
    std::string ipc(const std::string &command) {
        return available ? request(instance + "/.socket.sock", command) : std::string{};
    }
    void query_state(GDBusMethodInvocation *invocation) {
        // Keep compositor queries off the session's main loop. Power events,
        // drawer visibility and dismissal remain responsive during a slow IPC
        // reply. The worker owns its socket path and all result storage.
        GTask *task = g_task_new(nullptr, nullptr, [](GObject *, GAsyncResult *result, gpointer data) {
            auto *invocation = static_cast<GDBusMethodInvocation *>(data);
            GError *error = nullptr;
            auto *state = static_cast<GVariant *>(g_task_propagate_pointer(G_TASK(result), &error));
            if (state) g_dbus_method_invocation_return_value(invocation, g_variant_new("(@a{sv})", state));
            else g_dbus_method_invocation_return_dbus_error(invocation, "org.koya.Shell1.Error", error->message);
            g_clear_error(&error);
            g_object_unref(invocation);
        }, g_object_ref(invocation));
        g_task_set_task_data(task, new std::string(instance + "/.socket.sock"), [](gpointer data) {
            delete static_cast<std::string *>(data);
        });
        g_task_run_in_thread(task, [](GTask *task, gpointer, gpointer data, GCancellable *) {
            const auto &path = *static_cast<std::string *>(data);
            GVariantBuilder state; g_variant_builder_init(&state, G_VARIANT_TYPE_VARDICT);
            for (const char *topic : {"workspaces", "clients", "activeworkspace"}) {
                std::string reply = request(path, std::string("j/") + topic);
                if (reply.empty()) {
                    g_variant_builder_clear(&state);
                    g_task_return_new_error(task, G_IO_ERROR, G_IO_ERROR_FAILED, "Hyprland state query failed");
                    return;
                }
                g_variant_builder_add(&state, "{sv}", topic, g_variant_new_string(reply.c_str()));
            }
            g_task_return_pointer(task, g_variant_ref_sink(g_variant_builder_end(&state)), [](gpointer data) {
                g_variant_unref(static_cast<GVariant *>(data));
            });
        });
        g_object_unref(task);
    }
    bool dispatch(const std::string &command) {
        std::string response = ipc("dispatch " + command);
        return response == "ok" || response == "ok\n";
    }
    bool select_workspace(unsigned workspace) {
        std::string response = ipc("dispatch workspace " + std::to_string(workspace));
        // Hyprland 0.51 returns this error when selecting the active workspace.
        // An explicit desktop selection is successful if we are already there.
        return response == "ok" || response == "ok\n" ||
               response == "Previous workspace doesn't exist" || response == "Previous workspace doesn't exist\n";
    }
    static bool launchable(GDesktopAppInfo *info) {
        if (!g_app_info_should_show(G_APP_INFO(info)) || g_desktop_app_info_get_boolean(info, "Terminal")) return false;
        gchar *try_exec = g_desktop_app_info_get_string(info, "TryExec");
        const bool explicit_check = try_exec && *try_exec;
        const char *program = explicit_check ? try_exec : g_app_info_get_executable(G_APP_INFO(info));
        // D-Bus activated applications need not provide an Exec command.
        const bool activated = !explicit_check && g_desktop_app_info_get_boolean(info, "DBusActivatable");
        gchar *found = program && *program ? g_find_program_in_path(program) : nullptr;
        const bool result = found || activated;
        g_free(found); g_free(try_exec);
        return result;
    }
    void read_apps() {
        clear_apps();
        GList *list = g_app_info_get_all();
        for (GList *item = list; item; item = item->next) {
            GAppInfo *info = G_APP_INFO(item->data);
            const char *id = g_app_info_get_id(info);
            // Revalidate executables even when GIO still holds a cached entry.
            if (id && G_IS_DESKTOP_APP_INFO(info) && launchable(G_DESKTOP_APP_INFO(info)))
                apps[id] = G_DESKTOP_APP_INFO(g_object_ref(info));
        }
        g_list_free_full(list, g_object_unref);
        GDir *dir = g_dir_open((root + "/applications").c_str(), 0, nullptr);
        if (dir) {
            const char *name;
            while ((name = g_dir_read_name(dir))) {
                if (!g_str_has_suffix(name, ".desktop") || apps.count(name)) continue;
                auto *info = g_desktop_app_info_new_from_filename((root + "/applications/" + name).c_str());
                if (info && launchable(info)) apps[name] = info;
                else if (info) g_object_unref(info);
            }
            g_dir_close(dir);
        }
    }
    GVariant *applications() {
        read_apps();
        GVariantBuilder result; g_variant_builder_init(&result, G_VARIANT_TYPE("aa{sv}"));
        for (auto &app : apps) {
            GVariantBuilder entry; g_variant_builder_init(&entry, G_VARIANT_TYPE_VARDICT);
            auto add = [&](const char *key, const char *value) {
                g_variant_builder_add(&entry, "{sv}", key, g_variant_new_string(value ? value : ""));
            };
            add("id", app.first.c_str());
            add("name", g_app_info_get_display_name(G_APP_INFO(app.second)));
            add("class", g_desktop_app_info_get_startup_wm_class(app.second));
            GIcon *icon = g_app_info_get_icon(G_APP_INFO(app.second));
            gchar *icon_name = icon ? g_icon_to_string(icon) : nullptr;
            add("iconName", icon_name); g_free(icon_name);
            add("icon", icons.resolve(icon).c_str());
            const char *executable = g_app_info_get_executable(G_APP_INFO(app.second));
            gchar *base = executable ? g_path_get_basename(executable) : g_strdup("");
            add("executable", base); g_free(base);
            g_variant_builder_add_value(&result, g_variant_builder_end(&entry));
        }
        return g_variant_builder_end(&result);
    }
    bool launch(const char *id, unsigned workspace) {
        if (workspace < 2 || workspace > 10000) return false;
        read_apps();
        auto app = apps.find(id);
        if (app == apps.end()) return false;
        const char *filename = g_desktop_app_info_get_filename(app->second);
        gchar *helper = g_shell_quote((root + "/build/koya-launch-app").c_str());
        gchar *file = g_shell_quote(filename);
        // Switch before exec so Hyprland's initial-workspace token is inherited
        // by GIO-launched children, even if the user changes desktop during startup.
        bool result = dispatch("workspace " + std::to_string(workspace));
        if (result) result = dispatch(std::string("exec ") + helper + " " + file);
        g_free(helper); g_free(file);
        return result;
    }
    static bool address(const char *value) {
        size_t size = strlen(value);
        return size > 2 && size <= 18 && value[0] == '0' && value[1] == 'x' &&
            std::all_of(value + 2, value + size, [](char c) { return g_ascii_isxdigit(c); });
    }
};
