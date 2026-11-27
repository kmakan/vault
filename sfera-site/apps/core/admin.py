from django.contrib import admin

from .models import NavigationItem, Redirect, SiteProfile


@admin.register(SiteProfile)
class SiteProfileAdmin(admin.ModelAdmin):
    list_display = ("site", "locale", "brand_name", "is_active", "updated_at")
    list_filter = ("locale", "is_active")
    search_fields = ("site__domain", "brand_name")


@admin.register(NavigationItem)
class NavigationItemAdmin(admin.ModelAdmin):
    list_display = ("site", "location", "label", "url", "order", "is_active")
    list_filter = ("site", "location", "is_active")
    search_fields = ("label", "url")
    ordering = ("site", "location", "order")


@admin.register(Redirect)
class RedirectAdmin(admin.ModelAdmin):
    list_display = ("old_path", "new_path", "status_code", "site", "is_active")
    list_filter = ("status_code", "is_active", "site")
    search_fields = ("old_path", "new_path")
