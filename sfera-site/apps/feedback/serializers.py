from rest_framework import serializers

from .models import Feedback


class FeedbackSerializer(serializers.ModelSerializer):
    # Honeypot: real users never fill this hidden field.
    website = serializers.CharField(required=False, allow_blank=True, write_only=True)

    class Meta:
        model = Feedback
        fields = ("name", "email", "message", "page_url", "product", "website")

    def validate_message(self, value: str) -> str:
        value = value.strip()
        if len(value) < 10:
            raise serializers.ValidationError("Сообщение слишком короткое.")
        if len(value) > 8000:
            raise serializers.ValidationError("Сообщение слишком длинное.")
        return value

    def validate(self, attrs):
        attrs.pop("website", "")
        return attrs
