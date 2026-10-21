"""Плейсхолдерные демо-данные org_chart_mtp.

Запуск (на тестовом сайте!):
    bench --site <site> execute org_chart_mtp.demo.make_demo_data

Создаёт: дерево отделов с цветами (custom_color), ЦКП (custom_kra → KRA),
функциями и wiki-ссылками; сотрудников с иерархией reports_to;
личные и отделские цели (Goal с custom_department — именно они показываются
в разделе целей/метрик отдела). Повторный запуск пропускается, если данные уже есть.
"""
import frappe

# Плейсхолдерный набор цветов: тёплая и холодная гамма, различимая на светлом фоне
PALETTE = {
        "root": "#1f2937",        # почти чёрный
        "sales": "#2563eb",        # синий
        "sales_west": "#3b82f6",   # светлее синий
        "sales_east": "#60a5fa",   # самый светлый синий
        "marketing": "#9333ea",    # фиолетовый
        "it": "#0d9488",           # бирюзовый
        "it_dev": "#14b8a6",       # светлее бирюза
        "it_infra": "#2dd4bf",     # самый светлый бирюз
        "production": "#ea580c",   # оранжевый
        "production_ops": "#f97316",  # светлый оранжевый
        "hr": "#db2777",           # розовый
        "finance": "#65a30d",       # зелёно-оливковый
        "logistics": "#0891b2",     # сине-зелёный
}

MARKER = "MTP Demo Group"


