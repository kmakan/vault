"""Public API for the two site editions."""

from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/v1/", include("apps.core.urls")),
    path("api/v1/pages/", include("apps.pages.urls")),
    path("api/v1/docs/", include("apps.docs.urls")),
    path("api/v1/releases/", include("apps.releases.urls")),
    path("api/v1/plans/", include("apps.pricing.urls")),
    path("api/v1/legal/", include("apps.legal.urls")),
    path("api/v1/faq/", include("apps.faq.urls")),
    path("api/v1/feedback/", include("apps.feedback.urls")),
    path("api/v1/public/channels/", include("apps.public_channels.urls")),
    path("api/v1/store/", include("apps.store.urls")),
]
