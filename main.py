import sys
import asyncio
from platform import system
from os.path import dirname
from os import W_OK, access, stat
from stat import FILE_ATTRIBUTE_HIDDEN
from urllib.request import Request, urlopen
from urllib.parse import urlparse
from struct import unpack
from hashlib import sha256
import re
import json
import os
import threading
import traceback
from datetime import datetime, timezone
from base64 import b64decode, b64encode
from pathlib import Path
from shutil import copyfile
import decky # type: ignore

# Decky on Windows does not always prepend the plugin directory before loading
# the backend. Add it before importing any bundled module.
plugin_dir = Path(decky.DECKY_PLUGIN_DIR)
for module_root in [plugin_dir, plugin_dir / 'defaults']:
    module_root_str = str(module_root)
    if module_root_str not in sys.path:
        sys.path.insert(0, module_root_str)

from settings import SettingsManager # type: ignore
from helpers import get_ssl_context # type: ignore
from provider_search import ( # type: ignore
    inspect_remote_artwork as inspect_remote_artwork_sync,
    search_provider_assets as search_provider_assets_sync,
    search_playstation_games as search_playstation_games_sync,
    search_nintendo_games as search_nintendo_games_sync,
    search_igdb_games as search_igdb_games_sync,
    search_xbox_games as search_xbox_games_sync,
    search_iidb_games as search_iidb_games_sync,
    search_ign_games as search_ign_games_sync,
)

WINDOWS = system() == "Windows"

DIAGNOSTIC_DIR = Path(decky.DECKY_PLUGIN_LOG_DIR).parent / 'Playhub-Artworks'
DIAGNOSTIC_FILE = DIAGNOSTIC_DIR / 'playhub-artworks.jsonl'
DIAGNOSTIC_MAX_BYTES = 5 * 1024 * 1024
_diagnostic_lock = threading.Lock()
_download_progress_lock = threading.Lock()
_download_progress = {}
SETTINGS_FILE = Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / 'playhub_artworks.json'
PERFECT_SOURCE_DIR = Path(decky.DECKY_PLUGIN_RUNTIME_DIR) / 'perfect_sources'
SETTINGS_BACKUP_FILE = SETTINGS_FILE.with_suffix('.json.bak')

def _asset_format(content, content_type='', source=''):
    """Return the real media format expected by Steam's artwork API.

    Providers sometimes serve WebP bytes from URLs ending in .png. Prefer file
    signatures over headers/URLs so the filename Steam writes always matches
    the payload it contains.
    """
    if content.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if content.startswith(b'\xff\xd8\xff'):
        return 'jpg'
    if content.startswith((b'GIF87a', b'GIF89a')):
        return 'gif'
    if content.startswith(b'RIFF') and content[8:12] == b'WEBP':
        return 'webp'
    if content.startswith(b'\x1aE\xdf\xa3'):
        return 'webm'
    if content.startswith(b'\x00\x00\x01\x00'):
        return 'ico'

    mime = str(content_type or '').split(';', 1)[0].strip().lower()
    by_mime = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/vnd.microsoft.icon': 'ico',
        'image/x-icon': 'ico',
        'video/webm': 'webm',
    }
    if mime in by_mime:
        return by_mime[mime]
    suffix = Path(urlparse(str(source or '')).path).suffix.lower().lstrip('.')
    if suffix == 'jpeg':
        suffix = 'jpg'
    if suffix in {'png', 'jpg', 'webp', 'gif', 'webm', 'ico'}:
        return suffix
    raise ValueError('Formato artwork non riconosciuto.')

def _asset_is_animated(content, asset_format):
    if asset_format == 'webm':
        return True
    if asset_format == 'gif':
        return True
    if asset_format == 'webp':
        return b'ANIM' in content[:256] or (
            content[12:16] == b'VP8X' and len(content) > 20 and bool(content[20] & 0x02)
        )
    if asset_format == 'png':
        return b'acTL' in content[:1024]
    return False

def _read_json_object(path):
    with open(path, 'r', encoding='utf-8') as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError('Settings root must be a JSON object')
    return value

def _read_settings_file():
    for candidate in (SETTINGS_FILE, SETTINGS_BACKUP_FILE):
        try:
            if candidate.is_file():
                return _read_json_object(candidate)
        except Exception as error:
            _diagnostic('settings.read.failed', path=candidate, error=error)
    return {}

def _write_settings_file(value):
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = SETTINGS_FILE.with_suffix('.json.tmp')
    with open(temporary, 'w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    if SETTINGS_FILE.exists():
        copyfile(SETTINGS_FILE, SETTINGS_BACKUP_FILE)
    os.replace(temporary, SETTINGS_FILE)

def _redact_diagnostic(value, key=''):
    sensitive = any(part in str(key).lower() for part in ['api_key', 'apikey', 'authorization', 'cookie', 'token', 'secret'])
    if sensitive:
        return '[redacted]'
    if isinstance(value, dict):
        return {str(k): _redact_diagnostic(v, str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_redact_diagnostic(item) for item in value]
    if isinstance(value, BaseException):
        return {
            'type': type(value).__name__,
            'message': str(value),
            'stack': ''.join(traceback.format_exception(type(value), value, value.__traceback__)),
        }
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, str) and 'url' in str(key).lower():
        try:
            parsed = urlparse(value)
            return parsed._replace(query='', fragment='').geturl()
        except Exception:
            return '[redacted-url]'
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)

