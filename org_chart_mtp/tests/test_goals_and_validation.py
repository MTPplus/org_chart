"""Тесты создания целей (create_goal) и валидации цвета отдела.

Права создания (требование: «только HR или вышестоящий начальник»):
  * личная цель: HR — любому; руководитель — подчинённому;
    сам себе сотрудник назначить цель не может; рядовой — никому
  * цель отдела: HR — в любой отдел; руководитель — в отдел своей ветки;
    рядовой — никуда

Валидация: Department.custom_color обязан быть hex #RRGGBB
(пустое значение разрешено — нейтральный цвет на плитке).

Структура тестовых данных — см. test_scopes.py (те же OCMTP-* фикстуры).
"""
import frappe
from frappe.tests.utils import FrappeTestCase

from org_chart_mtp.install import _ensure_settings_defaults
from org_chart_mtp.org_chart.page.org_chart_mtp.org_chart_mtp import (
        create_goal,
        get_org_data,
)

HR_USER = "hr2@ocmtp.test"
DIR_USER = "dir2@ocmtp.test"
KAM_USER = "kam2@ocmtp.test"
EMP_USER = "emp2@ocmtp.test"


class TestGoalCreation(FrappeTestCase):
        @classmethod
        def setUpClass(cls):
                super().setUpClass()
                _ensure_settings_defaults()
                cls._make_data()
                frappe.db.commit()

        @classmethod
        def tearDownClass(cls):
                frappe.set_user("Administrator")
                for doctype, filters in [
                        ("Goal", {"employee": ["like", "OCMTP2-%"]}),
                        ("Employee", {"name": ["like", "OCMTP2-%"]}),
                ]:
                        for name in frappe.get_all(doctype, filters=filters, pluck="name"):
                                frappe.delete_doc(doctype, name, force=True, ignore_permissions=True)
                # Department — дерево: удалять снизу вверх (lft DESC)
                for name in frappe.get_all(
                        "Department",
                        filters={"name": ["like", "OCMTP2%"]},
                        pluck="name",
                        order_by="lft desc",
                ):
                        frappe.delete_doc("Department", name, force=True, ignore_permissions=True)
                for name in frappe.get_all("KRA", filters={"name": ["like", "OCMTP2%"]}, pluck="name"):
                        frappe.delete_doc("KRA", name, force=True, ignore_permissions=True)
                for user in (HR_USER, DIR_USER, KAM_USER, EMP_USER):
                        if frappe.db.exists("User", user):
                                frappe.delete_doc("User", user, force=True, ignore_permissions=True)
                frappe.db.commit()
                super().tearDownClass()

        def tearDown(self):
                frappe.set_user("Administrator")

        # --- HR: полный доступ ----------------------------------------------

        def test_hr_creates_personal_goal_for_anyone(self):
                frappe.set_user(HR_USER)
                result = create_goal(
                        goal_name="OCMTP2: HR ставит цель чужому сотруднику",
                        employee=self.kam_emp,
                )
                self.assertTrue(result["name"].startswith("HR-GOAL"))
                goal = frappe.get_doc("Goal", result["name"])
                self.assertEqual(goal.employee, self.kam_emp)
                self.assertEqual(goal.status, "Pending")

        def test_hr_creates_dept_goal(self):
                frappe.set_user(HR_USER)
                result = create_goal(
                        goal_name="OCMTP2: цель отдела от HR",
                        employee=self.emp_emp,
                        custom_department=self.support,
                        status="In Progress",
                        progress=20,
                )
                goal = frappe.get_doc("Goal", result["name"])
                self.assertEqual(goal.custom_department, self.support)
                self.assertEqual(goal.status, "In Progress")
                self.assertEqual(goal.progress, 20)

        # --- Руководитель: своя ветка ---------------------------------------

        def test_manager_creates_goal_for_subordinate(self):
                frappe.set_user(DIR_USER)
                result = create_goal(
                        goal_name="OCMTP2: руководитель ставит цель подчинённому",
                        employee=self.kam_emp,
                )
                self.assertTrue(result["name"])

        def test_manager_creates_dept_goal_in_own_branch(self):
                frappe.set_user(DIR_USER)
                result = create_goal(
                        goal_name="OCMTP2: цель отдела своей ветки",
                        employee=self.kam_emp,
                        custom_department=self.sales_west,
                )
                self.assertTrue(result["name"])

        def test_manager_cannot_create_dept_goal_outside_branch(self):
                frappe.set_user(DIR_USER)
                with self.assertRaises(frappe.PermissionError):
                        create_goal(
                                goal_name="OCMTP2: чужой отдел",
                                employee=self.emp_emp,
                                custom_department=self.support,
                        )

        def test_manager_cannot_create_goal_outside_branch(self):
                frappe.set_user(DIR_USER)
                with self.assertRaises(frappe.PermissionError):
                        create_goal(
                                goal_name="OCMTP2: чужой сотрудник",
                                employee=self.emp_emp,
                        )

        # --- Рядовой: нельзя вовсе ------------------------------------------

        def test_employee_cannot_create_goal_for_self(self):
                frappe.set_user(EMP_USER)
                with self.assertRaises(frappe.PermissionError):
                        create_goal(
                                goal_name="OCMTP2: сам себе",
                                employee=self.emp_emp,
                        )

        def test_employee_cannot_create_goal_for_others(self):
                frappe.set_user(EMP_USER)
                with self.assertRaises(frappe.PermissionError):
                        create_goal(
                                goal_name="OCMTP2: чужая",
                                employee=self.kam_emp,
                        )

        def test_employee_cannot_create_dept_goal(self):
                frappe.set_user(EMP_USER)
                with self.assertRaises(frappe.PermissionError):
                        create_goal(
                                goal_name="OCMTP2: отдел",
                                employee=self.emp_emp,
                                custom_department=self.support,
                        )

        # --- Мультикомпанийность в ответе API --------------------------------

        def test_org_data_contains_company_fields(self):
                frappe.set_user(EMP_USER)
                data = get_org_data()
                # Список компаний пришёл (на тестовом сайте есть минимум одна)
                self.assertIsInstance(data["companies"], list)
                self.assertTrue(len(data["companies"]) >= 1)
                # У сотрудников есть поле company (фильтр на клиенте)
                for emp in data["employees"]:
                        self.assertIn("company", emp)
                # Рядовому сотруднику нельзя добавлять цели никуда
                self.assertEqual(data["goal_editable_depts"], [])
                # Опции статуса — из doctype Goal
                self.assertIn("Pending", data["goal_status_options"])

        def test_manager_gets_goal_editable_depts(self):
                frappe.set_user(DIR_USER)
                data = get_org_data()
                self.assertIn(self.sales, data["goal_editable_depts"])
                self.assertIn(self.sales_west, data["goal_editable_depts"])
                self.assertNotIn(self.support, data["goal_editable_depts"])

        # --- Фикстуры -----------------------------------------------------------

        @classmethod
        def _make_data(cls):
                cls.company = cls._company()
                cls.kra = (
                        frappe.get_doc(
                                {
                                        "doctype": "KRA",
                                        "title": "OCMTP2 KRA Выручка",
                                        "description": "Увеличение выручки направления на 25% за год",
                                }
                        )
                        .insert(ignore_permissions=True)
                        .name
                )

                cls.hq = cls._dept("OCMTP2 HQ", None, is_group=1, color="#1f2937")
                cls.sales = cls._dept(
                        "OCMTP2 Sales", cls.hq, is_group=1, color="#2563eb", kra=cls.kra
                )
                cls.sales_west = cls._dept("OCMTP2 Sales West", cls.sales, is_group=0)
                cls.support = cls._dept(
                        "OCMTP2 Support", cls.hq, is_group=0, color="#16a34a"
                )

                cls.hr_emp = cls._employee("hr2@ocmtp.test", "Ольга", "Кадрова", "HR Manager", cls.hq)
                cls.dir_emp = cls._employee(
                        "dir2@ocmtp.test", "Дмитрий", "Веткин", "Директор направления", cls.sales
                )
                cls.kam_emp = cls._employee(
                        "kam2@ocmtp.test", "Ирина", "Клиентова", "KAM", cls.sales_west,
                        reports_to=cls.dir_emp,
                )
                cls.emp_emp = cls._employee("emp2@ocmtp.test", "Пётр", "Опоров", "Менеджер", cls.support)

        @classmethod
        def _company(cls):
                existing = frappe.get_all("Company", pluck="name", limit=1)
                if existing:
                        return existing[0]
                return (
                        frappe.get_doc(
                                {
                                        "doctype": "Company",
                                        "company_name": "OCMTP2 Test Co",
                                        "abbr": "OT2",
                                        "default_currency": "RUB",
                                        "country": "Russia",
                                }
                        )
                        .insert(ignore_permissions=True)
                        .name
                )

        @classmethod
        def _dept(cls, name, parent, is_group=0, color=None, kra=None):
                doc = frappe.get_doc(
                        {
                                "doctype": "Department",
                                "department_name": name,
                                "company": cls.company,
                                "parent_department": parent or "",
                                "is_group": is_group,
                                "custom_color": color,
                                "custom_kra": kra,
                        }
                ).insert(ignore_permissions=True)
                if not parent and doc.parent_department and doc.parent_department == doc.name:
                        frappe.db.set_value(
                                "Department", doc.name, "parent_department", None, update_modified=False
                        )
                return doc.name

        @classmethod
        def _employee(cls, email, first, last, designation, department, reports_to=None):
                if not frappe.db.exists("Designation", designation):
                        frappe.get_doc(
                                {"doctype": "Designation", "designation_name": designation}
                        ).insert(ignore_permissions=True)
                if not frappe.db.exists("User", email):
                        frappe.get_doc(
                                {
                                        "doctype": "User",
                                        "email": email,
                                        "first_name": first,
                                        "last_name": last,
                                        "roles": [{"role": "Employee"}],
                                        "send_welcome_email": 0,
                                }
                        ).insert(ignore_permissions=True)
                doc = frappe.get_doc(
                        {
                                "doctype": "Employee",
                                "naming_series": "OCMTP2-",
                                "first_name": first,
                                "last_name": last,
                                "company": cls.company,
                                "designation": designation,
                                "department": department,
                                "reports_to": reports_to,
                                "date_of_joining": "2024-01-15",
                                "date_of_birth": "1990-01-01",
                                "gender": "Female" if len(first) % 2 else "Male",
                                "user_id": email,
                                "status": "Active",
                        }
                ).insert(ignore_permissions=True)
                return doc.name


