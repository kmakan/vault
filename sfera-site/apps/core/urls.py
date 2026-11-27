from django.urls import path

from . import views

app_name = "core"

urlpatterns = [
    path("health/", views.HealthView.as_view(), name="health"),
    path("site/", views.SiteView.as_view(), name="site"),
]
