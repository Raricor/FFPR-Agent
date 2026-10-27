"""Keep API keys out of every log line and error message."""

import logging

MASK = "***"


class Redactor:
    def __init__(self) -> None:
        self._secrets: set[str] = set()

    def add(self, value: str) -> None:
        # Very short values would mask ordinary words; real API keys are long.
        if len(value) >= 6:
            self._secrets.add(value)

    def __call__(self, text: str) -> str:
        for secret in self._secrets:
            text = text.replace(secret, MASK)
        return text


class RedactingFilter(logging.Filter):
    def __init__(self, redactor: Redactor):
        super().__init__()
        self._redact = redactor

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = self._redact(record.getMessage())
        record.args = None
        return True


def install(redactor: Redactor) -> None:
    """Attach the redactor to every root handler."""
    for handler in logging.getLogger().handlers:
        handler.addFilter(RedactingFilter(redactor))
