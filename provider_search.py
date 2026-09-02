import concurrent.futures
import difflib
import html
import json
import re
import unicodedata
import uuid
from hashlib import sha1
from struct import unpack
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import parse_qs, quote, unquote, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen


USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36 Playhub-Artworks/1.0'

PROVIDERS: Dict[str, Dict[str, Any]] = {
    'google': {'label': 'Collegamento diretto', 'hosts': ()},
    'playstation': {'label': 'PlayStation', 'hosts': ('image.api.playstation.com',)},
    'igdb': {'label': 'IGDB', 'hosts': ('images.igdb.com',)},
    'alphacoders': {'label': 'AlphaCoders', 'hosts': ('images.alphacoders.com', 'images2.alphacoders.com', 'images3.alphacoders.com', 'images4.alphacoders.com')},
    'nintendo': {'label': 'Nintendo', 'hosts': ('assets.nintendo.com', 'assets.nintendo.eu')},
    'xbox': {'label': 'Xbox', 'hosts': ('store-images.s-microsoft.com', 'store-images.microsoft.com')},
    'iidb': {'label': 'iiDB', 'hosts': ('iidb.iisu.network', 'assets.iisu.network')},
    'ign': {'label': 'IGN', 'hosts': ('assets-prd.ignimgs.com', 'assets1.ignimgs.com', 'assets2.ignimgs.com')},
}

ASSET_HINTS = {
    'grid_p': 'video game cover box art portrait',
    'grid_l': 'video game library header banner landscape',
    'hero': 'video game key art background wallpaper landscape',
    'logo': 'video game logo transparent png',
    'icon': 'video game icon square',
}


def _decode_url(value: str) -> str:
    value = html.unescape(str(value or '')).replace('\\u0026', '&').replace('\\/', '/')
    value = value.replace('\\u003d', '=').replace('\\u002f', '/').replace('\\u003a', ':')
    value = unquote(value).strip()
    if value.startswith('//'):
        value = 'https:' + value
    parsed = urlparse(value)
    if parsed.netloc.endswith('google.com') and parsed.path.startswith('/imgres'):
        query = parse_qs(parsed.query)
        value = (query.get('imgurl') or query.get('url') or [value])[0]
    return re.split(r'[\s"\'<>]', value, 1)[0]


def _google_url(query: str) -> str:
    return 'https://www.google.com/search?' + urlencode({
        'q': query,
        'udm': '2',
        'safe': 'active',
        'hl': 'it',
        'client': 'firefox-b-d',
    })


def _fetch_html(url: str, timeout: int = 12) -> str:
    request = Request(url, headers={
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.7,en;q=0.6',
        'Cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX+410; SOCS=CAESHAgBEhIaAB',
    })
    with urlopen(request, timeout=timeout) as response:
        return response.read(2_000_000).decode('utf-8', 'ignore')


def _candidate_urls(markup: str) -> Iterable[str]:
    decoded = html.unescape(markup).replace('\\u0026', '&').replace('\\/', '/')
    patterns = (
        r'"ou"\s*:\s*"([^"]+)"',
        r'"(?:imageUrl|contentUrl|original)"\s*:\s*"([^"]+)"',
        r'imgurl=([^&"\']+)',
        r'(https?:\\?/\\?/[^"\'<>\s]+)',
    )
    seen = set()
    for pattern in patterns:
        for match in re.finditer(pattern, decoded, re.IGNORECASE):
            url = _decode_url(match.group(1))
            key = url.split('#', 1)[0].lower()
            if key and key not in seen:
                seen.add(key)
                yield url


def _host_allowed(url: str, provider: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme != 'https' or not parsed.netloc:
        return False
    host = parsed.netloc.lower().split(':', 1)[0]
    blocked = ('google.', 'gstatic.', 'googleusercontent.com', 'youtube.com', 'schema.org')
    if any(token in host for token in blocked):
        return False
    configured = PROVIDERS[provider]['hosts']
    return not configured or any(host == allowed or host.endswith('.' + allowed) for allowed in configured)


def _png_size(data: bytes) -> Optional[Tuple[int, int]]:
    if len(data) >= 24 and data.startswith(b'\x89PNG\r\n\x1a\n') and data[12:16] == b'IHDR':
        return unpack('>II', data[16:24])
    return None


def _jpeg_size(data: bytes) -> Optional[Tuple[int, int]]:
    if not data.startswith(b'\xff\xd8'):
        return None
    index = 2
    while index + 9 < len(data):
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        index += 2
        if marker in (0xD8, 0xD9):
            continue
        if index + 2 > len(data):
            break
        length = int.from_bytes(data[index:index + 2], 'big')
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF) and index + 7 <= len(data):
            return int.from_bytes(data[index + 5:index + 7], 'big'), int.from_bytes(data[index + 3:index + 5], 'big')
        index += max(2, length)
    return None


def _webp_size(data: bytes) -> Optional[Tuple[int, int]]:
    if len(data) < 30 or data[:4] != b'RIFF' or data[8:12] != b'WEBP':
        return None
    if data[12:16] == b'VP8X':
        return 1 + int.from_bytes(data[24:27], 'little'), 1 + int.from_bytes(data[27:30], 'little')
    if data[12:16] == b'VP8 ' and len(data) >= 30 and data[23:26] == b'\x9d\x01\x2a':
        return int.from_bytes(data[26:28], 'little') & 0x3FFF, int.from_bytes(data[28:30], 'little') & 0x3FFF
    if data[12:16] == b'VP8L' and len(data) >= 25 and data[20] == 0x2F:
        bits = int.from_bytes(data[21:25], 'little')
        return 1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF)
    return None


