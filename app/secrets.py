from __future__ import annotations

from cryptography.fernet import Fernet

from .config import SECRET_PATH


def _key() -> bytes:
    if not SECRET_PATH.exists():
        SECRET_PATH.write_bytes(Fernet.generate_key())
        SECRET_PATH.chmod(0o600)
    return SECRET_PATH.read_bytes().strip()


def encrypt(value: str) -> str:
    return Fernet(_key()).encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    return Fernet(_key()).decrypt(value.encode()).decode()
