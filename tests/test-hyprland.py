#!/usr/bin/env python3
"""Adapter transport/policy tests, private bus and fake Hyprland/idle sources.

No host compositor, hardware buttons or power actions are accessed. The native
coordinator is real; only compositor IPC, idle input and login1 are fixtures.
"""
import asyncio
import json
import hashlib
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from gi.repository import GLib

ROOT = Path(__file__).resolve().parents[1]

if '--inside' not in sys.argv:
    with tempfile.TemporaryDirectory(prefix='koya-hypr-test-') as tmp:
        env = dict(os.environ, XDG_RUNTIME_DIR=tmp, XDG_STATE_HOME=tmp, XDG_DATA_HOME=tmp, XDG_CACHE_HOME=tmp, KOYA_ICON_THEME='koya-test',
            WAYLAND_DISPLAY='fake-hyprland', HYPRLAND_INSTANCE_SIGNATURE='test',
            KOYA_TEST_IDLE_LOCK_SECONDS='2', KOYA_TEST_IDLE_SCREEN_SECONDS='1')
        sys.exit(subprocess.run(['dbus-run-session', '--', sys.executable, __file__, '--inside'], env=env).returncode)

os.environ['DBUS_SYSTEM_BUS_ADDRESS'] = os.environ['DBUS_SESSION_BUS_ADDRESS']
runtime = Path(os.environ['XDG_RUNTIME_DIR'])
instance = runtime / 'hypr/test'
instance.mkdir(parents=True)
fake_bin = runtime / 'bin'
fake_bin.mkdir()
idle = fake_bin / 'swayidle'
idle.write_text('''#!/usr/bin/python3
import os, signal, subprocess, sys
from pathlib import Path
Path(os.environ['XDG_RUNTIME_DIR'], 'idle-pid').write_text(str(os.getpid()))
seconds = int(sys.argv[-2])
signal.signal(signal.SIGUSR2, lambda *_: signal.alarm(seconds))
signal.signal(signal.SIGALRM, lambda *_: subprocess.run(sys.argv[-1], shell=True, check=True))
signal.alarm(seconds)
while True: signal.pause()
''')
idle.chmod(0o700)
os.environ['PATH'] = str(fake_bin) + ':' + os.environ['PATH']
app_dir = runtime / 'applications'
app_dir.mkdir()
for name, extra in [('koya-test', 'Icon=koya-test-icon\n'), ('koya-hidden', 'NoDisplay=true\n')]:
    (app_dir / (name + '.desktop')).write_text('[Desktop Entry]\nType=Application\nName=' + name + '\nExec=/bin/true\n' + extra)
for theme, inherits in [('koya-test', 'Inherits=koya-parent\n'), ('koya-parent', '')]:
    directory = runtime / 'icons' / theme
    (directory / 'scalable/apps').mkdir(parents=True)
    (directory / 'index.theme').write_text('[Icon Theme]\nName=Test\nDirectories=scalable/apps\n' + inherits +
        '[scalable/apps]\nSize=64\nType=Scalable\nMinSize=16\nMaxSize=256\n')
theme_icon = runtime / 'icons/koya-parent/scalable/apps/koya-test-icon.svg'
theme_icon.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#ff0000"/></svg>')
file_icon = runtime / 'absolute.png'
file_icon.write_bytes((ROOT / 'assets/power-menu/power-off.png').read_bytes())
(app_dir / 'koya-file-icon.desktop').write_text('[Desktop Entry]\nType=Application\nName=File icon\nExec=/bin/true\nIcon=' + str(file_icon) + '\n')


class NativeBridge:
    def __init__(self, command):
        self.command = command
        self.path = runtime / 'koya-display.sock'
        self.ready = runtime / 'koya-hyprland.state'
        self.stopped = asyncio.Event()
        self.process = None

    @property
    def coordinator(self):
        if not self.ready.exists():
            return None
        data = dict(line.split('=', 1) for line in self.ready.read_text().splitlines())
        return SimpleNamespace(pid=int(data['coordinator_pid']))

    @property
    def idle(self):
        return SimpleNamespace(pid=int((runtime / 'idle-pid').read_text()))

    async def run(self):
        self.process = await asyncio.create_subprocess_exec(str(ROOT / 'build/koya-hyprland-display-test'), str(ROOT), *self.command)
        wait = asyncio.create_task(self.process.wait())
        stop = asyncio.create_task(self.stopped.wait())
        await asyncio.wait([wait, stop], return_when=asyncio.FIRST_COMPLETED)
        if not wait.done():
            self.process.terminate()
        code = await wait
        stop.cancel()
        return code


