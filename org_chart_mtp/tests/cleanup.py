"""Создать/удалить OCMTP-фикстуры для тестов (bench console helper).

Запуск:
    bench --site mtp.local execute org_chart_mtp.tests.cleanup_ocmtp
"""
import frappe


def cleanup_ocmtp():
        """Удалить тестовые данные OCMTP/OCMTP2 (после упавших прогонов)."""
        for doctype, filters in [
                ("Goal", {"employee": ["like", "OCMTP-%"]}),
                ("Employee", {"name": ["like", "OCMTP-%"]}),
        ]:
                names = frappe.get_all(doctype, filters=filters, pluck="name")
                for name in names:
                        frappe.delete_doc(doctype, name, force=True, ignore_permissions=True)
                print(f"{doctype}: удалено {len(names)}")
        # Department — дерево: удалять снизу вверх (lft DESC — листья первыми)
        dept_names = frappe.get_all(
                "Department",
                filters={"name": ["like", "OCMTP%"]},
                pluck="name",
                order_by="lft desc",
        )
        for name in dept_names:
                frappe.delete_doc("Department", name, force=True, ignore_permissions=True)
        print(f"Department: удалено {len(dept_names)}")
        for doctype, filters in [
                ("KRA", {"name": ["like", "OCMTP%"]}),
        ]:
                names = frappe.get_all(doctype, filters=filters, pluck="name")
                for name in names:
                        frappe.delete_doc(doctype, name, force=True, ignore_permissions=True)
                print(f"{doctype}: удалено {len(names)}")
        for user in (
                "hr@ocmtp.test", "dir@ocmtp.test", "kam@ocmtp.test", "emp@ocmtp.test",
                "hr2@ocmtp.test", "dir2@ocmtp.test", "kam2@ocmtp.test", "emp2@ocmtp.test",
        ):
                if frappe.db.exists("User", user):
                        frappe.delete_doc("User", user, force=True, ignore_permissions=True)
                        print(f"User {user}: удалён")
        frappe.db.commit()
        print("cleanup_ocmtp: готово")
