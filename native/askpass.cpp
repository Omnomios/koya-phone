// SPDX-License-Identifier: MIT
#include <gio/gio.h>
#include <cstdio>
#include <cstring>
#include <string>

// OpenSSH and sudo execute this program with a prompt and read its stdout.
// The shell owns the UI; this process only relays the answer back to its caller.
int main(int argc, char **argv) {
    std::string question;
    for (int i = 1; i < argc; ++i) {
        if (i > 1) question += ' ';
        question += argv[i];
    }
    if (question.empty()) question = "Enter your password:";
    if (question.size() > 2048) return 1;

    const char *hint = g_getenv("SSH_ASKPASS_PROMPT");
    const char *mode = hint && !g_ascii_strcasecmp(hint, "confirm") ? "confirm"
        : hint && !g_ascii_strcasecmp(hint, "none") ? "none" : "entry";
    GError *error = nullptr;
    GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &error);
    if (!bus) { g_clear_error(&error); return 1; }
    GVariant *reply = g_dbus_connection_call_sync(bus, "org.koya.Shell1", "/org/koya/Shell1",
        "org.koya.Shell1", "Askpass", g_variant_new("(ss)", question.c_str(), mode),
        G_VARIANT_TYPE("(s)"), G_DBUS_CALL_FLAGS_NONE, G_MAXINT, nullptr, &error);
    g_object_unref(bus);
    if (!reply) { g_clear_error(&error); return 1; }
    const char *answer;
    g_variant_get(reply, "(&s)", &answer);
    bool ok = true;
    if (!strcmp(mode, "entry")) {
        ok = std::fputs(answer, stdout) >= 0 && std::fputc('\n', stdout) != EOF && std::fflush(stdout) == 0;
    }
    g_variant_unref(reply);
    return ok ? 0 : 1;
}
