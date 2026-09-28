// SPDX-License-Identifier: MIT
// Hyprland adapter for the existing coordinator's private display/idle socket.
// GIO watches descriptors and child exits; no recurring timers or polling loop.
#include <gio/gio.h>
#include <gio/gunixinputstream.h>
#include <glib-unix.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>
#include <signal.h>
#include <cerrno>
#include <cstring>
#include <string>
#include <vector>
#include <algorithm>

class Bridge;
struct Child {
    Bridge *bridge;
    GSubprocess *process;
    bool coordinator, expected = false;
    unsigned generation;
    guint source = 0, killer = 0;
    std::string buffer;
};

class Bridge {
public:
    GMainLoop *loop = g_main_loop_new(nullptr, false);
    std::string root, runtime, instance, signature, path, state;
    int server = -1, client = -1, events = -1, lock = -1;
    guint server_source = 0, client_source = 0, event_source = 0;
    bool stopping = false, off = false, bound = false;
    int status = 0;
    unsigned generation = 0;
    std::vector<Child *> children;
    Child *idle = nullptr;
    std::vector<const char *> coordinator_command;

    explicit Bridge(const char *directory): root(directory) {
        runtime = g_getenv("XDG_RUNTIME_DIR");
        signature = g_getenv("HYPRLAND_INSTANCE_SIGNATURE");
        instance = runtime + "/hypr/" + signature;
        path = runtime + "/koya-display.sock";
        state = runtime + "/koya-hyprland.state";
    }
    static void remove(guint &source) {
        if (source) g_source_remove(source);
        source = 0;
    }
    static int connect_socket(const std::string &path, int type) {
        sockaddr_un address{};
        address.sun_family = AF_UNIX;
        if (path.size() >= sizeof(address.sun_path)) return -1;
        strcpy(address.sun_path, path.c_str());
        int fd = socket(AF_UNIX, type | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
        if (fd >= 0 && connect(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address))) {
            close(fd);
            fd = -1;
        }
        return fd;
    }
    std::string ipc(const std::string &command) {
        int fd = connect_socket(instance + "/.socket.sock", SOCK_STREAM);
        if (fd < 0) return {};
        std::string response;
        if (send(fd, command.data(), command.size(), MSG_NOSIGNAL) != static_cast<ssize_t>(command.size())) {
            close(fd);
            return {};
        }
        gint64 deadline = g_get_monotonic_time() + 300000;
        while (g_get_monotonic_time() < deadline) {
            pollfd poll_fd{fd, POLLIN, 0};
            int remaining = (deadline - g_get_monotonic_time() + 999) / 1000;
            if (poll(&poll_fd, 1, remaining) <= 0) { response.clear(); break; }
            char buffer[4096];
            ssize_t length = recv(fd, buffer, sizeof(buffer), 0);
            if (length == 0) break;
            if (length < 0) { if (errno == EAGAIN || errno == EINTR) continue; response.clear(); break; }
            response.append(buffer, length);
        }
        close(fd);
        return response;
    }
    bool power(bool on) {
        std::string result = ipc(on ? "dispatch dpms on" : "dispatch dpms off");
        if (result != "ok" && result != "ok\n") {
            g_warning("Hyprland DPMS request rejected: %s", result.c_str());
            return false;
        }
        off = !on;
        return true;
    }
    static void child_setup(gpointer parent) {
        prctl(PR_SET_PDEATHSIG, SIGTERM);
        if (getppid() != GPOINTER_TO_INT(parent)) _exit(125);
    }
    Child *spawn(const std::vector<const char *> &args, bool coordinator, unsigned token = 0) {
        GSubprocessLauncher *launcher = g_subprocess_launcher_new(coordinator ? G_SUBPROCESS_FLAGS_NONE : G_SUBPROCESS_FLAGS_STDOUT_PIPE);
        g_subprocess_launcher_set_child_setup(launcher, child_setup, GINT_TO_POINTER(getpid()), nullptr);
        GError *error = nullptr;
        GSubprocess *process = g_subprocess_launcher_spawnv(launcher, args.data(), &error);
        g_object_unref(launcher);
        if (!process) {
            g_warning("Cannot launch child: %s", error ? error->message : "unknown error");
            g_clear_error(&error);
            return nullptr;
        }
        auto *child = new Child{this, process, coordinator, false, token, 0, 0, {}};
        children.push_back(child);
        if (!coordinator) {
            GInputStream *pipe = g_subprocess_get_stdout_pipe(process);
            int fd = g_unix_input_stream_get_fd(G_UNIX_INPUT_STREAM(pipe));
            fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
            child->source = g_unix_fd_add(fd, static_cast<GIOCondition>(G_IO_IN | G_IO_HUP | G_IO_ERR),
                [](gint fd, GIOCondition condition, gpointer data)->gboolean {
                    auto *child = static_cast<Child *>(data);
                    auto *bridge = child->bridge;
                    char buffer[128];
                    ssize_t length;
                    while ((length = read(fd, buffer, sizeof(buffer))) > 0) {
                        child->buffer.append(buffer, length);
                        size_t end;
                        while ((end = child->buffer.find('\n')) != std::string::npos) {
                            std::string packet = child->buffer.substr(0, end);
                            child->buffer.erase(0, end + 1);
                            if (child == bridge->idle && child->generation == bridge->generation && bridge->client >= 0 &&
                                packet == "T " + std::to_string(child->generation)) {
                                if (send(bridge->client, packet.data(), packet.size(), MSG_NOSIGNAL) != static_cast<ssize_t>(packet.size()))
                                    bridge->disconnect();
                            }
                        }
                    }
                    if (condition & (G_IO_HUP | G_IO_ERR) || length == 0) {
                        child->source = 0;
                        return G_SOURCE_REMOVE;
                    }
                    return G_SOURCE_CONTINUE;
                }, child);
        }
        g_subprocess_wait_async(process, nullptr, [](GObject *object, GAsyncResult *result, gpointer data) {
            auto *child = static_cast<Child *>(data);
            auto *bridge = child->bridge;
            g_subprocess_wait_finish(G_SUBPROCESS(object), result, nullptr);
            remove(child->source);
            remove(child->killer);
            if (bridge->idle == child) bridge->idle = nullptr;
            bool unexpected = !child->expected && !bridge->stopping;
            bridge->children.erase(std::remove(bridge->children.begin(), bridge->children.end(), child), bridge->children.end());
            g_object_unref(child->process);
            delete child;
            if (unexpected) { g_warning("Shell child exited unexpectedly"); bridge->stop(1); }
            if (bridge->stopping && bridge->children.empty()) g_main_loop_quit(bridge->loop);
        }, child);
        return child;
    }
    void terminate(Child *child) {
        if (!child || child->expected) return;
        child->expected = true;
        remove(child->source);
        g_subprocess_send_signal(child->process, SIGTERM);
        child->killer = g_timeout_add(child->coordinator ? 4000 : 2000, [](gpointer data)->gboolean {
            auto *child = static_cast<Child *>(data);
            child->killer = 0;
            g_subprocess_force_exit(child->process);
            return G_SOURCE_REMOVE;
        }, child);
    }
    void disarm() {
        terminate(idle);
        idle = nullptr;
    }
    bool arm(unsigned seconds, unsigned token) {
        disarm();
        generation = token;
        if (!seconds) return true;
        std::string timeout = std::to_string(seconds), callback = "printf 'T " + std::to_string(token) + "\\n'";
        idle = spawn({"swayidle", "-w", "timeout", timeout.c_str(), callback.c_str(), nullptr}, false, token);
        return idle != nullptr;
    }
    void disconnect() {
        remove(client_source);
        if (client >= 0) close(client);
        client = -1;
        disarm();
        if (off) power(true);
    }
    void request() {
        char packet[64] = {}, response = 'E';
        ssize_t length = recv(client, packet, sizeof(packet) - 1, 0);
        if (length < 0 && errno == EAGAIN) return;
        if (length <= 0) { disconnect(); return; }
        unsigned seconds, token;
        char extra;
        if (length == 1 && (packet[0] == '0' || packet[0] == '1')) {
            if (power(packet[0] == '1')) response = packet[0];
        } else if (length == 1 && packet[0] == '?') {
            response = off ? '0' : '1';
        } else if (sscanf(packet, "t %u %u %c", &seconds, &token, &extra) == 2 && seconds <= 86400) {
            // Reject negative and overflowing values before scanf's unsigned conversion.
            std::string expected = "t " + std::to_string(seconds) + " " + std::to_string(token);
            if (expected == packet && arm(seconds, token)) response = 't';
        }
        if (send(client, &response, 1, MSG_NOSIGNAL) != 1) disconnect();
    }
    bool bind_server() {
        std::string lock_path = runtime + "/koya-hyprland-bridge.lock";
        lock = open(lock_path.c_str(), O_WRONLY | O_CREAT | O_CLOEXEC, 0600);
        if (lock < 0 || flock(lock, LOCK_EX | LOCK_NB)) return false;
        sockaddr_un address{};
        address.sun_family = AF_UNIX;
        if (path.size() >= sizeof(address.sun_path)) return false;
        strcpy(address.sun_path, path.c_str());
        server = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
        if (server < 0) return false;
        if (bind(server, reinterpret_cast<sockaddr *>(&address), sizeof(address))) {
            if (errno != EADDRINUSE) return false;
            int probe = connect_socket(path, SOCK_SEQPACKET), error = errno;
            if (probe >= 0) { close(probe); return false; }
            struct stat info{};
            if (error != ECONNREFUSED || lstat(path.c_str(), &info) || info.st_uid != getuid() || !S_ISSOCK(info.st_mode)) return false;
            if (unlink(path.c_str()) || bind(server, reinterpret_cast<sockaddr *>(&address), sizeof(address))) return false;
        }
        bound = true;
        chmod(path.c_str(), 0600);
        if (listen(server, 1)) return false;
        server_source = g_unix_fd_add(server, G_IO_IN, [](gint fd, GIOCondition, gpointer data)->gboolean {
            auto *bridge = static_cast<Bridge *>(data);
            int client = accept4(fd, nullptr, nullptr, SOCK_CLOEXEC | SOCK_NONBLOCK);
            if (client < 0) return G_SOURCE_CONTINUE;
            ucred peer{};
            socklen_t size = sizeof(peer);
            if (bridge->client >= 0 || getsockopt(client, SOL_SOCKET, SO_PEERCRED, &peer, &size) || peer.uid != getuid()) {
                close(client);
                return G_SOURCE_CONTINUE;
            }
            bridge->client = client;
            bridge->client_source = g_unix_fd_add(client, static_cast<GIOCondition>(G_IO_IN | G_IO_HUP | G_IO_ERR),
                [](gint, GIOCondition, gpointer data)->gboolean {
                    static_cast<Bridge *>(data)->request();
                    return G_SOURCE_CONTINUE;
                }, bridge);
            return G_SOURCE_CONTINUE;
        }, this);
        return true;
    }
    void stop(int code = 0) {
        if (stopping) return;
        stopping = true;
        status = code;
        remove(server_source);
        remove(event_source);
        disconnect();
        for (Child *child : children) terminate(child);
        if (children.empty()) g_main_loop_quit(loop);
    }
    int run() {
        if (!bind_server()) { g_warning("Another display controller exists, or its socket cannot be created"); return 1; }
        events = connect_socket(instance + "/.socket2.sock", SOCK_STREAM);
        if (events < 0) { g_warning("Hyprland event socket is unavailable"); return 1; }
        event_source = g_unix_fd_add(events, static_cast<GIOCondition>(G_IO_IN | G_IO_HUP | G_IO_ERR),
            [](gint fd, GIOCondition condition, gpointer data)->gboolean {
                auto *bridge = static_cast<Bridge *>(data);
                char buffer[4096];
                ssize_t length;
                bool monitor_added = false;
                while ((length = recv(fd, buffer, sizeof(buffer), 0)) > 0) {
                    std::string event(buffer, length);
                    monitor_added |= event.find("monitoradded") != std::string::npos;
                }
                if (condition & (G_IO_HUP | G_IO_ERR) || length == 0) {
                    bridge->event_source = 0;
                    bridge->stop();
                    return G_SOURCE_REMOVE;
                }
                if (monitor_added && bridge->off) bridge->power(false);
                return G_SOURCE_CONTINUE;
            }, this);
        std::string launcher = root + "/run.sh";
        if (coordinator_command.empty()) coordinator_command = {launcher.c_str(), nullptr};
        Child *coordinator = spawn(coordinator_command, true);
        if (!coordinator) return 1;
        std::string metadata = "bridge_pid=" + std::to_string(getpid()) + "\ncoordinator_pid=" +
            g_subprocess_get_identifier(coordinator->process) + "\nsignature=" + signature +
            "\ndbus_address=" + g_getenv("DBUS_SESSION_BUS_ADDRESS") + "\n";
        if (!g_file_set_contents(state.c_str(), metadata.c_str(), metadata.size(), nullptr)) {
            stop(1);
        }
        for (int sig : {SIGTERM, SIGINT, SIGHUP})
            g_unix_signal_add(sig, [](gpointer data)->gboolean { static_cast<Bridge *>(data)->stop(); return G_SOURCE_CONTINUE; }, this);
        g_message("Hyprland display/idle adapter ready");
        g_main_loop_run(loop);
        return status;
    }
    ~Bridge() {
        remove(server_source);
        remove(client_source);
        remove(event_source);
        for (int fd : {server, client, events}) if (fd >= 0) close(fd);
        if (bound) { unlink(path.c_str()); unlink(state.c_str()); }
        // Keep the singleton lock until the old socket/state are gone.
        if (lock >= 0) close(lock);
        g_main_loop_unref(loop);
    }
};

int main(int argc, char **argv) {
    umask(0077);
    if (argc < 2) { g_printerr("Usage: koya-hyprland-display SHELL_DIRECTORY\n"); return 1; }
    for (const char *key : {"XDG_RUNTIME_DIR", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "HYPRLAND_INSTANCE_SIGNATURE"})
        if (!g_getenv(key)) { g_printerr("Missing %s; start through Hyprland exec-once\n", key); return 1; }
    Bridge bridge(argv[1]);
#ifdef KOYA_TESTING
    if (argc > 2) {
        for (int i = 2; i < argc; i++) bridge.coordinator_command.push_back(argv[i]);
        bridge.coordinator_command.push_back(nullptr);
    }
#endif
    return bridge.run();
}