def _rotate_diagnostic():
    if not DIAGNOSTIC_FILE.exists() or DIAGNOSTIC_FILE.stat().st_size < DIAGNOSTIC_MAX_BYTES:
        return
    for index in range(2, 0, -1):
        source = DIAGNOSTIC_DIR / f'playhub-artworks.jsonl.{index}'
        target = DIAGNOSTIC_DIR / f'playhub-artworks.jsonl.{index + 1}'
        if source.exists():
            if target.exists():
                target.unlink()
            source.replace(target)
    DIAGNOSTIC_FILE.replace(DIAGNOSTIC_DIR / 'playhub-artworks.jsonl.1')

def _diagnostic(event, **details):
    try:
        DIAGNOSTIC_DIR.mkdir(parents=True, exist_ok=True)
        entry = {
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'event': str(event),
            'pid': os.getpid(),
            'thread': threading.current_thread().name,
            **_redact_diagnostic(details),
        }
        with _diagnostic_lock:
            _rotate_diagnostic()
            with open(DIAGNOSTIC_FILE, 'a', encoding='utf-8') as stream:
                stream.write(json.dumps(entry, ensure_ascii=False, separators=(',', ':')) + '\n')
    except Exception as error:
        decky.logger.warning(f'Playhub Artworks diagnostic write failed: {error}')

if WINDOWS:
    from winreg import QueryValueEx, OpenKey, HKEY_CURRENT_USER

    # Windows/Decky sometimes does not add bundled Python modules to sys.path.
    # Keep both locations supported:
    #   - py_modules/ at plugin root (what the original installation leaves behind)
    #   - defaults/py_modules/ as a fallback bundled with the ZIP
    from py_modules.vdf import binary_dump, binary_load, parse
else:
    from vdf import binary_dump, binary_load, parse

def get_steam_path():
    if WINDOWS:
        return Path(QueryValueEx(OpenKey(HKEY_CURRENT_USER, r"Software\Valve\Steam"), "SteamPath")[0])
    else:
        return Path(decky.DECKY_USER_HOME) / '.local' / 'share' / 'Steam'

def get_steam_userdata():
    return get_steam_path() / 'userdata'

def get_steam_libcache():
    return get_steam_path() / 'appcache' / 'librarycache'

def get_userdata_config(steam32):
    return get_steam_userdata() / steam32 / 'config'


def _read_vdf(path):
    try:
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            return parse(f)
    except Exception:
        return {}

def _safe_int(value, fallback=0):
    try:
        return int(value)
    except Exception:
        return fallback

def _walk_dict_path(data, *keys):
    cur = data
    for key in keys:
        if not isinstance(cur, dict):
            return {}
        cur = cur.get(key, {})
    return cur if isinstance(cur, dict) else {}

def _grid_file_candidates(grid_dir, appid, asset_type):
    if not grid_dir.exists():
        return []

    appid = str(appid)
    suffixes = {
        'hero': ['_hero'],
        'logo': ['_logo'],
        'grid_p': ['p'],
        'grid_l': [''],
        'icon': ['_icon'],
    }.get(asset_type, [])

    candidates = []
    for file in grid_dir.iterdir():
        if not file.is_file():
            continue
        name = file.stem
        ext = file.suffix.lower()
        if ext not in ['.png', '.jpg', '.jpeg', '.webp']:
            continue
        for suffix in suffixes:
            if name == f'{appid}{suffix}':
                candidates.append(file)
                break

    # Prefer newest custom artwork if Steam left multiple extensions behind.
    candidates.sort(key=lambda x: x.stat().st_mtime, reverse=True)
    return candidates

def _librarycache_file_candidates(appid, asset_type):
    app_dir = get_steam_libcache() / str(appid)
    if not app_dir.exists():
        return []

    stems = {
        'hero': ['library_hero'],
        'logo': ['logo'],
        'grid_p': ['library_600x900'],
        'grid_l': ['header'],
    }.get(asset_type, [])
    candidates = []
    for stem in stems:
        for ext in ['.png', '.jpg', '.jpeg', '.webp']:
            path = app_dir / f'{stem}{ext}'
            if path.is_file():
                candidates.append(path)
    return candidates

def _sha256_file(path):
    digest = sha256()
    with open(path, 'rb') as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()

def _png_size(path):
    with open(path, 'rb') as f:
        header = f.read(24)
    if header.startswith(b'\x89PNG\r\n\x1a\n') and header[12:16] == b'IHDR':
        return unpack('>II', header[16:24])
    return None

