from __future__ import annotations

import hashlib

from django.conf import settings
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from .models import Feedback
from .serializers import FeedbackSerializer


class FeedbackThrottle(AnonRateThrottle):
    scope = "anon"


def _ip_hash(request) -> str:
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip()
    ip = forwarded or request.META.get("REMOTE_ADDR", "")
    return hashlib.sha256(f"{settings.SECRET_KEY}:{ip}".encode()).hexdigest()[:64]


class FeedbackCreateView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [FeedbackThrottle]

    def post(self, request):
        site = getattr(request, "site", None)
        if site is None:
            return Response({"error": {"code": "site_not_found", "message": "Host is not configured"}}, status=404)
        serializer = FeedbackSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        if request.data.get("website"):
            # Honeypot hit: accept silently, do not store.
            return Response({"ok": True}, status=status.HTTP_201_CREATED)
        Feedback.objects.create(
            site=site,
            product=serializer.validated_data.get("product") or "vault",
            name=serializer.validated_data.get("name", "")[:120],
            email=serializer.validated_data.get("email", ""),
            message=serializer.validated_data["message"],
            page_url=serializer.validated_data.get("page_url", ""),
            ip_hash=_ip_hash(request),
            user_agent=request.META.get("HTTP_USER_AGENT", "")[:500],
        )
        return Response({"ok": True}, status=status.HTTP_201_CREATED)
