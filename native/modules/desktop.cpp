#include "module.hpp"
#include "icons.hpp"
#include <gio/gdesktopappinfo.h>
#include <memory>
#include <atomic>
#include <thread>
#include <condition_variable>
#include <deque>

struct DesktopModule: NativeModule {
    std::string root;
    std::unique_ptr<Icons> icons;
    GAppInfoMonitor *monitor = nullptr;
    gulong handler = 0;
    guint notification = 0;
    std::map<std::string, GDesktopAppInfo *> apps;
    struct Job { unsigned id; std::string kind, argument; };
    struct Result { unsigned id; std::string json, error; };
    struct Promise { JSValue resolve, reject; };
    std::map<unsigned, Promise> promises;
    unsigned serial = 0;
    std::mutex mutex;
    std::condition_variable wake;
    std::deque<Job> jobs;
    std::deque<Result> results;
    std::thread worker;
    bool ending = false;
    std::atomic<bool> invalidated{false};
    using NativeModule::NativeModule;
    static std::string quote(const char *text) {
        std::string result = "\"";
        for (const unsigned char *p = reinterpret_cast<const unsigned char *>(text ? text : ""); *p; ++p) {
            if (*p == '"' || *p == '\\') { result += '\\'; result += *p; }
            else if (*p < 32) { char escaped[7]; snprintf(escaped, sizeof escaped, "\\u%04x", *p); result += escaped; }
            else result += *p;
        }
        return result + '"';
    }
    void clear() { for (auto &entry : apps) g_object_unref(entry.second); apps.clear(); }
    void shutdown() override {
        if (monitor) { g_signal_handler_disconnect(monitor, handler); g_object_unref(monitor); monitor = nullptr; }
        remove(notification);
        { std::lock_guard<std::mutex> lock(mutex); ending = true; jobs.clear(); }
        wake.notify_all(); if (worker.joinable()) worker.join();
        for (auto &entry : promises) {
            JSValue error = JS_NewString(js, "Desktop module stopped");
            JSValue result = JS_Call(js, entry.second.reject, JS_UNDEFINED, 1, &error);
            JS_FreeValue(js, result); JS_FreeValue(js, error);
            JS_FreeValue(js, entry.second.resolve); JS_FreeValue(js, entry.second.reject);
        }
        promises.clear(); results.clear(); clear(); icons.reset();
    }
    void update() override {
        NativeModule::update();
        std::deque<Result> completed;
        { std::lock_guard<std::mutex> lock(mutex); completed.swap(results); }
        for (auto &result : completed) {
            auto entry = promises.find(result.id); if (entry == promises.end()) continue;
            JSValue value = result.error.empty() ? JS_ParseJSON(js, result.json.c_str(), result.json.size(), "<desktop>") : JS_NewString(js, result.error.c_str());
            bool failed = !result.error.empty();
            if (JS_IsException(value)) { value = JS_GetException(js); failed = true; }
            JSValue returned = JS_Call(js, failed ? entry->second.reject : entry->second.resolve, JS_UNDEFINED, 1, &value);
            if (JS_IsException(returned)) JS_FreeValue(js, JS_GetException(js));
            JS_FreeValue(js, returned); JS_FreeValue(js, value);
            JS_FreeValue(js, entry->second.resolve); JS_FreeValue(js, entry->second.reject); promises.erase(entry);
        }
    }
    static bool launchable(GDesktopAppInfo *info) {
        if (!g_app_info_should_show(G_APP_INFO(info)) || g_desktop_app_info_get_boolean(info, "Terminal")) return false;
        gchar *try_exec = g_desktop_app_info_get_string(info, "TryExec");
        bool explicit_check = try_exec && *try_exec;
        const char *program = explicit_check ? try_exec : g_app_info_get_executable(G_APP_INFO(info));
        bool activated = !explicit_check && g_desktop_app_info_get_boolean(info, "DBusActivatable");
        gchar *found = program && *program ? g_find_program_in_path(program) : nullptr;
        bool result = found || activated; g_free(found); g_free(try_exec); return result;
    }
    void read() {
        clear(); GList *list = g_app_info_get_all();
        for (GList *item = list; item; item = item->next) {
            auto *info = G_APP_INFO(item->data); const char *id = g_app_info_get_id(info);
            if (id && G_IS_DESKTOP_APP_INFO(info) && launchable(G_DESKTOP_APP_INFO(info))) apps[id] = G_DESKTOP_APP_INFO(g_object_ref(info));
        }
        g_list_free_full(list, g_object_unref);
        GDir *dir = g_dir_open((root + "/applications").c_str(), 0, nullptr);
        if (!dir) return;
        while (const char *name = g_dir_read_name(dir)) {
            if (!g_str_has_suffix(name, ".desktop") || apps.count(name)) continue;
            auto *info = g_desktop_app_info_new_from_filename((root + "/applications/" + name).c_str());
            if (info && launchable(info)) apps[name] = info; else if (info) g_object_unref(info);
        }
        g_dir_close(dir);
    }
    std::string applications() {
        read(); std::string result = "[";
        for (auto &app : apps) {
            if (result.size() > 1) result += ',';
            result += '{'; bool first = true;
            auto add = [&](const char *key, const char *value) { if (!first) result += ','; first = false; result += quote(key) + ':' + quote(value); };
            add("id", app.first.c_str()); add("name", g_app_info_get_display_name(G_APP_INFO(app.second))); add("class", g_desktop_app_info_get_startup_wm_class(app.second));
            GIcon *icon = g_app_info_get_icon(G_APP_INFO(app.second)); gchar *description = icon ? g_icon_to_string(icon) : nullptr;
            add("iconName", description); g_free(description); add("icon", icons->resolve(icon).c_str());
            const char *executable = g_app_info_get_executable(G_APP_INFO(app.second)); gchar *name = executable ? g_path_get_basename(executable) : g_strdup("");
            add("executable", name); g_free(name); result += '}';
        }
        return result + ']';
    }
    void run() {
        for (;;) {
            Job job;
            { std::unique_lock<std::mutex> lock(mutex); wake.wait(lock, [&] { return ending || !jobs.empty(); });
                if (ending) return;
                job = std::move(jobs.front()); jobs.pop_front(); }
            Result result{job.id, {}, {}};
            if (invalidated.exchange(false)) icons->invalidate();
            if (job.kind == "applications") result.json = applications();
            else if (job.kind == "resolveIcon") {
                GIcon *icon = g_icon_new_for_string(job.argument.c_str(), nullptr);
                result.json = quote(icon ? icons->resolve(icon).c_str() : ""); if (icon) g_object_unref(icon);
            } else {
                read(); auto app = apps.find(job.argument);
                if (app == apps.end()) result.error = "Application is unavailable";
                else {
                    gchar *helper = g_shell_quote((root + "/build/koya-launch-app").c_str());
                    gchar *filename = g_shell_quote(g_desktop_app_info_get_filename(app->second));
                    std::string command = std::string("exec ") + helper + " " + filename;
                    result.json = quote(command.c_str()); g_free(helper); g_free(filename);
                }
            }
            { std::lock_guard<std::mutex> lock(mutex); if (!ending) results.push_back(std::move(result)); }
        }
    }
    static JSValue start(NativeModule *base, int argc, JSValueConst *argv) {
        auto *self = static_cast<DesktopModule *>(base);
        if (argc != 2 || !JS_IsString(argv[0]) || !JS_IsFunction(base->js, argv[1])) return JS_ThrowTypeError(base->js, "start expects (root, onApplicationsChanged)");
        self->shutdown(); self->root = string(base->js, argv[0]); self->icons = std::make_unique<Icons>(self->root); self->subscribe(argv[1]);
        self->ending = false; self->invalidated = false; self->worker = std::thread([self] { self->run(); });
        self->monitor = g_app_info_monitor_get();
        self->handler = g_signal_connect(self->monitor, "changed", G_CALLBACK(+[](GAppInfoMonitor *, gpointer data) {
            auto *self = static_cast<DesktopModule *>(data); self->invalidated = true;
            if (self->notification) return;
            GSource *source = g_idle_source_new();
            g_source_set_callback(source, [](gpointer data)->gboolean {
                auto *self = static_cast<DesktopModule *>(data); self->notification = 0; self->emit(JS_UNDEFINED); return G_SOURCE_REMOVE;
            }, self, nullptr);
            self->notification = g_source_attach(source, self->context); g_source_unref(source);
        }), self);
        return JS_UNDEFINED;
    }
    JSValue enqueue(const char *kind, std::string argument = "") {
        if (!icons) return JS_ThrowInternalError(js, "Desktop module is not started");
        if (promises.size() >= 128) return JS_ThrowInternalError(js, "Too many pending desktop requests");
        JSValue callbacks[2]; JSValue promise = JS_NewPromiseCapability(js, callbacks);
        if (JS_IsException(promise)) return promise;
        unsigned id = ++serial; promises.emplace(id, Promise{callbacks[0], callbacks[1]});
        { std::lock_guard<std::mutex> lock(mutex); jobs.push_back(Job{id, kind, std::move(argument)}); }
        wake.notify_one(); return promise;
    }
};
extern "C" HELIX_PLUGIN_EXPORT int helix_plugin_integrate(JSContext *ctx, const char *name, const HelixPluginHost *host, HelixPluginInstance **out) {
    auto *self = new DesktopModule(ctx);
    self->functions = {{"start", DesktopModule::start}, {"applications", [](NativeModule *base, int, JSValueConst *) { return static_cast<DesktopModule *>(base)->enqueue("applications"); }},
        {"resolveIcon", [](NativeModule *base, int argc, JSValueConst *argv) { if (argc != 1) return JS_ThrowTypeError(base->js, "resolveIcon expects a description"); return static_cast<DesktopModule *>(base)->enqueue("resolveIcon", NativeModule::string(base->js, argv[0])); }},
        {"launchCommand", [](NativeModule *base, int argc, JSValueConst *argv) { if (argc != 1) return JS_ThrowTypeError(base->js, "launchCommand expects an application ID"); return static_cast<DesktopModule *>(base)->enqueue("launchCommand", NativeModule::string(base->js, argv[0])); }}};
    if (self->integrate(name, host, out)) return 0;
    delete self; return 1;
}