def _jpeg_size(path):
    with open(path, 'rb') as f:
        if f.read(2) != b'\xff\xd8':
            return None
        while True:
            byte = f.read(1)
            if not byte:
                return None
            if byte != b'\xff':
                continue
            marker = f.read(1)
            while marker == b'\xff':
                marker = f.read(1)
            if marker in [b'\xd8', b'\xd9']:
                continue
            size_bytes = f.read(2)
            if len(size_bytes) != 2:
                return None
            size = unpack('>H', size_bytes)[0]
            if marker in [b'\xc0', b'\xc1', b'\xc2', b'\xc3', b'\xc5', b'\xc6', b'\xc7', b'\xc9', b'\xca', b'\xcb', b'\xcd', b'\xce', b'\xcf']:
                data = f.read(5)
                if len(data) != 5:
                    return None
                height = unpack('>H', data[1:3])[0]
                width = unpack('>H', data[3:5])[0]
                return width, height
            f.seek(size - 2, 1)

def _webp_size(path):
    with open(path, 'rb') as f:
        data = f.read(64)
    if len(data) < 30 or data[0:4] != b'RIFF' or data[8:12] != b'WEBP':
        return None
    chunk = data[12:16]
    if chunk == b'VP8X' and len(data) >= 30:
        width = 1 + int.from_bytes(data[24:27], 'little')
        height = 1 + int.from_bytes(data[27:30], 'little')
        return width, height
    if chunk == b'VP8 ' and len(data) >= 30:
        width = unpack('<H', data[26:28])[0] & 0x3fff
        height = unpack('<H', data[28:30])[0] & 0x3fff
        return width, height
    if chunk == b'VP8L' and len(data) >= 25:
        b0, b1, b2, b3 = data[21], data[22], data[23], data[24]
        width = 1 + (((b1 & 0x3f) << 8) | b0)
        height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
        return width, height
    return None

def _image_size(path):
    for reader in [_png_size, _jpeg_size, _webp_size]:
        try:
            size = reader(path)
            if size:
                return size
        except Exception:
            continue
    return None

def _steam_library_dirs():
    libraries = []
    try:
        steam_path = get_steam_path()
        libraries.append(steam_path)
        data = _read_vdf(steam_path / 'steamapps' / 'libraryfolders.vdf')
        folders = data.get('libraryfolders', data) if isinstance(data, dict) else {}
        if isinstance(folders, dict):
            for key, value in folders.items():
                path = None
                if isinstance(value, dict):
                    path = value.get('path') or value.get('Path')
                elif isinstance(value, str) and str(key).isdigit():
                    path = value
                if path:
                    libraries.append(Path(str(path)))
    except Exception as e:
        try:
            decky.logger.debug(f'Failed to read Steam library folders: {e}')
        except Exception:
            pass

    unique = []
    seen = set()
    for library in libraries:
        try:
            resolved = str(Path(library))
            key = resolved.lower() if WINDOWS else resolved
            if key not in seen and Path(library).exists():
                unique.append(Path(library))
                seen.add(key)
        except Exception:
            continue
    return unique

def _add_app(apps, appid, display_name='', is_shortcut=False):
    numeric = _safe_int(appid)
    if numeric <= 0:
        return
    existing = apps.get(numeric)
    name = str(display_name or '')
    if existing:
        if name and not existing.get('display_name'):
            existing['display_name'] = name
        if is_shortcut:
            existing['is_shortcut'] = True
        return
    apps[numeric] = { 'appid': numeric, 'display_name': name, 'is_shortcut': bool(is_shortcut) }

def _add_manifest_apps(apps):
    for library in _steam_library_dirs():
        steamapps_dir = library / 'steamapps'
        if not steamapps_dir.exists():
            continue

        libraryfolders = _read_vdf(steamapps_dir / 'libraryfolders.vdf')
        folders = libraryfolders.get('libraryfolders', libraryfolders) if isinstance(libraryfolders, dict) else {}
        if isinstance(folders, dict):
            for value in folders.values():
                if isinstance(value, dict):
                    for appid in (value.get('apps') or {}).keys():
                        _add_app(apps, appid, '', False)

        for manifest in steamapps_dir.glob('appmanifest_*.acf'):
            data = _read_vdf(manifest)
            state = data.get('AppState', data.get('appstate', {})) if isinstance(data, dict) else {}
            if not isinstance(state, dict):
                state = {}
            appid = state.get('appid') or manifest.stem.replace('appmanifest_', '')
            name = state.get('name') or state.get('Name') or ''
            _add_app(apps, appid, name, False)

