from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str
    ml_service_url: str = "http://ml-service:8001"
    upload_dir: str = "/data/uploads"
    cors_origins: str = "http://localhost:8080"
    jwt_secret: str = "change_me"
    jwt_algorithm: str = "HS256"
    jwt_expires_minutes: int = 480
    ingestion_api_key: str = "change_me_ingestion_key"
    admin_email: str = "admin@dans.ae"
    admin_password: str = "admin123"
    admin_name: str = "System Admin"
    engineer_email: str = "engineer@dans.ae"
    engineer_password: str = "engineer123"
    engineer_name: str = "DANS Engineer"
    engineer_department: str = "Operations"

    class Config:
        env_prefix = ""
        case_sensitive = False

settings = Settings()
