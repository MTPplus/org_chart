"""
Org Chart Page — бэкенд org_chart_mtp.

Данные оргструктуры через whitelisted API с учётом прав доступа.

Правила видимости (БЕЗ ролей, создаваемых страницей):
  * Полный доступ («HR-представление»):
      - пользователь с ролью HR Manager / System Manager (нативные роли), ИЛИ
      - сотрудник, чья должность (Employee.designation) перечислена в
        настройке Org Chart Settings.hr_designations
  * Руководитель (Manager):
      - у сотрудника есть подчинённые (рекурсивно по Employee.reports_to);
      - видит цели/метрики себя и своей ветки подчинённых,
        цели отделов своих подчинённых
  * Рядовой сотрудник:
      - видит структуру, контакты и ЦКП/функции отделов (публично),
        но из целей — только свои

Цвет плитки отдела берётся ТОЛЬКО из Department.custom_color (hex-строка).
Если поле не заполнено — нейтральный #475569.

Кастомные поля создаются автоматически при install/migrate (install.py).
"""
import hashlib
import json

import frappe

# _ (перевод) вызывается как frappe._ — чтобы не ломать статические
# тесты со стаб-модулем frappe (см. ci_tests/frappe_stub.py)

NEUTRAL_COLOR = "#475569"
FULL_ACCESS_ROLES = {"HR Manager", "System Manager"}

# Кэш get_org_data (Redis, per-scope). TTL — страховка: основная
# инвалидация — по doc_events (см. api/events.py и hooks.py).
CACHE_PREFIX = "org_chart_data"
CACHE_TTL = 300  # сек


def get_context(context):
        """Контекст шаблона страницы."""
        context.title = frappe._("Оргструктура компании")


@frappe.whitelist()
def get_org_data():
        """Все данные оргчарта одним запросом — с учётом прав доступа.

        Результат кэшируется в Redis per-scope (ключ = хеш прав видимости),
        инвалидация — doc_events на Department/Employee/Goal/File/Settings.
        """
        try:
                perms = _get_permissions()
                cache_key = _cache_key(perms)
                try:
                        cached = frappe.cache().get_value(cache_key)
                except Exception:
                        cached = None
                if cached:
                        return json.loads(cached)

                result = _get_org_data_impl(perms)

                try:
                        frappe.cache().set_value(
                                cache_key,
                                json.dumps(result, default=str),
                                expires_in_sec=CACHE_TTL,
                        )
                except Exception:
                        pass  # кэш не критичен — отдаём без записи
                return result
        except Exception as e:
                frappe.log_error(f"org_chart get_org_data error: {e}")
                return {
                        "departments": [],
                        "employees": [],
                        "attachments": [],
                        "goals": [],
                        "dept_goals": {},
                        "permissions": _empty_permissions(),
                        "settings": _default_settings(),
                        "error": str(e),
                }


def _cache_key(perms):
        """Ключ кэша per-scope: хеш полного набора прав видимости."""
        payload = json.dumps(perms, sort_keys=True, ensure_ascii=False)
        return f"{CACHE_PREFIX}::{hashlib.md5(payload.encode('utf-8')).hexdigest()}"