def _remote_image_info(url: str) -> Optional[Tuple[int, int, str]]:
    parsed = urlparse(url)
    referer = f'{parsed.scheme}://{parsed.netloc}/' if parsed.scheme and parsed.netloc else 'https://www.google.com/'
    for ranged in (True, False):
      try:
        headers = {
            'User-Agent': USER_AGENT,
            'Accept': 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Referer': referer,
        }
        if ranged:
            headers['Range'] = 'bytes=0-262143'
        request = Request(url, headers={
            **headers,
        })
        with urlopen(request, timeout=9) as response:
            content_type = str(response.headers.get('Content-Type') or '').split(';', 1)[0].lower()
            data = response.read(262144 if ranged else 8_000_000)
        if not content_type.startswith('image/') and not data.startswith((b'\xff\xd8', b'\x89PNG', b'RIFF')):
            continue
        size = _png_size(data) or _jpeg_size(data) or _webp_size(data)
        if not size:
            continue
        return size[0], size[1], content_type or 'image/jpeg'
      except Exception:
        continue
    return None


def _matches_asset(width: int, height: int, asset_type: str, square_only: bool) -> bool:
    ratio = width / max(1, height)
    if min(width, height) < 128:
        return False
    if square_only:
        return 0.82 <= ratio <= 1.18
    if asset_type == 'grid_p':
        return 0.52 <= ratio <= 0.82
    if asset_type == 'grid_l':
        return 1.65 <= ratio <= 2.45
    if asset_type == 'hero':
        return 1.55 <= ratio <= 3.5 and width >= 900
    if asset_type == 'logo':
        return 0.55 <= ratio <= 5.5
    if asset_type == 'icon':
        return 0.75 <= ratio <= 1.33
    return True


def _matches_aspect_mode(width: int, height: int, asset_type: str, aspect_mode: str) -> bool:
    if asset_type != 'grid_p':
        return _matches_asset(width, height, asset_type, False)
    mode = str(aspect_mode or 'portrait').lower()
    if mode == 'square':
        return _matches_asset(width, height, asset_type, True)
    if mode == 'both':
        return _matches_asset(width, height, asset_type, False) or _matches_asset(width, height, asset_type, True)
    return _matches_asset(width, height, asset_type, False)


def _meets_quality(width: int, height: int, asset_type: str, square_only: bool, quality: str) -> bool:
    quality = str(quality or 'standard').lower()
    if quality == 'any':
        return True
    thresholds = {
        'standard': {'grid_p': 720, 'grid_l': 920, 'hero': 1280, 'logo': 512, 'icon': 128},
        'high': {'grid_p': 900, 'grid_l': 1600, 'hero': 1920, 'logo': 1024, 'icon': 256},
        'ultra': {'grid_p': 1440, 'grid_l': 2560, 'hero': 3200, 'logo': 1600, 'icon': 512},
    }
    minimum = thresholds.get(quality, thresholds['standard']).get(asset_type, 720)
    measured = min(width, height) if square_only or asset_type == 'icon' else (height if asset_type == 'grid_p' else width)
    return measured >= minimum


def _mime_allowed(mime: str, allowed: Optional[List[str]]) -> bool:
    wanted = {str(value).lower() for value in (allowed or []) if str(value).strip()}
    if not wanted:
        return True
    normalized = str(mime or '').lower()
    if normalized == 'image/jpg':
        normalized = 'image/jpeg'
    return normalized in wanted


def _normalize_title(value: str) -> str:
    text = unicodedata.normalize('NFKD', str(value or '').lower())
    text = ''.join(char for char in text if not unicodedata.combining(char))
    text = re.sub(r'[™®©]', '', text)
    return re.sub(r'[^a-z0-9]+', ' ', text).strip()


def _title_score(query: str, candidate: str) -> int:
    left = _normalize_title(query)
    right = _normalize_title(candidate)
    if not left or not right:
        return 0
    if left == right:
        return 1000
    if left in right or right in left:
        return 760
    left_numbers = set(re.findall(r'\b\d+\b', left))
    right_numbers = set(re.findall(r'\b\d+\b', right))
    if left_numbers != right_numbers and (left_numbers or right_numbers):
        return 0
    similarity = difflib.SequenceMatcher(None, left, right).ratio()
    return int(similarity * 900) if similarity >= 0.72 else 0


def _result(provider: str, url: str, width: int, height: int, mime: str, label: str = '', thumb: str = '', page_url: str = '', content_kind: str = '') -> Dict[str, Any]:
    digest = sha1(url.encode('utf-8', 'ignore')).hexdigest()[:12]
    source = PROVIDERS[provider]['label']
    result = {
        'id': int(digest[:8], 16),
        'url': url,
        'thumb': thumb or url,
        'width': int(width or 0),
        'height': int(height or 0),
        'mime': mime or 'image/jpeg',
        'author': {'name': source},
        'provider': provider,
        'source': source,
        'notes': f'{label or source} · {width}×{height}',
        'humor': False,
        'epilepsy': False,
        'nsfw': False,
    }
    if page_url:
        result['page_url'] = page_url
    if content_kind:
        result['content_kind'] = content_kind
    return result


