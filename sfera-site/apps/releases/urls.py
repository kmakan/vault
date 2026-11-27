from django.urls import path

from . import views

app_name = "releases"

urlpatterns = [
    path("", views.ReleaseListView.as_view(), name="list"),
    path("latest/", views.LatestReleaseView.as_view(), name="latest"),
]
