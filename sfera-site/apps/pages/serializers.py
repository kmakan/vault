from rest_framework import serializers

from .models import Page, PageBlock


class PageBlockSerializer(serializers.ModelSerializer):
    class Meta:
        model = PageBlock
        fields = ("key", "kind", "title", "subtitle", "body_html", "data", "order")


class PageSerializer(serializers.ModelSerializer):
    blocks = PageBlockSerializer(many=True, read_only=True)

    class Meta:
        model = Page
        fields = (
            "slug",
            "title",
            "subtitle",
            "seo_title",
            "seo_description",
            "canonical_path",
            "og_image_path",
            "body_html",
            "blocks",
            "updated_at",
        )


class PageSummarySerializer(serializers.ModelSerializer):
    class Meta:
        model = Page
        fields = ("slug", "title", "updated_at")
