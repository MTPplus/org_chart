"""Событийные хуки org_chart_mtp.

Инвалидация кэша get_org_data (Redis, per-scope) при изменении
Department / Employee / Goal / File / Org Chart Settings.

Кэш:
  * ключ  org_chart_data::<md5(permissions)> — на каждого скоупа видимости;
  * TTL 300 сек как страховка (структура меняется редко);
  * doc_events сбрасывают ВСЕ скоупы сразу — просто и надёжно
    (право «видеть больше» меняется вместе с Employee.reports_to,
    значит сам Employee-хук покрывает и смену скоупа).

Примечание: ранее здесь же жила серверная валидация JSON-поля
Department.custom_metrics — поле удалено в v0.3 (метрики отделов теперь
это Goal из hrms, закреплённая за отделом полем custom_department).
"""
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