def _get_org_data_impl(perms=None):
        if perms is None:
                perms = _get_permissions()

        # === 1. Департаменты ===
        dept_fields = [
                "name",
                "department_name",
                "parent_department",
                "is_group",
                "company",
        ]
        custom_fields = [
                "custom_color",
                "custom_functions",
                "custom_wiki_url",
                "custom_folder_url",
                "custom_kra",
                "custom_metrics",
        ]
        for cf in custom_fields:
                if frappe.db.has_column("Department", cf):
                        dept_fields.append(cf)

        departments = frappe.get_all(
                "Department",
                fields=dept_fields,
                filters={"disabled": 0},
                order_by="lft asc",
                limit_page_length=0,
        )

        # === 1a. ЦКП из KRA ===
        kra_names = {d.get("custom_kra") for d in departments if d.get("custom_kra")}
        kra_map = {}
        if kra_names and frappe.db.exists("DocType", "KRA"):
                for row in frappe.get_all(
                        "KRA",
                        fields=["name", "title", "description"],
                        filters={"name": ["in", list(kra_names)]},
                ):
                        kra_map[row.name] = row
        for dept in departments:
                kra = kra_map.get(dept.get("custom_kra"))
                dept["kra_title"] = kra.title if kra else None
                dept["kra_description"] = (kra.description if kra else None) or ""
                if not dept.get("custom_color"):
                        dept["custom_color"] = NEUTRAL_COLOR

        # === 1b. Цели отделов (Goal.custom_department) — со скоупом ===
        visible_depts = _visible_departments(perms, departments)
        dept_goals = _get_dept_goals(visible_depts)

        # === 1c. Метрики — ЦЕЛЫЙ отдел без права их не получает ===
        # ЦКП (kra_title/kra_description) остаётся публичным для всех,
        # метрики вырезаются сервером: HR — все отделы, руководитель —
        # отделы своей ветки, рядовой сотрудник — никаких.
        metrics_depts = _metrics_allowed_depts(perms, departments, visible_depts)
        _strip_metrics(departments, metrics_depts)

        # === 2. Сотрудники (структура и контакты публичны) ===
        employees = frappe.get_all(
                "Employee",
                fields=[
                        "name",
                        "employee_number",
                        "employee_name",
                        "department",
                        "designation",
                        "reports_to",
                        "status",
                        "image",
                        "date_of_joining",
                        "user_id",
                        "cell_number",
                ],
                filters={"status": "Active"},
                limit_page_length=0,
        )

        # === 3. Вложения (отделы — всем; сотрудники — по скоупу) ===
        attachments = _get_attachments(perms, departments)

        # === 4. Цели сотрудников — со скоупом ===
        goals = _get_goals(perms)

        return {
                "departments": departments,
                "employees": employees,
                "attachments": attachments,
                "goals": goals,
                "dept_goals": dept_goals,
                "permissions": perms,
                "settings": _get_settings(),
        }


# ---------------------------------------------------------------------------
# Права доступа
# ---------------------------------------------------------------------------


def _get_permissions():
        """Вычислить права текущего пользователя.

        is_hr      — полный доступ (нативные роли HR Manager/System Manager или
                     должность из Org Chart Settings.hr_designations)
        is_manager — есть подчинённые (рекурсивно по reports_to)
        """
        user = frappe.session.user
        roles = set(frappe.get_roles(user))

        current_employee = frappe.db.get_value("Employee", {"user_id": user}, "name")
        designation = None
        if current_employee:
                designation = frappe.db.get_value("Employee", current_employee, "designation")

        is_hr = bool(roles & FULL_ACCESS_ROLES)
        if not is_hr and designation:
                hr_designations = _hr_designations_set()
                if designation in hr_designations:
                        is_hr = True

        visible_employee_ids = set()
        if current_employee:
                visible_employee_ids = _get_subordinates(current_employee)
                visible_employee_ids.add(current_employee)

        return {
                "is_hr": is_hr,
                "is_manager": len(visible_employee_ids) > 1,
                "current_employee": current_employee,
                "current_designation": designation,
                "visible_employee_ids": list(visible_employee_ids),
        }


def _empty_permissions():
        return {
                "is_hr": False,
                "is_manager": False,
                "current_employee": None,
                "current_designation": None,
                "visible_employee_ids": [],
        }


def _hr_designations_set():
        """Набор HR-должностей из настроек (по строке)."""
        raw = frappe.db.get_single_value("Org Chart Settings", "hr_designations") or ""
        return {line.strip() for line in raw.splitlines() if line.strip()}


def _get_subordinates(manager_id):
        """Все подчинённые менеджера рекурсивно по reports_to.

        CEO → CFO → Accountant;  CEO → Head Sales → KAM
            _get_subordinates("CEO")  = {CFO, Accountant, Head Sales, KAM}
            _get_subordinates("CFO")  = {Accountant}
            _get_subordinates("KAM")  = {} (нет подчинённых)
        """
        result = set()
        queue = [manager_id]
        while queue:
                current = queue.pop(0)
                for name in frappe.get_all(
                        "Employee",
                        filters={"reports_to": current, "status": "Active"},
                        pluck="name",
                ):
                        if name not in result:
                                result.add(name)
                                queue.append(name)
        return result


