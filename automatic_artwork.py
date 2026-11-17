"""Read-only missing-art proof and private icon staging. Never writes Steam/VDF."""
import hashlib
import os
import re
import stat
from pathlib import Path

ASSETS = ('grid_p', 'grid_l', 'hero', 'logo', 'icon')
SUFFIX = {'grid_p': 'p', 'grid_l': '', 'hero': '_hero', 'logo': '_logo', 'icon': '_icon'}

def _directory(path, missing=False):
    try:
        info = path.lstat()
    except FileNotFoundError:
        if missing:
            return False
        raise ValueError('PA_AUTO_ARTWORK_UNKNOWN')
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise ValueError('PA_AUTO_ARTWORK_UNKNOWN')
    return True

def _files(path, predicate, missing=False):
    if not _directory(path, missing):
        return []
    result = []
    with os.scandir(path) as entries:
        for entry in entries:
            if not predicate(entry.name):
                continue
            info = entry.stat(follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise ValueError('PA_AUTO_ARTWORK_UNKNOWN')
            if stat.S_ISREG(info.st_mode):
                result.append(Path(entry.path))
    return result


def _regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise ValueError('PA_AUTO_ARTWORK_UNKNOWN')
    return info

def status(userdata, librarycache, appid, steam_user, active_user, shortcut, read_shortcuts):
    appid, user = str(appid), str(steam_user)
    if not re.fullmatch(r'[1-9][0-9]{0,9}', appid) or int(appid) > 0xffffffff or not re.fullmatch(r'[1-9][0-9]{0,9}', user) or int(user) > 0xffffffff:
        raise ValueError('PA_AUTO_ARTWORK_UNKNOWN')
    if str(active_user()) != user:
        raise ValueError('PA_AUTO_ARTWORK_ACCOUNT_CHANGED')
    userdata, librarycache = Path(userdata), Path(librarycache)
    _directory(userdata)
    userdir = userdata / user
    _directory(userdir)
    config = userdir / 'config'
    _directory(config)
    grid = config / 'grid'
    _directory(grid, missing=True)
    icon = ''
    if shortcut:
        _regular(config / 'shortcuts.vdf')
        rows = read_shortcuts(config / 'shortcuts.vdf')
        if not isinstance(rows, dict) or not isinstance(rows.get('shortcuts'), dict):
            raise ValueError('PA_AUTO_ARTWORK_UNKNOWN')
        matching = [row for row in rows['shortcuts'].values() if isinstance(row, dict) and (int(row.get('appid', -1)) & 0xffffffff) == int(appid)]
        if len(matching) != 1 or not isinstance(matching[0].get('icon', ''), str):
            raise ValueError('PA_AUTO_ARTWORK_UNKNOWN')
        icon = matching[0].get('icon', '')
    assets = {}
    for kind in ASSETS:
        stem = appid + SUFFIX[kind]
        custom = _files(grid, lambda name: Path(name).stem.casefold() == stem.casefold() and Path(name).suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp', '.ico', '.tga'), missing=True)
        exists = bool(custom) or kind == 'icon' and bool(icon)
        if not exists and not shortcut:
            # Existing official art is preserved too. Failure to read a cache is
            # unknown, never evidence that a user image can be replaced.
            stems = {'grid_p': ['library_600x900'], 'grid_l': ['header'], 'hero': ['library_hero'], 'logo': ['logo', 'library_logo'], 'icon': ['icon']}[kind]
            for root in [librarycache, librarycache / appid]:
                for official in stems:
                    prefix = appid + '_' + official if root == librarycache else official
                    if _files(root, lambda name, p=prefix: re.fullmatch(re.escape(p) + r'(?:_[A-Za-z0-9_-]+)?\.(?:png|jpg|jpeg|webp|ico)', name, re.I) is not None, missing=True):
                        exists = True
            if _directory(librarycache / appid, missing=True):
                for child in (librarycache / appid).iterdir():
                    info = child.lstat()
                    if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                        raise ValueError('PA_AUTO_ARTWORK_UNKNOWN')
                    if stat.S_ISDIR(info.st_mode):
                        _directory(child)
                        for official in stems:
                            if _files(child, lambda name, p=official: re.fullmatch(re.escape(p) + r'(?:_[A-Za-z0-9_-]+)?\.(?:png|jpg|jpeg|webp|ico)', name, re.I) is not None):
                                exists = True
        assets[kind] = {'exists': bool(exists)}
    if str(active_user()) != user:
        raise ValueError('PA_AUTO_ARTWORK_ACCOUNT_CHANGED')
    return {'appid': int(appid), 'steamUser': user, 'assets': assets, 'shortcutIcon': icon}

def stage_icon(directory, content, appid, user, active_user, inspect):
    if not re.fullmatch(r'[1-9][0-9]{0,9}', str(appid)) or int(appid) > 0xffffffff or not re.fullmatch(r'[1-9][0-9]{0,9}', str(user)) or int(user) > 0xffffffff:
        raise ValueError('PA_AUTO_ARTWORK_UNKNOWN')
    if str(active_user()) != str(user):
        raise ValueError('PA_AUTO_ARTWORK_ACCOUNT_CHANGED')
    metadata = inspect(content)
    if metadata['format'] != 'png' or metadata.get('animated') or not metadata.get('dimensions') or max(metadata['dimensions']) > 1024 or len(content) > 2 * 1024 * 1024:
        raise ValueError('PA_ERROR_INVALID_ARTWORK')
    root = Path(directory)
    if not root.is_absolute():
        raise ValueError('PA_AUTO_ARTWORK_UNKNOWN')
    for parent in reversed([root, *root.parents]):
        _directory(parent, missing=True)
    root.mkdir(parents=True, exist_ok=True)
    _directory(root)
    digest = hashlib.sha256(content).hexdigest()
    path = root / (str(user) + '-' + str(appid) + '-' + digest + '.png')
    if not path.exists():
        entries = list(root.iterdir())
        if len(entries) >= 2000 or sum(_regular(entry).st_size for entry in entries) + len(content) > 256 * 1024 * 1024:
            raise ValueError('PA_AUTO_ARTWORK_CACHE_FULL')
        with path.open('xb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    else:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400 or path.read_bytes() != content:
            raise ValueError('PA_AUTO_ARTWORK_UNKNOWN')
    if str(active_user()) != str(user):
        raise ValueError('PA_AUTO_ARTWORK_ACCOUNT_CHANGED')
    return {'path': str(path), 'sha256': digest}
