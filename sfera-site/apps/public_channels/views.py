"""Proxy for the Rust public-channel vitrine.

Django does not verify Ed25519 signatures here. ``social-public`` does that
before serving JSON; this view only fetches and caches the verified payload.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

from django.core.cache import cache
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import PublicChannelSource

CHANNEL_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
CACHE_SECONDS = 30


class PublicChannelView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request, channel_id: str):
        if not CHANNEL_ID.fullmatch(channel_id):
            return Response({"error": {"code": "bad_channel", "message": "Invalid channel id"}}, status=404)
        source = PublicChannelSource.objects.filter(is_enabled=True).order_by("id").first()
        if source is None:
            return Response(
                {"error": {"code": "unavailable", "message": "Public channel source is not configured"}},
                status=503,
            )
        key = f"public-channel:{source.pk}:{channel_id}"
        cached = cache.get(key)
        if cached is not None:
            return Response(cached)
        url = f"{source.base_url.rstrip('/')}/sfera/public/channels/{channel_id}"
        try:
            with urllib.request.urlopen(url, timeout=source.timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError, OSError):
            return Response(
                {"error": {"code": "unavailable", "message": "Public channel source is unavailable"}},
                status=503,
            )
        cache.set(key, payload, CACHE_SECONDS)
        return Response(payload)
