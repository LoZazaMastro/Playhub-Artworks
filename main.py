import sys
import asyncio
from concurrent.futures import ThreadPoolExecutor
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
ARTWORK_DOWNLOAD_MAX_BYTES = 16 * 1024 * 1024
ARTWORK_IMAGE_MAX_PIXELS = 16_000_000
ARTWORK_IMAGE_MAX_DIMENSION = 6144
ARTWORK_DOWNLOAD_CONCURRENCY = 2
PROVIDER_SEARCH_CONCURRENCY = 3
DOWNLOAD_CHUNK_BYTES = 128 * 1024
PERFECT_SOURCE_READ_CHUNK_BYTES = 384 * 1024
PERFECT_SOURCE_LEGACY_RPC_MAX_BYTES = 1024 * 1024
DERIVED_COVER_READ_CHUNK_BYTES = 252 * 1024
DERIVED_COVER_METADATA_VERSION = 2
PLUGIN_USER_AGENT = 'Playhub-Artworks/1.1.2'
_diagnostic_lock = threading.Lock()
_download_progress_lock = threading.Lock()
_download_progress = {}
SETTINGS_FILE = Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / 'playhub_artworks.json'
PERFECT_SOURCE_DIR = Path(decky.DECKY_PLUGIN_RUNTIME_DIR) / 'perfect_sources'
DERIVED_COVER_BACKUP_DIR = Path(decky.DECKY_PLUGIN_RUNTIME_DIR) / 'derived_cover_backups'
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
    raise ValueError('PA_ERROR_ARTWORK_FORMAT_UNKNOWN')

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

def _jpeg_size_bytes(data):
    if len(data) < 4 or data[0:2] != b'\xff\xd8':
        return None
    offset = 2
    sof_markers = {
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
        0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
    }
    while offset + 4 <= len(data):
        while offset < len(data) and data[offset] != 0xff:
            offset += 1
        while offset < len(data) and data[offset] == 0xff:
            offset += 1
        if offset >= len(data):
            return None
        marker = data[offset]
        offset += 1
        if marker in {0x01, 0xd8, 0xd9} or 0xd0 <= marker <= 0xd7:
            continue
        if offset + 2 > len(data):
            return None
        segment_size = int.from_bytes(data[offset:offset + 2], 'big')
        if segment_size < 2 or offset + segment_size > len(data):
            return None
        if marker in sof_markers and segment_size >= 7:
            height = int.from_bytes(data[offset + 3:offset + 5], 'big')
            width = int.from_bytes(data[offset + 5:offset + 7], 'big')
            return width, height
        offset += segment_size
    return None

def _image_size_bytes(content, asset_format):
    if asset_format == 'png' and len(content) >= 24 and content[12:16] == b'IHDR':
        return unpack('>II', content[16:24])
    if asset_format == 'jpg':
        return _jpeg_size_bytes(content)
    if asset_format == 'webp' and len(content) >= 30:
        chunk = content[12:16]
        if chunk == b'VP8X':
            return 1 + int.from_bytes(content[24:27], 'little'), 1 + int.from_bytes(content[27:30], 'little')
        if chunk == b'VP8 ':
            return unpack('<H', content[26:28])[0] & 0x3fff, unpack('<H', content[28:30])[0] & 0x3fff
        if chunk == b'VP8L' and len(content) >= 25:
            b0, b1, b2, b3 = content[21], content[22], content[23], content[24]
            return 1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    if asset_format == 'gif' and len(content) >= 10:
        return int.from_bytes(content[6:8], 'little'), int.from_bytes(content[8:10], 'little')
    if asset_format == 'ico' and len(content) >= 8:
        return content[6] or 256, content[7] or 256
    return None

def _validate_artwork_content(content, content_type='', source=''):
    if not content:
        raise ValueError('PA_ERROR_INVALID_ARTWORK')
    if len(content) > ARTWORK_DOWNLOAD_MAX_BYTES:
        raise ValueError('PA_ERROR_ARTWORK_TOO_LARGE')
    asset_format = _asset_format(content, content_type, source)
    dimensions = _image_size_bytes(content, asset_format)
    if dimensions:
        width, height = dimensions
        if (
            width <= 0
            or height <= 0
            or width > ARTWORK_IMAGE_MAX_DIMENSION
            or height > ARTWORK_IMAGE_MAX_DIMENSION
            or width * height > ARTWORK_IMAGE_MAX_PIXELS
        ):
            raise ValueError('PA_ERROR_ARTWORK_TOO_LARGE')
    return asset_format, dimensions