def _json_request(url: str, payload: Optional[Dict[str, Any]] = None, headers: Optional[Dict[str, str]] = None, timeout: int = 15) -> Any:
    request_headers = {'User-Agent': USER_AGENT, 'Accept': 'application/json'}
    request_headers.update(headers or {})
    data = None
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
        request_headers['Content-Type'] = 'application/json'
    request = Request(url, data=data, headers=request_headers, method='POST' if data is not None else 'GET')
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read(8_000_000).decode('utf-8', 'ignore'))


def _search_iidb(title: str, asset_type: str, limit: int) -> List[Dict[str, Any]]:
    requested_type = {
        'grid_l': 'banner',
        'hero': 'hero',
        'logo': 'logo',
        'icon': 'icon',
    }.get(asset_type, 'hero')
    payload = _json_request('https://iidb-api.iisu.network/api/v1/assets/search/groups?' + urlencode({
        'q': title,
        'asset_type': requested_type,
        'parent_limit': 4,
        'assets_per_parent': 8,
    }), headers={'Referer': 'https://iidb.iisu.network/'}, timeout=10)
    groups = payload.get('groups') if isinstance(payload, dict) else []
    ranked = []
    for group in groups or []:
        parent = group.get('parent') if isinstance(group, dict) and isinstance(group.get('parent'), dict) else {}
        score = _title_score(title, str(parent.get('name') or ''))
        if score >= 650:
            ranked.append((score, group))
    if not ranked:
        return []
    ranked.sort(key=lambda item: item[0], reverse=True)
    selected = ranked[0][1]
    parent = selected.get('parent') or {}
    parent_id = parent.get('id')
    assets = selected.get('assets') or []
    if parent_id:
        try:
            expanded = _json_request('https://iidb-api.iisu.network/api/v1/assets/browse/enriched?' + urlencode({
                'parent_id': parent_id,
                'asset_type': requested_type,
                'skip': 0,
                'limit': min(40, max(limit, 24)),
            }), headers={'Referer': 'https://iidb.iisu.network/'}, timeout=10)
            assets = expanded.get('items') or assets
        except Exception:
            pass
    results = []
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        filename = str(asset.get('filename') or '').lstrip('/')
        url = str(asset.get('raw_url') or '') or (f'https://assets.iisu.network/{filename}' if filename else '')
        if not url:
            continue
        try:
            width = int(asset.get('resolution_width') or 0)
            height = int(asset.get('resolution_height') or 0)
        except Exception:
            width = height = 0
        if not width or not height:
            match = re.search(r'(\d+)\s*[x×]\s*(\d+)', str(asset.get('resolution') or ''), re.I)
            if match:
                width, height = int(match.group(1)), int(match.group(2))
        if not width or not height:
            info = _remote_image_info(url)
            if info:
                width, height, _ = info
        mime = str(asset.get('mime_type') or asset.get('mime') or 'image/jpeg')
        if mime == 'image/x-icon':
            mime = 'image/vnd.microsoft.icon'
        item = _result(
            'iidb',
            url,
            width,
            height,
            mime,
            f'iiDB {requested_type}',
            str(asset.get('library_preview_url') or asset.get('preview_url') or url),
            str(asset.get('source_url') or 'https://iidb.iisu.network/'),
        )
        creator = str(asset.get('credits') or asset.get('username') or asset.get('account_username') or '').strip()
        if creator:
            item['author'] = {'name': creator}
        results.append(item)
    return results


def search_iidb_games(title: str, limit: int = 12) -> List[Dict[str, Any]]:
    """Game names from iiDB's own parent index."""
    payload = _json_request('https://iidb-api.iisu.network/api/v1/assets/search/groups?' + urlencode({
        'q': title,
        'parent_limit': max(1, min(24, int(limit))),
        'assets_per_parent': 1,
    }), headers={'Referer': 'https://iidb.iisu.network/'}, timeout=10)
    games = []
    for group in (payload.get('groups') or []) if isinstance(payload, dict) else []:
        parent = group.get('parent') if isinstance(group, dict) else None
        if not isinstance(parent, dict):
            continue
        name = str(parent.get('name') or '').strip()
        game_id = str(parent.get('id') or '').strip()
        if name and game_id:
            games.append({'id': game_id, 'name': name})
    games.sort(key=lambda game: _title_score(title, game['name']), reverse=True)
    return games[:max(1, int(limit))]


def _nintendo_cloudinary(public_id: str, width: int = 1920, aspect: str = '16:9') -> str:
    public_id = str(public_id or '').strip().lstrip('/')
    return (
        'https://assets.nintendo.com/image/upload/'
        f'ar_{aspect},b_auto:border,c_lpad/b_white/f_jpg/q_auto/dpr_1/c_scale,w_{width}/'
        f'{public_id}'
    )


def _nintendo_results(title: str) -> List[Dict[str, Any]]:
    """Raw Nintendo Store hits for a title, best match first."""
    app_id = 'U3B6GR4UA3'
    api_key = 'a29c6927638bfd8cee23993e51e721c9'
    try:
        payload = _json_request(
            f'https://{app_id}-2.algolia.net/1/indexes/*/queries',
            {'requests': [{'indexName': 'store_game_en_us', 'query': title, 'facetFilters': ['corePlatforms:Nintendo Switch', 'hasDlc:false'], 'hitsPerPage': 24}]},
            {'X-Algolia-API-Key': api_key, 'X-Algolia-Application-Id': app_id},
        )
    except Exception:
        return []
    hits = ((payload.get('results') or [{}])[0].get('hits') or []) if isinstance(payload, dict) else []
    ranked = sorted(
        ((_title_score(title, str(hit.get('title') or '')), hit) for hit in hits if isinstance(hit, dict)),
        key=lambda item: item[0],
        reverse=True,
    )
    return [hit for _score, hit in ranked]


