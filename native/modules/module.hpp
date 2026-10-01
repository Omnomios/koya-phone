#pragma once
#include <helix/plugin.h>
#include <quickjs.h>
#include <gio/gio.h>
#include <glib-unix.h>
#include <map>
#include <mutex>
#include <string>
#include <functional>

// Instances own contexts, callbacks and resources. The routing map only bridges
// QuickJS's module initializer, which does not accept an opaque argument.
struct NativeModule {
    HelixPluginInstance instance{};
    JSContext *js;
    GMainContext *context = g_main_context_new();
    JSValue callback = JS_UNDEFINED;
    bool stopped = false;
    using Function = JSValue (*)(NativeModule *, int, JSValueConst *);
    std::map<std::string, Function> functions;
    inline static std::map<JSModuleDef *, NativeModule *> initializers;
    inline static std::mutex initializer_mutex;
    explicit NativeModule(JSContext *ctx): js(ctx) {}
    virtual ~NativeModule() { g_main_context_unref(context); }
    struct Scope {
        GMainContext *context;
        explicit Scope(GMainContext *ctx): context(ctx) { g_main_context_push_thread_default(context); }
        ~Scope() { g_main_context_pop_thread_default(context); }
    };
    virtual void shutdown() {}
    virtual void update() {
        Scope scope(context);
        for (unsigned i = 0; i < 64 && g_main_context_pending(context); ++i) g_main_context_iteration(context, FALSE);
    }
    void stop() {
        if (stopped) return;
        Scope scope(context);
        shutdown();
        JS_FreeValue(js, callback); callback = JS_UNDEFINED;
        stopped = true;
    }
    static std::string string(JSContext *ctx, JSValueConst value) {
        const char *text = JS_ToCString(ctx, value);
        std::string result = text ? text : "";
        if (text) JS_FreeCString(ctx, text);
        return result;
    }
    void subscribe(JSValueConst value) {
        JS_FreeValue(js, callback); callback = JS_DupValue(js, value);
    }
    void emit(JSValue event) {
        if (!stopped && JS_IsFunction(js, callback)) {
            JSValue result = JS_Call(js, callback, JS_UNDEFINED, 1, &event);
            if (JS_IsException(result)) {
                JSValue error = JS_GetException(js);
                g_warning("Native module callback: %s", string(js, error).c_str()); JS_FreeValue(js, error);
            }
            JS_FreeValue(js, result);
        }
        JS_FreeValue(js, event);
    }
    guint watch(int fd, GIOCondition conditions, GUnixFDSourceFunc function, void *data) {
        GSource *source = g_unix_fd_source_new(fd, conditions);
        g_source_set_callback(source, G_SOURCE_FUNC(function), data, nullptr);
        guint id = g_source_attach(source, context); g_source_unref(source); return id;
    }
    void remove(guint &id) {
        if (id) { if (GSource *source = g_main_context_find_source_by_id(context, id)) g_source_destroy(source); id = 0; }
    }
    static JSValue variant(JSContext *ctx, GVariant *value) {
        if (g_variant_is_of_type(value, G_VARIANT_TYPE_VARIANT)) {
            GVariant *inner = g_variant_get_variant(value); JSValue result = variant(ctx, inner); g_variant_unref(inner); return result;
        }
        switch (g_variant_classify(value)) {
        case G_VARIANT_CLASS_STRING: case G_VARIANT_CLASS_OBJECT_PATH: case G_VARIANT_CLASS_SIGNATURE:
            return JS_NewString(ctx, g_variant_get_string(value, nullptr));
        case G_VARIANT_CLASS_BOOLEAN: return JS_NewBool(ctx, g_variant_get_boolean(value));
        case G_VARIANT_CLASS_BYTE: return JS_NewUint32(ctx, g_variant_get_byte(value));
        case G_VARIANT_CLASS_INT32: return JS_NewInt32(ctx, g_variant_get_int32(value));
        case G_VARIANT_CLASS_UINT32: return JS_NewUint32(ctx, g_variant_get_uint32(value));
        default: break;
        }
        bool dict = g_variant_is_of_type(value, G_VARIANT_TYPE_VARDICT);
        JSValue result = dict ? JS_NewObject(ctx) : JS_NewArray(ctx);
        for (gsize i = 0; i < g_variant_n_children(value); ++i) {
            GVariant *child = g_variant_get_child_value(value, i);
            if (dict) {
                GVariant *key = g_variant_get_child_value(child, 0), *item = g_variant_get_child_value(child, 1);
                JS_SetPropertyStr(ctx, result, g_variant_get_string(key, nullptr), variant(ctx, item));
                g_variant_unref(key); g_variant_unref(item);
            } else JS_SetPropertyUint32(ctx, result, i, variant(ctx, child));
            g_variant_unref(child);
        }
        return result;
    }
    bool integrate(const char *name, const HelixPluginHost *host, HelixPluginInstance **out) {
        if (!out || !host || host->abiVersion != HELIX_PLUGIN_ABI_VERSION) return false;
        instance.abiVersion = HELIX_PLUGIN_ABI_VERSION; instance.state = this;
        instance.scriptUpdate = [](void *opaque, const HelixPluginUpdate *) { static_cast<NativeModule *>(opaque)->update(); };
        instance.scriptShutdown = [](void *opaque) { static_cast<NativeModule *>(opaque)->stop(); };
        instance.destroy = [](void *opaque) { auto *self = static_cast<NativeModule *>(opaque); { std::lock_guard<std::mutex> lock(initializer_mutex); initializers.erase(self->instance.module); } delete self; };
        instance.module = JS_NewCModule(js, name, [](JSContext *ctx, JSModuleDef *module) {
            NativeModule *self;
            { std::lock_guard<std::mutex> lock(initializer_mutex); self = initializers.at(module); }
            for (const auto &entry : self->functions) {
                JSValue data[] = {JS_NewBigInt64(ctx, reinterpret_cast<intptr_t>(self)), JS_NewString(ctx, entry.first.c_str())};
                JSValue function = JS_NewCFunctionData(ctx, [](JSContext *ctx, JSValueConst, int argc, JSValueConst *argv, int, JSValue *data) {
                    int64_t pointer = 0;
                    if (JS_ToBigInt64(ctx, &pointer, data[0]) < 0) return JS_EXCEPTION;
                    auto *self = reinterpret_cast<NativeModule *>(static_cast<intptr_t>(pointer));
                    if (self->stopped) return JS_ThrowInternalError(ctx, "Native module is shut down");
                    Scope scope(self->context);
                    return self->functions.at(string(ctx, data[1]))(self, argc, argv);
                }, 0, 0, 2, data);
                JS_SetModuleExport(ctx, module, entry.first.c_str(), function);
                for (JSValue value : data) JS_FreeValue(ctx, value);
            }
            return 0;
        });
        if (!instance.module) return false;
        { std::lock_guard<std::mutex> lock(initializer_mutex); initializers[instance.module] = this; }
        for (const auto &entry : functions) JS_AddModuleExport(js, instance.module, entry.first.c_str());
        *out = &instance; return true;
    }
};