class Compositor:
    def __init__(self):
        self.on = True
        self.reject = False
        self.commands = []
        self.events = []
        self.closed = asyncio.Event()
        self.workspace = 1
        self.clients = []

    async def command(self, reader, writer):
        command = (await reader.read(65536)).decode()
        self.commands.append(command)
        if command == 'j/monitors':
            response = json.dumps([dict(name='DSI-1', dpmsStatus=self.on)])
        elif command == 'j/workspaces':
            response = json.dumps([dict(id=self.workspace, name=str(self.workspace))])
        elif command == 'j/clients':
            response = json.dumps(self.clients)
        elif command == 'j/activeworkspace':
            response = json.dumps(dict(id=self.workspace, name=str(self.workspace)))
        elif command.startswith('dispatch workspace '):
            target = int(command.rsplit(' ', 1)[1])
            if target == self.workspace:
                response = "Previous workspace doesn't exist"
            else:
                self.workspace = target
                response = 'ok'
        elif command.startswith(('dispatch exec ', 'dispatch closewindow address:', 'dispatch focuswindow address:')):
            response = 'ok'
        elif command in ('dispatch dpms on', 'dispatch dpms off'):
            if self.reject:
                response = 'unsupported'
            else:
                self.on = command.endswith(' on')
                response = 'ok'
        else:
            response = 'unknown command'
        writer.write(response.encode())
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    async def event(self, reader, writer):
        self.events.append(writer)
        await self.closed.wait()
        writer.close()
        try: await writer.wait_closed()
        except ConnectionError: pass

    async def emit(self, data):
        for peer in list(self.events):
            try:
                peer.write(data); await peer.drain()
            except ConnectionError:
                self.events.remove(peer); peer.close()


async def eventually(predicate, timeout=5):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        result = predicate()
        if asyncio.iscoroutine(result):
            result = await result
        if result:
            return result
        await asyncio.sleep(.03)
    raise AssertionError('Timed out waiting for condition')


async def connect():
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    sock.setblocking(False)
    await asyncio.get_running_loop().sock_connect(sock, str(runtime / 'koya-display.sock'))
    return sock


async def packet(sock, data):
    loop = asyncio.get_running_loop()
    await loop.sock_sendall(sock, data)
    return await asyncio.wait_for(loop.sock_recv(sock, 64), .5)


