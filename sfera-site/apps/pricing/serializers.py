from rest_framework import serializers

from .models import Plan


class PlanSerializer(serializers.ModelSerializer):
    class Meta:
        model = Plan
        fields = (
            "code",
            "name",
            "price",
            "currency",
            "period",
            "limits",
            "features",
            "cta_label",
            "cta_url",
        )
