from django.urls import path

from . import views

app_name = "legal"

urlpatterns = [
    path("", views.LegalListView.as_view(), name="list"),
    path("<str:kind>/", views.LegalDetailView.as_view(), name="detail"),
]
