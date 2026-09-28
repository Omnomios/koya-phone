// SPDX-License-Identifier: MIT
#pragma once
#include <gio/gio.h>
#include <glib/gstdio.h>
#include <dlfcn.h>
#include <sys/stat.h>
#include <set>
#include <limits>
#include <vector>
#include <map>
#include <string>
#include <cstring>
#include <algorithm>

// No GTK/display connection: resolve XDG theme files, then use the installed
// GdkPixbuf loaders (including librsvg) to cache square, transparent PNGs.
class Icons {
    std::vector<std::string> bases;
    std::string root;
    std::map<std::string, std::string> resolved;
    static std::vector<std::string> strings(GKeyFile *file, const char *group, const char *key) {
        gchar *value = g_key_file_get_string(file, group, key, nullptr);
        std::vector<std::string> result;
        if (value) {
            gchar **parts = g_strsplit(value, ",", -1);
            for (gchar **part = parts; *part; ++part) if (*g_strstrip(*part)) result.emplace_back(*part);
            g_strfreev(parts); g_free(value);
        }
        return result;
    }
    static int integer(GKeyFile *file, const char *group, const char *key, int fallback) {
        GError *error = nullptr;
        int value = g_key_file_get_integer(file, group, key, &error);
        if (error) { g_clear_error(&error); return fallback; }
        return value;
    }
    static bool exists(const std::string &path) { return g_file_test(path.c_str(), G_FILE_TEST_IS_REGULAR); }
    std::string theme(const std::string &name, const std::string &icon, std::set<std::string> &seen) {
        if (name.empty() || name.find('/') != std::string::npos || !seen.insert(name).second) return {};
        GKeyFile *index = g_key_file_new();
        bool loaded = false;
        for (const auto &base : bases) {
            if (g_key_file_load_from_file(index, (base + "/" + name + "/index.theme").c_str(), G_KEY_FILE_NONE, nullptr)) { loaded = true; break; }
        }
        if (!loaded) { g_key_file_unref(index); return {}; }
        auto directories = strings(index, "Icon Theme", "Directories");
        auto scaled = strings(index, "Icon Theme", "ScaledDirectories");
        directories.insert(directories.end(), scaled.begin(), scaled.end());
        std::string match;
        int best = std::numeric_limits<int>::max();
        for (const auto &directory : directories) {
            if (directory.empty() || directory[0] == '/' || directory.find("..") != std::string::npos) continue;
            int size = integer(index, directory.c_str(), "Size", 48);
            int scale = integer(index, directory.c_str(), "Scale", 1);
            gchar *type = g_key_file_get_string(index, directory.c_str(), "Type", nullptr);
            int low = size, high = size;
            if (type && !strcmp(type, "Scalable")) {
                low = integer(index, directory.c_str(), "MinSize", size);
                high = integer(index, directory.c_str(), "MaxSize", size);
            } else if (!type || !strcmp(type, "Threshold")) {
                int threshold = integer(index, directory.c_str(), "Threshold", 2); low -= threshold; high += threshold;
            }
            g_free(type);
            int distance = std::max({low * scale - 160, 160 - high * scale, 0});
            for (const auto &base : bases) for (const char *extension : {".png", ".svg", ".xpm"}) {
                std::string path = base + "/" + name + "/" + directory + "/" + icon + extension;
                if (distance < best && exists(path)) { best = distance; match = path; }
            }
        }
        auto parents = strings(index, "Icon Theme", "Inherits");
        g_key_file_unref(index);
        if (!match.empty()) return match;
        for (const auto &parent : parents) {
            match = theme(parent, icon, seen); if (!match.empty()) return match;
        }
        return {};
    }
    std::string lookup(const std::string &name) {
        if (g_path_is_absolute(name.c_str())) return exists(name) ? name : std::string{};
        if (name.empty() || name.find('/') != std::string::npos || name.find("..") != std::string::npos) return {};
        std::string stem = name;
        for (const char *extension : {".png", ".svg", ".xpm"}) {
            if (g_str_has_suffix(stem.c_str(), extension)) { stem.resize(stem.size() - strlen(extension)); break; }
        }
        std::set<std::string> seen;
        const char *selected = g_getenv("KOYA_ICON_THEME");
        auto result = theme(selected && *selected ? selected : "Adwaita", stem, seen);
        if (result.empty()) result = theme("hicolor", stem, seen);
        if (!result.empty()) return result;
        std::vector<std::string> unthemed = bases;
        for (const char *const *data = g_get_system_data_dirs(); *data; ++data) unthemed.emplace_back(std::string(*data) + "/pixmaps");
        for (const auto &base : unthemed) for (const char *extension : {"", ".png", ".svg", ".xpm"}) {
            auto path = base + "/" + name + extension; if (exists(path)) return path;
        }
        auto bundled = root + "/assets/launcher/" + name + ".svg";
        return exists(bundled) ? bundled : std::string{};
    }
public:
    const std::string cache;
    explicit Icons(const std::string &directory): root(directory), cache(std::string(g_get_user_cache_dir()) + "/koya/icons") {
        bases.emplace_back(std::string(g_get_user_data_dir()) + "/icons");
        bases.emplace_back(std::string(g_get_home_dir()) + "/.icons");
        for (const char *const *data = g_get_system_data_dirs(); *data; ++data) bases.emplace_back(std::string(*data) + "/icons");
        g_mkdir_with_parents(cache.c_str(), 0700);
    }
    void invalidate() { resolved.clear(); }
    static bool rasterize(const std::string &source, const std::string &target) {
        static void *library = dlopen("libgdk_pixbuf-2.0.so.0", RTLD_LAZY | RTLD_LOCAL);
        if (!library) return false;
        auto load = reinterpret_cast<void *(*)(const char *, int, int, gboolean, GError **)>(dlsym(library, "gdk_pixbuf_new_from_file_at_scale"));
        auto create = reinterpret_cast<void *(*)(int, gboolean, int, int, int)>(dlsym(library, "gdk_pixbuf_new"));
        auto fill = reinterpret_cast<void (*)(void *, guint32)>(dlsym(library, "gdk_pixbuf_fill"));
        auto width = reinterpret_cast<int (*)(void *)>(dlsym(library, "gdk_pixbuf_get_width"));
        auto height = reinterpret_cast<int (*)(void *)>(dlsym(library, "gdk_pixbuf_get_height"));
        auto copy = reinterpret_cast<void (*)(void *, int, int, int, int, void *, int, int)>(dlsym(library, "gdk_pixbuf_copy_area"));
        auto save = reinterpret_cast<gboolean (*)(void *, const char *, const char *, char **, char **, GError **)>(dlsym(library, "gdk_pixbuf_savev"));
        if (!load || !create || !fill || !width || !height || !copy || !save) return false;
        GError *error = nullptr;
        void *image = load(source.c_str(), 160, 160, true, &error);
        g_clear_error(&error);
        if (!image) return false;
        void *square = create(0, true, 8, 160, 160);
        bool ok = false;
        if (square) {
            fill(square, 0);
            copy(image, 0, 0, width(image), height(image), square, (160-width(image))/2, (160-height(image))/2);
            std::string temporary = target + ".tmp";
            ok = save(square, temporary.c_str(), "png", nullptr, nullptr, &error) && !g_rename(temporary.c_str(), target.c_str());
            if (!ok) g_unlink(temporary.c_str());
            g_object_unref(square);
        }
        g_clear_error(&error); g_object_unref(image);
        return ok;
    }
    std::string resolve(GIcon *icon) {
        gchar *description = icon ? g_icon_to_string(icon) : nullptr;
        std::string key = description ? description : "";
        g_free(description);
        auto known = resolved.find(key); if (known != resolved.end()) return known->second;
        std::string path;
        if (icon && G_IS_FILE_ICON(icon)) {
            gchar *file = g_file_get_path(g_file_icon_get_file(G_FILE_ICON(icon))); if (file) path = file; g_free(file);
        } else if (icon && G_IS_THEMED_ICON(icon)) {
            const gchar *const *names = g_themed_icon_get_names(G_THEMED_ICON(icon));
            for (; *names && path.empty(); ++names) path = lookup(*names);
        }
        if (path.empty()) path = root + "/assets/launcher/application.svg";
        struct stat status{};
        std::string texture;
        if (!stat(path.c_str(), &status)) {
            std::string identity = path + ":" + std::to_string(status.st_mtim.tv_sec) + ":" + std::to_string(status.st_mtim.tv_nsec) + ":" + std::to_string(status.st_size);
            gchar *hash = g_compute_checksum_for_string(G_CHECKSUM_SHA256, identity.c_str(), -1);
            std::string name = std::string("koya-app-icon-") + hash + ".png"; g_free(hash);
            std::string target = cache + "/" + name;
            if (exists(target) || rasterize(path, target)) texture = "/rom/" + name;
        }
        resolved[key] = texture;
        return texture;
    }
};