class Plugin:
    async def _main(self):
        self.settings = SettingsManager(name="playhub_artworks", settings_directory=decky.DECKY_PLUGIN_SETTINGS_DIR)
        self._settings_lock = asyncio.Lock()
        self._settings_data = _read_settings_file()
        _diagnostic('backend.started', platform=system(), plugin_dir=decky.DECKY_PLUGIN_DIR, settings_dir=decky.DECKY_PLUGIN_SETTINGS_DIR, log_dir=DIAGNOSTIC_DIR)

    async def _unload(self):
        _diagnostic('backend.stopped')

    async def write_diagnostic_events(self, events=None):
        for event in (events or [])[:100]:
            if isinstance(event, dict):
                _diagnostic('frontend.event', payload=event)
        return True

    async def download_as_base64(self, url='', job_id=''):
        started = asyncio.get_running_loop().time()
        def _download():
            req = Request(url, headers={'User-Agent': 'Playhub-Artworks/1.0'})
            chunks = []
            received = 0
            with urlopen(req, context=get_ssl_context(), timeout=20) as response:
                total = int(response.headers.get('Content-Length') or 0)
                if job_id:
                    with _download_progress_lock:
                        _download_progress[str(job_id)] = {'received': 0, 'total': total, 'percent': 0, 'status': 'running'}
                while True:
                    chunk = response.read(128 * 1024)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    received += len(chunk)
                    if job_id:
                        percent = min(99, round(received * 100 / total)) if total > 0 else 0
                        with _download_progress_lock:
                            _download_progress[str(job_id)] = {'received': received, 'total': total, 'percent': percent, 'status': 'running'}
            if job_id:
                with _download_progress_lock:
                    _download_progress[str(job_id)] = {'received': received, 'total': total, 'percent': 100, 'status': 'complete'}
            return b''.join(chunks)

        try:
            content = await asyncio.to_thread(_download)
            _diagnostic('download.completed', url=url, bytes=len(content), duration_ms=round((asyncio.get_running_loop().time() - started) * 1000))
            return b64encode(content).decode('utf-8')
        except Exception as error:
            if job_id:
                with _download_progress_lock:
                    current = _download_progress.get(str(job_id), {})
                    _download_progress[str(job_id)] = {**current, 'status': 'error'}
            _diagnostic('download.failed', url=url, duration_ms=round((asyncio.get_running_loop().time() - started) * 1000), error=error)
            raise

    async def download_artwork_payload(self, url='', job_id=''):
        started = asyncio.get_running_loop().time()
        def _download():
            req = Request(url, headers={'User-Agent': 'Playhub-Artworks/1.0'})
            chunks = []
            received = 0
            with urlopen(req, context=get_ssl_context(), timeout=20) as response:
                total = int(response.headers.get('Content-Length') or 0)
                content_type = response.headers.get('Content-Type') or ''
                if job_id:
                    with _download_progress_lock:
                        _download_progress[str(job_id)] = {'received': 0, 'total': total, 'percent': 0, 'status': 'running'}
                while True:
                    chunk = response.read(128 * 1024)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    received += len(chunk)
                    if job_id:
                        percent = min(99, round(received * 100 / total)) if total > 0 else 0
                        with _download_progress_lock:
                            _download_progress[str(job_id)] = {'received': received, 'total': total, 'percent': percent, 'status': 'running'}
            if job_id:
                with _download_progress_lock:
                    _download_progress[str(job_id)] = {'received': received, 'total': total, 'percent': 100, 'status': 'complete'}
            return b''.join(chunks), content_type

        try:
            content, content_type = await asyncio.to_thread(_download)
            asset_format = _asset_format(content, content_type, url)
            _diagnostic('artwork.download.completed', url=url, bytes=len(content), format=asset_format, duration_ms=round((asyncio.get_running_loop().time() - started) * 1000))
            return {'data': b64encode(content).decode('utf-8'), 'format': asset_format, 'animated': _asset_is_animated(content, asset_format)}
        except Exception as error:
            if job_id:
                with _download_progress_lock:
                    current = _download_progress.get(str(job_id), {})
                    _download_progress[str(job_id)] = {**current, 'status': 'error'}
            _diagnostic('artwork.download.failed', url=url, duration_ms=round((asyncio.get_running_loop().time() - started) * 1000), error=error)
            raise

    async def get_download_progress(self, job_id=''):
        with _download_progress_lock:
            return dict(_download_progress.get(str(job_id), {'received': 0, 'total': 0, 'percent': 0, 'status': 'pending'}))

    async def clear_download_progress(self, job_id=''):
        with _download_progress_lock:
            _download_progress.pop(str(job_id), None)
        return True

    async def download_asset_payload(self, url=''):
        """Download an artwork once and return both Steam-ready data and its hash.

        Running the blocking URL request in a worker thread allows the frontend's
        small preparation pool to overlap downloads without blocking Decky's plugin
        event loop.
        """
        def _download():
            req = Request(url, headers={'User-Agent': 'Playhub-Artworks/1.0'})
            with urlopen(req, context=get_ssl_context(), timeout=20) as response:
                return response.read(), response.headers.get('Content-Type') or ''

        started = asyncio.get_running_loop().time()
        try:
            content, content_type = await asyncio.to_thread(_download)
            digest = sha256(content).hexdigest()
            asset_format = _asset_format(content, content_type, url)
            _diagnostic('artwork.download.completed', url=url, bytes=len(content), sha256=digest, format=asset_format, duration_ms=round((asyncio.get_running_loop().time() - started) * 1000))
            return {'data': b64encode(content).decode('utf-8'), 'sha256': digest, 'format': asset_format, 'animated': _asset_is_animated(content, asset_format)}
        except Exception as error:
            _diagnostic('artwork.download.failed', url=url, duration_ms=round((asyncio.get_running_loop().time() - started) * 1000), error=error)
            raise

    async def read_file_as_base64(self, path=''):
        with open(path, 'rb') as image_file:
            return b64encode(image_file.read()).decode('utf-8')

    async def read_artwork_payload(self, path=''):
        with open(path, 'rb') as image_file:
            content = image_file.read()
        asset_format = _asset_format(content, source=path)
        return {'data': b64encode(content).decode('utf-8'), 'format': asset_format, 'animated': _asset_is_animated(content, asset_format)}

    async def get_local_start(self):
        return decky.DECKY_USER_HOME

    async def download_file(self, url='', output_dir='', file_name=''):
        _diagnostic('file.download.started', url=url, output_dir=output_dir, file_name=file_name)
        try:
            if access(dirname(output_dir), W_OK):
                req = Request(url, headers={'User-Agent': 'Playhub-Artworks/1.0'})
                res = urlopen(req, context=get_ssl_context())
                if res.status == 200:
                    with open(Path(output_dir) / file_name, mode='wb') as f:
                        f.write(res.read())
                    saved_path = str(Path(output_dir) / file_name)
                    _diagnostic('file.download.completed', url=url, path=saved_path)
                    return saved_path
                return False
        except Exception as error:
            _diagnostic('file.download.failed', url=url, output_dir=output_dir, file_name=file_name, error=error)
            return False

        return False

    async def set_shortcut_icon_from_path(self, appid, owner_id, path):
        ext = Path(path).suffix
        iconname = "%s_icon%s" % (appid, ext)
        output_file = get_userdata_config(owner_id) / 'grid' / iconname
        saved_path = str(copyfile(path, output_file))
        return await self.set_shortcut_icon(appid, owner_id, path=saved_path)

    async def set_shortcut_icon_from_url(self, appid, owner_id, url):
        output_dir = get_userdata_config(owner_id) / 'grid'
        ext = Path(urlparse(url).path).suffix
        iconname = "%s_icon%s" % (appid, ext)
        saved_path = await self.download_file(url, output_dir, file_name=iconname)
        if saved_path:
            return await self.set_shortcut_icon(appid, owner_id, path=saved_path)
        else:
            raise Exception("Failed to download icon from %s" % url)

    async def set_shortcut_icon(self, appid, owner_id, path=None):
        shortcuts_vdf = get_userdata_config(owner_id) / 'shortcuts.vdf'

        d = binary_load(open(shortcuts_vdf, "rb"))
        for shortcut in d['shortcuts'].values():
            shortcut_appid = (shortcut['appid'] & 0xffffffff) | 0x80000000
            if shortcut_appid == appid:
                if shortcut['icon'] == path:
                    return 'icon_is_same_path'

                # Clear icon
                if path is None:
                    shortcut['icon'] = ''
                else:
                    shortcut['icon'] = path
                binary_dump(d, open(shortcuts_vdf, 'wb'))
                return True
        raise Exception('Could not find shortcut to edit')

    async def set_steam_icon_from_url(self, appid, url):
        await self.download_file(url, get_steam_libcache(), file_name=("%s_icon.jpg" % appid))

    async def set_steam_icon_from_path(self, appid, path):
        copyfile(path, get_steam_libcache() / str("%s_icon.jpg" % appid))

    async def set_setting(self, key, value):
        async with self._settings_lock:
            self._settings_data[str(key)] = value
            await asyncio.to_thread(_write_settings_file, self._settings_data)
        sensitive = any(marker in str(key).lower() for marker in ('api_key', 'token', 'secret', 'password', 'cookie', 'auth'))
        _diagnostic('setting.saved', key=key, value='[redacted]' if sensitive else value)
        return True

    async def get_setting(self, key, fallback):
        return self._settings_data.get(str(key), fallback)

    async def delete_setting(self, key):
        async with self._settings_lock:
            self._settings_data.pop(str(key), None)
            await asyncio.to_thread(_write_settings_file, self._settings_data)
        _diagnostic('setting.deleted', key=key)
        return True

    async def save_steamgriddb_api_key(self, value=''):
        normalized = str(value or '').strip()
        async with self._settings_lock:
            pending = dict(self._settings_data)
            pending['steamgriddb_api_key'] = normalized
            await asyncio.to_thread(_write_settings_file, pending)
            persisted = await asyncio.to_thread(_read_json_object, SETTINGS_FILE)
            saved = str(persisted.get('steamgriddb_api_key', '') or '') == normalized
            if saved:
                self._settings_data = persisted
        _diagnostic('setting.saved', key='steamgriddb_api_key', value='[redacted]', persisted=saved)
        return {'saved': saved, 'configured': bool(normalized) if saved else bool(self._settings_data.get('steamgriddb_api_key', ''))}

    # --- Perfect Hero / Perfect Banner pristine sources ------------------
    #
    # A composed artwork replaces the artwork it was made from. Re-opening the
    # editor would then compose on top of a picture that already has the logo
    # baked in. The untouched background is kept aside the first time, so every
    # later edit still starts from the original.

    def _perfect_source_path(self, appid, target, ext='jpg'):
        return PERFECT_SOURCE_DIR / f'{int(appid)}_{str(target)}.{str(ext).lstrip(".")}'

    def _find_perfect_source(self, appid, target):
        for ext in ('png', 'jpg', 'jpeg', 'webp'):
            candidate = self._perfect_source_path(appid, target, ext)
            if candidate.exists():
                return candidate
        return None

    async def save_perfect_source(self, appid=0, target='hero', data='', ext='jpg'):
        try:
            PERFECT_SOURCE_DIR.mkdir(parents=True, exist_ok=True)
            existing = self._find_perfect_source(appid, target)
            if existing:
                return {'saved': True, 'existing': True}
            payload = b64decode(str(data or ''))
            if not payload:
                return {'saved': False}
            path = self._perfect_source_path(appid, target, ext)
            temporary = path.with_suffix(path.suffix + '.tmp')
            temporary.write_bytes(payload)
            temporary.replace(path)
            _diagnostic('perfect.source.saved', appid=appid, target=target, bytes=len(payload))
            return {'saved': True, 'existing': False}
        except Exception as error:
            _diagnostic('perfect.source.save_failed', appid=appid, target=target, error=error)
            return {'saved': False}

    async def get_perfect_source(self, appid=0, target='hero'):
        try:
            path = self._find_perfect_source(appid, target)
            if not path:
                return ''
            mime = 'image/png' if path.suffix.lower() == '.png' else 'image/webp' if path.suffix.lower() == '.webp' else 'image/jpeg'
            return f'data:{mime};base64,' + b64encode(path.read_bytes()).decode('ascii')
        except Exception as error:
            _diagnostic('perfect.source.read_failed', appid=appid, target=target, error=error)
            return ''

    async def clear_perfect_source(self, appid=0, target='hero'):
        try:
            path = self._find_perfect_source(appid, target)
            if path:
                path.unlink()
                _diagnostic('perfect.source.cleared', appid=appid, target=target)
            return True
        except Exception as error:
            _diagnostic('perfect.source.clear_failed', appid=appid, target=target, error=error)
            return False

    async def get_steamgriddb_api_key(self):
        return str(self._settings_data.get('steamgriddb_api_key', '') or '')

    async def search_provider_games(self, provider='', title='', limit=12):
        """Store titles matching a name, so the user can pick the right one."""
        try:
            finders = {
                'playstation': search_playstation_games_sync,
                'nintendo': search_nintendo_games_sync,
                'igdb': search_igdb_games_sync,
                'xbox': search_xbox_games_sync,
                'iidb': search_iidb_games_sync,
                'ign': search_ign_games_sync,
            }
            finder = finders.get(str(provider or '').lower())
            if finder is None:
                return []
            loop = asyncio.get_running_loop()
            games = await loop.run_in_executor(
                None,
                lambda: finder(str(title or ''), int(limit)),
            )
            _diagnostic('provider.games', provider=provider, title=title, found=len(games))
            return games
        except Exception as error:
            _diagnostic('provider.games.failed', provider=provider, title=title, error=error)
            return []

    async def search_provider_assets(self, provider='', title='', asset_type='grid_p', square_only=False, limit=24, minimum_quality='standard', mimes=None, content_type='all', query='', exact_size=''):
        """Search and validate provider images without blocking Decky's event loop."""
        started = asyncio.get_running_loop().time()
        search = {'provider': provider, 'title': title, 'asset_type': asset_type, 'square_only': bool(square_only), 'minimum_quality': minimum_quality, 'mimes': mimes or [], 'content_type': content_type, 'query': query, 'exact_size': exact_size}
        _diagnostic('provider.search.started', **search)
        try:
            bounded_limit = max(1, min(36, int(limit)))
            results = await asyncio.wait_for(
                asyncio.to_thread(
                    search_provider_assets_sync,
                    provider,
                    title,
                    asset_type,
                    bool(square_only),
                    bounded_limit,
                    minimum_quality,
                    mimes or [],
                    content_type,
                    query,
                    exact_size,
                ),
                timeout=28,
            )
            _diagnostic('provider.search.completed', **search, result_count=len(results), duration_ms=round((asyncio.get_running_loop().time() - started) * 1000))
            return results
        except asyncio.TimeoutError:
            decky.logger.warning(f'Artwork provider timeout provider={provider} title={title}')
            _diagnostic('provider.search.timeout', **search, duration_ms=round((asyncio.get_running_loop().time() - started) * 1000))
            return []
        except Exception as error:
            decky.logger.warning(f'Artwork provider failed provider={provider} title={title}: {error}')
            _diagnostic('provider.search.failed', **search, duration_ms=round((asyncio.get_running_loop().time() - started) * 1000), error=error)
            return []

    async def inspect_remote_artwork(self, url='', asset_type='grid_p', aspect_mode='portrait', minimum_quality='standard', mimes=None):
        started = asyncio.get_running_loop().time()
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(
                    inspect_remote_artwork_sync,
                    url,
                    asset_type,
                    aspect_mode,
                    minimum_quality,
                    mimes or [],
                ),
                timeout=22,
            )
            _diagnostic('artwork.inspect.completed', url=url, asset_type=asset_type, aspect_mode=aspect_mode, minimum_quality=minimum_quality, result=result, duration_ms=round((asyncio.get_running_loop().time() - started) * 1000))
            return result
        except asyncio.TimeoutError as error:
            _diagnostic('artwork.inspect.timeout', url=url, asset_type=asset_type, duration_ms=round((asyncio.get_running_loop().time() - started) * 1000))
            raise ValueError('La verifica dell’immagine ha impiegato troppo tempo.') from error
        except Exception as error:
            _diagnostic('artwork.inspect.failed', url=url, asset_type=asset_type, duration_ms=round((asyncio.get_running_loop().time() - started) * 1000), error=error)
            raise


    async def get_library_apps(self):
        started = asyncio.get_running_loop().time()
        _diagnostic('library.enumeration.started')
        apps = {}
        _add_manifest_apps(apps)
        userdata = get_steam_userdata()
        if not userdata.exists():
            result = sorted(apps.values(), key=lambda app: (app.get('display_name') or str(app.get('appid'))).lower())
            _diagnostic('library.enumeration.completed', app_count=len(result), duration_ms=round((asyncio.get_running_loop().time() - started) * 1000))
            return result

        for user_dir in userdata.iterdir():
            if not user_dir.is_dir():
                continue
            config_dir = user_dir / 'config'

            # Steam apps from local/shared config.
            for filename in ['sharedconfig.vdf', 'localconfig.vdf']:
                data = _read_vdf(config_dir / filename)
                steam_apps = _walk_dict_path(data, 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps')
                if not steam_apps:
                    steam_apps = _walk_dict_path(data, 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'Apps')
                for appid, meta in steam_apps.items():
                    numeric = _safe_int(appid)
                    if numeric > 0:
                        name = ''
                        if isinstance(meta, dict):
                            name = meta.get('name') or meta.get('Name') or meta.get('appname') or meta.get('AppName') or ''
                        _add_app(apps, numeric, str(name), False)

            # Non-Steam shortcuts.
            shortcuts_vdf = config_dir / 'shortcuts.vdf'
            if shortcuts_vdf.exists():
                try:
                    d = binary_load(open(shortcuts_vdf, 'rb'))
                    for shortcut in d.get('shortcuts', {}).values():
                        raw_appid = _safe_int(shortcut.get('appid'))
                        appid = (raw_appid & 0xffffffff) | 0x80000000
                        if appid > 0:
                            name = shortcut.get('AppName') or shortcut.get('appname') or shortcut.get('name') or ''
                            _add_app(apps, appid, str(name), True)
                except Exception as e:
                    decky.logger.debug(f'Failed to read shortcuts.vdf: {e}')

            # If artwork exists for an app, include it even if config parsing missed it.
            grid_dir = config_dir / 'grid'
            if grid_dir.exists():
                for file in grid_dir.iterdir():
                    match = re.match(r'^(\d+)', file.name)
                    if match:
                        appid = _safe_int(match.group(1))
                        if appid > 0 and appid not in apps:
                            _add_app(apps, appid, '', appid >= 0x80000000)

        result = sorted(apps.values(), key=lambda app: (app.get('display_name') or str(app.get('appid'))).lower())
        _diagnostic('library.enumeration.completed', app_count=len(result), duration_ms=round((asyncio.get_running_loop().time() - started) * 1000))
        return result

    async def get_local_asset_info(self, appid, asset_type):
        userdata = get_steam_userdata()
        result = { 'exists': False }
        if userdata.exists():
            for user_dir in userdata.iterdir():
                grid_dir = user_dir / 'config' / 'grid'
                for file in _grid_file_candidates(grid_dir, appid, asset_type):
                    width_height = _image_size(file)
                    if width_height:
                        return { 'exists': True, 'width': width_height[0], 'height': width_height[1], 'path': str(file), 'source': 'custom', 'sha256': _sha256_file(file) }
                    return { 'exists': True, 'path': str(file), 'source': 'custom', 'sha256': _sha256_file(file) }

        for file in _librarycache_file_candidates(appid, asset_type):
            width_height = _image_size(file)
            if width_height:
                return { 'exists': True, 'width': width_height[0], 'height': width_height[1], 'path': str(file), 'source': 'official' }
            return { 'exists': True, 'path': str(file), 'source': 'official' }

        return result

    async def get_zazamastro_position_candidates(self):
        """Return locally verified games whose current hero is the one applied by ZazaMastro Fix.

        This intentionally performs no SteamGridDB requests and does not enumerate the
        whole Steam library. It scans only local ZazaMastro markers, indexes custom hero
        files once, then verifies the small marked subset by SHA-256.
        """
        try:
            self.settings.read()
        except Exception:
            pass

        raw_settings = getattr(self.settings, 'settings', {}) or {}
        marked = {}
        prefix = 'zazamastro_hero_'
        if isinstance(raw_settings, dict):
            for key, marker in raw_settings.items():
                if not isinstance(key, str) or not key.startswith(prefix):
                    continue
                appid = _safe_int(key[len(prefix):])
                if appid <= 0 or not isinstance(marker, dict):
                    continue
                marked[appid] = marker

        # Index all custom heroes once instead of rescanning every grid folder for
        # every marker. Newest duplicate wins, matching get_local_asset_info.
        hero_files = {}
        userdata = get_steam_userdata()
        if userdata.exists():
            for user_dir in userdata.iterdir():
                if not user_dir.is_dir():
                    continue
                grid_dir = user_dir / 'config' / 'grid'
                if not grid_dir.exists():
                    continue
                for file in grid_dir.iterdir():
                    if not file.is_file() or file.suffix.lower() not in ['.png', '.jpg', '.jpeg', '.webp']:
                        continue
                    match = re.match(r'^(\d+)_hero$', file.stem)
                    if not match:
                        continue
                    appid = _safe_int(match.group(1))
                    previous = hero_files.get(appid)
                    if appid > 0 and (previous is None or file.stat().st_mtime > previous.stat().st_mtime):
                        hero_files[appid] = file

        candidates = []
        skipped = 0
        for appid, marker in marked.items():
            expected_sha = marker.get('sha256')
            hero_file = hero_files.get(appid)
            if not expected_sha or hero_file is None:
                skipped += 1
                continue
            try:
                if _sha256_file(hero_file) == expected_sha:
                    candidates.append(appid)
                else:
                    skipped += 1
            except Exception as e:
                decky.logger.debug(f'Failed to verify ZazaMastro hero for {appid}: {e}')
                skipped += 1

        return {
            'appids': sorted(candidates),
            'marked': len(marked),
            'skipped': skipped,
        }

    async def get_hidden_logo_fix_info(self, appid):
        """Return whether a custom logo exists and already has valid position metadata.

        Steam stores custom logo placement in userdata/<account>/config/grid/<appid>.json.
        Importers such as Steam ROM Manager may copy only <appid>_logo.png, leaving the
        JSON absent. Steam then keeps the logo hidden until the position is saved once.
        """
        userdata = get_steam_userdata()
        result = {
            'logo_exists': False,
            'position_exists': False,
            'position': None,
        }
        if not userdata.exists():
            return result

        for user_dir in userdata.iterdir():
            if not user_dir.is_dir():
                continue
            grid_dir = user_dir / 'config' / 'grid'
            if not _grid_file_candidates(grid_dir, appid, 'logo'):
                continue

            result['logo_exists'] = True
            position_file = grid_dir / f'{appid}.json'
            if not position_file.is_file():
                return result

            try:
                with open(position_file, 'r', encoding='utf-8', errors='ignore') as f:
                    data = json.load(f)
                position = data.get('logoPosition') if isinstance(data, dict) else None
                if (
                    isinstance(data, dict) and
                    data.get('nVersion') == 1 and
                    isinstance(position, dict) and
                    isinstance(position.get('pinnedPosition'), str) and
                    bool(position.get('pinnedPosition')) and
                    isinstance(position.get('nWidthPct'), (int, float)) and
                    isinstance(position.get('nHeightPct'), (int, float)) and
                    0 < float(position.get('nWidthPct')) <= 100 and
                    0 < float(position.get('nHeightPct')) <= 100
                ):
                    result['position_exists'] = True
                    result['position'] = {
                        'pinnedPosition': position.get('pinnedPosition'),
                        'nWidthPct': float(position.get('nWidthPct')),
                        'nHeightPct': float(position.get('nHeightPct')),
                    }
            except Exception as e:
                decky.logger.debug(f'Invalid custom logo position metadata for {appid}: {e}')

            return result

        return result

    async def local_asset_matches_url(self, appid, asset_type, url):
        userdata = get_steam_userdata()
        if not userdata.exists() or not url:
            return False

        local_file = None
        for user_dir in userdata.iterdir():
            grid_dir = user_dir / 'config' / 'grid'
            candidates = _grid_file_candidates(grid_dir, appid, asset_type)
            if candidates:
                local_file = candidates[0]
                break

        if not local_file:
            return False

        try:
            req = Request(url, headers={'User-Agent': 'Playhub-Artworks/1.0'})
            remote_digest = sha256()
            with urlopen(req, context=get_ssl_context(), timeout=15) as response:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    remote_digest.update(chunk)
            return _sha256_file(local_file) == remote_digest.hexdigest()
        except Exception as e:
            decky.logger.debug(f'Failed to compare local artwork for {appid}: {e}')
            return False

    async def _migration(self):
        decky.migrate_settings(str(Path(decky.DECKY_HOME) / "settings" / "steamgriddb_zazamastro.json"))