def _decoded_base64_size(value):
    normalized = str(value or '').strip()
    if not normalized:
        return 0
    padding = 2 if normalized.endswith('==') else 1 if normalized.endswith('=') else 0
    return max(0, (len(normalized) * 3) // 4 - padding)

def _response_length(response):
    try:
        return max(0, int(response.headers.get('Content-Length') or 0))
    except (TypeError, ValueError, AttributeError):
        return 0

def _download_limited(url, job_id='', shutdown_event=None, validate_artwork=True):
    req = Request(url, headers={'User-Agent': PLUGIN_USER_AGENT})
    received = 0
    content = bytearray()
    with urlopen(req, context=get_ssl_context(), timeout=20) as response:
        total = _response_length(response)
        content_type = response.headers.get('Content-Type') or ''
        if total > ARTWORK_DOWNLOAD_MAX_BYTES:
            raise ValueError('PA_ERROR_ARTWORK_TOO_LARGE')
        if job_id:
            with _download_progress_lock:
                _download_progress[str(job_id)] = {'received': 0, 'total': total, 'percent': 0, 'status': 'running'}
        while True:
            if shutdown_event is not None and shutdown_event.is_set():
                raise RuntimeError('PA_OPERATION_CANCELLED')
            chunk = response.read(DOWNLOAD_CHUNK_BYTES)
            if not chunk:
                break
            received += len(chunk)
            if received > ARTWORK_DOWNLOAD_MAX_BYTES:
                raise ValueError('PA_ERROR_ARTWORK_TOO_LARGE')
            content.extend(chunk)
            if job_id:
                percent = min(99, round(received * 100 / total)) if total > 0 else 0
                with _download_progress_lock:
                    _download_progress[str(job_id)] = {'received': received, 'total': total, 'percent': percent, 'status': 'running'}
    if job_id:
        with _download_progress_lock:
            _download_progress[str(job_id)] = {'received': received, 'total': total, 'percent': 100, 'status': 'complete'}
    if validate_artwork:
        asset_format, dimensions = _validate_artwork_content(content, content_type, url)
    else:
        asset_format, dimensions = '', None
    return content, content_type, asset_format, dimensions

def _remote_sha256_limited(url, shutdown_event=None):
    req = Request(url, headers={'User-Agent': PLUGIN_USER_AGENT})
    digest = sha256()
    received = 0
    with urlopen(req, context=get_ssl_context(), timeout=15) as response:
        total = _response_length(response)
        if total > ARTWORK_DOWNLOAD_MAX_BYTES:
            raise ValueError('PA_ERROR_ARTWORK_TOO_LARGE')
        while True:
            if shutdown_event is not None and shutdown_event.is_set():
                raise RuntimeError('PA_OPERATION_CANCELLED')
            chunk = response.read(DOWNLOAD_CHUNK_BYTES)
            if not chunk:
                break
            received += len(chunk)
            if received > ARTWORK_DOWNLOAD_MAX_BYTES:
                raise ValueError('PA_ERROR_ARTWORK_TOO_LARGE')
            digest.update(chunk)
    return digest.hexdigest()

def _read_json_object(path):
    with open(path, 'r', encoding='utf-8') as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError('PA_ERROR_GENERIC')
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

def _atomic_write_bytes(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f'.{path.name}.{os.getpid()}.{threading.get_ident()}.tmp')
    try:
        with open(temporary, 'wb') as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            if temporary.exists():
                temporary.unlink()
        except Exception:
            pass

def _atomic_write_json(path, value):
    payload = json.dumps(value, ensure_ascii=False, indent=2).encode('utf-8')
    _atomic_write_bytes(path, payload)

def _normalized_numeric_id(value, error='PA_ERROR_GENERIC'):
    text = str(value or '').strip()
    if not text.isdigit() or int(text) <= 0:
        raise ValueError(error)
    return text

def _derived_cover_directory(steam_user, appid):
    user = _normalized_numeric_id(steam_user)
    app = _normalized_numeric_id(appid)
    return DERIVED_COVER_BACKUP_DIR / user / app

def _derived_cover_metadata_path(steam_user, appid):
    return _derived_cover_directory(steam_user, appid) / 'metadata.json'

def _derived_cover_custom_candidates(steam_user, appid):
    user = _normalized_numeric_id(steam_user)
    grid_dir = get_steam_userdata() / user / 'config' / 'grid'
    return _grid_file_candidates(grid_dir, appid, 'grid_p')

def _valid_custom_cover(steam_user, appid):
    for candidate in _derived_cover_custom_candidates(steam_user, appid):
        try:
            size = candidate.stat().st_size
            if size <= 0 or size > ARTWORK_DOWNLOAD_MAX_BYTES:
                continue
            payload = candidate.read_bytes()
            asset_format, dimensions = _validate_artwork_content(payload, source=candidate)
            return {
                'path': candidate,
                'payload': payload,
                'format': asset_format,
                'dimensions': dimensions,
                'size': len(payload),
                'sha256': sha256(payload).hexdigest(),
            }
        except Exception as error:
            _diagnostic('derived_cover.custom.invalid', appid=appid, steam_user=steam_user, path=candidate, error=error)
    return None

def _validated_derived_cover_backup(steam_user, appid):
    metadata_path = _derived_cover_metadata_path(steam_user, appid)
    if not metadata_path.is_file():
        return None, None
    metadata = _read_json_object(metadata_path)
    user = _normalized_numeric_id(steam_user)
    app = int(_normalized_numeric_id(appid))
    version = metadata.get('version')
    if version not in {1, DERIVED_COVER_METADATA_VERSION} or metadata.get('steam_user') != user or metadata.get('appid') != app:
        raise ValueError('PA_ERROR_COVER_BACKUP_FAILED')
    state = str(metadata.get('state') or '')
    if state not in {'preserved', 'pending', 'derived', 'restoring'}:
        raise ValueError('PA_ERROR_COVER_BACKUP_FAILED')
    derived_sha256 = metadata.get('derived_sha256')
    if derived_sha256 is not None and not re.fullmatch(r'[0-9a-f]{64}', str(derived_sha256)):
        raise ValueError('PA_ERROR_COVER_BACKUP_FAILED')
    restore_sha256 = metadata.get('restore_sha256')
    if restore_sha256 is not None and not re.fullmatch(r'[0-9a-f]{64}', str(restore_sha256)):
        raise ValueError('PA_ERROR_COVER_BACKUP_FAILED')
    if state in {'pending', 'derived', 'restoring'} and not derived_sha256:
        raise ValueError('PA_ERROR_COVER_BACKUP_FAILED')
    if not isinstance(metadata.get('had_custom'), bool):
        raise ValueError('PA_ERROR_COVER_BACKUP_FAILED')
    if not metadata['had_custom']:
        return metadata, None

    original = metadata.get('original')
    if not isinstance(original, dict):
        raise ValueError('PA_ERROR_COVER_BACKUP_FAILED')
    asset_format = str(original.get('format') or '').lower()
    digest = str(original.get('sha256') or '')
    if not re.fullmatch(r'[0-9a-f]{64}', digest):
        raise ValueError('PA_ERROR_COVER_BACKUP_FAILED')
    expected_name = (
        f'original.{asset_format}'
        if version == 1
        else f'original-{digest}.{asset_format}'
    )
    if original.get('filename') != expected_name or asset_format not in {'png', 'jpg', 'webp'}:
        raise ValueError('PA_ERROR_COVER_BACKUP_FAILED')
    original_path = metadata_path.parent / expected_name
    size = original_path.stat().st_size
    if size <= 0 or size > ARTWORK_DOWNLOAD_MAX_BYTES or size != int(original.get('size') or 0):
        raise ValueError('PA_ERROR_COVER_BACKUP_FAILED')
    payload = original_path.read_bytes()
    validated_format, _dimensions = _validate_artwork_content(payload, source=original_path)
    actual_digest = sha256(payload).hexdigest()
    if validated_format != asset_format or actual_digest != digest:
        raise ValueError('PA_ERROR_COVER_BACKUP_FAILED')
    return metadata, original_path

def _write_derived_cover_baseline(steam_user, appid, custom):
    """Commit a new baseline by switching metadata only after its payload is durable."""
    directory = _derived_cover_directory(steam_user, appid)
    metadata_path = directory / 'metadata.json'
    original_path = None
    metadata = {
        'version': DERIVED_COVER_METADATA_VERSION,
        'steam_user': _normalized_numeric_id(steam_user),
        'appid': int(_normalized_numeric_id(appid)),
        'had_custom': custom is not None,
        'original': None,
        'state': 'preserved',
        'derived_sha256': None,
        'restore_sha256': None,
        'created_at': datetime.now(timezone.utc).isoformat(),
    }
    if custom is not None:
        original_name = f"original-{custom['sha256']}.{custom['format']}"
        original_path = directory / original_name
        _atomic_write_bytes(original_path, custom['payload'])
        metadata['original'] = {
            'filename': original_name,
            'format': custom['format'],
            'mime': 'image/png' if custom['format'] == 'png' else 'image/webp' if custom['format'] == 'webp' else 'image/jpeg',
            'size': custom['size'],
            'sha256': custom['sha256'],
        }

    _atomic_write_json(metadata_path, metadata)
    _validated_derived_cover_backup(steam_user, appid)

    # Metadata now points at the new durable payload. Old generations are safe to remove.
    for child in list(directory.iterdir()):
        if not child.is_file() or child == metadata_path or child == original_path:
            continue
        if child.name in {'original.png', 'original.jpg', 'original.webp'} or re.fullmatch(
            r'original-[0-9a-f]{64}\.(?:png|jpg|webp)', child.name
        ):
            try:
                child.unlink()
            except OSError as error:
                _diagnostic('derived_cover.backup.cleanup_failed', path=child, error=error)
    return metadata

def _remove_derived_cover_backup(steam_user, appid):
    directory = _derived_cover_directory(steam_user, appid)
    if not directory.exists():
        return True
    legacy = {'metadata.json', 'original.png', 'original.jpg', 'original.webp'}
    for child in list(directory.iterdir()):
        owned_generation = bool(re.fullmatch(r'original-[0-9a-f]{64}\.(?:png|jpg|webp)', child.name))
        if not child.is_file() or (child.name not in legacy and not owned_generation and not child.name.endswith('.tmp')):
            return False
    for child in list(directory.iterdir()):
        child.unlink()
    directory.rmdir()
    user_dir = directory.parent
    try:
        user_dir.rmdir()
    except OSError:
        pass
    return True

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
        self._shutdown_event = threading.Event()
        self._derived_cover_lock = threading.Lock()
        self._download_semaphore = asyncio.Semaphore(ARTWORK_DOWNLOAD_CONCURRENCY)
        self._download_executor = ThreadPoolExecutor(max_workers=ARTWORK_DOWNLOAD_CONCURRENCY, thread_name_prefix='artwork-download')
        self._provider_executor = ThreadPoolExecutor(max_workers=PROVIDER_SEARCH_CONCURRENCY, thread_name_prefix='artwork-provider')
        _diagnostic('backend.started', platform=system(), plugin_dir=decky.DECKY_PLUGIN_DIR, settings_dir=decky.DECKY_PLUGIN_SETTINGS_DIR, log_dir=DIAGNOSTIC_DIR)

    async def _unload(self):
        self._shutdown_event.set()
        self._download_executor.shutdown(wait=False, cancel_futures=True)
        self._provider_executor.shutdown(wait=False, cancel_futures=True)
        _diagnostic('backend.stopped')

    async def write_diagnostic_events(self, events=None):
        for event in (events or [])[:100]:
            if isinstance(event, dict):
                _diagnostic('frontend.event', payload=event)
        return True

    async def download_as_base64(self, url='', job_id=''):
        started = asyncio.get_running_loop().time()
        try:
            loop = asyncio.get_running_loop()
            async with self._download_semaphore:
                content, _content_type, _asset_format_name, _dimensions = await loop.run_in_executor(
                    self._download_executor,
                    lambda: _download_limited(url, job_id, self._shutdown_event),
                )
                encoded = await loop.run_in_executor(
                    self._download_executor,
                    lambda: b64encode(content).decode('ascii'),
                )
            _diagnostic('download.completed', url=url, bytes=len(content), duration_ms=round((asyncio.get_running_loop().time() - started) * 1000))
            return encoded
        except Exception as error:
            if job_id:
                with _download_progress_lock:
                    current = _download_progress.get(str(job_id), {})
                    _download_progress[str(job_id)] = {**current, 'status': 'error'}
            _diagnostic('download.failed', url=url, duration_ms=round((asyncio.get_running_loop().time() - started) * 1000), error=error)
            raise

    async def download_artwork_payload(self, url='', job_id=''):
        started = asyncio.get_running_loop().time()
        try:
            loop = asyncio.get_running_loop()
            async with self._download_semaphore:
                content, _content_type, asset_format, dimensions = await loop.run_in_executor(
                    self._download_executor,
                    lambda: _download_limited(url, job_id, self._shutdown_event),
                )
                encoded = await loop.run_in_executor(
                    self._download_executor,
                    lambda: b64encode(content).decode('ascii'),
                )
            _diagnostic('artwork.download.completed', url=url, bytes=len(content), format=asset_format, dimensions=dimensions, duration_ms=round((asyncio.get_running_loop().time() - started) * 1000))
            return {'data': encoded, 'format': asset_format, 'animated': _asset_is_animated(content, asset_format)}
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
        started = asyncio.get_running_loop().time()
        try:
            loop = asyncio.get_running_loop()
            async with self._download_semaphore:
                content, _content_type, asset_format, dimensions = await loop.run_in_executor(
                    self._download_executor,
                    lambda: _download_limited(url, '', self._shutdown_event),
                )
                digest = sha256(content).hexdigest()
                encoded = await loop.run_in_executor(
                    self._download_executor,
                    lambda: b64encode(content).decode('ascii'),
                )
            _diagnostic('artwork.download.completed', url=url, bytes=len(content), sha256=digest, format=asset_format, dimensions=dimensions, duration_ms=round((asyncio.get_running_loop().time() - started) * 1000))
            return {'data': encoded, 'sha256': digest, 'format': asset_format, 'animated': _asset_is_animated(content, asset_format)}
        except Exception as error:
            _diagnostic('artwork.download.failed', url=url, duration_ms=round((asyncio.get_running_loop().time() - started) * 1000), error=error)
            raise

    async def read_file_as_base64(self, path=''):
        def read_sync():
            source = Path(path)
            if source.stat().st_size > ARTWORK_DOWNLOAD_MAX_BYTES:
                raise ValueError('PA_ERROR_ARTWORK_TOO_LARGE')
            content = source.read_bytes()
            _validate_artwork_content(content, source=path)
            return b64encode(content).decode('ascii')
        return await asyncio.get_running_loop().run_in_executor(self._download_executor, read_sync)

    async def read_artwork_payload(self, path=''):
        def read_sync():
            source = Path(path)
            if source.stat().st_size > ARTWORK_DOWNLOAD_MAX_BYTES:
                raise ValueError('PA_ERROR_ARTWORK_TOO_LARGE')
            content = source.read_bytes()
            asset_format, dimensions = _validate_artwork_content(content, source=path)
            return {
                'data': b64encode(content).decode('ascii'),
                'format': asset_format,
                'animated': _asset_is_animated(content, asset_format),
                'dimensions': dimensions,
            }
        return await asyncio.get_running_loop().run_in_executor(self._download_executor, read_sync)

    async def get_local_start(self):
        return decky.DECKY_USER_HOME

    async def download_file(self, url='', output_dir='', file_name=''):
        _diagnostic('file.download.started', url=url, output_dir=output_dir, file_name=file_name)
        try:
            if access(dirname(output_dir), W_OK):
                loop = asyncio.get_running_loop()
                async with self._download_semaphore:
                    content, _content_type, _format, _dimensions = await loop.run_in_executor(
                        self._download_executor,
                        lambda: _download_limited(url, '', self._shutdown_event),
                    )
                    saved_path = str(Path(output_dir) / file_name)
                    await loop.run_in_executor(self._download_executor, lambda: Path(saved_path).write_bytes(content))
                _diagnostic('file.download.completed', url=url, path=saved_path, bytes=len(content))
                return saved_path
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
            raise Exception('PA_ERROR_RETRIEVE_ASSET')

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
        raise Exception('PA_CANT_OPEN_GAME')

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
        target = str(target)
        if target not in {'hero', 'grid_l'}:
            raise ValueError('PA_ERROR_INVALID_ARTWORK')
        normalized_ext = str(ext).lower().lstrip('.')
        if normalized_ext == 'jpeg':
            normalized_ext = 'jpg'
        if normalized_ext not in {'png', 'jpg', 'webp'}:
            raise ValueError('PA_ERROR_ARTWORK_FORMAT_UNKNOWN')
        return PERFECT_SOURCE_DIR / f'{int(appid)}_{target}.{normalized_ext}'

    def _find_perfect_source(self, appid, target):
        for ext in ('png', 'jpg', 'jpeg', 'webp'):
            candidate = self._perfect_source_path(appid, target, ext)
            if candidate.exists():
                return candidate
        return None

    def _write_perfect_source(self, appid, target, payload, asset_format):
        _validate_artwork_content(payload, source=f'perfect-source.{asset_format}')
        PERFECT_SOURCE_DIR.mkdir(parents=True, exist_ok=True)
        path = self._perfect_source_path(appid, target, asset_format)
        temporary = path.with_suffix(path.suffix + '.tmp')
        temporary.write_bytes(payload)
        temporary.replace(path)
        return path

    async def preserve_perfect_source(self, appid=0, target='hero', candidates=None, allow_custom=True):
        """Keep the untouched source without carrying image bytes through Decky's RPC bridge."""
        started = asyncio.get_running_loop().time()

        def preserve_sync():
            existing = self._find_perfect_source(appid, target)
            if existing:
                return {'saved': True, 'existing': True, 'source': 'preserved'}

            local_candidates = []
            if allow_custom:
                userdata = get_steam_userdata()
                if userdata.exists():
                    for user_dir in userdata.iterdir():
                        local_candidates.extend(_grid_file_candidates(user_dir / 'config' / 'grid', appid, target))
            local_candidates.extend(_librarycache_file_candidates(appid, target))

            for source in local_candidates:
                try:
                    if source.stat().st_size > ARTWORK_DOWNLOAD_MAX_BYTES:
                        continue
                    payload = source.read_bytes()
                    asset_format, _dimensions = _validate_artwork_content(payload, source=source)
                    self._write_perfect_source(appid, target, payload, asset_format)
                    return {'saved': True, 'existing': False, 'source': 'local', 'bytes': len(payload)}
                except Exception as error:
                    _diagnostic('perfect.source.local_failed', appid=appid, target=target, path=source, error=error)

            for url in list(candidates or [])[:8]:
                try:
                    parsed = urlparse(str(url or ''))
                    if parsed.scheme not in {'http', 'https'}:
                        continue
                    payload, _content_type, asset_format, _dimensions = _download_limited(
                        str(url), '', self._shutdown_event
                    )
                    self._write_perfect_source(appid, target, payload, asset_format)
                    return {'saved': True, 'existing': False, 'source': 'remote', 'bytes': len(payload)}
                except Exception as error:
                    _diagnostic('perfect.source.remote_failed', appid=appid, target=target, url=url, error=error)

            return {'saved': False, 'existing': False, 'source': 'unavailable'}

        try:
            result = await asyncio.get_running_loop().run_in_executor(self._download_executor, preserve_sync)
            _diagnostic(
                'perfect.source.preserved',
                appid=appid,
                target=target,
                result=result,
                duration_ms=round((asyncio.get_running_loop().time() - started) * 1000),
            )
            return result
        except Exception as error:
            _diagnostic(
                'perfect.source.preserve_failed',
                appid=appid,
                target=target,
                duration_ms=round((asyncio.get_running_loop().time() - started) * 1000),
                error=error,
            )
            return {'saved': False, 'existing': False, 'source': 'error'}

    async def save_perfect_source(self, appid=0, target='hero', data='', ext='jpg'):
        def save_sync():
            try:
                PERFECT_SOURCE_DIR.mkdir(parents=True, exist_ok=True)
                existing = self._find_perfect_source(appid, target)
                if existing:
                    return {'saved': True, 'existing': True}
                decoded_size = _decoded_base64_size(data)
                if decoded_size > PERFECT_SOURCE_LEGACY_RPC_MAX_BYTES:
                    raise ValueError('PA_ERROR_ARTWORK_TOO_LARGE')
                payload = b64decode(str(data or ''), validate=True)
                if not payload:
                    return {'saved': False}
                self._write_perfect_source(appid, target, payload, ext)
                _diagnostic('perfect.source.saved', appid=appid, target=target, bytes=len(payload))
                return {'saved': True, 'existing': False}
            except Exception as error:
                _diagnostic('perfect.source.save_failed', appid=appid, target=target, error=error)
                return {'saved': False}

        return await asyncio.get_running_loop().run_in_executor(self._download_executor, save_sync)

    async def get_perfect_source_info(self, appid=0, target='hero'):
        def read_info():
            try:
                path = self._find_perfect_source(appid, target)
                if not path:
                    return {'exists': False}
                size = path.stat().st_size
                if size <= 0 or size > ARTWORK_DOWNLOAD_MAX_BYTES:
                    raise ValueError('PA_ERROR_ARTWORK_TOO_LARGE')
                with open(path, 'rb') as stream:
                    header = stream.read(min(size, 128 * 1024))
                asset_format = _asset_format(header, source=path)
                mime = 'image/png' if asset_format == 'png' else 'image/webp' if asset_format == 'webp' else 'image/jpeg'
                return {
                    'exists': True,
                    'size': size,
                    'mime': mime,
                    'chunk_size': PERFECT_SOURCE_READ_CHUNK_BYTES,
                }
            except Exception as error:
                _diagnostic('perfect.source.info_failed', appid=appid, target=target, error=error)
                return {'exists': False}

        return await asyncio.get_running_loop().run_in_executor(self._download_executor, read_info)

    async def read_perfect_source_chunk(self, appid=0, target='hero', offset=0):
        def read_chunk():
            path = self._find_perfect_source(appid, target)
            if not path:
                return ''
            size = path.stat().st_size
            position = max(0, int(offset or 0))
            if size <= 0 or size > ARTWORK_DOWNLOAD_MAX_BYTES or position >= size:
                return ''
            with open(path, 'rb') as stream:
                stream.seek(position)
                payload = stream.read(PERFECT_SOURCE_READ_CHUNK_BYTES)
            return b64encode(payload).decode('ascii')

        return await asyncio.get_running_loop().run_in_executor(self._download_executor, read_chunk)

    async def get_perfect_source(self, appid=0, target='hero'):
        def read_sync():
            try:
                path = self._find_perfect_source(appid, target)
                if not path:
                    return ''
                if path.stat().st_size > ARTWORK_DOWNLOAD_MAX_BYTES:
                    raise ValueError('PA_ERROR_ARTWORK_TOO_LARGE')
                payload = path.read_bytes()
                _validate_artwork_content(payload, source=path)
                mime = 'image/png' if path.suffix.lower() == '.png' else 'image/webp' if path.suffix.lower() == '.webp' else 'image/jpeg'
                return f'data:{mime};base64,' + b64encode(payload).decode('ascii')
            except Exception as error:
                _diagnostic('perfect.source.read_failed', appid=appid, target=target, error=error)
                return ''

        return await asyncio.get_running_loop().run_in_executor(self._download_executor, read_sync)

    async def clear_perfect_source(self, appid=0, target='hero'):
        def clear_sync():
            try:
                path = self._find_perfect_source(appid, target)
                if path:
                    path.unlink()
                    _diagnostic('perfect.source.cleared', appid=appid, target=target)
                return True
            except Exception as error:
                _diagnostic('perfect.source.clear_failed', appid=appid, target=target, error=error)
                return False

        return await asyncio.get_running_loop().run_in_executor(self._download_executor, clear_sync)

    # --- Covers derived from a banner or hero ---------------------------

    async def preserve_derived_cover_backup(self, steam_user='', appid=0):
        """Preserve the current cover unless a verified derived generation is still active."""
        def preserve_sync():
            with self._derived_cover_lock:
                metadata_path = _derived_cover_metadata_path(steam_user, appid)
                if metadata_path.exists():
                    metadata, _original_path = _validated_derived_cover_backup(steam_user, appid)
                    state = str(metadata.get('state') or '')
                    if state in {'pending', 'restoring'}:
                        # An interrupted transaction owns this baseline until recovery.
                        return {
                            'saved': False,
                            'existing': True,
                            'recoverable': True,
                            'reason': state,
                            'had_custom': bool(metadata.get('had_custom')),
                        }

                    current = _valid_custom_cover(steam_user, appid)
                    expected = str(metadata.get('derived_sha256') or '')
                    if state == 'derived' and current is not None and current.get('sha256') == expected:
                        return {
                            'saved': True,
                            'existing': True,
                            'reused': True,
                            'had_custom': bool(metadata.get('had_custom')),
                        }

                    candidates = _derived_cover_custom_candidates(steam_user, appid)
                    if candidates and current is None:
                        return {'saved': False, 'existing': True, 'reason': 'invalid-custom-cover'}

                    # The user changed or removed the cover after the last completed
                    # transaction. Atomically repoint metadata at this new baseline.
                    metadata = _write_derived_cover_baseline(steam_user, appid, current)
                    _diagnostic(
                        'derived_cover.backup.rebased',
                        steam_user=steam_user,
                        appid=appid,
                        had_custom=current is not None,
                        sha256=current.get('sha256') if current else None,
                    )
                    return {
                        'saved': True,
                        'existing': False,
                        'replaced': True,
                        'had_custom': bool(metadata.get('had_custom')),
                    }

                directory = metadata_path.parent
                if directory.exists() and any(directory.iterdir()):
                    # An incomplete or unknown backup is never overwritten on a guess.
                    return {'saved': False, 'existing': True, 'reason': 'incomplete'}

                candidates = _derived_cover_custom_candidates(steam_user, appid)
                custom = _valid_custom_cover(steam_user, appid)
                if candidates and custom is None:
                    return {'saved': False, 'existing': False, 'reason': 'invalid-custom-cover'}

                try:
                    _write_derived_cover_baseline(steam_user, appid, custom)
                except Exception:
                    try:
                        _remove_derived_cover_backup(steam_user, appid)
                    except Exception:
                        pass
                    raise

                _diagnostic(
                    'derived_cover.backup.preserved',
                    steam_user=steam_user,
                    appid=appid,
                    had_custom=custom is not None,
                    sha256=custom.get('sha256') if custom else None,
                )
                return {'saved': True, 'existing': False, 'had_custom': custom is not None}

        try:
            return await asyncio.get_running_loop().run_in_executor(self._download_executor, preserve_sync)
        except Exception as error:
            _diagnostic('derived_cover.backup.failed', steam_user=steam_user, appid=appid, error=error)
            return {'saved': False, 'existing': False, 'reason': 'error'}

    async def begin_derived_cover_apply(self, steam_user='', appid=0, derived_sha256=''):
        def begin_sync():
            digest = str(derived_sha256 or '').strip().lower()
            if not re.fullmatch(r'[0-9a-f]{64}', digest):
                return False
            with self._derived_cover_lock:
                metadata, _original_path = _validated_derived_cover_backup(steam_user, appid)
                if metadata is None:
                    return False
                state = str(metadata.get('state') or '')
                if state not in {'preserved', 'derived'}:
                    return False
                if state == 'derived':
                    current = _valid_custom_cover(steam_user, appid)
                    expected = str(metadata.get('derived_sha256') or '')
                    if current is None or current.get('sha256') != expected:
                        return False
                updated = dict(metadata)
                updated['state'] = 'pending'
                updated['derived_sha256'] = digest
                updated['restore_sha256'] = None
                _atomic_write_json(_derived_cover_metadata_path(steam_user, appid), updated)
                return True

        try:
            return await asyncio.get_running_loop().run_in_executor(self._download_executor, begin_sync)
        except Exception as error:
            _diagnostic('derived_cover.begin.failed', steam_user=steam_user, appid=appid, error=error)
            return False

    async def finalize_derived_cover_apply(self, steam_user='', appid=0, derived_sha256=''):
        def finalize_sync():
            digest = str(derived_sha256 or '').strip().lower()
            with self._derived_cover_lock:
                metadata, _original_path = _validated_derived_cover_backup(steam_user, appid)
                if metadata is None or metadata.get('state') != 'pending' or metadata.get('derived_sha256') != digest:
                    return False
                current = _valid_custom_cover(steam_user, appid)
                if current is None or current.get('sha256') != digest:
                    return False
                updated = dict(metadata)
                updated['state'] = 'derived'
                updated['restore_sha256'] = None
                updated['applied_at'] = datetime.now(timezone.utc).isoformat()
                _atomic_write_json(_derived_cover_metadata_path(steam_user, appid), updated)
                _diagnostic('derived_cover.applied', steam_user=steam_user, appid=appid, sha256=digest)
                return True

        try:
            return await asyncio.get_running_loop().run_in_executor(self._download_executor, finalize_sync)
        except Exception as error:
            _diagnostic('derived_cover.finalize.failed', steam_user=steam_user, appid=appid, error=error)
            return False

    async def cancel_derived_cover_apply(self, steam_user='', appid=0, derived_sha256=''):
        def cancel_sync():
            with self._derived_cover_lock:
                metadata, _original_path = _validated_derived_cover_backup(steam_user, appid)
                if (
                    metadata is None
                    or metadata.get('state') != 'pending'
                    or metadata.get('derived_sha256') != str(derived_sha256 or '').strip().lower()
                ):
                    return False
                updated = dict(metadata)
                updated['state'] = 'preserved'
                updated['derived_sha256'] = None
                updated['restore_sha256'] = None
                _atomic_write_json(_derived_cover_metadata_path(steam_user, appid), updated)
                return True

        try:
            return await asyncio.get_running_loop().run_in_executor(self._download_executor, cancel_sync)
        except Exception:
            return False

    async def get_derived_cover_backup_info(self, steam_user='', appid=0):
        def read_info():
            with self._derived_cover_lock:
                metadata, original_path = _validated_derived_cover_backup(steam_user, appid)
                if metadata is None:
                    return {'exists': False, 'is_derived': False}
                current = _valid_custom_cover(steam_user, appid)
                expected = str(metadata.get('derived_sha256') or '')
                state = str(metadata.get('state') or '')
                interrupted = state in {'pending', 'restoring'}
                source_is_derived = bool(expected and current and current.get('sha256') == expected)
                recoverable = bool(interrupted or (state == 'derived' and source_is_derived))
                original = metadata.get('original') or {}
                return {
                    'exists': True,
                    'is_derived': recoverable,
                    'recoverable': recoverable,
                    'state': state,
                    'had_custom': bool(metadata.get('had_custom')),
                    'size': int(original.get('size') or 0) if original_path else 0,
                    'mime': str(original.get('mime') or '') if original_path else '',
                    'format': str(original.get('format') or '') if original_path else '',
                    'sha256': str(original.get('sha256') or '') if original_path else '',
                    'chunk_size': DERIVED_COVER_READ_CHUNK_BYTES,
                }

        try:
            return await asyncio.get_running_loop().run_in_executor(self._download_executor, read_info)
        except Exception as error:
            _diagnostic('derived_cover.info.failed', steam_user=steam_user, appid=appid, error=error)
            return {'exists': False, 'is_derived': False}

    async def begin_derived_cover_restore(self, steam_user='', appid=0, allow_pending=False):
        def begin_restore_sync():
            with self._derived_cover_lock:
                metadata, _original_path = _validated_derived_cover_backup(steam_user, appid)
                if metadata is None or not metadata.get('derived_sha256'):
                    return False
                current = _valid_custom_cover(steam_user, appid)
                expected = str(metadata.get('derived_sha256') or '')
                state = str(metadata.get('state') or '')
                interrupted = state in {'pending', 'restoring'}
                if interrupted and not allow_pending:
                    return False
                if not interrupted and (state != 'derived' or current is None or current.get('sha256') != expected):
                    return False
                updated = dict(metadata)
                updated['state'] = 'restoring'
                updated['restore_sha256'] = None
                _atomic_write_json(_derived_cover_metadata_path(steam_user, appid), updated)
                return True

        try:
            return await asyncio.get_running_loop().run_in_executor(self._download_executor, begin_restore_sync)
        except Exception as error:
            _diagnostic('derived_cover.restore.begin_failed', steam_user=steam_user, appid=appid, error=error)
            return False

    async def read_derived_cover_backup_chunk(self, steam_user='', appid=0, offset=0):
        def read_chunk():
            with self._derived_cover_lock:
                metadata, original_path = _validated_derived_cover_backup(steam_user, appid)
                if metadata is None or original_path is None:
                    return ''
                current = _valid_custom_cover(steam_user, appid)
                expected = str(metadata.get('derived_sha256') or '')
                source_is_derived = bool(expected and current and current.get('sha256') == expected)
                if not expected or (metadata.get('state') != 'restoring' and not source_is_derived):
                    return ''
                size = original_path.stat().st_size
                position = max(0, int(offset or 0))
                if position >= size:
                    return ''
                with open(original_path, 'rb') as stream:
                    stream.seek(position)
                    payload = stream.read(DERIVED_COVER_READ_CHUNK_BYTES)
                return b64encode(payload).decode('ascii')

        try:
            return await asyncio.get_running_loop().run_in_executor(self._download_executor, read_chunk)
        except Exception as error:
            _diagnostic('derived_cover.chunk.failed', steam_user=steam_user, appid=appid, error=error)
            return ''

    async def prepare_derived_cover_restore(self, steam_user='', appid=0, restored_sha256=''):
        def prepare_sync():
            with self._derived_cover_lock:
                metadata, _original_path = _validated_derived_cover_backup(steam_user, appid)
                if metadata is None or metadata.get('state') != 'restoring':
                    return False
                digest = str(restored_sha256 or '').strip().lower()
                if metadata.get('had_custom'):
                    if not re.fullmatch(r'[0-9a-f]{64}', digest):
                        return False
                elif digest:
                    return False
                updated = dict(metadata)
                updated['restore_sha256'] = digest or None
                _atomic_write_json(_derived_cover_metadata_path(steam_user, appid), updated)
                return True

        try:
            return await asyncio.get_running_loop().run_in_executor(self._download_executor, prepare_sync)
        except Exception as error:
            _diagnostic('derived_cover.restore.prepare_failed', steam_user=steam_user, appid=appid, error=error)
            return False

    async def complete_derived_cover_restore(self, steam_user='', appid=0):
        def complete_sync():
            with self._derived_cover_lock:
                metadata, _original_path = _validated_derived_cover_backup(steam_user, appid)
                if metadata is None or not metadata.get('derived_sha256') or metadata.get('state') != 'restoring':
                    return False
                current = _valid_custom_cover(steam_user, appid)
                if metadata.get('had_custom'):
                    restored_sha256 = str(metadata.get('restore_sha256') or '')
                    restored = bool(restored_sha256 and current and current.get('sha256') == restored_sha256)
                else:
                    restored = metadata.get('restore_sha256') is None and len(_derived_cover_custom_candidates(steam_user, appid)) == 0
                if not restored:
                    return False
                removed = _remove_derived_cover_backup(steam_user, appid)
                if removed:
                    _diagnostic('derived_cover.restored', steam_user=steam_user, appid=appid)
                return removed

        try:
            return await asyncio.get_running_loop().run_in_executor(self._download_executor, complete_sync)
        except Exception as error:
            _diagnostic('derived_cover.restore.failed', steam_user=steam_user, appid=appid, error=error)
            return False

    async def clear_derived_cover_backup(self, steam_user='', appid=0):
        def clear_sync():
            with self._derived_cover_lock:
                return _remove_derived_cover_backup(steam_user, appid)

        try:
            return await asyncio.get_running_loop().run_in_executor(self._download_executor, clear_sync)
        except Exception as error:
            _diagnostic('derived_cover.clear.failed', steam_user=steam_user, appid=appid, error=error)
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
                self._provider_executor,
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
                asyncio.get_running_loop().run_in_executor(
                    self._provider_executor,
                    lambda: search_provider_assets_sync(
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
                asyncio.get_running_loop().run_in_executor(
                    self._provider_executor,
                    lambda: inspect_remote_artwork_sync(
                        url,
                        asset_type,
                        aspect_mode,
                        minimum_quality,
                        mimes or [],
                    ),
                ),
                timeout=22,
            )
            _diagnostic('artwork.inspect.completed', url=url, asset_type=asset_type, aspect_mode=aspect_mode, minimum_quality=minimum_quality, result=result, duration_ms=round((asyncio.get_running_loop().time() - started) * 1000))
            return result
        except asyncio.TimeoutError as error:
            _diagnostic('artwork.inspect.timeout', url=url, asset_type=asset_type, duration_ms=round((asyncio.get_running_loop().time() - started) * 1000))
            raise ValueError('PA_ERROR_IMAGE_CHECK_TIMEOUT') from error
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
            remote_digest = await asyncio.get_running_loop().run_in_executor(
                self._download_executor,
                lambda: _remote_sha256_limited(url, self._shutdown_event),
            )
            return _sha256_file(local_file) == remote_digest
        except Exception as e:
            decky.logger.debug(f'Failed to compare local artwork for {appid}: {e}')
            return False

    async def _migration(self):
        decky.migrate_settings(str(Path(decky.DECKY_HOME) / "settings" / "steamgriddb_zazamastro.json"))
