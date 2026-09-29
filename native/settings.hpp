// SPDX-License-Identifier: MIT
#pragma once
#include <gio/gio.h>
#include <string>

namespace ShellSettings {
inline std::string directory() { return std::string(g_get_user_config_dir()) + "/koya-shell"; }
inline std::string path() { return directory() + "/settings.conf"; }

// Per-user overrides survive release upgrades and never modify the checkout.
inline void merge(GKeyFile *destination) {
    GKeyFile *overrides = g_key_file_new();
    GError *error = nullptr;
    if (g_key_file_load_from_file(overrides, path().c_str(), G_KEY_FILE_NONE, &error)) {
        gchar **groups = g_key_file_get_groups(overrides, nullptr);
        for (gchar **group = groups; group && *group; ++group) {
            gchar **keys = g_key_file_get_keys(overrides, *group, nullptr, nullptr);
            for (gchar **key = keys; key && *key; ++key) {
                gchar *value = g_key_file_get_value(overrides, *group, *key, nullptr);
                g_key_file_set_value(destination, *group, *key, value);
                g_free(value);
            }
            g_strfreev(keys);
        }
        g_strfreev(groups);
    } else if (!g_error_matches(error, G_FILE_ERROR, G_FILE_ERROR_NOENT)) {
        g_warning("Cannot read shell settings: %s", error->message);
    }
    g_clear_error(&error); g_key_file_unref(overrides);
}

inline bool save(const char *group, const char *key, const char *value, std::string &message) {
    GKeyFile *config = g_key_file_new();
    GError *error = nullptr;
    bool ok = g_key_file_load_from_file(config, path().c_str(), G_KEY_FILE_KEEP_COMMENTS, &error);
    if (!ok && !g_error_matches(error, G_FILE_ERROR, G_FILE_ERROR_NOENT)) {
        message = error->message;
        g_clear_error(&error); g_key_file_unref(config); return false;
    }
    g_clear_error(&error);
    g_key_file_set_value(config, group, key, value);
    gsize length = 0; gchar *data = g_key_file_to_data(config, &length, nullptr);
    ok = g_mkdir_with_parents(directory().c_str(), 0700) == 0;
    if (ok) ok = g_file_set_contents(path().c_str(), data, length, &error);
    if (!ok) message = error ? error->message : "Cannot create settings directory";
    g_clear_error(&error); g_free(data); g_key_file_unref(config);
    return ok;
}

inline std::string wallpaper_file(const std::string &id) {
    if (id == "earthy-green") return "assets/earthy-green-wallpaper.png";
    if (id == "tidal-blue" || id == "terracotta-dunes" || id == "violet-dusk")
        return "assets/wallpapers/" + id + ".png";
    return "";
}
inline bool wallpaper_available(const std::string &root, const std::string &id) {
    const auto file = wallpaper_file(id);
    return !file.empty() && g_file_test((root + "/" + file).c_str(), G_FILE_TEST_IS_REGULAR);
}
}
