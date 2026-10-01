#include <gio/gdesktopappinfo.h>
#include <fcntl.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    // Hyprland redirects exec output to /dev/null. Preserve startup errors.
    gchar *dir = g_build_filename(g_get_user_state_dir(), "koya-shell", nullptr);
    g_mkdir_with_parents(dir, 0700);
    gchar *path = g_build_filename(dir, "applications.log", nullptr);
    int fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (fd >= 0) { dup2(fd, STDERR_FILENO); close(fd); }
    g_free(dir); g_free(path);
    GDesktopAppInfo *app = g_desktop_app_info_new_from_filename(argv[1]);
    if (!app) { g_printerr("Cannot load desktop entry: %s\n", argv[1]); return 1; }
    GAppLaunchContext *context = g_app_launch_context_new();
    GError *error = nullptr;
    bool result = g_app_info_launch(G_APP_INFO(app), nullptr, context, &error);
    if (!result) g_printerr("Cannot launch %s: %s\n", argv[1], error ? error->message : "unknown error");
    g_clear_error(&error); g_object_unref(context); g_object_unref(app);
    return result ? 0 : 1;
}
