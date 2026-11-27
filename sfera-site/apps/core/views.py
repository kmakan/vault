"""Core API: health, site profile and navigation."""

from __future__ import annotations

from django.db import connection
from django.db.utils import OperationalError
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import NavigationItem


class HealthView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = []

    def get(self, request):
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                cursor.fetchone()
            database = "ok"
        except OperationalError:
            database = "unavailable"
        return Response({"ok": database == "ok", "database": database})


class SiteView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        site = getattr(request, "site", None)
        profile = getattr(request, "site_profile", None)
        if site is None:
            return Response({"error": {"code": "site_not_found", "message": "Host is not configured"}}, status=404)
        nav = NavigationItem.objects.filter(site=site, is_active=True)
        return Response(
            {
                "site": {
                    "domain": site.domain,
                    "name": site.name,
                    "locale": getattr(request, "locale", "ru"),
                    "brand": profile.brand_name if profile else site.name,
                    "tagline": profile.tagline if profile else "",
                    "contact_email": profile.contact_email if profile else "",
                    "default_seo_title": profile.default_seo_title if profile else "",
                    "default_seo_description": profile.default_seo_description if profile else "",
                    "og_image_path": profile.og_image_path if profile else "",
                    "theme_color": profile.theme_color if profile else "#f59e0b",
                },
                "navigation": {
                    "header": [
                        {"label": item.label, "url": item.url, "external": item.is_external}
                        for item in nav.filter(location=NavigationItem.Location.HEADER)
                    ],
                    "footer": [
                        {"label": item.label, "url": item.url, "external": item.is_external}
                        for item in nav.filter(location=NavigationItem.Location.FOOTER)
                    ],
                    "legal": [
                        {"label": item.label, "url": item.url, "external": item.is_external}
                        for item in nav.filter(location=NavigationItem.Location.LEGAL)
                    ],
                },
            }
        )
