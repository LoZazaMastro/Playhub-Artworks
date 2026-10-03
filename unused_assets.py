"""On-demand removal of plugin-owned caches after a complete Steam inventory."""
from pathlib import Path
import io
import re
import struct

IMAGE = re.compile(r'(?P<app>\d+)_(?:hero|grid_l|banner)\.(?:png|jpg|jpeg|webp)$', re.I)

def inventory(steam_root, parse_text, parse_binary):
    root = Path(steam_root)
    installed, shortcuts = set(), set()
    native_complete = shortcuts_complete = True
    def text(path):
        value = path.read_text(encoding='utf-8-sig')
        # A truncated inventory is not evidence that games were removed.
        quoted = re.sub(r'"(?:\\.|[^"\\])*"', '""', value)
        if quoted.count('{') != quoted.count('}'):
            raise ValueError('Incomplete Steam inventory')
        return parse_text(io.StringIO(value))
    libraries = {root / 'steamapps'}
    try:
        folders = text(root / 'steamapps' / 'libraryfolders.vdf')
        folders = folders['libraryfolders']
        if not isinstance(folders, dict): raise ValueError('Invalid Steam libraries')
        for key, entry in folders.items():
            path = entry.get('path') if isinstance(entry, dict) else entry if str(key).isdigit() else None
            if path: libraries.add(Path(path) / 'steamapps')
    except (OSError, ValueError, SyntaxError, KeyError, TypeError, AttributeError):
        native_complete = False
    for library in libraries:
        try:
            if not library.is_dir(): raise OSError('Unavailable Steam library')
            for manifest in library.glob('appmanifest_*.acf'):
                state = text(manifest).get('AppState', {})
                app = int(state['appid'])
                if not 0 < app < 0x80000000: raise ValueError('Invalid app identity')
                installed.add(app)
        except (OSError, ValueError, SyntaxError, KeyError, TypeError):
            native_complete = False
    try:
        accounts = [p for p in (root / 'userdata').iterdir() if p.is_dir() and p.name.isdigit()]
        if not accounts: raise OSError('Unavailable Steam accounts')
        for account in accounts:
            config = account / 'config'
            if not config.is_dir(): raise OSError('Unavailable Steam account')
            path = config / 'shortcuts.vdf'
            if not path.exists(): continue
            data = path.read_bytes()
            if not data.endswith(b'\x08\x08'): raise ValueError('Incomplete shortcuts')
            parsed = parse_binary(io.BytesIO(data), raise_on_remaining=True)
            entries = parsed['shortcuts']
            if not isinstance(entries, dict): raise ValueError('Invalid shortcuts')
            for game in entries.values():
                app = int(game['appid']) & 0xffffffff
                if not app & 0x80000000: raise ValueError('Invalid shortcut identity')
                shortcuts.add(app)
    except (OSError, ValueError, SyntaxError, struct.error, KeyError, TypeError, AttributeError):
        shortcuts_complete = False
    return installed, shortcuts, native_complete, shortcuts_complete

def clean_sources(source_root, snapshot, dry_run=False):
    root = Path(source_root)
    installed, shortcuts, native_complete, shortcuts_complete = snapshot
    files, bytes_removed, errors = [], 0, 0
    def linked(path):
        return path.is_symlink() or bool(getattr(path.lstat(), 'st_file_attributes', 0) & 0x400)
    if not root.is_dir() or any(linked(p) for p in (root, *root.parents)):
        return {'removed': 0, 'bytes': 0, 'errors': 0, 'inventoryComplete': native_complete and shortcuts_complete}
    for path in root.iterdir():
        match = IMAGE.fullmatch(path.name)
        if not match or linked(path) or not path.is_file(): continue
        app = int(match['app'])
        if not 0 < app <= 0xffffffff: continue
        active = shortcuts if app & 0x80000000 else installed
        complete = shortcuts_complete if app & 0x80000000 else native_complete
        if not complete or app in active: continue
        try:
            if path.resolve().parent != root.resolve(): continue
            size = path.stat().st_size
            if not dry_run: path.unlink()
            files.append(path.name); bytes_removed += size
        except OSError:
            errors += 1
    # Original artwork backups and Steam's grid/librarycache are kept intact.
    return {'removed': len(files), 'bytes': bytes_removed, 'errors': errors,
            'inventoryComplete': native_complete and shortcuts_complete}
