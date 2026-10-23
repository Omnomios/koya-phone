#include <gio/gdesktopappinfo.h>
#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>

struct Launch {
    const char *id;
    GDBusConnection *bus = nullptr;
    GMainLoop *loop = g_main_loop_new(nullptr, FALSE);
    unsigned children = 0;
    int result = 0;
    explicit Launch(const char *token): id(token) {
        if (id) bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, nullptr);
    }
    ~Launch() { if (bus) g_object_unref(bus); g_main_loop_unref(loop); }
    void changed(const char *state, GPid pid, int status, const char *message = "") {
        if (!bus) return;
        g_dbus_connection_emit_signal(bus, nullptr, "/org/koya/Application", "org.koya.Application1", "LaunchChanged",
            g_variant_new("(ssuis)", id, state, static_cast<guint32>(pid), status, message), nullptr);
        g_dbus_connection_flush_sync(bus, nullptr, nullptr);
    }
    static void started(GDesktopAppInfo *, GPid pid, gpointer data) {
        auto *self = static_cast<Launch *>(data);
        self->children++;
        self->changed("started", pid, 0);
        g_child_watch_add(pid, [](GPid child, gint status, gpointer data) {
            auto *self = static_cast<Launch *>(data);
            GError *error = nullptr;
            const bool success = g_spawn_check_wait_status(status, &error);
            const int code = WIFEXITED(status) ? WEXITSTATUS(status) : -WTERMSIG(status);
            if (!success) { self->result = 1; g_printerr("Application process %d: %s\n", child, error->message); }
            self->changed("exited", child, code, error ? error->message : "");
            g_clear_error(&error); g_spawn_close_pid(child);
            if (!--self->children) g_main_loop_quit(self->loop);
        }, self);
    }
};

int main(int argc, char **argv) {
    if (argc != 2 && argc != 3) return 2;
    // Hyprland redirects exec output to /dev/null. Preserve startup errors.
    gchar *dir = g_build_filename(g_get_user_state_dir(), "koya-shell", nullptr);
    g_mkdir_with_parents(dir, 0700);
    gchar *path = g_build_filename(dir, "applications.log", nullptr);
    int fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (fd >= 0) { dup2(fd, STDERR_FILENO); close(fd); }
    g_free(dir); g_free(path);
    Launch launch(argc == 3 ? argv[2] : nullptr);
    GDesktopAppInfo *app = g_desktop_app_info_new_from_filename(argv[1]);
    if (!app) {
        g_printerr("Cannot load desktop entry: %s\n", argv[1]);
        launch.changed("failed", 0, 1, "Cannot load desktop entry"); return 1;
    }
    GAppLaunchContext *context = g_app_launch_context_new();
    GError *error = nullptr;
    bool result = launch.id ? g_desktop_app_info_launch_uris_as_manager(app, nullptr, context, G_SPAWN_DO_NOT_REAP_CHILD,
        nullptr, nullptr, Launch::started, &launch, &error) : g_app_info_launch(G_APP_INFO(app), nullptr, context, &error);
    if (!result) {
        g_printerr("Cannot launch %s: %s\n", argv[1], error ? error->message : "unknown error");
        launch.changed("failed", 0, 1, error ? error->message : "Unable to start application");
    }
    g_clear_error(&error); g_object_unref(context); g_object_unref(app);
    if (launch.children) g_main_loop_run(launch.loop);
    return result ? launch.result : 1;
}
