#!/usr/bin/env python3
"""Check a WAYLAND_DEBUG=1 capture-rotation.js log for old-buffer stretching."""
import re
import sys

viewports = {}
pending = {}
committed = {}
attached = set()
presented = set()
checked = 0
failures = []

for number, line in enumerate(open(sys.argv[1]), 1):
    if ' -> ' not in line:
        continue
    match = re.search(r'create_surface\(new id wl_surface[@#](\d+)\)', line)
    if match:
        surface = match[1]
        pending.pop(surface, None)
        committed.pop(surface, None)
        presented.discard(surface)
    match = re.search(r'get_viewport\(new id wp_viewport[@#](\d+), wl_surface[@#](\d+)\)', line)
    if match:
        viewports[match[1]] = match[2]
    match = re.search(r'wp_viewport[@#](\d+)\.set_destination\((\d+), (\d+)\)', line)
    if match:
        surface = viewports[match[1]]
        pending[surface] = (int(match[2]), int(match[3]))
    match = re.search(r'wl_surface[@#](\d+)\.attach\(wl_buffer[@#]\d+,', line)
    if match:
        attached.add(match[1])
    match = re.search(r'wl_surface[@#](\d+)\.commit\(', line)
    if match:
        surface = match[1]
        if surface in pending:
            size = pending.pop(surface)
            # Initial null-buffer commits request the first configure and
            # cannot stretch anything. Once mapped, a new size needs a buffer.
            if size != committed.get(surface) and (surface in presented or surface in attached):
                checked += 1
                if surface not in attached:
                    failures.append(f'line {number}: surface {surface} committed {size} without a new buffer')
            committed[surface] = size
        if surface in attached:
            presented.add(surface)
        attached.discard(surface)

if checked < 8:
    failures.append(f'Only {checked} viewport changes captured; expected initial buffers and four rotations')
if failures:
    sys.exit('\n'.join(failures))
print(f'PASS: {checked} viewport size changes committed with new buffers')
