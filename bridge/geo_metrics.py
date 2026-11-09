"""Brand alias and URL matching extracted from the archived fangli_geo_lab metrics."""
from __future__ import annotations

import ipaddress
import re
import unicodedata
from collections.abc import Sequence
from urllib.parse import quote, unquote, urlsplit, urlunsplit


TRACKING_KEYS = {"gclid", "fbclid", "msclkid", "yclid", "dclid", "_ga"}


UNRESERVED = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
)


def _is_cjk(char: str) -> bool:
    value = ord(char)
    return (
        0x3400 <= value <= 0x4DBF or 0x4E00 <= value <= 0x9FFF
        or 0xF900 <= value <= 0xFAFF or 0x20000 <= value <= 0x323AF
    )


def _normalize_brand_text(text: str) -> str:
    normalized = " ".join(unicodedata.normalize("NFKC", text).casefold().split())
    # Chinese typography may insert spaces between characters. Preserve spaces
    # inside Latin names so "new balance" is not conflated with "newbalance".
    return "".join(
        char for index, char in enumerate(normalized)
        if not (
            char == " "
            and ((index > 0 and _is_cjk(normalized[index - 1]))
                 or (index + 1 < len(normalized) and _is_cjk(normalized[index + 1])))
        )
    )


def _western_word_char(char: str) -> bool:
    return char == "_" or (char.isalnum() and not _is_cjk(char))


def contains_brand_alias(text: str, aliases: Sequence[str]) -> bool:
    """Lexical matching only; sentiment, recommendation and entity identity differ."""
    normalized = _normalize_brand_text(text)
    for alias in aliases:
        needle = _normalize_brand_text(alias)
        if not needle:
            continue
        for match in re.finditer(re.escape(needle), normalized):
            start, end = match.span()
            if (_western_word_char(needle[0]) and start > 0
                    and _western_word_char(normalized[start - 1])):
                continue
            if (_western_word_char(needle[-1]) and end < len(normalized)
                    and _western_word_char(normalized[end])):
                continue
            return True
    return False


def _normalize_host(host: str) -> str | None:
    host = host.rstrip(".").lower()
    if not host or any(char.isspace() for char in host):
        return None
    try:
        return ipaddress.ip_address(host.strip("[]")).compressed
    except ValueError:
        pass
    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return None
    if len(ascii_host) > 253:
        return None
    labels = ascii_host.split(".")
    if any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", item)
           for item in labels):
        return None
    return ascii_host


def _split_http_url(url: str):
    if not isinstance(url, str) or not url:
        return None
    if any(ord(char) < 32 or char.isspace() for char in url) or "\\" in url:
        return None
    try:
        split = urlsplit(url)
        if split.scheme.lower() not in {"http", "https"}:
            return None
        if not split.hostname or split.username is not None or split.password is not None:
            return None
        host = _normalize_host(split.hostname)
        port = split.port  # Access validates malformed / out-of-range ports.
    except (ValueError, UnicodeError):
        return None
    if host is None:
        return None
    return split, host, port


def _normalize_percent_encoding(component: str, safe: str) -> str | None:
    if re.search(r"%(?![0-9a-fA-F]{2})", component):
        return None

    def replace(match):
        value = int(match.group(1), 16)
        decoded = chr(value)
        return decoded if decoded in UNRESERVED else "%" + match.group(1).upper()

    component = re.sub(r"%([0-9a-fA-F]{2})", replace, component)
    return quote(component, safe=safe + "%")


def canonicalize_url(url: str) -> str | None:
    """Conservative URL identity, without network access or inferred redirects.

    Remove fragments and recognized tracking parameters, normalize host/default
    ports and unreserved percent escapes. Preserve scheme, significant query
    order/values, path case, trailing slashes, and www-vs-bare host distinctions.
    This favors reviewable false negatives over unsupported identity merges.
    """
    parsed = _split_http_url(url)
    if parsed is None:
        return None
    split, host, port = parsed
    scheme = split.scheme.lower()
    netloc = "[" + host + "]" if ":" in host else host
    if port is not None and (scheme, port) not in {("http", 80), ("https", 443)}:
        netloc += ":" + str(port)
    path = _normalize_percent_encoding(split.path or "/", "/:@!$&'()*+,;=-._~")
    if path is None:
        return None
    retained = []
    for component in split.query.split("&") if split.query else []:
        key = unquote(component.split("=", 1)[0]).casefold()
        if key.startswith("utm_") or key in TRACKING_KEYS:
            continue
        normalized = _normalize_percent_encoding(component, "/?:@!$'()*+,;=-._~")
        if normalized is None:
            return None
        retained.append(normalized)
    return urlunsplit((scheme, netloc, path, "&".join(retained), ""))
