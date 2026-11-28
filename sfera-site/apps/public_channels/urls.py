from django.urls import path

from . import views

app_name = "public_channels"

urlpatterns = [
    path("", views.PublicChannelListView.as_view(), name="list"),
    path("<str:channel_id>/", views.PublicChannelView.as_view(), name="detail"),
]
