#!/usr/bin/env python3
"""Rasterize the editable SVG icon sources with system librsvg/Cairo.
No package installation is needed; Koya consumes the resulting PNG textures.
"""
import ctypes as C
from pathlib import Path
rsvg = C.CDLL('librsvg-2.so.2')
cairo = C.CDLL('libcairo.so.2')
gobject = C.CDLL('libgobject-2.0.so.0')
rsvg.rsvg_handle_new_from_file.argtypes = [C.c_char_p, C.c_void_p]
rsvg.rsvg_handle_new_from_file.restype = C.c_void_p
rsvg.rsvg_handle_render_cairo.argtypes = [C.c_void_p, C.c_void_p]
rsvg.rsvg_handle_render_cairo.restype = C.c_int
cairo.cairo_image_surface_create.argtypes = [C.c_int, C.c_int, C.c_int]
cairo.cairo_image_surface_create.restype = C.c_void_p
cairo.cairo_create.argtypes = [C.c_void_p]
cairo.cairo_create.restype = C.c_void_p
cairo.cairo_surface_write_to_png.argtypes = [C.c_void_p, C.c_char_p]
cairo.cairo_surface_write_to_png.restype = C.c_int
cairo.cairo_destroy.argtypes = [C.c_void_p]
cairo.cairo_surface_destroy.argtypes = [C.c_void_p]
gobject.g_object_unref.argtypes = [C.c_void_p]
for source in (Path(__file__).resolve().parents[1]/'assets/power-menu').glob('*.svg'):
    handle = rsvg.rsvg_handle_new_from_file(str(source).encode(), None)
    assert handle, source
    surface = cairo.cairo_image_surface_create(0, 160, 160)
    context = cairo.cairo_create(surface)
    try:
        assert rsvg.rsvg_handle_render_cairo(handle, context), source
        assert cairo.cairo_surface_write_to_png(surface, str(source.with_suffix('.png')).encode()) == 0
    finally:
        cairo.cairo_destroy(context)
        cairo.cairo_surface_destroy(surface)
        gobject.g_object_unref(handle)