def _nintendo_id(hit: Dict[str, Any]) -> str:
    return str(hit.get('objectID') or hit.get('nsuid') or hit.get('url') or '').strip()


def search_nintendo_games(title: str, limit: int = 12) -> List[Dict[str, Any]]:
    """
    The Nintendo Store titles matching a name.

    Same reason as the PlayStation one: handing SteamGridDB's spelling to Nintendo's
    index finds nothing whenever the two databases name the game differently.
    """
    games: List[Dict[str, Any]] = []
    for hit in _nintendo_results(str(title or '').strip())[:max(1, int(limit))]:
        name = str(hit.get('title') or '').strip()
        game_id = _nintendo_id(hit)
        if not name or not game_id:
            continue
        platforms = hit.get('corePlatforms') or []
        games.append({
            'id': game_id,
            'name': name,
            'platform': ', '.join(str(entry) for entry in platforms) if isinstance(platforms, list) else str(platforms),
            'release': str(hit.get('releaseDateDisplay') or hit.get('releaseDate') or ''),
        })
    return games


def _search_nintendo(title: str, asset_type: str, limit: int, product_id: str = '') -> List[Dict[str, Any]]:
    ranked = _nintendo_results(title)
    if not ranked:
        return []

    """
    A store entry the user picked wins over the best guess.

    Without an explicit id the best-scoring hit is used and the score gate still applies,
    so a bad match is dropped instead of returning another game's artwork.
    """
    hit = None
    if product_id:
        for candidate in ranked:
            if _nintendo_id(candidate) == product_id:
                hit = candidate
                break
    if hit is None:
        if product_id:
            hit = ranked[0]
        else:
            if _title_score(title, str(ranked[0].get('title') or '')) < 650:
                return []
            hit = ranked[0]

    page_url = urljoin('https://www.nintendo.com/', str(hit.get('url') or ''))
    candidates: List[Tuple[str, int, int, str]] = []
    if asset_type == 'grid_p':
        square = str(hit.get('productImageSquare') or '')
        if square:
            square = square.replace('/f_auto/', '/f_jpg/')
            candidates.append((square, 1024, 1024, 'Nintendo cover quadrata'))
    else:
        product_image = str(hit.get('productImage') or '')
        if product_image:
            candidates.append((_nintendo_cloudinary(product_image), 1920, 1080, 'Nintendo key art'))
        for gallery in hit.get('productGallery') or []:
            if isinstance(gallery, dict) and gallery.get('resourceType') == 'image' and gallery.get('publicId'):
                candidates.append((_nintendo_cloudinary(str(gallery['publicId'])), 1920, 1080, 'Nintendo screenshot'))
    return [
        _result(
            'nintendo',
            url,
            width,
            height,
            'image/jpeg',
            label,
            page_url=page_url,
            content_kind='screenshot' if 'screenshot' in label.lower() else 'artwork',
        )
        # Apply the shared content/aspect/quality filters before the public
        # result limit. Slicing here could hide valid screenshots whenever a
        # key art entry appeared first in Nintendo's response.
        for url, width, height, label in candidates
    ]


def _igdb_image(image_id: str) -> str:
    return f'https://images.igdb.com/igdb/image/upload/t_original/{image_id}.jpg'


def _search_igdb(title: str, asset_type: str, limit: int) -> List[Dict[str, Any]]:
    search = _json_request('https://api2.playnite.link/api/igdb/search', {'searchTerm': title})
    games = search.get('data') if isinstance(search, dict) else []
    ranked = sorted(((_title_score(title, str(game.get('name') or '')), game) for game in games or [] if isinstance(game, dict)), key=lambda item: item[0], reverse=True)
    if not ranked or ranked[0][0] < 650:
        return []
    game = ranked[0][1]
    details: Dict[str, Any] = {}
    # IGDB can return duplicate records with identical names, some without any
    # media. Inspect only the strongest few matches and keep the first record
    # that actually contains the requested artwork type.
    for score, candidate in ranked[:5]:
        if score < 650:
            break
        try:
            details_payload = _json_request(f'https://api2.playnite.link/api/igdb/game/{candidate.get("id")}')
            candidate_details = details_payload.get('data') if isinstance(details_payload, dict) else {}
        except Exception:
            candidate_details = {}
        if not isinstance(candidate_details, dict):
            candidate_details = candidate
        has_media = bool(candidate_details.get('cover_expanded')) if asset_type == 'grid_p' else bool(
            (candidate_details.get('artworks_expanded') or []) + (candidate_details.get('screenshots_expanded') or [])
        )
        if has_media:
            game = candidate
            details = candidate_details
            break
    if not details:
        return []
    page_url = str(details.get('url') or game.get('url') or '')
    candidates: List[Tuple[Dict[str, Any], str]] = []
    if asset_type == 'grid_p':
        cover = details.get('cover_expanded') or game.get('cover_expanded')
        if isinstance(cover, dict):
            candidates.append((cover, 'IGDB cover'))
    else:
        candidates.extend((item, 'IGDB artwork') for item in details.get('artworks_expanded') or [] if isinstance(item, dict))
        candidates.extend((item, 'IGDB screenshot') for item in details.get('screenshots_expanded') or [] if isinstance(item, dict))
    results = []
    for item, label in candidates:
        image_id = str(item.get('image_id') or '')
        if not image_id:
            continue
        width, height = int(item.get('width') or 0), int(item.get('height') or 0)
        results.append(_result(
            'igdb',
            _igdb_image(image_id),
            width,
            height,
            'image/jpeg',
            label,
            page_url=page_url,
            content_kind='screenshot' if 'screenshot' in label.lower() else 'artwork',
        ))
    # Keep every candidate until the shared aspect/quality filter has run. Cutting
    # here could leave only square artworks and hide valid landscape screenshots.
    return results


