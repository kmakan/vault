from django.urls import path

from . import views

app_name = "store"

urlpatterns = [path("", views.StoreListingView.as_view(), name="list")]
