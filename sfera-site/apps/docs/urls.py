from django.urls import path

from . import views

app_name = "docs"

urlpatterns = [
    path("tree/", views.DocTreeView.as_view(), name="tree"),
    path("<slug:slug>/", views.DocDetailView.as_view(), name="detail"),
]