def make_demo_data():
        """Создать плейсхолдерный набор данных для оргчарта."""
        if frappe.db.exists("Department", {"department_name": MARKER}):
                print("org_chart_mtp: демо-данные уже существуют, пропускаю")
                return

        company = frappe.get_all("Company", pluck="name", limit=1)
        if not company:
                print("org_chart_mtp: на сайте нет ни одной Company — создайте компанию сначала")
                return
        company = company[0]

        def kra(title, description):
                return frappe.get_doc(
                        {"doctype": "KRA", "title": title, "description": description}
                ).insert(ignore_permissions=True).name

        def dept(name, parent, is_group, color, functions=None, kra_name=None, wiki=None, folder=None):
                return frappe.get_doc({
                        "doctype": "Department",
                        "department_name": name,
                        "company": company,
                        "parent_department": parent or "",
                        "is_group": is_group,
                        "custom_color": color,
                        "custom_functions": functions,
                        "custom_kra": kra_name,
                        "custom_wiki_url": wiki,
                        "custom_folder_url": folder,
                }).insert(ignore_permissions=True).name

        def designation_or_create(name):
                """Должность сотрудника: создаём, если её ещё нет."""
                if not frappe.db.exists("Designation", name):
                        frappe.get_doc(
                                {"doctype": "Designation", "designation_name": name}
                        ).insert(ignore_permissions=True)
                return name

        def employee(first, last, designation, department, reports_to=None, email=None):
                designation = designation_or_create(designation)
                return frappe.get_doc({
                        "doctype": "Employee",
                        "naming_series": "MTP-DEMO-",
                        "first_name": first,
                        "last_name": last,
                        "company": company,
                        "designation": designation,
                        "department": department,
                        "reports_to": reports_to,
                        "date_of_joining": "2024-03-01",
                        "date_of_birth": "1990-06-15",
                        "gender": "Male" if len(first) % 2 else "Female",
                        "status": "Active",
                        "user_id": email,
                        "cell_number": "+7 900 000-00-00",
                }).insert(ignore_permissions=True).name

        def goal(name, employee, progress, dept_name=None):
                return frappe.get_doc({
                        "doctype": "Goal",
                        "goal_name": name,
                        "employee": employee,
                        "progress": progress,
                        "status": "In Progress",
                        "start_date": "2026-01-01",
                        "end_date": "2026-12-31",
                        "custom_department": dept_name,
                }).insert(ignore_permissions=True).name

        # --- Отделы ------------------------------------------------------------
        root = dept("MTP Demo Group", None, 1, PALETTE["root"],
                functions="Стратегия\nУправление компанией",
                wiki="https://wiki.example.test/company")

        kra_sales = kra("Выручка 500 млн ₽", "Достижение выручки 500 млн рублей за финансовый год")
        sales = dept("Отдел продаж", root, 1, PALETTE["sales"],
                functions="Планирование продаж\nВедение ключевых клиентов\nКонтроль дебиторки",
                kra_name=kra_sales, wiki="https://wiki.example.test/sales",
                folder="https://drive.example.test/sales")
        sales_west = dept("Западный регион", sales, 0, PALETTE["sales_west"],
                functions="Продажи западному кластеру\nПартнёрская сеть")
        sales_east = dept("Восточный регион", sales, 0, PALETTE["sales_east"],
                functions="Продажи восточному кластеру\nТендеры")

        kra_mkt = kra("Лидогенерация 1000/мес", "Стабильный поток квалифицированных лидов")
        marketing = dept("Маркетинг", root, 1, PALETTE["marketing"],
                functions="Трафик\nБренд\nКонтент",
                kra_name=kra_mkt, wiki="https://wiki.example.test/marketing")

        kra_it = kra("Uptime 99.9%", "Доступность всех продуктивных систем не ниже 99.9%")
        it = dept("IT-департамент", root, 1, PALETTE["it"],
                functions="Разработка\nСопровождение\nИнфраструктура",
                kra_name=kra_it, wiki="https://wiki.example.test/it")
        it_dev = dept("Разработка", it, 0, PALETTE["it_dev"],
                functions="Разработка фич\nРевью кода\nРелизы")
        it_infra = dept("Инфраструктура", it, 0, PALETTE["it_infra"],
                functions="Серверы\nСети\nМониторинг")

        kra_prod = kra("План производства 100%", "Исполнение производственного плана без переноса сроков")
        production = dept("Производство", root, 1, PALETTE["production"],
                functions="Выпуск продукции\nКонтроль качества\nРемонт",
                kra_name=kra_prod)
        production_ops = dept("Операционное управление", production, 0, PALETTE["production_ops"],
                functions="Смены\nМатериалы")

        hr = dept("HR", root, 0, PALETTE["hr"],
                functions="Подбор\nАдаптация\nКадровое делопроизводство",
                wiki="https://wiki.example.test/hr")
        finance = dept("Финансы", root, 0, PALETTE["finance"],
                functions="Бюджет\nОтчётность\nКазначейство")
        logistics = dept("Логистика", root, 0, PALETTE["logistics"],
                functions="Склад\nДоставка\nТаможня")

        # --- Сотрудники (reports_to-цепочка до 4 уровней) ----------------------
        gm = employee("Алексей", "Управин", "Генеральный директор", root)
        sales_dir = employee("Мария", "Продажкина", "Директор по продажам", sales, reports_to=gm)
        west_head = employee("Олег", "Западнов", "Руководитель западного региона", sales_west, reports_to=sales_dir)
        west_kam = employee("Ирина", "Клиентова", "KAM", sales_west, reports_to=west_head)
        east_head = employee("Тимур", "Востоков", "Руководитель восточного региона", sales_east, reports_to=sales_dir)
        mkt_dir = employee("Анна", "Брендова", "Директор по маркетингу", marketing, reports_to=gm)
        mkt_spec = employee("Лена", "Контентова", "Контент-менеджер", marketing, reports_to=mkt_dir)
        it_cio = employee("Сергей", "Серверов", "IT-директор", it, reports_to=gm)
        it_tl = employee("Никита", "Кодеров", "Тимлид", it_dev, reports_to=it_cio)
        it_dev1 = employee("Павел", "Фичев", "Разработчик", it_dev, reports_to=it_tl)
        it_ops = employee("Роман", "Сетьев", "Сисадмин", it_infra, reports_to=it_cio)
        prod_dir = employee("Виктор", "Цехов", "Директор производства", production, reports_to=gm)
        prod_master = employee("Галина", "Сменова", "Начальник смены", production_ops, reports_to=prod_dir)
        hr_head = employee("Ольга", "Кадрова", "HR Manager", hr, reports_to=gm)
        fin = employee("Елена", "Бюджетова", "Финансовый директор", finance, reports_to=gm)
        log = employee("Иван", "Грузов", "Логист", logistics, reports_to=gm)

        # --- Цели (личные и отделские) -----------------------------------------
        goal("Выручка направления 500 млн", sales_dir, 62, sales)
        goal("Запад: 200 млн и 3 якорных клиента", west_head, 55, sales_west)
        goal("10 продлений контрактов", west_kam, 70)
        goal("Восток: 150 млн", east_head, 48, sales_east)
        goal("1000 лидов в месяц", mkt_dir, 80, marketing)
        goal("40 публикаций в квартал", mkt_spec, 35)
        goal("Uptime 99.9%", it_cio, 100, it)
        goal("Выпустить 6 релизов", it_tl, 50, it_dev)
        goal("Погасить техдолг на 30%", it_dev1, 20)
        goal("План производства 100%", prod_dir, 94, production)
        goal("Смены без простоев", prod_master, 90)
        goal("Нанять 8 специалистов", hr_head, 25, hr)
        goal("Закрыть бюджет года", fin, 15, finance)
        goal("Сократить стоимость доставки на 7%", log, 10, logistics)
        goal("Личная цель: обучение команды", gm, 40)

        frappe.db.commit()
        print(
                "org_chart_mtp: демо-данные созданы — 13 отделов, 16 сотрудников, 15 целей, "
                f"цвета из палитры ({len(PALETTE)} оттенков), компания: {company}"
        )