def search_igdb_games(title: str, limit: int = 12) -> List[Dict[str, Any]]:
    """Game names returned by IGDB, without passing through SteamGridDB."""
    payload = _json_request('https://api2.playnite.link/api/igdb/search', {'searchTerm': title})
    raw = payload.get('data') if isinstance(payload, dict) else []
    games = []
    for game in raw or []:
        if not isinstance(game, dict):
            continue
        name = str(game.get('name') or '').strip()
        game_id = str(game.get('id') or '').strip()
        if name and game_id:
            games.append({'id': game_id, 'name': name, 'release': str(game.get('first_release_date') or '')})
    games.sort(key=lambda game: _title_score(title, game['name']), reverse=True)
    return games[:max(1, int(limit))]


def _search_alphacoders(title: str, limit: int) -> List[Dict[str, Any]]:
    slug = re.sub(r'[^a-z0-9]+', '-', _normalize_title(title)).strip('-')
    urls = [f'https://alphacoders.com/{slug}-wallpapers']
    markup = ''
    for url in urls:
        try:
            markup = _fetch_html(url, 15)
            if 'itemprop="contentUrl"' in markup or "itemprop='contentUrl'" in markup:
                break
        except Exception:
            markup = ''
    if not markup:
        return []
    results = []
    blocks = re.split(r'<div\s+id=["\']content_\d+["\']', markup, flags=re.I)[1:]
    for block in blocks:
        original = re.search(r'itemprop=["\']contentUrl["\']\s+content=["\']([^"\']+)', block, re.I)
        if not original:
            continue
        url = html.unescape(original.group(1)).replace('\\/', '/')
        thumb_match = re.search(r'itemprop=["\']thumbnailUrl["\']\s+content=["\']([^"\']+)', block, re.I)
        author_match = re.search(r'itemprop=["\']author["\']\s+content=["\']([^"\']+)', block, re.I)
        dimensions = re.search(r'\b(\d{3,5})\s*[x×]\s*(\d{3,5})\b', block, re.I)
        if dimensions:
            width, height = int(dimensions.group(1)), int(dimensions.group(2))
        else:
            info = _remote_image_info(url)
            if not info:
                continue
            width, height, _ = info
        extension = urlparse(url).path.rsplit('.', 1)[-1].lower()
        mime = {'png': 'image/png', 'webp': 'image/webp'}.get(extension, 'image/jpeg')
        item = _result('alphacoders', url, width, height, mime, 'AlphaCoders wallpaper', html.unescape(thumb_match.group(1)) if thumb_match else url, f'https://alphacoders.com/{slug}-wallpapers')
        if author_match:
            item['author'] = {'name': html.unescape(author_match.group(1))}
        results.append(item)
        if len(results) >= limit * 2:
            break
    return results


def _xbox_autosuggest(title: str) -> List[Tuple[str, str]]:
    url = (
        'https://www.microsoft.com/msstoreapiprod/api/autosuggest?market=en-us'
        '&sources=DCatAll-Products,xSearch-Products&filter=+ClientType:StoreWeb&counts=20,20&query='
        + quote(title, safe='')
    )
    payload = _json_request(url, headers={'Referer': 'https://www.xbox.com/en-US/'}, timeout=8)
    products = []
    for result_set in (payload.get('ResultSets') or payload.get('resultSets') or []) if isinstance(payload, dict) else []:
        if str(result_set.get('Type') or result_set.get('type') or '').lower() != 'product':
            continue
        for suggestion in result_set.get('Suggests') or result_set.get('suggests') or []:
            if not isinstance(suggestion, dict) or str(suggestion.get('Source') or suggestion.get('source') or '').lower() != 'game':
                continue
            metadata = {}
            for entry in suggestion.get('Metas') or suggestion.get('metas') or []:
                if isinstance(entry, dict):
                    metadata[str(entry.get('Key') or entry.get('key') or '').lower()] = str(entry.get('Value') or entry.get('value') or '')
            product_id = metadata.get('bigcatalogid', '').strip()
            product_title = str(suggestion.get('Title') or suggestion.get('title') or '').strip()
            if product_id and product_title:
                products.append((product_id, product_title))
    products.sort(key=lambda item: _title_score(title, item[1]), reverse=True)
    return products


def search_xbox_games(title: str, limit: int = 12) -> List[Dict[str, Any]]:
    """Xbox Store autosuggestions, already ranked by the store title."""
    games = []
    seen = set()
    for product_id, product_title in _xbox_autosuggest(title):
        if product_id in seen:
            continue
        seen.add(product_id)
        games.append({'id': product_id, 'name': product_title, 'platform': 'Xbox'})
        if len(games) >= max(1, int(limit)):
            break
    return games


