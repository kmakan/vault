from rest_framework import serializers

from .models import Release


class ReleaseSerializer(serializers.ModelSerializer):
    class Meta:
        model = Release
        fields = (
            "platform",
            "channel",
            "version",
            "url",
            "sha256",
            "size",
            "requirements",
            "cta_label",
            "secondary_url",
            "secondary_label",
            "notes_html",
            "published_at",
        )
