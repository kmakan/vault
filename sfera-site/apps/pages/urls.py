from django.urls import path

from . import views

app_name = "pages"

urlpatterns = [
    path("", views.PageListView.as_view(), name="list"),
    path("<slug:slug>/", views.PageDetailView.as_view(), name="detail"),
]