def _search_xbox(title: str, asset_type: str, limit: int) -> List[Dict[str, Any]]:
    products = _xbox_autosuggest(title)
    if not products or _title_score(title, products[0][1]) < 650:
        return []
    selected = products[:1] if _title_score(title, products[0][1]) >= 900 else products[:3]
    payload = _json_request('https://displaycatalog.mp.microsoft.com/v7.0/products?' + urlencode({
        'bigIds': ','.join(product[0] for product in selected),
        'market': 'US',
        'languages': 'en-us',
        'fieldsTemplate': 'Details',
    }), timeout=10)
    entries = payload.get('Products') or payload.get('products') or [] if isinstance(payload, dict) else []
    landscape_roles = {'superheroart', 'hero', 'titledheroart', 'imagegallery', 'screenshot'}
    cover_roles = {'poster', 'boxart', 'boxartlg', 'tile', 'brandedkeyart', 'featurepromotionalsquareart'}
    icon_roles = {'logo'}
    results = []
    for product in entries:
        if not isinstance(product, dict):
            continue
        product_id = str(product.get('ProductId') or product.get('productId') or '')
        localized = product.get('LocalizedProperties') or product.get('localizedProperties') or []
        for properties in localized[:1]:
            if not isinstance(properties, dict):
                continue
            product_title = str(properties.get('ProductTitle') or properties.get('productTitle') or '')
            page_url = f'https://www.xbox.com/en-US/games/store/{quote(product_title.lower().replace(" ", "-"), safe="-")}/{product_id}'
            for image in properties.get('Images') or properties.get('images') or []:
                if not isinstance(image, dict):
                    continue
                purpose = str(image.get('ImagePurpose') or image.get('imagePurpose') or '').lower()
                accepted_roles = cover_roles if asset_type == 'grid_p' else icon_roles if asset_type == 'icon' else landscape_roles
                if purpose not in accepted_roles:
                    continue
                url = str(image.get('Uri') or image.get('uri') or image.get('Url') or image.get('url') or '').strip()
                if url.startswith('//'):
                    url = 'https:' + url
                elif url.startswith('http://'):
                    url = 'https://' + url[7:]
                try:
                    width = int(image.get('Width') or image.get('width') or 0)
                    height = int(image.get('Height') or image.get('height') or 0)
                except Exception:
                    width = height = 0
                if not url or not width or not height:
                    continue
                parsed = urlparse(url)
                if parsed.netloc.lower() in {'store-images.s-microsoft.com', 'store-images.microsoft.com'}:
                    url = f'{parsed.scheme or "https"}://{parsed.netloc}{parsed.path}?w={width}&h={height}&q=100'
                results.append(_result(
                    'xbox',
                    url,
                    width,
                    height,
                    'image/jpeg',
                    f'Xbox {purpose}',
                    page_url=page_url,
                    content_kind='screenshot' if purpose == 'screenshot' else 'artwork',
                ))
    return results


PS_GRAPHQL_URL = 'https://web.np.playstation.com/api/graphql/v1//op'
PS_SEARCH_HASH = '4df6284f982e57bec70f23c77e2c219dc792eb19af7fb3d3a81767aa3f1958aa'


def _playstation_payload(title: str, country: str, language: str) -> Any:
    variables = json.dumps({
        'countryCode': country,
        'languageCode': language,
        'nextCursor': '',
        'pageOffset': 0,
        'pageSize': 24,
        'searchTerm': title,
    }, separators=(',', ':'), ensure_ascii=False)
    extensions = json.dumps({'persistedQuery': {'version': 1, 'sha256Hash': PS_SEARCH_HASH}}, separators=(',', ':'))
    url = (
        f'{PS_GRAPHQL_URL}?operationName=getSearchResults'
        f'&variables={quote(variables, safe="")}'
        f'&extensions={quote(extensions, safe="")}'
    )
    return _json_request(url, headers={
        'Origin': 'https://store.playstation.com',
        'Referer': 'https://store.playstation.com/',
        'apollographql-client-name': '@sie-ppr-web-store/app',
        'apollographql-client-version': '0.113.0',
        'Content-Type': 'application/json',
        'X-PSN-App-Ver': '@sie-ppr-web-store/app/0.113.0-',
        'X-PSN-Correlation-ID': str(uuid.uuid4()),
        'X-PSN-Request-ID': str(uuid.uuid4()),
        'X-PSN-Store-Locale-Override': f'{language.lower()}-{country.upper()}',
    }, timeout=18)


def _playstation_media(item: Dict[str, Any]) -> List[Dict[str, str]]:
    results = []
    seen = set()
    for media in item.get('media') or []:
        if not isinstance(media, dict):
            continue
        url = str(media.get('url') or media.get('src') or media.get('imageUrl') or '').strip().replace('\\/', '/')
        if url.startswith('//'):
            url = 'https:' + url
        if not url.startswith('https://') or url.split('?', 1)[0].lower() in seen:
            continue
        seen.add(url.split('?', 1)[0].lower())
        results.append({'url': url, 'role': str(media.get('role') or '').upper(), 'type': str(media.get('type') or '').upper()})
    return results


def _playstation_results(title: str) -> List[Dict[str, Any]]:
    """Raw PlayStation Store hits for a title, best match first."""
    raw_results: List[Any] = []
    for country, language in (('IT', 'it'), ('US', 'en')):
        try:
            payload = _playstation_payload(title, country, language)
            universal = (payload.get('data') or {}).get('universalSearch') if isinstance(payload, dict) else None
            raw_results = universal.get('results') or [] if isinstance(universal, dict) else []
            if raw_results:
                break
        except Exception:
            raw_results = []
    ranked = sorted(
        ((_title_score(title, str(item.get('name') or item.get('title') or '')), item)
         for item in raw_results if isinstance(item, dict)),
        key=lambda row: row[0],
        reverse=True,
    )
    return [item for _score, item in ranked]


