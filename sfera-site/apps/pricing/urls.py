from django.urls import path

from . import views

app_name = "pricing"

urlpatterns = [path("", views.PlanListView.as_view(), name="list")]
