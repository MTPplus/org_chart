"""
Удаление org_chart_mtp: чистим созданные нами Custom Field.

Внимание: значения полей (цвета, функции, ссылки, метрики) при удалении
приложения теряются. Отменить удаление полей можно, закомментировав
before_uninstall в hooks.py перед `bench --site X uninstall-app`.
"""
import frappe

from org_chart_mtp.install import ALL_CUSTOM_FIELDS


def before_uninstall():
	for doctype, fields in ALL_CUSTOM_FIELDS.items():
		fieldnames = [f["fieldname"] for f in fields]
		existing = frappe.get_all(
			"Custom Field",
			filters={"dt": doctype, "fieldname": ["in", fieldnames]},
			pluck="name",
		)
		for name in existing:
			frappe.delete_doc("Custom Field", name, ignore_permissions=True, force=True)
