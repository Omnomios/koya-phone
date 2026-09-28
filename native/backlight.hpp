// SPDX-License-Identifier: MIT
#pragma once
#include <gio/gio.h>
#include <algorithm>
#include <string>
#include <vector>

// Read the kernel's state on request; no cached brightness or UI policy here.
struct Backlight {
    std::string name;
    guint level = 0, maximum = 0;
    static bool number(const std::string &path, guint &value) {
        gchar *contents = nullptr;
        if (!g_file_get_contents(path.c_str(), &contents, nullptr, nullptr)) return false;
        gchar *end = nullptr; guint64 number = g_ascii_strtoull(contents, &end, 10);
        bool valid = end != contents && number <= G_MAXUINT;
        if (valid) value = number;
        g_free(contents); return valid;
    }
    static Backlight read() {
        std::string base = "/sys/class/backlight";
#ifdef KOYA_TESTING
        base = g_getenv("KOYA_TEST_BACKLIGHT_DIR") ? g_getenv("KOYA_TEST_BACKLIGHT_DIR") : "/nonexistent/koya-test-backlight";
#endif
        GDir *dir = g_dir_open(base.c_str(), 0, nullptr);
        if (!dir) return {};
        std::vector<std::string> names;
        while (const char *name = g_dir_read_name(dir)) names.emplace_back(name);
        g_dir_close(dir); std::sort(names.begin(), names.end());
        for (const auto &name : names) {
            Backlight result;
            if (number(base + "/" + name + "/max_brightness", result.maximum) && result.maximum
                && number(base + "/" + name + "/brightness", result.level)) {
                result.name = name; return result;
            }
        }
        return {};
    }
    GVariant *variant() const {
        GVariantBuilder result; g_variant_builder_init(&result, G_VARIANT_TYPE_VARDICT);
        g_variant_builder_add(&result, "{sv}", "Available", g_variant_new_boolean(maximum != 0));
        g_variant_builder_add(&result, "{sv}", "Device", g_variant_new_string(name.c_str()));
        gint percent = maximum ? static_cast<gint>(std::min(100u, static_cast<guint>((guint64(level) * 100 + maximum / 2) / maximum))) : -1;
        g_variant_builder_add(&result, "{sv}", "Percent", g_variant_new_int32(percent));
        return g_variant_builder_end(&result);
    }
};
