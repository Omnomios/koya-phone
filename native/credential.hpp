#pragma once
#include <algorithm>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <stdexcept>
#include <string>

namespace Credential {
constexpr int iterations = 600000;
inline bool pin(const std::string &value) {
    return value.size() >= 6 && value.size() <= 12 &&
           std::all_of(value.begin(), value.end(), [](char c) { return c >= '0' && c <= '9'; });
}
inline bool salt(const std::string &value) {
    return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char c) {
               return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
           });
}
inline std::string hex(const unsigned char *bytes, size_t size) {
    const char *digits = "0123456789abcdef";
    std::string result;
    result.reserve(size * 2);
    for (size_t i = 0; i < size; ++i) {
        result += digits[bytes[i] >> 4];
        result += digits[bytes[i] & 15];
    }
    return result;
}
inline std::string newSalt() {
    unsigned char bytes[32];
    if (RAND_bytes(bytes, sizeof(bytes)) != 1)
        throw std::runtime_error("Cannot generate PIN salt");
    return hex(bytes, sizeof(bytes));
}
inline std::string derive(const std::string &value, const std::string &saltValue) {
    if (!pin(value) || !salt(saltValue))
        throw std::runtime_error("Use a PIN of 6 to 12 digits");
    unsigned char bytes[32];
    const std::string domain = "koya-pin-v1:" + saltValue;
    if (PKCS5_PBKDF2_HMAC(value.data(), value.size(), reinterpret_cast<const unsigned char *>(domain.data()),
                          domain.size(), iterations, EVP_sha256(), sizeof(bytes), bytes) != 1)
        throw std::runtime_error("PIN derivation failed");
    std::string result = hex(bytes, sizeof(bytes));
    OPENSSL_cleanse(bytes, sizeof(bytes));
    return result;
}
inline void erase(std::string &value) {
    if (!value.empty())
        OPENSSL_cleanse(value.data(), value.size());
    value.clear();
}
} // namespace Credential
