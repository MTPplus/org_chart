"""Тесты скоупов видимости: рядовой сотрудник / руководитель / HR.

Правила (без ролей, создаваемых страницей):
  HR     — должность из Org Chart Settings.hr_designations или нативная роль
           HR Manager / System Manager: видит все цели и цели отделов
  Менеджер — есть подчинённые (reports_to, рекурсивно): видит цели своей ветки
           и цели отделов своей ветки
  Сотрудник — видит структуру, но из целей только свои; цели отделов скрыты

Структура тестовых данных:
  OCMTP HQ (root, group)            — работает hr@ (должность «HR Manager»)
  ├─ OCMTP Sales (group, #2563eb)   — работает dir@ («Директор направления»)
  │   └─ OCMTP Sales West (leaf)    — работает kam@, reports_to → dir@
  └─ OCMTP Support (leaf)           — работает emp@ («Менеджер»)

Цели (личные): dir — 1, kam — 2, emp — 1, hr — 1  (итого 5)
Цели отделов: OCMTP Sales — 1, OCMTP Support — 1
"""
import frappe
from frappe.tests.utils import FrappeTestCase

from org_chart_mtp.install import _ensure_settings_defaults
from org_chart_mtp.org_chart.page.org_chart_mtp.org_chart_mtp import (
        get_employee_details,
        get_org_data,
)

HR_USER = "hr@ocmtp.test"
DIR_USER = "dir@ocmtp.test"
KAM_USER = "kam@ocmtp.test"
EMP_USER = "emp@ocmtp.test"
NEUTRAL = "#475569"


