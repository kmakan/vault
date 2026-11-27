from rest_framework import serializers

from .models import DocPage


class DocTreeSerializer(serializers.ModelSerializer):
    children = serializers.SerializerMethodField()

    class Meta:
        model = DocPage
        fields = ("slug", "title", "summary", "product", "order", "children")

    def get_children(self, obj):
        children = [c for c in obj.children.all() if c.is_published]
        return DocTreeSerializer(children, many=True, context=self.context).data


class DocPageSerializer(serializers.ModelSerializer):
    class Meta:
        model = DocPage
        fields = ("slug", "title", "summary", "product", "body_html", "version", "updated_at", "parent")
