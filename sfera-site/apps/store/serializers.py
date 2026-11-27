from rest_framework import serializers

from .models import StoreListing


class StoreListingSerializer(serializers.ModelSerializer):
    class Meta:
        model = StoreListing
        fields = (
            "product",
            "title",
            "short_description",
            "full_description",
            "keywords",
            "category",
            "age_rating",
            "screenshots",
            "status",
            "updated_at",
        )