class TestOrgChartScopes(FrappeTestCase):
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
                        ("Goal", {"employee": ["like", "OCMTP-%"]}),
                        ("Employee", {"name": ["like", "OCMTP-%"]}),
                        ("Department", {"name": ["like", "OCMTP%"]}),
                        ("KRA", {"name": ["like", "OCMTP%"]}),
                ]:
                        for name in frappe.get_all(doctype, filters=filters, pluck="name"):
                                frappe.delete_doc(doctype, name, force=True, ignore_permissions=True)
                for user in (HR_USER, DIR_USER, KAM_USER, EMP_USER):
                        if frappe.db.exists("User", user):
                                frappe.delete_doc("User", user, force=True, ignore_permissions=True)
                frappe.db.commit()
                super().tearDownClass()

        def tearDown(self):
                frappe.set_user("Administrator")

        # --- HR: полный доступ через ДОЛЖНОСТЬ (роль не выдана) ---------------

        def test_hr_via_designation_sees_everything(self):
                frappe.set_user(HR_USER)
                data = get_org_data()
                perms = data["permissions"]
                self.assertTrue(perms["is_hr"], "HR-должность должна давать полный доступ")
                self.assertEqual(perms["current_designation"], "HR Manager")
                # Все 5 личных целей
                self.assertEqual(len(data["goals"]), 5)
                # Цели обоих отделов
                self.assertEqual(len(data["dept_goals"].get(self.sales, [])), 1)
                self.assertEqual(len(data["dept_goals"].get(self.support, [])), 1)

        def test_hr_via_native_role(self):
                """Нативная роль HR Manager тоже даёт полный доступ (без должности)."""
                user = frappe.get_doc("User", EMP_USER)
                user.add_roles("HR Manager")
                self.addCleanup(user.remove_roles, "HR Manager")
                frappe.set_user(EMP_USER)
                data = get_org_data()
                self.assertTrue(data["permissions"]["is_hr"])
                self.assertEqual(len(data["goals"]), 5)

        # --- Руководитель: своя ветка по reports_to ----------------------------

        def test_manager_sees_own_branch_only(self):
                frappe.set_user(DIR_USER)
                data = get_org_data()
                perms = data["permissions"]
                self.assertFalse(perms["is_hr"], "Директор — не HR")
                self.assertTrue(perms["is_manager"], "Есть подчинённый kam@")
                self.assertEqual(set(perms["visible_employee_ids"]), {self.dir_emp, self.kam_emp})
                # Цели: свои + подчинённого (1 + 2), но не emp@ и не hr@
                goal_owners = {g["employee"] for g in data["goals"]}
                self.assertEqual(goal_owners, {self.dir_emp, self.kam_emp})
                # Цели отделов: только отделы своей ветки (Sales, Sales West)
                self.assertIn(self.sales, data["dept_goals"])
                self.assertNotIn(self.support, data["dept_goals"])

        def test_regular_employee_without_subordinates_is_not_manager(self):
                frappe.set_user(KAM_USER)
                perms = get_org_data()["permissions"]
                self.assertFalse(perms["is_hr"])
                self.assertFalse(perms["is_manager"])
                self.assertEqual(perms["visible_employee_ids"], [self.kam_emp])

        # --- Рядовой сотрудник: только свои цели -------------------------------

        def test_employee_sees_only_own_goals(self):
                frappe.set_user(EMP_USER)
                data = get_org_data()
                self.assertEqual(len(data["goals"]), 1)
                self.assertEqual(data["goals"][0]["employee"], self.emp_emp)
                self.assertEqual(data["dept_goals"], {}, "Цели отделов рядовому скрыты")

        def test_structure_is_public_for_everyone(self):
                """Структура, ЦКП и сотрудники видны всем скоупам."""
                for user in (HR_USER, DIR_USER, KAM_USER, EMP_USER):
                        frappe.set_user(user)
                        data = get_org_data()
                        self.assertEqual(len(data["departments"]), 4, f"департаменты для {user}")
                        self.assertEqual(len(data["employees"]), 4, f"сотрудники для {user}")

        # --- Данные отделов: цвет, ЦКП, метрики -------------------------------

        def test_color_comes_from_department_field(self):
                frappe.set_user(EMP_USER)
                data = get_org_data()
                by_name = {d["name"]: d for d in data["departments"]}
                self.assertEqual(by_name[self.sales]["custom_color"], "#2563eb")
                # Нет цвета → нейтральный
                self.assertEqual(by_name[self.sales_west]["custom_color"], NEUTRAL)

        def test_kra_enrichment(self):
                frappe.set_user(EMP_USER)
                data = get_org_data()
                by_name = {d["name"]: d for d in data["departments"]}
                self.assertEqual(by_name[self.sales]["kra_title"], "Рост выручки продаж")
                self.assertEqual(by_name[self.support]["kra_title"], None)

        # --- Панель сотрудника: ограничения ------------------------------------

        def test_employee_details_restricted_for_strangers(self):
                frappe.set_user(EMP_USER)
                result = get_employee_details(self.dir_emp)
                self.assertTrue(result["restricted"])
                self.assertEqual(result["goals"], [])

        def test_employee_details_full_for_self(self):
                frappe.set_user(EMP_USER)
                result = get_employee_details(self.emp_emp)
                self.assertFalse(result["restricted"])
                self.assertEqual(len(result["goals"]), 1)

        def test_employee_details_full_for_manager_of_branch(self):
                frappe.set_user(DIR_USER)
                result = get_employee_details(self.kam_emp)
                self.assertFalse(result["restricted"])
                self.assertEqual(len(result["goals"]), 2)

        # --- Фикстуры -----------------------------------------------------------

        @classmethod
        def _make_data(cls):
                cls.company = cls._company()
                cls.kra = (
                        frappe.get_doc(
                                {
                                        "doctype": "KRA",
                                        "title": "OCMTP KRA Выручка",
                                        "description": "Увеличение выручки направления на 25% за год",
                                }
                        )
                        .insert(ignore_permissions=True)
                        .name
                )

                cls.hq = cls._dept("OCMTP HQ", None, is_group=1, color="#1f2937")
                cls.sales = cls._dept(
                        "OCMTP Sales",
                        cls.hq,
                        is_group=1,
                        color="#2563eb",
                        kra=cls.kra,
                        functions="Планирование продаж\nВедение ключевых клиентов",
                        wiki="https://wiki.example.test/sales",
                )
                cls.sales_west = cls._dept("OCMTP Sales West", cls.sales, is_group=0)
                cls.support = cls._dept(
                        "OCMTP Support",
                        cls.hq,
                        is_group=0,
                        color="#16a34a",
                        functions="Обработка обращений",
                )

                cls.hr_emp = cls._employee("hr@ocmtp.test", "Ольга", "Кадрова", "HR Manager", cls.hq)
                cls.dir_emp = cls._employee(
                        "dir@ocmtp.test", "Дмитрий", "Веткин", "Директор направления", cls.sales
                )
                cls.kam_emp = cls._employee(
                        "kam@ocmtp.test", "Ирина", "Клиентова", "KAM", cls.sales_west, reports_to=cls.dir_emp
                )
                cls.emp_emp = cls._employee("emp@ocmtp.test", "Пётр", "Опоров", "Менеджер", cls.support)

                cls._goal("План продаж ветки 120%", cls.dir_emp)
                cls._goal("Привлечь 5 новых клиентов", cls.kam_emp, progress=40)
                cls._goal("Продлить 10 контрактов", cls.kam_emp, progress=70)
                cls._goal("Закрыть 50 тикетов", cls.emp_emp, progress=55, dept=cls.support)
                cls._goal("Нанять 3 специалистов", cls.hr_emp, dept=cls.sales)

        @classmethod
        def _company(cls):
                existing = frappe.get_all("Company", pluck="name", limit=1)
                if existing:
                        return existing[0]
                return (
                        frappe.get_doc(
                                {
                                        "doctype": "Company",
                                        "company_name": "OCMTP Test Co",
                                        "abbr": "OTC",
                                        "default_currency": "RUB",
                                        "country": "Russia",
                                }
                        )
                        .insert(ignore_permissions=True)
                        .name
                )

        @classmethod
        def _dept(cls, name, parent, is_group=0, color=None, kra=None, functions=None, wiki=None):
                doc = frappe.get_doc(
                        {
                                "doctype": "Department",
                                "department_name": name,
                                "company": cls.company,
                                "parent_department": parent or "",
                                "is_group": is_group,
                                "custom_color": color,
                                "custom_kra": kra,
                                "custom_functions": functions,
                                "custom_wiki_url": wiki,
                        }
                ).insert(ignore_permissions=True)
                # Защита от окружений, где validate подставляет parent=самому себе
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
                                "naming_series": "OCMTP-",
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

        @classmethod
        def _goal(cls, name, employee, progress=10, dept=None):
                return (
                        frappe.get_doc(
                                {
                                        "doctype": "Goal",
                                        "goal_name": name,
                                        "employee": employee,
                                        "progress": progress,
                                        "start_date": "2026-01-01",
                                        "end_date": "2026-12-31",
                                        "custom_department": dept,
                                }
                        )
                        .insert(ignore_permissions=True)
                        .name
                )
