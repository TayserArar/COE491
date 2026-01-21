from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str
    ml_service_url: str = "http://ml-service:8001"
    upload_dir: str = "/data/uploads"
    cors_origins: str = "http://localhost:8080"

    class Config:
        env_prefix = ""
        case_sensitive = False

settings = Settings()
