# org_chart_mtp v0.3 — раздел «метрики» отделов переведён на Goal из hrms.
#
# Кастомное JSON-поле Department.custom_metrics («Метрики») удалено из
# install.py: цели и метрики отдела теперь задаёт обычный Goal из hrms,
# закреплённый за отделом полем Goal.custom_department (см. install.py).
# Патч удаляет Custom Field с уже развёрнутых сайтов.
#
# Колонка tabDepartment.custom_metrics в БД не дропается намеренно:
# get_org_data больше не читает это поле, данные не покидают сервер,
# а ALTER TABLE на больших таблицах — дорогая и рискованная операция.
import frappe

FIELD_NAME = "Department-custom_metrics"


def execute():
	if frappe.db.exists("Custom Field", FIELD_NAME):
		frappe.delete_doc("Custom Field", FIELD_NAME, ignore_permissions=True, force=True)
		frappe.db.commit()
		print("org_chart_mtp v0.3: Custom Field Department-custom_metrics удалён")
	else:
		print("org_chart_mtp v0.3: Custom Field Department-custom_metrics не найден — пропуск")
