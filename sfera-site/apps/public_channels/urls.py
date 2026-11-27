from django.urls import path

from . import views

app_name = "public_channels"

urlpatterns = [path("<str:channel_id>/", views.PublicChannelView.as_view(), name="detail")]