def _visible_departments(perms, departments):
        """Отделы, чьи цели видит пользователь.

        HR — все; руководитель — отделы себя и подчинённых; сотрудник — ничего
        (цели отделов для рядовых скрыты).
        """
        if perms["is_hr"]:
                return [d["name"] for d in departments]
        if not perms["is_manager"]:
                return []
        emp_names = set(perms["visible_employee_ids"])
        dept_names = {
                dept
                for dept in frappe.get_all(
                        "Employee", filters={"name": ["in", list(emp_names)]}, pluck="department"
                )
                if dept
        }
        return [d["name"] for d in departments if d["name"] in dept_names]


def _metrics_allowed_depts(perms, departments, visible_depts):
        """Отделы, чьи МЕТРИКИ видит пользователь.

        Правило «ЦКП — всем, метрики — по праву»:
          * HR — все отделы;
          * руководитель — отделы своей ветки (visible_depts);
          * рядовой сотрудник — пустое множество.
        """
        if perms["is_hr"]:
                return {d["name"] for d in departments}
        if perms["is_manager"]:
                return set(visible_depts)
        return set()


def _strip_metrics(departments, allowed_depts):
        """Вырезать custom_metrics у отделов вне allowed_depts.

        Выполняется на сервере ДО отдачи клиенту: метрики не должны
        попадать в браузер пользователей без права, даже если интерфейс
        их не показывает.
        """
        for dept in departments:
                if dept.get("name") not in allowed_depts:
                        dept.pop("custom_metrics", None)


# ---------------------------------------------------------------------------
# Данные со скоупом
# ---------------------------------------------------------------------------


def _get_dept_goals(dept_names):
        """Цели отделов из Goal.custom_department."""
        dept_goals = {}
        if not dept_names:
                return dept_goals
        if not frappe.db.has_column("Goal", "custom_department"):
                return dept_goals
        try:
                for goal in frappe.get_all(
                        "Goal",
                        fields=[
                                "name",
                                "goal_name",
                                "kra",
                                "progress",
                                "start_date",
                                "end_date",
                                "custom_department",
                        ],
                        filters={"custom_department": ["in", dept_names]},
                        limit_page_length=0,
                ):
                        dept_goals.setdefault(goal.custom_department, []).append(goal)
        except Exception as e:
                frappe.log_error(f"org_chart: cannot fetch dept goals: {e}")
        return dept_goals


def _get_attachments(perms, departments):
        """Вложения: Department — всем; Employee — HR или видимым сотрудникам."""
        if perms["is_hr"]:
                filters = {"attached_to_doctype": ["in", ["Department", "Employee"]]}
        else:
                visible = list(perms["visible_employee_ids"])
                if not visible:
                        return []
                filters = {
                        "attached_to_doctype": "Employee",
                        "attached_to_name": ["in", visible],
                }
        try:
                return frappe.get_all(
                        "File",
                        fields=[
                                "name",
                                "file_name",
                                "file_url",
                                "file_type",
                                "file_size",
                                "attached_to_doctype",
                                "attached_to_name",
                        ],
                        filters=filters,
                        limit_page_length=0,
                )
        except Exception as e:
                frappe.log_error(f"org_chart: cannot fetch attachments: {e}")
                return []


def _get_goals(perms):
        """Цели сотрудников: HR — все; руководитель — своя ветка; иначе — свои."""
        goal_fields = ["name", "goal_name", "employee", "kra", "progress", "start_date", "end_date"]
        if frappe.db.has_column("Goal", "description"):
                goal_fields.append("description")

        filters = {}
        if not perms["is_hr"]:
                if perms["visible_employee_ids"]:
                        filters["employee"] = ["in", perms["visible_employee_ids"]]
                else:
                        return []
        try:
                return frappe.get_all("Goal", fields=goal_fields, filters=filters, limit_page_length=0)
        except Exception as e:
                frappe.log_error(f"org_chart: cannot fetch Goals: {e}")
                return []


