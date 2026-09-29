// Hyprland's nested output takes its mode from the parent xdg_toplevel.
// Aquamarine 0.12 substitutes 1280x720 when the parent lets the client choose.
// Keep this workaround in the development launcher, outside the phone build.
#define _GNU_SOURCE
#include <wayland-client-protocol.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>

typedef void (*configure_fn)(void *, struct wl_proxy *, int32_t, int32_t, struct wl_array *);
typedef void (*enter_fn)(void *, struct wl_proxy *, uint32_t, struct wl_surface *, wl_fixed_t, wl_fixed_t);
typedef void (*motion_fn)(void *, struct wl_proxy *, uint32_t, wl_fixed_t, wl_fixed_t);
struct binding {
    struct wl_proxy *proxy;
    void (*listeners[11])(void);
    void (*original[11])(void);
    struct binding *next;
};
static struct binding *bindings;
static int width, height;

__attribute__((constructor)) static void setup(void) {
    const char *size = getenv("KOYA_DEV_NESTED_SIZE");
    if (!size) return;
    char *end;
    width = (int)strtol(size, &end, 10);
    if (*end == 'x') height = (int)strtol(end + 1, &end, 10);
    if (*end || width < 100 || width > 9999 || height < 100 || height > 9999)
        width = height = 0;

    // Only Hyprland loads the helper; its shell/Koya children inherit the
    // caller's original preload environment.
    const char *preload = getenv("KOYA_DEV_CHILD_PRELOAD");
    if (preload && *preload) setenv("LD_PRELOAD", preload, 1);
    else unsetenv("LD_PRELOAD");
    unsetenv("KOYA_DEV_NESTED_SIZE");
    unsetenv("KOYA_DEV_CHILD_PRELOAD");
}

static struct binding *find(struct wl_proxy *proxy) {
    for (struct binding *entry = bindings; entry; entry = entry->next)
        if (entry->proxy == proxy) return entry;
    return NULL;
}

static void configure(void *data, struct wl_proxy *proxy, int32_t w, int32_t h, struct wl_array *states) {
    struct binding *entry = find(proxy);
    // The host window is half-size; Aquamarine still receives full-size modes.
    ((configure_fn)entry->original[0])(data, proxy, w ? w * 2 : width, h ? h * 2 : height, states);
}

static void enter(void *data, struct wl_proxy *proxy, uint32_t serial, struct wl_surface *surface, wl_fixed_t x, wl_fixed_t y) {
    ((enter_fn)find(proxy)->original[0])(data, proxy, serial, surface, x * 2, y * 2);
}

static void motion(void *data, struct wl_proxy *proxy, uint32_t time, wl_fixed_t x, wl_fixed_t y) {
    ((motion_fn)find(proxy)->original[2])(data, proxy, time, x * 2, y * 2);
}

int wl_proxy_add_listener(struct wl_proxy *proxy, void (**listeners)(void), void *data) {
    int (*original)(struct wl_proxy *, void (**)(void), void *) = dlsym(RTLD_NEXT, "wl_proxy_add_listener");
    if (!width || !height) return original(proxy, listeners, data);
    const char *type = wl_proxy_get_class(proxy);
    if (!strcmp(type, "wl_surface")) {
        // Reuse Wayland's integer buffer scale; no extra compositor or shader.
        wl_surface_set_buffer_scale((struct wl_surface *)proxy, 2);
        return original(proxy, listeners, data);
    }
    const int pointer = !strcmp(type, "wl_pointer");
    if (!pointer && strcmp(type, "xdg_toplevel")) return original(proxy, listeners, data);

    struct binding *entry = calloc(1, sizeof(*entry));
    if (!entry) return original(proxy, listeners, data);
    const uint32_t version = wl_proxy_get_version(proxy);
    const size_t count = pointer ? (version >= 9 ? 11 : version >= 8 ? 10 : version >= 5 ? 9 : 5)
                                 : (version >= 5 ? 4 : version >= 4 ? 3 : 2);
    memcpy(entry->listeners, listeners, count * sizeof(*listeners));
    memcpy(entry->original, listeners, count * sizeof(*listeners));
    entry->proxy = proxy;
    entry->listeners[0] = pointer ? (void (*)(void))enter : (void (*)(void))configure;
    if (pointer) entry->listeners[2] = (void (*)(void))motion;
    const int result = original(proxy, entry->listeners, data);
    if (result) { free(entry); return result; }
    entry->next = bindings;
    bindings = entry;
    if (pointer) return result;

    // xdg_toplevel.set_max_size (7) / set_min_size (8). These constraints
    // prevent the parent from resizing the phone output after it is mapped.
    wl_proxy_marshal_flags(proxy, 7, NULL, version, 0, width / 2, height / 2);
    wl_proxy_marshal_flags(proxy, 8, NULL, version, 0, width / 2, height / 2);
    return result;
}

void wl_proxy_destroy(struct wl_proxy *proxy) {
    void (*original)(struct wl_proxy *) = dlsym(RTLD_NEXT, "wl_proxy_destroy");
    for (struct binding **link = &bindings; *link; link = &(*link)->next) {
        if ((*link)->proxy != proxy) continue;
        struct binding *entry = *link;
        *link = entry->next;
        free(entry);
        break;
    }
    original(proxy);
}
