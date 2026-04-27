from pathlib import Path

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_REPO_ROOT = Path(__file__).resolve().parents[3]
_ENV_FILE = _REPO_ROOT / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE) if _ENV_FILE.is_file() else None,
        env_file_encoding="utf-8",
        env_ignore_empty=True,
        extra="ignore",
    )

    # Loaded from API_HOST, API_PORT, CORS_ORIGINS (see repository root .env / .env.example)
    api_host: str | None = Field(default=None)
    api_port: int | None = Field(default=None)
    @field_validator("api_host", mode="before")
    @classmethod
    def default_api_host(cls, v):
        # Default to 0.0.0.0 for local/dev, None for Lambda
        return v if v is not None else ("0.0.0.0" if not cls._running_in_lambda() else None)

    @field_validator("api_port", mode="before")
    @classmethod
    def default_api_port(cls, v):
        # Default to 8000 for local/dev, None for Lambda
        return v if v is not None else (8000 if not cls._running_in_lambda() else None)

    @staticmethod
    def _running_in_lambda() -> bool:
        import os
        return bool(os.environ.get("AWS_LAMBDA_FUNCTION_NAME"))
    cors_origins: str
    deployment_environment: str | None = None
    # Chat completions: OPENROUTER_API_KEY when using OpenRouter; else OPENAI_API_KEY alone.
    openrouter_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("OPENROUTER_API_KEY", "openrouter_api_key"),
    )
    openai_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("OPENAI_API_KEY", "openai_api_key"),
    )

    auth_mode: str = "clerk_jwks"
    clerk_jwks_url: str | None = None
    clerk_issuer: str | None = None
    clerk_audience: str | None = None

    max_upload_bytes: int = 5 * 1024 * 1024
    max_text_chars: int = 80_000
    max_output_chars: int = 120_000

    @staticmethod
    def _lambda_path(path: str) -> str:
        import os
        if os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
            # Use /tmp for Lambda writable storage
            return f"/tmp/{Path(path).name}"
        return path

    sqlite_path: str = Field(default_factory=lambda: Settings._lambda_path(".data/talentstreamai.sqlite3"))
    upload_dir: str = Field(default_factory=lambda: Settings._lambda_path(".data/uploads"))
    sqlite_busy_timeout_ms: int = 5000
    sqlite_enable_wal: bool = True

    upload_storage: str = "none"
    s3_bucket: str | None = None
    s3_prefix: str = "uploads/"
    s3_sse: str = "AES256"
    s3_kms_key_id: str | None = None

    agent_mode: str = "stub"
    llm_base_url: str = "https://api.openai.com"
    llm_model: str = "gpt-4.1-mini"
    llm_timeout_seconds: float = 45.0
    llm_max_tokens: int = 1800
    llm_temperature: float = 0.2
    openrouter_referer: str | None = None
    openrouter_title: str | None = None

    # Product: reported match % for the AI-tailored resume (floor/cap; not a third-party ATS guarantee)
    min_tailored_match_score: int = 90
    max_reported_match_score: int = 99

    # --- Observability ---
    log_level: str = "INFO"
    log_json: bool = False
    enable_prometheus: bool = True
    request_id_header: str = "X-Request-Id"
    # Set to enable OpenTelemetry gRPC/HTTP export (requires optional otel packages)
    otel_exporter_otlp_endpoint: str | None = None
    service_name: str = "talentstreamai-api"
    # Langfuse (LLM traces; optional — leave unset for local/stub)
    langfuse_public_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("LANGFUSE_PUBLIC_KEY", "langfuse_public_key"),
    )
    langfuse_secret_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("LANGFUSE_SECRET_KEY", "langfuse_secret_key"),
    )
    langfuse_base_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "LANGFUSE_BASE_URL", "LANGFUSE_HOST", "langfuse_host"
        ),
    )
    langfuse_tracing_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices("LANGFUSE_TRACING_ENABLED", "langfuse_tracing_enabled"),
    )

    @property
    def cors_origins_list(self) -> list[str]:
        return [
            origin.strip() for origin in self.cors_origins.split(",") if origin.strip()
        ]

    @property
    def chat_completions_api_key(self) -> str | None:
        """Bearer for ``/v1/chat/completions``: ``OPENROUTER_API_KEY`` if set, else ``OPENAI_API_KEY``.

        With both set, OpenRouter is used for completions; keep ``OPENAI_API_KEY`` for other
        uses (e.g. tools). Langfuse uses only ``LANGFUSE_*`` keys, not OpenAI for tracing.
        """
        orv = (self.openrouter_api_key or "").strip()
        oai = (self.openai_api_key or "").strip()
        if orv:
            return orv
        if oai:
            return oai
        return None

    @field_validator("auth_mode", "agent_mode", "upload_storage", mode="before")
    @classmethod
    def _normalize_lower_modes(cls, value: str | None) -> str | None:
        if isinstance(value, str):
            return value.strip().lower()
        return value

    @field_validator("s3_sse", mode="before")
    @classmethod
    def _normalize_s3_sse(cls, value: str | None) -> str | None:
        if not isinstance(value, str):
            return value
        normalized = value.strip()
        if normalized.lower() == "aes256":
            return "AES256"
        if normalized.lower() == "aws:kms":
            return "aws:kms"
        return normalized


settings = Settings()
