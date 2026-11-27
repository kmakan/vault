"""Host -> site profile resolution and legacy URL redirects."""

from __future__ import annotations

from django.conf import settings
from django.contrib.sites.models import Site
from django.http import HttpResponsePermanentRedirect, HttpResponseRedirect

from .models import Redirect, SiteProfile


class SiteProfileMiddleware:
    """Resolve the public site by host, not by a global SITE_ID.

    Both editions share one codebase and one database; the host chooses the
    editorial profile (locale, brand, navigation).
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        host = request.get_host().split(":")[0].lower()
        # SSR calls the API on localhost but must render a specific edition.
        # The header is internal-only; external hosts still resolve normally.
        internal_host = request.headers.get("X-Site-Host", "").split(":")[0].lower()
        if internal_host and request.path.startswith("/api/"):
            host = internal_host
        site = Site.objects.filter(domain__iexact=host).first()
        if site is None:
            site = Site.objects.filter(pk=getattr(settings, "SITE_ID", 1)).first()
        request.site = site
        profile = None
        if site is not None:
            profile = SiteProfile.objects.filter(site=site, is_active=True).first()
        request.site_profile = profile
        request.locale = profile.locale if profile else settings.LANGUAGE_CODE
        return self.get_response(request)


class LegacyRedirectMiddleware:
    """Apply data-driven redirects for old .html URLs.

    Runs after ``SiteProfileMiddleware`` so a redirect can be scoped to one
    edition. API, admin and static requests are never redirected.
    """

    SKIP_PREFIXES = ("/api/", "/admin/", "/static/", "/media/")

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        path = request.path
        if path.startswith(self.SKIP_PREFIXES):
            return self.get_response(request)
        rule = Redirect.objects.filter(old_path=path, is_active=True).first()
        if rule is None:
            return self.get_response(request)
        if rule.site_id is not None and request.site is not None and rule.site_id != request.site.id:
            return self.get_response(request)
        if rule.status_code == 301:
            return HttpResponsePermanentRedirect(rule.new_path)
        return HttpResponseRedirect(rule.new_path)
