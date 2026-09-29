// Compositor IPC and owned UI clients for the Bash launcher's lifecycle test.
#include <gio/gio.h>
#include <glib-unix.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <signal.h>
#include <cstring>
#include <string>
#include <vector>

static GMainLoop *loop;
static int socket_at(const std::string &path) {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    sockaddr_un address{}; address.sun_family = AF_UNIX;
    if (path.size() >= sizeof(address.sun_path)) return -1;
    strcpy(address.sun_path, path.c_str());
    if (fd < 0 || bind(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) || listen(fd, 8)) return -1;
    return fd;
}
static void action(GDBusConnection *bus, const char*, const char*, const char*, const char*, GVariant *args, GDBusMethodInvocation *invocation, gpointer) {
    const char *member; g_variant_get(args, "(&s)", &member);
    g_dbus_connection_call(bus, "org.koya.Shell1", "/org/koya/Shell1", "org.koya.Shell1", member, nullptr,
        nullptr, G_DBUS_CALL_FLAGS_NONE, 3000, nullptr, [](GObject *object, GAsyncResult *result, gpointer data) {
            auto *invocation = static_cast<GDBusMethodInvocation *>(data);
            GError *error = nullptr;
            GVariant *reply = g_dbus_connection_call_finish(G_DBUS_CONNECTION(object), result, &error);
            if (reply) { g_dbus_method_invocation_return_value(invocation, reply); g_variant_unref(reply); }
            else { g_dbus_method_invocation_return_gerror(invocation, error); g_error_free(error); }
            g_object_unref(invocation);
        }, g_object_ref(invocation));
}
int main(int argc, char **argv) {
    loop = g_main_loop_new(nullptr, FALSE);
    for (int sig : {SIGTERM, SIGINT}) g_unix_signal_add(sig, [](gpointer)->gboolean { g_main_loop_quit(loop); return G_SOURCE_REMOVE; }, nullptr);
    if (argc == 3 && !strcmp(argv[1], "--parent")) {
        int fd = socket_at(argv[2]); if (fd < 0) return 1;
        g_main_loop_run(loop); close(fd); unlink(argv[2]); return 0;
    }
    if (argc > 1 && !strcmp(argv[1], "--hyprland")) {
        if (argc > 2 && !strcmp(argv[2], "--version")) { g_print("Hyprland 0.51.1 (IPC fixture)\n"); return 0; }
        if (argc > 2 && !strcmp(argv[2], "--verify-config")) { g_print("config ok\n"); return 0; }
        const char *run = g_getenv("KOYA_DEV_RUN");
        if (!run || argc != 4 || strcmp(argv[2], "--config")) return 1;
        std::string instance = std::string(run) + "/hypr/local-dev-test";
        g_mkdir_with_parents(instance.c_str(), 0700);
        int commands = socket_at(instance + "/.socket.sock"), events = socket_at(instance + "/.socket2.sock");
        if (commands < 0 || events < 0) return 1;
        std::vector<int> peers;
        g_unix_fd_add(events, G_IO_IN, [](int fd, GIOCondition, gpointer data)->gboolean {
            int peer = accept4(fd, nullptr, nullptr, SOCK_CLOEXEC);
            if (peer >= 0) static_cast<std::vector<int> *>(data)->push_back(peer);
            return G_SOURCE_CONTINUE;
        }, &peers);
        g_unix_fd_add(commands, G_IO_IN, [](int fd, GIOCondition, gpointer)->gboolean {
            int peer = accept4(fd, nullptr, nullptr, SOCK_CLOEXEC);
            if (peer < 0) return G_SOURCE_CONTINUE;
            char buffer[8192]{}; ssize_t length = recv(peer, buffer, sizeof(buffer) - 1, 0);
            std::string command(buffer, length > 0 ? length : 0), reply = "ok";
            if (command == "j/monitors") reply = "[{\"name\":\"WL-1\",\"dpmsStatus\":true}]";
            else if (command == "j/workspaces") reply = "[{\"id\":1,\"name\":\"1\"}]";
            else if (command == "j/clients") reply = "[]";
            else if (command == "j/activeworkspace") reply = "{\"id\":1,\"name\":\"1\"}";
            send(peer, reply.data(), reply.size(), MSG_NOSIGNAL); close(peer);
            return G_SOURCE_CONTINUE;
        }, nullptr);
        std::string audit;
        for (const char *key : {"KOYA_DEV_RUN", "KOYA_DEV_KOYA", "KOYA_DEV_ASSETS", "KOYA_DEV_PLUGINS", "DBUS_SESSION_BUS_ADDRESS", "DBUS_SYSTEM_BUS_ADDRESS"}) {
            gchar *quoted = g_shell_quote(g_getenv(key)); audit += std::string("export ") + key + "=" + quoted + "\n"; g_free(quoted);
        }
        g_file_set_contents(g_getenv("KOYA_DEV_AUDIT"), audit.c_str(), -1, nullptr);
        g_setenv("HYPRLAND_INSTANCE_SIGNATURE", "local-dev-test", TRUE);
        g_setenv("WAYLAND_DISPLAY", "nested-test", TRUE);
        GError *error = nullptr;
        GSubprocess *shell = g_subprocess_new(G_SUBPROCESS_FLAGS_NONE, &error, "bash", (std::string(run) + "/shell.sh").c_str(), nullptr);
        if (!shell) return 1;
        g_main_loop_run(loop);
        for (int peer : peers) close(peer);
        close(commands); close(events); g_object_unref(shell); return 0;
    }
    if (argc > 1 && !strcmp(argv[1], "--koya")) {
        std::string entry;
        for (int i = 2; i + 1 < argc; ++i) if (!strcmp(argv[i], "-i")) entry = argv[i + 1];
        std::string component = entry == "dev-top-bar.js" ? "top-bar" : entry.substr(5, entry.size() - 8);
        GError *error = nullptr;
        GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &error);
        if (!bus) return 1;
        GDBusNodeInfo *node = g_dbus_node_info_new_for_xml("<node><interface name=\"org.koya.Test.Component\"><method name=\"Action\"><arg type=\"s\" direction=\"in\"/></method></interface></node>", nullptr);
        static const GDBusInterfaceVTable table = {action, nullptr, nullptr, {nullptr}};
        g_dbus_connection_register_object(bus, "/org/koya/Test/Component", node->interfaces[0], &table, nullptr, nullptr, nullptr);
        std::string name = "org.koya.Test." + component;
        for (char &character : name) if (character == '-') character = '_';
        GVariant *reply = g_dbus_connection_call_sync(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
            g_variant_new("(su)", name.c_str(), 4u), nullptr, G_DBUS_CALL_FLAGS_NONE, 3000, nullptr, nullptr);
        if (!reply) return 1;
        g_variant_unref(reply);
        reply = g_dbus_connection_call_sync(bus, "org.koya.Shell1", "/org/koya/Shell1", "org.koya.Shell1", "Ready",
            g_variant_new("(s)", component.c_str()), nullptr, G_DBUS_CALL_FLAGS_NONE, 3000, nullptr, &error);
        if (!reply) { g_printerr("%s\n", error->message); return 1; }
        g_variant_unref(reply);
        std::string pidfile = std::string(g_getenv("KOYA_DEV_RUN")) + "/component-" + component + ".pid";
        g_file_set_contents(pidfile.c_str(), std::to_string(getpid()).c_str(), -1, nullptr);
        g_main_loop_run(loop); g_dbus_node_info_unref(node); g_object_unref(bus); return 0;
    }
    return 1;
}
