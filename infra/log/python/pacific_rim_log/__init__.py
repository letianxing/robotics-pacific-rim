import logging
from typing import Any

from pacific_rim_trace import get_active_trace_ids


def _logger() -> logging.Logger:
  if not logging.getLogger().handlers:
    logging.basicConfig(level=logging.INFO)
  return logging.getLogger("pacific-rim")


def emit_log(message: str, level: int = logging.INFO, attributes: dict[str, Any] | None = None) -> None:
  fields = {
    **get_active_trace_ids(),
    **(attributes or {}),
  }
  _logger().log(level, message, extra=fields)


def info(message: str, attributes: dict[str, Any] | None = None) -> None:
  emit_log(message, logging.INFO, attributes)


def warn(message: str, attributes: dict[str, Any] | None = None) -> None:
  emit_log(message, logging.WARNING, attributes)


def error(message: str, attributes: dict[str, Any] | None = None) -> None:
  emit_log(message, logging.ERROR, attributes)
