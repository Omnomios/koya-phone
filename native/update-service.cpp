// System-owned updater. Only this process decides whether an update is active.
#include <gio/gio.h>
#include <glib-unix.h>
#include <fcntl.h>
#include <unistd.h>
#include <string>
#include <cstdio>

static constexpr const char *NAME = "org.koya.Update1";
static constexpr const char *PATH = "/org/koya/Update1";
static constexpr const char *ACTION = "org.koya.update";
static const char *XML = R"(<node><interface name="org.koya.Update1">
<method name="GetState"><arg type="a{sv}" direction="out"/></method>
<method name="Start"/>
<signal name="Changed"><arg type="a{sv}"/></signal>
</interface></node>)";

struct Updater {
    GMainLoop *loop = g_main_loop_new(nullptr, FALSE);
    GDBusConnection *bus = nullptr;
    GSubprocess *child = nullptr;
    GCancellable *authorization = nullptr;
    std::string state = "idle", phase, message, output;
    std::string worker = "/usr/local/libexec/koya-update-worker";
    std::string logfile = "/var/log/koya-shell/update.log";
    guint64 job = 0;
    std::string requester, cancellation;
    bool stopping = false;

    bool busy() const { return state == "authorizing" || child; }
    void cancel_authorization() {
        if (!authorization) return;
        g_dbus_connection_call(bus, "org.freedesktop.PolicyKit1", "/org/freedesktop/PolicyKit1/Authority",
            "org.freedesktop.PolicyKit1.Authority", "CancelCheckAuthorization",
            g_variant_new("(s)", cancellation.c_str()), nullptr, G_DBUS_CALL_FLAGS_NONE, -1, nullptr, nullptr, nullptr);
        g_cancellable_cancel(authorization);
    }
    GVariant *snapshot() {
        GVariantBuilder b;
        g_variant_builder_init(&b, G_VARIANT_TYPE_VARDICT);
        for (const auto &entry : {std::pair<const char*, std::string>("State", state),
                {"Phase", phase}, {"Message", message}, {"Log", output}})
            g_variant_builder_add(&b, "{sv}", entry.first, g_variant_new_string(entry.second.c_str()));
        g_variant_builder_add(&b, "{sv}", "Job", g_variant_new_uint64(job));
        return g_variant_builder_end(&b);
    }
    void changed() {
        g_dbus_connection_emit_signal(bus, nullptr, PATH, NAME, "Changed",
            g_variant_new("(@a{sv})", snapshot()), nullptr);
    }
    bool read_log() {
        // The log is diagnostic output, never a source of running/completed state.
        int fd = open(logfile.c_str(), O_RDONLY | O_CLOEXEC);
        if (fd < 0) return false;
        bool phase_changed = false;
        if (child && phase != "install") {
            char head[4096]; ssize_t count = read(fd, head, sizeof(head));
            if (count > 0 && std::string(head, count).find("Starting installation outside the graphical session...") != std::string::npos) {
                phase = "install"; phase_changed = true;
            }
        }
        off_t end = lseek(fd, 0, SEEK_END);
        lseek(fd, end > 16384 ? end - 16384 : 0, SEEK_SET);
        char data[16385]; ssize_t count = read(fd, data, sizeof(data) - 1); close(fd);
        if (count < 0) return false;
        data[count] = 0;
        char *valid = g_utf8_make_valid(data, count);
        std::string next(valid); g_free(valid);
        if (next == output) return phase_changed;
        output = std::move(next);
        return true;
    }
    void failed(const std::string &reason) {
        state = "failed"; message = reason; changed();
        if (stopping) g_main_loop_quit(loop);
    }
    void launch() {
        GError *error = nullptr;
        // Replace the log inode: descendants from an earlier installer may
        // still have its stdout open and must not write into the next job.
        std::string next_log = logfile + ".new";
        int fd = open(next_log.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
        if (fd < 0) { failed("Cannot open the installer log"); return; }
        if (rename(next_log.c_str(), logfile.c_str()) < 0) {
            close(fd); failed("Cannot replace the installer log"); return;
        }
        auto *launcher = g_subprocess_launcher_new(G_SUBPROCESS_FLAGS_STDERR_MERGE);
        const char *env[] = {"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root", "USER=root", "LOGNAME=root", nullptr};
        g_subprocess_launcher_set_environ(launcher, const_cast<char**>(env));
        g_subprocess_launcher_set_cwd(launcher, "/");
        g_subprocess_launcher_take_stdout_fd(launcher, fd);
        child = g_subprocess_launcher_spawn(launcher, &error, "/bin/sh", worker.c_str(), nullptr);
        g_object_unref(launcher);
        if (!child) {
            std::string reason = error->message; g_error_free(error); failed(reason); return;
        }
        state = "running"; phase = "download"; message.clear(); output.clear(); changed();
        g_subprocess_wait_async(child, nullptr, +[](GObject *object, GAsyncResult *result, gpointer data) {
            auto &s = *static_cast<Updater*>(data);
            GError *error = nullptr;
            bool waited = g_subprocess_wait_finish(G_SUBPROCESS(object), result, &error);
            bool success = waited && g_subprocess_get_successful(G_SUBPROCESS(object));
            s.read_log();
            // Reap the actual installer before accepting the next request.
            g_clear_object(&s.child);
            s.state = success ? "succeeded" : "failed";
            s.message = success ? "Update complete" : error ? error->message : "The installer failed. See the installer output.";
            g_clear_error(&error); s.changed();
            if (s.stopping) g_main_loop_quit(s.loop);
        }, this);
    }
    void start(const char *sender, GDBusMethodInvocation *invocation) {
        if (stopping || busy()) {
            g_dbus_method_invocation_return_dbus_error(invocation, "org.koya.Update1.Busy", "An update is already in progress"); return;
        }
        ++job; state = "authorizing"; phase.clear(); message.clear();
        requester = sender; cancellation = "koya-update-" + std::to_string(job);
        authorization = g_cancellable_new();
        GVariantBuilder subject, details;
        g_variant_builder_init(&subject, G_VARIANT_TYPE_VARDICT);
        g_variant_builder_add(&subject, "{sv}", "name", g_variant_new_string(sender));
        g_variant_builder_init(&details, G_VARIANT_TYPE("a{ss}"));
        // Authorize the bus caller, never a caller-provided PID or identity.
        g_dbus_connection_call(bus, "org.freedesktop.PolicyKit1", "/org/freedesktop/PolicyKit1/Authority",
            "org.freedesktop.PolicyKit1.Authority", "CheckAuthorization",
            g_variant_new("((s@a{sv})s@a{ss}us)", "system-bus-name", g_variant_builder_end(&subject), ACTION,
                g_variant_builder_end(&details), 1u, cancellation.c_str()), G_VARIANT_TYPE("((bba{ss}))"),
            G_DBUS_CALL_FLAGS_NONE, G_MAXINT, authorization,
            +[](GObject *object, GAsyncResult *result, gpointer data) {
                auto &s = *static_cast<Updater*>(data);
                GError *error = nullptr;
                GVariant *reply = g_dbus_connection_call_finish(G_DBUS_CONNECTION(object), result, &error);
                g_clear_object(&s.authorization);
                gboolean allowed = FALSE, challenge = FALSE; GVariant *details = nullptr;
                if (reply) { g_variant_get(reply, "((bb@a{ss}))", &allowed, &challenge, &details); g_variant_unref(details); g_variant_unref(reply); }
                if (allowed && !s.stopping) s.launch();
                else s.failed(error ? error->message : "Administrator approval was refused or cancelled");
                g_clear_error(&error);
            }, this);
        // Password entry may take minutes; no GUI method call is held open.
        g_dbus_method_invocation_return_value(invocation, nullptr);
        changed();
    }
};

int main(int argc, char **argv) {
    Updater s;
    GBusType type = G_BUS_TYPE_SYSTEM;
#ifdef KOYA_UPDATE_TESTING
    if (argc != 3) return 2;
    type = G_BUS_TYPE_SESSION; s.worker = argv[1]; s.logfile = argv[2];
#else
    (void)argc; (void)argv;
    if (getuid() != 0) return 1;
    g_mkdir_with_parents("/var/log/koya-shell", 0755);
#endif
    GError *error = nullptr;
    s.bus = g_bus_get_sync(type, nullptr, &error);
    if (!s.bus) { g_printerr("Updater bus: %s\n", error->message); return 1; }
    auto *node = g_dbus_node_info_new_for_xml(XML, nullptr);
    static const GDBusInterfaceVTable vtable = {+[](GDBusConnection*, const char *sender, const char*, const char*,
            const char *method, GVariant*, GDBusMethodInvocation *invocation, gpointer data) {
        auto &s = *static_cast<Updater*>(data);
        if (!g_strcmp0(method, "GetState")) {
            s.read_log(); g_dbus_method_invocation_return_value(invocation, g_variant_new("(@a{sv})", s.snapshot()));
        } else s.start(sender, invocation);
    }, nullptr, nullptr, {nullptr}};
    if (!g_dbus_connection_register_object(s.bus, PATH, node->interfaces[0], &vtable, &s, nullptr, &error)) return 1;
    auto *reply = g_dbus_connection_call_sync(s.bus, "org.freedesktop.DBus", "/org/freedesktop/DBus",
        "org.freedesktop.DBus", "RequestName", g_variant_new("(su)", NAME, 4u), G_VARIANT_TYPE("(u)"),
        G_DBUS_CALL_FLAGS_NONE, -1, nullptr, &error);
    guint result = 0;
    if (reply) { g_variant_get(reply, "(u)", &result); g_variant_unref(reply); }
    if (result != 1) { g_printerr("Updater service already owned or unavailable\n"); return 1; }
    g_dbus_connection_signal_subscribe(s.bus, "org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged",
        "/org/freedesktop/DBus", nullptr, G_DBUS_SIGNAL_FLAGS_NONE,
        +[](GDBusConnection*, const char*, const char*, const char*, const char*, GVariant *args, gpointer data) {
            auto &s = *static_cast<Updater*>(data);
            const char *name, *before, *after; g_variant_get(args, "(&s&s&s)", &name, &before, &after);
            if (s.authorization && s.requester == name && !*after) s.cancel_authorization();
        }, &s, nullptr);
    g_timeout_add_seconds(1, +[](gpointer data)->gboolean {
        auto &s = *static_cast<Updater*>(data);
        if (s.child && s.read_log()) s.changed();
        return G_SOURCE_CONTINUE;
    }, &s);
    for (int signal : {SIGTERM, SIGINT}) g_unix_signal_add(signal, +[](gpointer data)->gboolean {
        auto &s = *static_cast<Updater*>(data); s.stopping = true;
        if (s.authorization) s.cancel_authorization();
        else if (!s.child) g_main_loop_quit(s.loop);
        return G_SOURCE_REMOVE;
    }, &s);
    g_main_loop_run(s.loop);
    return 0;
}
