#pragma once
#include "settings.hpp"
#include <algorithm>

struct CredentialSettings {
    std::string mode = "password", salt, pending_mode, pending_salt;
    static bool salt_ok(const std::string &s) {
        return s.size() == 64 && std::all_of(s.begin(), s.end(), [](char c) {
                   return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
               });
    }
    static bool parse(const std::string &value, std::string &mode, std::string &salt) {
        if (value == "password:") {
            mode = "password";
            salt.clear();
            return true;
        }
        if (value.rfind("pin:", 0) == 0 && salt_ok(value.substr(4))) {
            mode = "pin";
            salt = value.substr(4);
            return true;
        }
        return false;
    }
    void load() {
        GKeyFile *file = g_key_file_new();
        ShellSettings::merge(file);
        for (auto key : {"credential", "pending"}) {
            gchar *value = g_key_file_get_string(file, "authentication", key, nullptr);
            if (value) {
                if (!strcmp(key, "credential"))
                    parse(value, mode, salt);
                else
                    parse(value, pending_mode, pending_salt);
            }
            g_free(value);
        }
        g_key_file_unref(file);
    }
    bool stage(const std::string &next_mode, const std::string &next_salt, std::string &error) {
        if (!ShellSettings::save("authentication", "pending", (next_mode + ":" + next_salt).c_str(), error, true))
            return false;
        pending_mode = next_mode;
        pending_salt = next_salt;
        return true;
    }
    bool commit(std::string &error) {
        if (!ShellSettings::save("authentication", "credential", (pending_mode + ":" + pending_salt).c_str(),
                                 error, true))
            return false;
        mode = pending_mode;
        salt = pending_salt;
        if (!ShellSettings::save("authentication", "pending", "", error, true))
            return false;
        pending_mode.clear();
        pending_salt.clear();
        return true;
    }
    bool discard(std::string &error) {
        if (!ShellSettings::save("authentication", "pending", "", error, true))
            return false;
        pending_mode.clear();
        pending_salt.clear();
        return true;
    }
    void append(GVariantBuilder &b) const {
        for (auto entry : {std::pair{"AuthenticationMode", mode}, std::pair{"AuthenticationSalt", salt},
                           std::pair{"PendingAuthenticationMode", pending_mode},
                           std::pair{"PendingAuthenticationSalt", pending_salt}})
            g_variant_builder_add(&b, "{sv}", entry.first, g_variant_new_string(entry.second.c_str()));
    }
};
