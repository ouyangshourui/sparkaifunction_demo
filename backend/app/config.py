"""配置：从 .env / 环境变量读取。"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # —— 大模型 OpenAI 兼容协议 ——
    # 仅需 ApiKey + BaseUrl；默认指向腾讯混元 OpenAI 兼容端点。
    HUNYUAN_API_KEY: str = ""
    HUNYUAN_BASE_URL: str = "https://api.hunyuan.cloud.tencent.com/v1"
    DEFAULT_SMALL_MODEL: str = "minimax-m3"
    DEFAULT_LARGE_MODEL: str = "minimax-m3"

    SPARK_MASTER: str = "local[*]"
    WAREHOUSE_PATH: str = "./warehouse"
    STATE_TABLE: str = "ai_function_state"
    AIFN_JAR_PATH: str = "../spark-extension/target/aifn-spark-extension-0.1.0.jar"
    AIFN_DEMO_MODE: str = "auto"

    BATCH_MAX_SIZE: int = 16
    BATCH_MAX_WAIT_MS: int = 200
    QPS_LIMIT: int = 50
    TOKEN_BUDGET: int = 1_000_000


settings = Settings()
