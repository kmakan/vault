"""SEO endpoints: sitemap is wired in config.urls; robots is host-aware."""

from __future__ import annotations

from django.http import HttpResponse
from rest_framework.permissions import AllowAny
from rest_framework.views import APIView


class RobotsView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = []

    def get(self, request):
        site = getattr(request, "site", None)
        domain = site.domain if site is not None else "vault-msg.ru"
        body = "\n".join(
            [
                "User-agent: *",
                "Disallow: /admin/",
                "Disallow: /api/",
                "Allow: /",
                f"Sitemap: https://{domain}/sitemap.xml",
                "",
            ]
        )
        return HttpResponse(body, content_type="text/plain; charset=utf-8")
