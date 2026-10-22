"""Событийные хуки org_chart_mtp.

1. Инвалидация кэша get_org_data (Redis, per-scope) при изменении
   Department / Employee / Goal / File / Org Chart Settings +
   рассылка realtime-события открытым оргчартам (мягкое обновление).

2. Серверная валидация Department.custom_color (hex) — на validate,
   чтобы битый цвет не «молча» ломал плитки.

Кэш:
  * ключ  org_chart_data::<md5(permissions)> — на каждого скоупа видимости;
  * TTL 300 сек как страховка (структура меняется редко);
  * doc_events сбрасывают ВСЕ скоупы сразу — просто и надёжно
    (право «видеть больше» меняется вместе с Employee.reports_to,
    значит сам Employee-хук покрывает и смену скоупа).

Realtime:
  * событие org_chart_mtp_refresh публикуется всему сайту после коммита
    (after_commit=True) — открытые страницы перезагружают данные
    с debounce, не мешая текущему жесту пользователя.

Примечание: ранее здесь же жила серверная валидация JSON-поля
Department.custom_metrics — поле удалено в v0.3 (метрики отделов теперь
это Goal из hrms, закреплённая за отделом полем custom_department).
"""
import re

import frappe

# _ (перевод) вызывается как frappe._ — чтобы не ломать статические
# тесты со стаб-модулем frappe

CACHE_PREFIX = "org_chart_data"
CACHE_TTL = 300  # сек

# Имя realtime-события для клиента (org_chart_mtp.js слушает его же)
REALTIME_EVENT = "org_chart_mtp_refresh"

# Цвет плитки отдела: строго #RRGGBB
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def invalidate_cache(doc=None, method=None):
    """Сбросить кэш get_org_data для всех пользователей (все скоупы)."""
    try:
        frappe.cache().delete_keys(CACHE_PREFIX)
    except Exception:
        # кэш не критичен: в крайнем случае запись протухнет по TTL
        pass
    _broadcast_refresh()


def validate_color(doc, method=None):
    """Валидация hex-цвета Department.custom_color (поле «Цвет (hex)»).

    Некорректное значение ломало бы цвет плитки и заголовка в оргчарте
    молча — поэтому проверяем на validate и нормализуем к нижнему
    регистру. Пустое значение разрешено (будет нейтральный цвет).
    """
    color = (doc.get("custom_color") or "").strip()
    if not color:
        return
    if not HEX_COLOR_RE.match(color):
        frappe.throw(
            frappe._(
                "Некорректный цвет «{0}»: ожидается hex-формат #RRGGBB "
                "(например #2563eb)"
            ).format(color)
        )
    doc.custom_color = color.lower()


def _broadcast_refresh():
    """Сообщить открытым оргчартам, что данные изменились.

    after_commit=True: событие уходит только если транзакция завершилась
    успешно — открытые страницы не перерисовываются на откаченных данных.
    Ошибки realtime не должны ломать сохранение документа.
    """
    try:
        frappe.publish_realtime(
            REALTIME_EVENT,
            {"user": frappe.session.user},
            after_commit=True,
        )
    except Exception:
        pass  # realtime не критичен: у клиентов сработает TTL-страховка