async def call(method, *args, dest='org.koya.Shell1', path='/org/koya/Shell1', iface='org.koya.Shell1'):
    process = await asyncio.create_subprocess_exec('gdbus', 'call', '--session', '--dest', dest,
        '--object-path', path, '--method', iface + '.' + method, *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    output, error = await process.communicate()
    if process.returncode:
        raise RuntimeError(error.decode())
    return GLib.Variant.parse(None, output.decode().strip(), None, None).unpack()


async def state():
    return (await call('GetState'))[0]


async def wait_state(predicate):
    async def check():
        try:
            value = await state()
            return value if predicate(value) else False
        except RuntimeError:
            return False
    return await eventually(check)


async def main():
    compositor = Compositor()
    command_server = await asyncio.start_unix_server(compositor.command, path=str(instance / '.socket.sock'))
    event_server = await asyncio.start_unix_server(compositor.event, path=str(instance / '.socket2.sock'))
    bridge = task = login = None
    try:
        # Recover a stale socket, but reject another live adapter.
        stale = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        stale.bind(str(runtime / 'koya-display.sock'))
        stale.close()
        bridge = NativeBridge(['setpriv', '--pdeathsig', 'TERM',
            sys.executable, '-c', 'import signal; signal.pause()'])
        task = asyncio.create_task(bridge.run())
        await eventually(lambda: bridge.coordinator is not None)
        sock = await connect()
        assert await packet(sock, b'?') == b'1'
        assert await packet(sock, b'0') == b'0' and not compositor.on
        assert await packet(sock, b'?') == b'0'
        for invalid in (b'x', b'00', b't 86401 1', b't -1 1', b't 1 4294967296', b't 1 2 extra'):
            assert await packet(sock, invalid) == b'E', invalid
        compositor.reject = True
        assert await packet(sock, b'1') == b'E' and not compositor.on
        compositor.reject = False
        duplicate = await asyncio.create_subprocess_exec(str(ROOT / 'build/koya-hyprland-display'), str(ROOT),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        assert await duplicate.wait() != 0
        assert await packet(sock, b'?') == b'0', 'Duplicate disturbed the live adapter'
        assert await packet(sock, b'1') == b'1'
        assert await packet(sock, b't 1 10') == b't'
        await asyncio.sleep(.6)
        assert await packet(sock, b't 1 11') == b't'
        assert not select.select([sock], [], [], 0)[0]
        await asyncio.sleep(.5)
        assert not select.select([sock], [], [], 0)[0], 'Old idle generation survived rearm'
        assert await asyncio.wait_for(asyncio.get_running_loop().sock_recv(sock, 64), 1) == b'T 11'
        idle_pid = bridge.idle.pid
        assert await packet(sock, b't 0 12') == b't'
        await eventually(lambda: not Path('/proc/%d' % idle_pid).exists())
        assert await packet(sock, b'0') == b'0'
        sock.close()
        await eventually(lambda: compositor.on)
        bridge.stopped.set()
        assert await asyncio.wait_for(task, 6) == 0
        assert not bridge.path.exists() and not bridge.ready.exists()
        print('PASS: transport, DPMS rejection, stale recovery, singleton, rearm/disarm and disconnect cleanup')

        # Exercise the real coordinator and its desktop service against the adapter.
        login = await asyncio.create_subprocess_exec(sys.executable, str(ROOT / 'tests/fixtures/login.py'))
        async def login_ready():
            try:
                await call('Set', 'true', 'yes', 'false', dest='org.freedesktop.login1',
                    path='/org/freedesktop/login1', iface='org.koya.Test.Login')
                return True
            except RuntimeError:
                return False
        await eventually(login_ready)
        fixture = runtime / 'ui-with-hyprland-display.py'
        fixture.write_bytes((ROOT / 'tests/fixtures/component.py').read_bytes())
        fixture.chmod(0o700)
        bridge = NativeBridge(['setpriv', '--pdeathsig', 'TERM',
            str(ROOT / 'build/koya-session-test'), str(ROOT), str(fixture)])
        task = asyncio.create_task(bridge.run())
        await wait_state(lambda s: s['Active'] and s['top-barStatus'] == 'ready')
        await asyncio.sleep(1)
        # Inject compositor input into the idle fixture, without touching the
        # daemon's test command or adding a production reset API.
        os.kill(bridge.idle.pid, signal.SIGUSR2)
        await asyncio.sleep(1.3)
        assert (await state())['ScreenState'] == 'unlocked'
        await wait_state(lambda s: s['ScreenState'] == 'off' and s['lock-screenStatus'] == 'ready' and not compositor.on)
        assert not compositor.on and not (await state())['LastError']
        for value in ('1', '0'):
            await call('Button', '116', value, iface='org.koya.Shell1.Test')
        await wait_state(lambda s: s['ScreenState'] == 'locked')
        assert compositor.on
        await wait_state(lambda s: s['ScreenState'] == 'off')
        assert not compositor.on
        for value in ('1', '0'):
            await call('Button', '116', value, iface='org.koya.Shell1.Test')
        await call('Action', 'Unlock', dest='org.koya.Test.lock_screen',
            path='/org/koya/Test/Component', iface='org.koya.Test.Component')
        await wait_state(lambda s: s['ScreenState'] == 'unlocked')
        # Real desktop discovery and command routing; only the owned drawer may launch.
        await wait_state(lambda s: s['navigationStatus'] == 'ready')
        apps = (await call('GetApplications'))[0]
        assert any(app['id'] == 'koya-test.desktop' for app in apps), apps
        assert not any(app['id'] == 'koya-hidden.desktop' for app in apps), apps
        for app_id, source in [('koya-test.desktop', theme_icon), ('koya-file-icon.desktop', file_icon)]:
            entry = next(app for app in apps if app['id'] == app_id)
            status = source.stat()
            identity = f'{source}:{status.st_mtime_ns // 1000000000}:{status.st_mtime_ns % 1000000000}:{status.st_size}'
            name = 'koya-app-icon-' + hashlib.sha256(identity.encode()).hexdigest() + '.png'
            assert entry['icon'] == '/rom/' + name, entry
            png = (runtime / 'koya/icons' / name).read_bytes()
            assert png[:8] == b'\x89PNG\r\n\x1a\n' and int.from_bytes(png[16:20], 'big') == 160 and int.from_bytes(png[20:24], 'big') == 160
        desktop = (await call('GetDesktopState'))[0]
        assert json.loads(desktop['activeworkspace'])['id'] == 1
        watcher = await asyncio.create_subprocess_exec('gdbus', 'monitor', '--session', '--dest', 'org.koya.Shell1',
            '--object-path', '/org/koya/Shell1', stdout=asyncio.subprocess.PIPE)
        try:
            await asyncio.wait_for(watcher.stdout.readline(), 2)
            await asyncio.sleep(.05)
            await compositor.emit(b'work')
            await asyncio.sleep(.02)
            await compositor.emit(b'spacev2>>2,2\n')
            async def desktop_signal():
                while b'DesktopChanged' not in await watcher.stdout.readline(): pass
            await asyncio.wait_for(desktop_signal(), 2)
        finally:
            watcher.terminate(); await watcher.wait()
        await call('ShowDesktopView', 'apps')
        drawer = await wait_state(lambda s: s['navigationStatus'] == 'ready' and s['DesktopView'] == 'apps')
        assert 'desktop-viewPid' not in drawer, 'Drawer still has a separate process'
        await call('ShowDesktopView', 'desktops')
        assert (await state())['navigationPid'] == drawer['navigationPid'], 'View switch restarted navigation'
        try:
            await call('Launch', 'missing.desktop', '2', dest='org.koya.Test.navigation',
                path='/org/koya/Test/Component', iface='org.koya.Test.Component')
        except RuntimeError: pass
        else: raise AssertionError('Unknown desktop entry accepted')
        for method, args in [('LaunchApplication', ('koya-test.desktop', '2')), ('SwitchDesktop', ('0',)),
                             ('FocusWindow', ('0x12;quit',)), ('CloseWindow', ('class:.*',))]:
            try: await call(method, *args)
            except RuntimeError: pass
            else: raise AssertionError(('Accepted invalid/unowned desktop command', method))
        await call('Launch', 'koya-test.desktop', '2', dest='org.koya.Test.navigation',
            path='/org/koya/Test/Component', iface='org.koya.Test.Component')
        assert compositor.workspace == 2
        assert any(command.endswith("/build/koya-launch-app' '" + str(app_dir / 'koya-test.desktop') + "'") for command in compositor.commands), compositor.commands
        assert (await state())['DesktopView'] == 'desktops', 'Launch dismissed feedback before the app window arrived'
        await call('FocusWindow', '0xabc')
        hidden = await wait_state(lambda s: s['DesktopView'] == 'closed')
        assert hidden['navigationPid'] == drawer['navigationPid'] and hidden['navigationStatus'] == 'ready', hidden
        await call('ShowDesktopView', 'desktops')
        assert (await state())['navigationPid'] == drawer['navigationPid'], 'Reopening restarted the process'
        await call('DismissDesktopView')
        await call('SwitchDesktop', '1')
        assert compositor.workspace == 1
        await call('ShowDesktopView', 'desktops')
        await call('SwitchDesktop', '1')
        assert compositor.workspace == 1 and (await state())['DesktopView'] == 'closed', 'Home failed while already active'
        await call('FocusWindow', '0xabc')
        await call('CloseWindow', '0xabc')
        print('PASS: application discovery, hidden entries, singleton drawer, owned launch, desktop switching and validated window commands')
        await call('ShowPowerMenu')
        await wait_state(lambda s: s['PowerMenuState'] == 'open')
        assert compositor.on and not (await state())['LastError']
        try: await call('SwitchDesktop', '2')
        except RuntimeError: pass
        else: raise AssertionError('Desktop switched underneath power menu')
        children = [s['%sPid' % name] for name in ('wallpaper', 'top-bar', 'power-menu', 'navigation') if (s := await state())['%sPid' % name]]
        # Compositor exit must clean up the coordinator and its Koya children.
        compositor.closed.set()
        assert await asyncio.wait_for(task, 6) == 0
        for pid in children:
            path = Path('/proc/%d/stat' % pid)
            assert not path.exists() or path.read_text().rsplit(') ', 1)[1].startswith('Z ')
        assert compositor.on and not bridge.path.exists()
        print('PASS: native daemon idle reset, auto-lock, short-press DPMS, shorter lock timeout, unlock, menu and compositor-exit cleanup')
    finally:
        if bridge and task and not task.done():
            bridge.stopped.set()
            await asyncio.wait_for(task, 6)
        if login and login.returncode is None:
            login.terminate()
            await login.wait()
        compositor.closed.set()
        command_server.close()
        event_server.close()
        await command_server.wait_closed()
        await event_server.wait_closed()


asyncio.run(main())