class TestDepartmentColorValidation(FrappeTestCase):
        """hex-валидация Department.custom_color (цвет плитки оргчарта)."""

        def _dept(self, name, color):
                if frappe.db.exists("Department", name):
                        frappe.delete_doc("Department", name, force=True, ignore_permissions=True)
                return frappe.get_doc(
                        {
                                "doctype": "Department",
                                "department_name": name,
                                "company": (frappe.get_all("Company", pluck="name", limit=1) or [""])[0],
                                "is_group": 0,
                                "custom_color": color,
                        }
                )

        def test_valid_hex_passes_and_normalizes(self):
                doc = self._dept("OCMTP2 Color Valid", "#25ACDE")
                doc.insert(ignore_permissions=True)
                self.addCleanup(
                        lambda: frappe.delete_doc(
                                "Department", doc.name, force=True, ignore_permissions=True
                        )
                )
                self.assertEqual(doc.custom_color, "#25acde")

        def test_empty_color_is_allowed(self):
                doc = self._dept("OCMTP2 Color Empty", "")
                doc.insert(ignore_permissions=True)
                self.addCleanup(
                        lambda: frappe.delete_doc(
                                "Department", doc.name, force=True, ignore_permissions=True
                        )
                )
                self.assertFalse(doc.custom_color)

        def test_invalid_hex_throws(self):
                for bad in ("2563eb", "#25", "#GGGGGG", "red", "#12345", "#1234567"):
                        doc = self._dept("OCMTP2 Color Bad", bad)
                        with self.assertRaises(frappe.ValidationError):
                                doc.insert(ignore_permissions=True)

        def test_update_existing_department_with_bad_color_throws(self):
                doc = self._dept("OCMTP2 Color Update", "#2563eb")
                doc.insert(ignore_permissions=True)
                self.addCleanup(
                        lambda: frappe.delete_doc(
                                "Department", doc.name, force=True, ignore_permissions=True
                        )
                )
                doc.custom_color = "зелёный"
                with self.assertRaises(frappe.ValidationError):
                        doc.save(ignore_permissions=True)
