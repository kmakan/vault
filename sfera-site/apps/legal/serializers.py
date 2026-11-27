from rest_framework import serializers

from .models import LegalDocument


class LegalDocumentSerializer(serializers.ModelSerializer):
    kind_label = serializers.CharField(source="get_kind_display", read_only=True)

    class Meta:
        model = LegalDocument
        fields = ("kind", "kind_label", "version", "effective_at", "title", "body_html", "updated_at")
