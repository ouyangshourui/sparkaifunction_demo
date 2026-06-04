"""配置：从 .env / 环境变量读取。"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # —— 腾讯云混元 V3 签名 ——
    TENCENT_SECRET_ID: str = ""
    TENCENT_SECRET_KEY: str = ""
    HUNYUAN_HOST: str = "hunyuan.tencentcloudapi.com"
    DEFAULT_SMALL_MODEL: str = "hunyuan-lite"
    DEFAULT_LARGE_MODEL: str = "hunyuan-pro"

    SPARK_MASTER: str = "local[*]"
    WAREHOUSE_PATH: str = "./warehouse"
    STATE_TABLE: str = "ai_function_state"
    AIFN_JAR_PATH: str = "../spark-extension/target/aifn-spark-extension-0.1.0.jar"

    BATCH_MAX_SIZE: int = 16
    BATCH_MAX_WAIT_MS: int = 200
    QPS_LIMIT: int = 50
    TOKEN_BUDGET: int = 1_000_000


settings = Settings()