# ---------------------------------------------------------------------------
# Настройки
# ---------------------------------------------------------------------------


def _default_settings():
        return {
                "card_default": "ЦКП",
                "panel_default": "Функции",
                "show_employees": True,
        }


def _get_settings():
        if not frappe.db.exists("DocType", "Org Chart Settings"):
                return _default_settings()
        return {
                "card_default": frappe.db.get_single_value("Org Chart Settings", "card_default") or "ЦКП",
                "panel_default": frappe.db.get_single_value("Org Chart Settings", "panel_default") or "Функции",
                "show_employees": bool(frappe.db.get_single_value("Org Chart Settings", "show_employees")),
        }


# ---------------------------------------------------------------------------
# Детальные представления (клик по плитке / сотруднику)
# ---------------------------------------------------------------------------


@frappe.whitelist()
def get_department_details(department_name):
        """Детали отдела: сотрудники, вложения, метрики — с учётом прав."""
        perms = _get_permissions()

        dept = frappe.get_doc("Department", department_name)

        attachments = frappe.get_all(
                "File",
                fields=["name", "file_name", "file_url", "file_type", "file_size"],
                filters={
                        "attached_to_doctype": "Department",
                        "attached_to_name": department_name,
                },
                limit_page_length=100,
        )

        employees = frappe.get_all(
                "Employee",
                fields=[
                        "name",
                        "employee_number",
                        "employee_name",
                        "designation",
                        "status",
                        "image",
                        "date_of_joining",
                ],
                filters={"department": department_name, "status": "Active"},
                limit_page_length=500,
        )

        # Метрики: HR — любой отдел; руководитель — отделы своей ветки;
        # рядовой сотрудник — ничего (ЦКП при этом виден всем).
        can_view_metrics = perms["is_hr"] or (
                perms["is_manager"]
                and department_name in _visible_departments(perms, [{"name": department_name}])
        )

        metrics = None
        if can_view_metrics and dept.get("custom_metrics"):
                try:
                        metrics = json.loads(dept.custom_metrics)
                except (json.JSONDecodeError, TypeError):
                        metrics = None

        dept_data = dept.as_dict()
        if not can_view_metrics:
                dept_data.pop("custom_metrics", None)

        return {
                "department": dept_data,
                "attachments": attachments,
                "employees": employees,
                "metrics": metrics,
                "can_view_metrics": can_view_metrics,
        }


@frappe.whitelist()
def get_employee_details(employee_name):
        """Детали сотрудника: рядовой видит только свои данные, HR — все."""
        perms = _get_permissions()
        is_self = employee_name == perms["current_employee"]
        is_visible = employee_name in perms["visible_employee_ids"]

        if not (perms["is_hr"] or is_self or is_visible):
                emp = frappe.get_doc("Employee", employee_name)
                return {
                        "employee": {
                                "name": emp.name,
                                "employee_name": emp.employee_name,
                                "designation": emp.designation,
                                "department": emp.department,
                                "status": emp.status,
                                "image": emp.image,
                        },
                        "attachments": [],
                        "goals": [],
                        "restricted": True,
                }

        emp = frappe.get_doc("Employee", employee_name)

        attachments = frappe.get_all(
                "File",
                fields=["name", "file_name", "file_url", "file_type", "file_size"],
                filters={
                        "attached_to_doctype": "Employee",
                        "attached_to_name": employee_name,
                },
                limit_page_length=100,
        )

        goals = []
        try:
                goals = frappe.get_all(
                        "Goal",
                        fields=["name", "goal_name", "kra", "progress", "start_date", "end_date"],
                        filters={"employee": employee_name},
                        limit_page_length=100,
                )
        except Exception:
                pass

        return {
                "employee": emp.as_dict(),
                "attachments": attachments,
                "goals": goals,
                "restricted": False,
        }
