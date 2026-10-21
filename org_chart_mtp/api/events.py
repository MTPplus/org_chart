"""Событийные хуки org_chart_mtp.

Инвалидация кэша get_org_data (Redis, per-scope) при изменении
Department / Employee / Goal / File / Org Chart Settings и
серверная валидация JSON-поля Department.custom_metrics.

Кэш:
  * ключ  org_chart_data::<md5(permissions)> — на каждого скоупа видимости;
  * TTL 300 сек как страховка (структура меняется редко);
  * doc_events сбрасывают ВСЕ скоупы сразу — просто и надёжно
    (право «видеть больше» меняется вместе с Employee.reports_to,
    значит сам Employee-хук покрывает и смену скоупа).
"""
import json

import frappe

# _ (перевод) вызывается как frappe._ — чтобы не ломать статические
# тесты со стаб-модулем frappe

CACHE_PREFIX = "org_chart_data"
CACHE_TTL = 300  # сек


def invalidate_cache(doc=None, method=None):
    """Сбросить кэш get_org_data для всех пользователей (все скоупы)."""
    try:
        frappe.cache().delete_keys(CACHE_PREFIX)
    except Exception:
        # кэш не критичен: в крайнем случае запись протухнет по TTL
        pass


def validate_department(doc, method=None):
    """Валидация Department.custom_metrics — JSON-список объектов-метрик.

    Формат: [{"name": "...", "current": "...", "target": "...",
              "unit": "...", "progress": 0-100}]
    Бросает frappe.throw с понятным сообщением (UI-валидация).
    """
    raw = doc.get("custom_metrics")
    if not raw:
        return

    expected = '[{"name": "...", "current": "...", "target": "...", "unit": "...", "progress": 50}]'

    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        frappe.throw(
            frappe._("Поле «Метрики» должно быть корректным JSON-списком вида {0}").format(
                "<code>{0}</code>".format(expected.replace("&", "&amp;").replace("<", "&lt;"))
            )
        )

    if not isinstance(data, list):
        frappe.throw(frappe._("Метрики должны быть JSON-списком объектов, получен {0}").format(type(data).__name__))

    for i, m in enumerate(data, 1):
        if not isinstance(m, dict):
            frappe.throw(frappe._("Метрика №{0}: должен быть объектом").format(i))
        if not (m.get("name") or "").strip():
            frappe.throw(frappe._("Метрика №{0}: не заполнено поле name").format(i))
        progress = m.get("progress", 0)
        if progress in (None, ""):
            progress = 0
        try:
            progress = float(progress)
        except (TypeError, ValueError):
            frappe.throw(frappe._("Метрика «{0}»: progress должен быть числом").format(m.get("name", i)))
        if progress < 0 or progress > 100:
            frappe.throw(
                frappe._("Метрика «{0}»: progress должен быть в диапазоне 0–100 (получено {1})").format(
                    m.get("name", i), progress
                )
            )
