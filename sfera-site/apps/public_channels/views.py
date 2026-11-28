"""Read-only public channel API backed by the verified Rust vitrine."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from urllib.parse import quote

from django.core.cache import cache
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import PublicChannelSource

CHANNEL_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
CACHE_SECONDS = 30


def configured_source() -> PublicChannelSource | None:
    return PublicChannelSource.objects.filter(is_enabled=True).order_by("id").first()


def unavailable() -> Response:
    return Response(
        {"error": {"code": "unavailable", "message": "Public channel source is unavailable"}},
        status=503,
    )


def source_cache_key(source: PublicChannelSource) -> str:
    return f"{source.pk}:{source.updated_at.timestamp()}"


def fetch_verified(path: str) -> dict:
    """Fetch JSON only from the configured local/trusted vitrine.

    Signature verification belongs to social-public. The channel id is
    validated and URL-quoted before it becomes part of the upstream URL.
    """
    source = configured_source()
    if source is None:
        raise LookupError("Public channel source is not configured")
    url = f"{source.base_url.rstrip('/')}{path}"
    try:
        with urllib.request.urlopen(url, timeout=source.timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
        raise ConnectionError("Public channel source is unavailable") from error


class PublicChannelListView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        source = configured_source()
        if source is None:
            return unavailable()
        key = f"public-channels:{source_cache_key(source)}"
        cached = cache.get(key)
        if cached is not None:
            return Response(cached)
        try:
            payload = fetch_verified("/sfera/public/channels")
        except (LookupError, ConnectionError):
            return unavailable()
        cache.set(key, payload, CACHE_SECONDS)
        return Response(payload)


class PublicChannelView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request, channel_id: str):
        if not CHANNEL_ID.fullmatch(channel_id):
            return Response({"error": {"code": "bad_channel", "message": "Invalid channel id"}}, status=404)
        source = configured_source()
        if source is None:
            return unavailable()
        key = f"public-channel:{source_cache_key(source)}:{channel_id}"
        cached = cache.get(key)
        if cached is not None:
            return Response(cached)
        try:
            payload = fetch_verified(f"/sfera/public/channels/{quote(channel_id, safe='')}")
        except (LookupError, ConnectionError):
            return unavailable()
        cache.set(key, payload, CACHE_SECONDS)
        return Response(payload)