def search_playstation_games(title: str, limit: int = 12) -> List[Dict[str, Any]]:
    """
    The PlayStation Store titles matching a name.

    The asset search below picks the first one on its own; this is what lets the user
    override that choice when the store calls the game something else.
    """
    games: List[Dict[str, Any]] = []
    for item in _playstation_results(str(title or '').strip())[:max(1, int(limit))]:
        name = str(item.get('name') or item.get('title') or '').strip()
        product_id = str(item.get('id') or item.get('conceptId') or item.get('productId') or '').strip()
        if not name or not product_id:
            continue
        games.append({
            'id': product_id,
            'name': name,
            'platform': str(item.get('platform') or ''),
            'release': str(item.get('releaseDate') or ''),
        })
    return games


def _search_playstation(title: str, asset_type: str, limit: int, product_id: str = '') -> List[Dict[str, Any]]:
    results = _playstation_results(title)
    if not results:
        return []

    """
    A specific store entry wins over the best guess.

    Without an explicit id the first (best-scoring) result is used, which is right almost
    always - and wrong exactly when the store spells the game differently, which is the
    case the picker exists for.
    """
    item = None
    if product_id:
        for candidate in results:
            ids = {str(candidate.get('id') or ''), str(candidate.get('conceptId') or ''), str(candidate.get('productId') or '')}
            if product_id in ids:
                item = candidate
                break
    if item is None:
        best = results[0]
        # Only fall back to scoring when the caller did not name an entry.
        if not product_id and _title_score(title, str(best.get('name') or best.get('title') or '')) < 650:
            return []
        item = best
    product_title = str(item.get('name') or item.get('title') or title)
    product_id = str(item.get('id') or item.get('conceptId') or item.get('productId') or '')
    page_url = str(item.get('url') or item.get('href') or '')
    if not page_url and product_id:
        page_url = f'https://store.playstation.com/en-us/concept/{quote(product_id, safe="-_.")}'
    media = _playstation_media(item)
    cover_roles = {'MASTER', 'PORTRAIT_BANNER'}
    landscape_roles = {'BACKGROUND', 'SIXTEEN_BY_NINE_BANNER', 'EDITION_KEY_ART', 'SCREENSHOT'}
    logo_roles = {'LOGO'}
    candidates = []
    for entry in media:
        role = entry['role']
        accepted_roles = cover_roles if asset_type == 'grid_p' else logo_roles if asset_type == 'logo' else landscape_roles
        if role not in accepted_roles:
            continue
        info = _remote_image_info(entry['url'])
        if not info:
            continue
        width, height, mime = info
        candidates.append(_result(
            'playstation',
            entry['url'],
            width,
            height,
            mime,
            f'PlayStation {role.lower()}',
            page_url=page_url,
            content_kind='screenshot' if role == 'SCREENSHOT' else 'artwork',
        ))
    candidates.sort(key=lambda result: int(result['width']) * int(result['height']), reverse=True)
    return candidates[:max(limit, 24)]


IGN_GRAPHQL_URL = 'https://mollusk.apis.ign.com/graphql'
IGN_SEARCH_HASH = 'e1c2e012a21b4a98aaa618ef1b43eb0cafe9136303274a34f5d9ea4f2446e884'


def _search_ign(title: str, limit: int) -> List[Dict[str, Any]]:
    variables = json.dumps({
        'term': title,
        'count': min(20, max(5, limit)),
        'objectType': 'Game',
    }, separators=(',', ':'), ensure_ascii=False)
    extensions = json.dumps({
        'persistedQuery': {'version': 1, 'sha256Hash': IGN_SEARCH_HASH},
    }, separators=(',', ':'))
    url = (
        f'{IGN_GRAPHQL_URL}?operationName=SearchObjectsByName'
        f'&variables={quote(variables, safe="")}'
        f'&extensions={quote(extensions, safe="")}'
    )
    payload = _json_request(url, headers={
        'Content-Type': 'application/json',
        'Origin': 'https://www.ign.com',
        'Referer': 'https://www.ign.com/',
        'apollographql-client-name': 'kraken',
        'apollographql-client-version': 'v0.67.0',
        'x-apollo-operation-name': 'SearchObjectsByName',
    }, timeout=15)
    search = ((payload.get('data') or {}).get('searchObjectsByName') or {}) if isinstance(payload, dict) else {}
    objects = search.get('objects') or [] if isinstance(search, dict) else []
    ranked = []
    for item in objects:
        if not isinstance(item, dict):
            continue
        names = ((item.get('metadata') or {}).get('names') or {}) if isinstance(item.get('metadata'), dict) else {}
        name = str(names.get('name') or item.get('name') or '')
        score = _title_score(title, name)
        if score >= 650:
            ranked.append((score, item, name))
    ranked.sort(key=lambda row: row[0], reverse=True)
    if not ranked:
        return []
    for _score, item, name in ranked[:5]:
        primary = item.get('primaryImage') or {}
        image_url = str(primary.get('url') or '').strip() if isinstance(primary, dict) else ''
        if not image_url:
            continue
        info = _remote_image_info(image_url)
        if not info:
            continue
        width, height, mime = info
        page_path = str(item.get('url') or '').strip()
        page_url = urljoin('https://www.ign.com/', page_path)
        return [_result('ign', image_url, width, height, mime, f'IGN cover · {name}', page_url=page_url)]
    return []


