from django.contrib.sitemaps.views import sitemap
from django.urls import path

from . import views
from .seo import RobotsView
from .sitemaps import DocSitemap, LegalSitemap, PageSitemap, PublicChannelSitemap

app_name = "core"

sitemaps = {
    "pages": PageSitemap,
    "docs": DocSitemap,
    "legal": LegalSitemap,
    "public-channels": PublicChannelSitemap,
}

urlpatterns = [
    path("health/", views.HealthView.as_view(), name="health"),
    path("site/", views.SiteView.as_view(), name="site"),
]

# Mounted at the site root in config/urls.py.
seo_urlpatterns = [
    path("sitemap.xml", sitemap, {"sitemaps": sitemaps}, name="sitemap"),
    path("robots.txt", RobotsView.as_view(), name="robots"),
]
