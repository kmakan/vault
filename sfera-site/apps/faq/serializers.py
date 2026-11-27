from rest_framework import serializers

from .models import FaqItem


class FaqItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = FaqItem
        fields = ("question", "answer_html", "order")