def search_ign_games(title: str, limit: int = 12) -> List[Dict[str, Any]]:
    """Game names from IGN's own object search."""
    variables = json.dumps({
        'term': title,
        'count': min(20, max(5, int(limit))),
        'objectType': 'Game',
    }, separators=(',', ':'), ensure_ascii=False)
    extensions = json.dumps({'persistedQuery': {'version': 1, 'sha256Hash': IGN_SEARCH_HASH}}, separators=(',', ':'))
    url = (
        f'{IGN_GRAPHQL_URL}?operationName=SearchObjectsByName'
        f'&variables={quote(variables, safe="")}'
        f'&extensions={quote(extensions, safe="")}'
    )
    payload = _json_request(url, headers={
        'Content-Type': 'application/json',
        'Origin': 'https://www.ign.com',
        'Referer': 'https://www.ign.com/',
        'apollographql-client-name': 'kraken',
        'apollographql-client-version': 'v0.67.0',
        'x-apollo-operation-name': 'SearchObjectsByName',
    }, timeout=15)
    search = ((payload.get('data') or {}).get('searchObjectsByName') or {}) if isinstance(payload, dict) else {}
    games = []
    for item in (search.get('objects') or []) if isinstance(search, dict) else []:
        if not isinstance(item, dict):
            continue
        names = ((item.get('metadata') or {}).get('names') or {}) if isinstance(item.get('metadata'), dict) else {}
        name = str(names.get('name') or item.get('name') or '').strip()
        game_id = str(item.get('id') or item.get('slug') or item.get('url') or name).strip()
        if name:
            games.append({'id': game_id, 'name': name})
    games.sort(key=lambda game: _title_score(title, game['name']), reverse=True)
    return games[:max(1, int(limit))]


# --- Web image search: removed ----------------------------------------------
#
# The free web scraper is gone. Google serves image results only to a JavaScript-capable
# client, so a Python backend receives a bootstrap script with no results in it; the
# fallback engines answer without JavaScript but their plain-HTML index degrades badly on
# game titles, and no amount of query cleaning or relevance filtering made it reliable
# enough to be worth offering. `inspect_remote_artwork` below stays: pasting a direct
# image address still works, and that path was never the problem.


def inspect_remote_artwork(url: str, asset_type: str, aspect_mode: str = 'portrait', minimum_quality: str = 'standard', mimes: Optional[List[str]] = None) -> Dict[str, Any]:
    direct_url = _decode_url(url)
    parsed = urlparse(direct_url)
    if parsed.scheme not in {'http', 'https'} or not parsed.netloc:
        raise ValueError('Inserisci l’indirizzo diretto di un’immagine HTTP o HTTPS.')
    info = _remote_image_info(direct_url)
    if not info:
        raise ValueError('Il collegamento non contiene un’immagine valida o il sito ne impedisce il download.')
    width, height, mime = info
    if not _matches_aspect_mode(width, height, asset_type, aspect_mode):
        raise ValueError('L’immagine non ha proporzioni adatte a questa scheda.')
    square_only = asset_type == 'grid_p' and str(aspect_mode).lower() == 'square'
    if not _meets_quality(width, height, asset_type, square_only, minimum_quality):
        raise ValueError('L’immagine è più piccola della qualità minima selezionata.')
    if not _mime_allowed(mime, mimes):
        raise ValueError('Il formato dell’immagine è escluso dai filtri correnti.')
    return _result('google', direct_url, width, height, mime, 'Google')


def search_provider_assets(provider: str, title: str, asset_type: str, square_only: bool = False, limit: int = 24, minimum_quality: str = 'standard', mimes: Optional[List[str]] = None, content_type: str = 'all', query: str = '', exact_size: str = '') -> List[Dict[str, Any]]:
    provider = str(provider or '').lower()
    title = str(title or '').strip()
    if provider not in PROVIDERS or not title:
        return []
    if provider == 'ign' and asset_type != 'grid_p':
        return []
    if provider == 'iidb':
        raw = _search_iidb(title, asset_type, limit)
    elif provider == 'nintendo':
        raw = _search_nintendo(title, asset_type, limit, str(query or ''))
    elif provider == 'igdb':
        raw = _search_igdb(title, asset_type, limit)
    elif provider == 'alphacoders':
        raw = _search_alphacoders(title, limit)
    elif provider == 'xbox':
        raw = _search_xbox(title, asset_type, limit)
    elif provider == 'playstation':
        raw = _search_playstation(title, asset_type, limit, str(query or ''))
    elif provider == 'ign':
        raw = _search_ign(title, limit)
    else:
        # No web scraper any more; an unknown provider simply has nothing to offer.
        return []

    filtered = []
    seen = set()
    for item in raw:
        width, height = int(item.get('width') or 0), int(item.get('height') or 0)
        if not width or not height:
            info = _remote_image_info(str(item.get('url') or ''))
            if not info:
                continue
            width, height, detected_mime = info
            item['width'], item['height'] = width, height
            item['mime'] = detected_mime
        if not _matches_asset(width, height, asset_type, square_only):
            continue
        if not _meets_quality(width, height, asset_type, square_only, minimum_quality):
            continue
        if not _mime_allowed(str(item.get('mime') or ''), mimes):
            continue
        if content_type in {'artwork', 'screenshot'} and str(item.get('content_kind') or '') != content_type:
            continue
        key = str(item.get('url') or '').split('#', 1)[0].lower()
        if not key or key in seen:
            continue
        seen.add(key)
        filtered.append(item)
    filtered.sort(key=lambda item: int(item.get('width') or 0) * int(item.get('height') or 0), reverse=True)
    return filtered[:limit]
