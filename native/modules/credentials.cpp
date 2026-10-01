#include "../credential.hpp"
#include "module.hpp"
#include <atomic>
#include <thread>

struct Credentials : NativeModule {
    static std::string credential(JSContext *ctx, JSValueConst value) {
        size_t length = 0;
        const char *bytes = JS_ToCStringLen(ctx, &length, value);
        std::string result = bytes ? std::string(bytes, length) : "";
        if (bytes)
            JS_FreeCString(ctx, bytes);
        return result;
    }
    std::thread worker;
    std::atomic<bool> done{false};
    JSValue resolve = JS_UNDEFINED, reject = JS_UNDEFINED;
    std::string result, error;
    explicit Credentials(JSContext *ctx) : NativeModule(ctx) {
        functions["newSalt"] = [](NativeModule *base, int, JSValueConst *) {
            try {
                return JS_NewString(base->js, Credential::newSalt().c_str());
            } catch (const std::exception &e) {
                return JS_ThrowInternalError(base->js, "%s", e.what());
            }
        };
        functions["derivePin"] = [](NativeModule *base, int argc, JSValueConst *argv) {
            auto *self = static_cast<Credentials *>(base);
            if (argc != 2)
                return JS_ThrowTypeError(base->js, "derivePin needs a PIN and salt");
            if (self->worker.joinable())
                return JS_ThrowInternalError(base->js, "Credential operation is busy");
            std::string pin = credential(base->js, argv[0]), salt = credential(base->js, argv[1]);
            if (!Credential::pin(pin) || !Credential::salt(salt)) {
                Credential::erase(pin);
                return JS_ThrowTypeError(base->js, "Use a PIN of 6 to 12 digits");
            }
            JSValue funcs[2];
            JSValue promise = JS_NewPromiseCapability(base->js, funcs);
            if (JS_IsException(promise)) {
                Credential::erase(pin);
                return promise;
            }
            self->resolve = funcs[0];
            self->reject = funcs[1];
            self->done = false;
            self->worker = std::thread([self, pin = std::move(pin), salt = std::move(salt)]() mutable {
                try {
                    self->result = Credential::derive(pin, salt);
                } catch (const std::exception &e) {
                    self->error = e.what();
                }
                Credential::erase(pin);
                self->done = true;
            });
            return promise;
        };
    }
    ~Credentials() override { stop(); }
    void update() override {
        NativeModule::update();
        if (!done)
            return;
        worker.join();
        done = false;
        JSValue value = JS_NewString(js, (error.empty() ? result : error).c_str());
        JSValue returned = JS_Call(js, error.empty() ? resolve : reject, JS_UNDEFINED, 1, &value);
        JS_FreeValue(js, returned);
        JS_FreeValue(js, value);
        JS_FreeValue(js, resolve);
        JS_FreeValue(js, reject);
        resolve = reject = JS_UNDEFINED;
        Credential::erase(result);
        error.clear();
    }
    void shutdown() override {
        if (worker.joinable())
            worker.join();
        JS_FreeValue(js, resolve);
        JS_FreeValue(js, reject);
        resolve = reject = JS_UNDEFINED;
        Credential::erase(result);
        error.clear();
    }
};
extern "C" HELIX_PLUGIN_EXPORT int helix_plugin_integrate(JSContext *ctx, const char *name,
                                                          const HelixPluginHost *host,
                                                          HelixPluginInstance **out) {
    auto *module = new Credentials(ctx);
    if (module->integrate(name, host, out))
        return 0;
    delete module;
    return 1;
}
