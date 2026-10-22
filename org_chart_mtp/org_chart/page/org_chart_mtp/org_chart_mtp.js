// =====================================================================
//  Org Chart Page — org_chart_mtp (Frappe HR, Desk)
//  URL: /desk/org_chart_mtp
//
//  Vanilla JS (без React/Vue), работает внутри Frappe Desk.
//  Данные: frappe.call → org_chart_mtp.py:get_org_data (Redis-кэш на сервере)
//
//  Возможности:
//    - Рекурсивная иерархия любой глубины (depthMap — precompute, O(n))
//    - Зум к курсору (колесо мыши + кнопки), панорамирование
//    - Pointer events: мышь + тач/планшет единообразно;
//      зажатие ЛКМ на плитке = пан, короткий клик = открыть плитку
//      (захват указателя — только после порога движения, иначе click
//      по плитке ретаргетится на обёртку и не сработает)
//    - Мобильная версия (<=768px): шапка в два ряда, зум — плавающими
//      кнопками, панель — нижняя шторка (затемнение, свайп вниз —
//      закрыть); pinch-zoom двумя пальцами и двойной тап по фону;
//      все мобильные CSS-правила скоуплены .org-root (не попадают
//      в клон экспорта)
//    - Поиск по отделам/сотрудникам с автоскроллом и подсветкой узла
//    - Мультикомпанийность: селектор в шапке фильтрует дерево/чипы/поиск
//      по Department.company / Employee.company (предки всегда видны)
//    - Deep links: выбор отдела/сотрудника пишется в URL-hash
//      (#dept=... / #emp=...) — ссылками можно делиться, кнопка «Назад»
//      браузера закрывает панель (hashchange)
//    - Realtime: doc_events на сервере публикуют org_chart_mtp_refresh
//      после коммита — открытые страницы мягко обновляют данные
//      (debounce 1.5 с, зум/пан/сворачивание/выбор сохраняются)
//    - «+ Добавить цель» в панели отдела и сотрудника: создаёт Goal
//      из hrms; права — только HR или вышестоящий начальник (сервер
//      проверяет строже, чем права doctype)
//    - Экспорт всего оргчарта: PNG / JPG (масштаб, качество)
//      и векторный PDF с выделяемым текстом (рендер на сервере,
//      с per-user rate-limit) с откатом на растровый PDF клиента
//    - Плитка отдела: ЦКП (по умолчанию) или Функции — переключается
//      в шапке и в Org Chart Settings; выбор запоминается
//    - Боковая панель: Функции (по умолчанию) или ЦКП — переключается
//    - Цвет плитки — из Department.custom_color (hex), иначе нейтральный
//    - Клик по отделу → панель (Папка / Wiki / Цели)
//      Цели отдела — обычные Goal из hrms, закреплённые полем
//      «Отдел» (Goal.custom_department); каждая цель — ссылка на документ
//    - Клик по сотруднику → панель сотрудника
//    - Сворачивание/разворачивание подотделов
//    - Права: HR/руководитель видят цели, рядовой — только свои
//    - i18n: строки обёрнуты в __() — переводятся через стандартные
//      CSV-файлы переводов Frappe при необходимости
// =====================================================================

var APP_NAME = 'org_chart_mtp';
var METHOD_PATH = 'org_chart_mtp.org_chart.page.org_chart_mtp.org_chart_mtp.get_org_data';
var CREATE_GOAL_METHOD = 'org_chart_mtp.org_chart.page.org_chart_mtp.org_chart_mtp.create_goal';
var NEUTRAL_COLOR = '#475569';
var TILE_KEY = 'org_chart_mtp_tile_mode';
var PANEL_KEY = 'org_chart_mtp_panel_mode';
var COMPANY_KEY = 'org_chart_mtp_company';
var REALTIME_EVENT = 'org_chart_mtp_refresh';
var PAN_THRESHOLD = 5;    // px: превышение = pan, иначе — клик
var PAN_THRESHOLD_TOUCH = 10; // px: у пальца дрожание выше, чем у мыши
var PAN_CLICK_GUARD = 200; // мс: клики сразу после пана игнорируются
var MOBILE_QUERY = '(max-width: 768px)'; // тот же брейкпоинт, что в CSS страницы
var DOUBLE_TAP_MS = 300;   // мс: окно двойного тапа (зум на телефоне)
var DOUBLE_TAP_DIST = 35;  // px: допустимый разброс пальца между тапами

function isMobileScreen() {
    return window.matchMedia && window.matchMedia(MOBILE_QUERY).matches;
}
var COMPANY_ALL = '__all__';
var SOFT_REFRESH_DELAY = 1500; // мс: debounce realtime-обновления

frappe.pages['org_chart_mtp'].on_page_load = function (wrapper) {
    var page = frappe.ui.make_app_page({
        parent: wrapper,
        title: __('Оргструктура компании'),
        single_column: true,
    });

    // === Глобальное состояние ===
    var state = {
        data: null,
        permissions: null,
        settings: { card_default: 'ЦКП', panel_default: 'Функции', show_employees: true },
        selection: null,
        activeTab: 'folder',
        tileMode: 'ЦКП',       // 'ЦКП' | 'Функции' — что на плитке
        panelMode: 'Функции',  // 'ЦКП' | 'Функции' — что в боковой панели
        collapsed: new Set(),
        depthMap: null,        // precompute: name → depth (O(n) вместо O(n²))
        scale: 1,
        tx: 0,
        ty: 0,
        isPanning: false,
        panStart: { x: 0, y: 0, tx: 0, ty: 0 },
        isPointerDown: false,
        panMoved: false,
        activePointerId: null,
        lastPanEnd: 0,        // timestamp: гард «клик сразу после пана»
        searchTerm: '',
        hasCentered: false,
        exportSize: null,    // кэш размеров контейнера экспорта (для диалога)
        // Мультикомпанийность: '__all__' | имя компании
        companyFilter: COMPANY_ALL,
        companies: [],
        filtered: { departments: [], employees: [] }, // данные после фильтра компании
        // Цели: отделы, куда пользователь может добавлять цели (HR — все)
        goalEditableDepts: [],
        goalStatusOptions: [],
        softRefreshTimer: null,
        refreshCount: 0,     // счётчик обновлений (data-refresh-count, удобно для E2E)
    };

    // === HTML-каркас + CSS ===
    var $body = $(page.body).length ? $(page.body) : $(wrapper).find('.layout-main-section');
    $body.html(`
        <style>
            .org-root { display: flex; flex-direction: column; height: calc(100vh - 110px); background: #f3f4f6; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif; }
            .org-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 24px; background: white; border-bottom: 1px solid #e5e7eb; flex-shrink: 0; z-index: 20; flex-wrap: wrap; gap: 8px; }
            .org-header h1 { font-size: 15px; font-weight: 600; color: #111827; margin: 0; }
            .org-header .stats { font-size: 12px; color: #9ca3af; margin-left: 12px; }
            .org-header-controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
            .org-switcher { display: flex; align-items: center; gap: 4px; border: 1px solid #e5e7eb; border-radius: 6px; background: white; padding: 2px; }
            .org-switcher-label { font-size: 11px; color: #9ca3af; padding: 0 6px; white-space: nowrap; }
            .org-switch-btn { padding: 4px 10px; border: none; border-radius: 4px; background: none; cursor: pointer; font-size: 12px; color: #6b7280; }
            .org-switch-btn:hover { background: #f3f4f6; color: #111827; }
            .org-switch-btn.active { background: #2563eb; color: white; font-weight: 600; }
            .org-zoom-controls { display: flex; align-items: center; border: 1px solid #e5e7eb; border-radius: 6px; background: white; }
            .org-zoom-controls button { padding: 6px 10px; border: none; background: none; cursor: pointer; color: #4b5563; }
            .org-zoom-controls button:hover { background: #f3f4f6; }
            .org-zoom-controls .zoom-value { font-size: 12px; color: #6b7280; min-width: 45px; text-align: center; padding: 0 8px; }
            .org-canvas-wrapper { flex: 1; position: relative; overflow: hidden; cursor: grab; background: #f3f4f6; background-image: radial-gradient(circle, #d1d5db 1px, transparent 1px); background-size: 24px 24px; user-select: none; -webkit-user-select: none; -moz-user-select: none; }
            .org-canvas-wrapper.panning { cursor: grabbing; }
            .org-canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; will-change: transform; }
            .org-hint { position: absolute; top: 16px; left: 16px; background: rgba(255,255,255,0.95); backdrop-filter: blur(4px); border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); font-size: 12px; color: #6b7280; z-index: 10; }
            .org-node { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); border: 1px solid #e5e7eb; cursor: pointer; transition: box-shadow 0.15s, border-color 0.15s; width: 280px; }
            .org-node:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.12); border-color: #d1d5db; }
            .org-node.is-root { width: 360px; }
            .org-node.is-section { width: 220px; }
            .org-node-header { padding: 8px 12px 6px; border-bottom: 1px solid #f3f4f6; }
            .org-node-code { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 3px; margin-right: 6px; }
            .org-node-section { padding: 6px 12px; border-bottom: 1px solid #f3f4f6; }
            .org-node-section-label { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #9ca3af; margin-bottom: 2px; }
            .org-node-functions { list-style: none; padding: 0; margin: 0; }
            .org-node-functions li { font-size: 11px; color: #374151; padding-left: 10px; position: relative; margin-bottom: 1px; }
            .org-node-functions li::before { content: '•'; position: absolute; left: 0; color: #9ca3af; }
            .org-node-ckp-title { font-size: 12px; font-weight: 600; color: #111827; line-height: 1.35; }
            .org-node-ckp-desc { font-size: 10px; color: #6b7280; line-height: 1.4; margin-top: 2px; }
            .org-node-empty { font-size: 10px; color: #c0c4cc; font-style: italic; }
            .org-node-employees { padding: 6px 12px; display: flex; flex-wrap: wrap; gap: 3px; }
            .org-emp-chip { display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px; font-size: 10px; border-radius: 3px; border: 1px solid #e5e7eb; background: #f9fafb; color: #374151; cursor: pointer; transition: all 0.1s; }
            .org-emp-chip:hover { border-color: #60a5fa; background: #eff6ff; color: #1d4ed8; }
            .org-emp-chip svg { width: 9px; height: 9px; }
            .org-tree-level { display: flex; flex-direction: column; align-items: flex-start; }
            .org-collapse-btn { margin-top: 8px; width: 20px; height: 20px; border-radius: 50%; background: white; border: 1px solid #d1d5db; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 10; transition: all 0.15s; }
            .org-collapse-btn:hover { border-color: #60a5fa; background: #eff6ff; }
            .org-collapse-btn svg { width: 12px; height: 12px; color: #4b5563; }
            .org-collapsed-label { margin-top: 4px; font-size: 10px; color: #9ca3af; font-style: italic; }
            .org-side-panel { position: absolute; top: 0; right: 0; bottom: 0; width: 384px; background: white; border-left: 1px solid #e5e7eb; box-shadow: -4px 0 16px rgba(0,0,0,0.12); display: flex; flex-direction: column; z-index: 30; }
            .org-panel-header { padding: 16px; border-bottom: 1px solid #e5e7eb; display: flex; align-items: flex-start; justify-content: space-between; }
            .org-panel-header .icon { width: 40px; height: 40px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: white; flex-shrink: 0; }
            .org-panel-header .icon svg { width: 20px; height: 20px; }
            .org-panel-header .title-block { flex: 1; min-width: 0; margin-left: 12px; }
            .org-panel-header .type-label { font-size: 10px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
            .org-panel-header h2 { font-size: 14px; font-weight: 600; color: #111827; margin: 0; line-height: 1.3; word-break: break-word; }
            .org-panel-close { background: none; border: none; cursor: pointer; color: #9ca3af; padding: 4px; }
            .org-panel-close:hover { color: #111827; }
            .org-panel-close svg { width: 16px; height: 16px; }
            .org-panel-ckp { padding: 10px 16px; background: #f9fafb; border-bottom: 1px solid #f3f4f6; }
            .org-panel-ckp .label { font-size: 10px; font-weight: 600; text-transform: uppercase; color: #9ca3af; margin-bottom: 2px; }
            .org-panel-ckp .text { font-size: 12px; color: #374151; line-height: 1.5; }
            .org-panel-employees { padding: 8px 16px; border-bottom: 1px solid #f3f4f6; }
            .org-panel-employees .label { font-size: 10px; font-weight: 600; text-transform: uppercase; color: #9ca3af; margin-bottom: 4px; }
            .org-panel-employees .chips { display: flex; flex-wrap: wrap; gap: 4px; }
            .org-panel-employees .chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid #e5e7eb; background: white; cursor: pointer; color: #374151; }
            .org-panel-employees .chip:hover { border-color: #60a5fa; background: #eff6ff; color: #1d4ed8; }
            .org-panel-tabs { display: flex; border-bottom: 2px solid #e5e7eb; flex-shrink: 0; }
            .org-tab { flex: 1; padding: 10px; border: none; background: none; cursor: pointer; font-size: 12px; font-weight: 500; color: #6b7280; border-bottom: 2px solid transparent; margin-bottom: -2px; display: flex; align-items: center; justify-content: center; gap: 6px; }
            .org-tab:hover { color: #111827; background: #f9fafb; }
            .org-tab.active { color: #1d4ed8; border-bottom-color: #2563eb; background: rgba(239,246,255,0.5); }
            .org-tab svg { width: 14px; height: 14px; }
            .org-panel-content { flex: 1; overflow-y: auto; padding: 16px; }
            .org-file-item { display: flex; align-items: center; gap: 12px; padding: 8px; border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: 4px; text-decoration: none; color: inherit; }
            .org-file-item:hover { border-color: #93c5fd; background: #eff6ff; }
            .org-file-icon { width: 32px; height: 32px; border-radius: 6px; background: #f3f4f6; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
            .org-file-icon svg { width: 16px; height: 16px; }
            .org-file-name { font-size: 12px; font-weight: 500; color: #111827; }
            .org-file-meta { font-size: 10px; color: #9ca3af; }
            .org-wiki-link { display: block; padding: 12px; border: 1px solid #bfdbfe; background: #eff6ff; border-radius: 6px; text-decoration: none; }
            .org-wiki-link:hover { border-color: #60a5fa; }
            .org-goal-item { display: block; padding: 8px; border: 1px solid #e5e7eb; border-radius: 6px; background: #f9fafb; margin-bottom: 8px; text-decoration: none; color: inherit; transition: border-color 0.15s, background 0.15s; }
            .org-goal-item:hover { border-color: #93c5fd; background: white; }
            .org-goal-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; }
            .org-goal-top svg { width: 12px; height: 12px; color: #9ca3af; flex-shrink: 0; margin-top: 2px; }
            .org-goal-text { font-size: 12px; color: #111827; margin-bottom: 4px; font-weight: 500; }
            .org-goal-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
            .org-goal-status { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 9px; font-weight: 600; white-space: nowrap; }
            .org-goal-status.st-pending { background: #f3f4f6; color: #6b7280; }
            .org-goal-status.st-inprogress { background: #dbeafe; color: #1d4ed8; }
            .org-goal-status.st-completed { background: #dcfce7; color: #15803d; }
            .org-goal-status.st-archived { background: #f9fafb; color: #9ca3af; }
            .org-goal-status.st-closed { background: #ede9fe; color: #6d28d9; }
            .org-goal-owner { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; color: #6b7280; }
            .org-goal-owner svg { width: 11px; height: 11px; flex-shrink: 0; }
            .org-goal-due { font-size: 10px; color: #6b7280; }
            .org-progress-bar { height: 6px; background: #e5e7eb; border-radius: 3px; overflow: hidden; margin-top: 4px; }
            .org-progress-fill { height: 100%; background: #22c55e; border-radius: 3px; transition: width 0.3s; }
            .org-restricted { padding: 32px 16px; text-align: center; color: #9ca3af; font-size: 12px; }
            .org-restricted svg { width: 56px !important; height: 56px !important; margin: 0 auto 12px auto; display: block; }
            .org-wiki-link svg, .org-file-item svg { width: 16px !important; height: 16px !important; flex-shrink: 0; }
            .org-section-title { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
            .org-section-title svg { width: 14px; height: 14px; color: #6b7280; flex-shrink: 0; }
            .org-section-title span { font-size: 12px; font-weight: 600; color: #111827; text-transform: uppercase; }
            .org-goal-due svg { width: 11px; height: 11px; vertical-align: -1px; margin-right: 2px; }
            .org-panel-employees .chip svg { width: 12px; height: 12px; flex-shrink: 0; }
            .org-canvas-wrapper { touch-action: none; }
            #org-side-panel { touch-action: auto; }
            .org-search { position: relative; }
            .org-search-input { width: 240px; padding: 6px 10px 6px 28px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 12px; color: #111827; background: white; outline: none; transition: border-color 0.15s, box-shadow 0.15s; }
            .org-search-input:focus { border-color: #60a5fa; box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
            .org-search-icon { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); color: #9ca3af; display: flex; pointer-events: none; }
            .org-search-icon svg { width: 14px; height: 14px; }
            .org-search-dropdown { position: absolute; top: calc(100% + 4px); left: 0; width: 320px; max-height: 320px; overflow-y: auto; background: white; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.14); z-index: 60; display: none; }
            .org-search-dropdown.open { display: block; }
            .org-search-group { padding: 6px 10px 2px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #9ca3af; }
            .org-search-item { padding: 8px 12px; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
            .org-search-item:hover { background: #eff6ff; }
            .org-search-item .title { font-size: 12px; color: #111827; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .org-search-item .subtitle { font-size: 10px; color: #9ca3af; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .org-search-empty { padding: 12px; font-size: 12px; color: #9ca3af; text-align: center; }
            .org-export-controls { display: flex; align-items: center; gap: 4px; border: 1px solid #e5e7eb; border-radius: 6px; background: white; }
            .org-export-controls button { display: inline-flex; align-items: center; gap: 5px; padding: 6px 10px; border: none; background: none; cursor: pointer; color: #4b5563; font-size: 11px; font-weight: 600; }
            .org-export-controls button svg { width: 12px; height: 12px; }
            .org-export-controls button:hover { background: #f3f4f6; color: #111827; }
            .org-export-controls button:disabled { opacity: 0.5; cursor: wait; }
            .org-company-select { border: 1px solid #e5e7eb; border-radius: 6px; background: white; padding: 6px 8px; font-size: 12px; color: #374151; outline: none; max-width: 190px; cursor: pointer; }
            .org-company-select:focus { border-color: #60a5fa; box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
            .org-goals-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
            .org-add-goal-btn { display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; border: 1px solid #2563eb; border-radius: 4px; background: #2563eb; color: white; font-size: 11px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: background 0.15s; }
            .org-add-goal-btn:hover { background: #1d4ed8; }
            .org-add-goal-btn svg { width: 11px; height: 11px; }
            .org-node, .org-emp-chip, .org-collapse-btn { -webkit-tap-highlight-color: transparent; }
            @keyframes orgPulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(37,99,235,0); } 50% { box-shadow: 0 0 0 10px rgba(37,99,235,0.45); } }
            .org-node.org-highlight { animation: orgPulse 0.9s ease-in-out 2; border-color: #2563eb; z-index: 5; }
            .org-emp-chip.org-highlight { animation: orgPulse 0.9s ease-in-out 2; border-color: #2563eb; background: #eff6ff; color: #1d4ed8; }
            .org-hint { cursor: pointer; transition: opacity 0.4s; }
            /* ===== Мобильная версия (<=768px): два ряда шапки, плавающий зум,
               панель — нижняя шторка. ВСЕ селекторы через .org-root: экспорт
               клонирует <style> внутрь контейнера без .org-root-обёртки —
               мобильные правила не должны попадать в картинки/PDF ===== */
            .org-panel-backdrop { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(17,24,39,0.4); z-index: 1044; }
            @keyframes orgSheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
            @media (max-width: 768px) {
                .org-root { height: calc(100vh - 96px); height: calc(100dvh - 96px); }
                .org-root .org-header { padding: 8px 12px; gap: 6px 10px; }
                .org-root .org-header h1 { font-size: 13px; white-space: nowrap; }
                .org-root .org-header .stats { margin-left: 6px; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .org-root .org-header > div:first-child { order: 1; flex: 0 1 auto; min-width: 0; overflow: hidden; }
                .org-root .org-header-controls { display: contents; }
                .org-root .org-export-controls { order: 4; flex-shrink: 0; }
                .org-root .org-export-controls button { padding: 8px 12px; }
                .org-root .org-export-controls .org-btn-label { display: none; }
                .org-root .org-search { order: 3; flex: 1 1 100%; min-width: 0; }
                .org-root .org-search-input { width: 100%; padding: 9px 10px 9px 30px; font-size: 16px; } /* 16px: iOS не зумит страницу при фокусе */
                .org-root .org-search-dropdown { width: 100%; max-height: 45vh; }
                .org-root .org-search-item { padding: 11px 12px; }
                .org-root .org-company-select { order: 2; max-width: 108px; font-size: 12px; padding: 6px 4px; flex-shrink: 1; margin-left: auto; }
                .org-root .org-switcher { order: 5; flex-shrink: 0; }
                .org-root .org-switcher-label { display: none; }
                .org-root .org-switch-btn { padding: 6px 10px; font-size: 12px; }
                .org-root .org-header button, .org-root .org-header select { touch-action: manipulation; } /* без 300мс-задержки и двойного-тап зума */
                .org-root .org-zoom-controls { position: fixed; right: 12px; bottom: calc(14px + env(safe-area-inset-bottom, 0px)); flex-direction: column; border-radius: 12px; box-shadow: 0 4px 18px rgba(0,0,0,0.18); z-index: 1040; overflow: hidden; }
                .org-root .org-zoom-controls button { min-width: 44px; min-height: 42px; padding: 0 10px; font-size: 18px; }
                .org-root .org-zoom-controls #zoom-reset { border-left: none; border-top: 1px solid #e5e7eb; font-size: 15px; }
                .org-root .org-zoom-controls .zoom-value { min-width: 44px; font-size: 11px; padding: 2px 6px; }
                .org-root .org-hint { top: 10px; left: 10px; max-width: calc(100vw - 24px); font-size: 11px; padding: 7px 10px; }
                .org-root .org-panel-backdrop.open { display: block; }
                .org-root .org-side-panel { position: absolute; left: 0; right: 0; bottom: 0; top: auto; width: 100%; max-height: 78vh; max-height: 78dvh; border-left: none; border-top: 1px solid #e5e7eb; border-radius: 14px 14px 0 0; box-shadow: 0 -10px 40px rgba(0,0,0,0.25); z-index: 1045; animation: orgSheetUp 0.28s cubic-bezier(0.32, 0.72, 0, 1); padding-bottom: env(safe-area-inset-bottom, 0px); }
                .org-root .org-side-panel::before { content: ''; position: absolute; top: 7px; left: 50%; transform: translateX(-50%); width: 38px; height: 4px; border-radius: 2px; background: #d1d5db; z-index: 2; }
                .org-root .org-panel-header { padding: 16px 12px 10px; touch-action: none; } /* зона свайпа вниз */
                .org-root .org-panel-header .icon { width: 36px; height: 36px; }
                .org-root .org-panel-close { min-width: 38px; min-height: 38px; margin: -4px -6px 0 0; }
                .org-root .org-panel-close svg { width: 18px; height: 18px; }
                .org-root .org-panel-content { -webkit-overflow-scrolling: touch; padding: 12px; }
                .org-root .org-tab { padding: 11px 4px; font-size: 12px; }
                .org-root .org-emp-chip { padding: 4px 8px; font-size: 11px; }
                .org-root .org-collapse-btn { width: 28px; height: 28px; }
                .org-root .org-collapse-btn svg { width: 14px; height: 14px; }
            }
            /* Диалоги приложения (экспорт / новая цель) вписываем в экран телефона.
               Селекторы НЕ через .org-root: фраппе вешает модалки на body. */
            @media (max-width: 768px) {
                .org-chart-dialog .modal-dialog { margin: 10px; width: calc(100vw - 20px); max-width: 460px; }
                .org-chart-dialog .modal-content { max-height: calc(100vh - 40px); max-height: calc(100dvh - 40px); display: flex; flex-direction: column; }
                .org-chart-dialog .modal-body { overflow-y: auto; -webkit-overflow-scrolling: touch; }
            }
        </style>
        <div class="org-root">
            <div class="org-header">
                <div style="display:flex;align-items:center;">
                    <h1>${__('Оргструктура')}</h1>
                    <span class="stats" id="org-stats"></span>
                </div>
                <div class="org-search">
                    <span class="org-search-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>
                    <input class="org-search-input" id="org-search-input" type="text" autocomplete="off" placeholder="${__('Поиск отдела или сотрудника')}…">
                    <div class="org-search-dropdown" id="org-search-dropdown"></div>
                </div>
                <div class="org-header-controls">
                    <select class="org-company-select" id="org-company-select" style="display:none;" title="${__('Фильтр по компании')}"></select>
                    <div class="org-switcher" title="${__('Что показывать на плитке отдела')}">
                        <span class="org-switcher-label">${__('Плитка')}:</span>
                        <button class="org-switch-btn" data-tile-mode="ЦКП">${__('ЦКП')}</button>
                        <button class="org-switch-btn" data-tile-mode="Функции">${__('Функции')}</button>
                    </div>
                    <div class="org-switcher" title="${__('Что показывать в боковой панели отдела')}">
                        <span class="org-switcher-label">${__('Панель')}:</span>
                        <button class="org-switch-btn" data-panel-mode="ЦКП">${__('ЦКП')}</button>
                        <button class="org-switch-btn" data-panel-mode="Функции">${__('Функции')}</button>
                    </div>
                    <div class="org-export-controls">
                        <button id="export-btn" title="${__('Экспорт оргчарта: PNG / JPG (с выбором разрешения) или векторный PDF (текст выделяется)')}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                            <span class="org-btn-label">${__('Экспорт')}</span>
                        </button>
                    </div>
                    <div class="org-zoom-controls">
                        <button id="zoom-out" title="${__('Уменьшить')}">−</button>
                        <span class="zoom-value" id="zoom-value">100%</span>
                        <button id="zoom-in" title="${__('Увеличить')}">+</button>
                        <button id="zoom-reset" title="${__('Сбросить')}" style="border-left:1px solid #e5e7eb;">⤢</button>
                    </div>
                </div>
            </div>
            <div class="org-canvas-wrapper" id="org-canvas-wrapper">
                <div class="org-canvas" id="org-canvas"></div>
                <div class="org-hint" id="org-hint">${__('Колесо мыши — зум к курсору · перетаскивание — пан · клик по карточке — детали')}</div>
                <div class="org-panel-backdrop" id="org-panel-backdrop"></div>
                <div class="org-side-panel" id="org-side-panel" style="display:none;"></div>
            </div>
        </div>
    `);

    // === Мобильная адаптация: подсказка под тач + скрытие по тапу ===
    var mql = window.matchMedia ? window.matchMedia(MOBILE_QUERY) : null;
    function syncHintText() {
        var hint = document.getElementById('org-hint');
        if (!hint) return;
        hint.textContent = (mql && mql.matches)
            ? __('Щипок — зум · перетаскивание — пан · тап по карточке — детали')
            : __('Колесо мыши — зум к курсору · перетаскивание — пан · клик по карточке — детали');
    }
    syncHintText();
    if (mql && mql.addEventListener) mql.addEventListener('change', syncHintText);

    // Высота страницы = остаток экрана ниже хрома Frappe. На мобиле
    // navbar/page-head ниже, чем на десктопе, и разница зависит от
    // устройства — замеряем, а не угадываем в CSS (десктоп не трогаем).
    function fitRootHeight() {
        var el = document.querySelector('.org-root');
        if (!el) return;
        if (mql && mql.matches) {
            var top = el.getBoundingClientRect().top;
            el.style.height = Math.max(320, window.innerHeight - top) + 'px';
        } else {
            el.style.height = '';
        }
    }
    // Первый замер — только после укладки DOM: сразу после вставки
    // getBoundingClientRect().top ещё 0 (хром Frappe не отрисован),
    // и высота завышается на высоту навбара
    requestAnimationFrame(function () { requestAnimationFrame(fitRootHeight); });
    setTimeout(fitRootHeight, 350); // страховка после полной отрисовки
    window.addEventListener('resize', fitRootHeight);
    if (mql && mql.addEventListener) mql.addEventListener('change', fitRootHeight);
    var orgHintEl = document.getElementById('org-hint');
    if (orgHintEl) {
        orgHintEl.addEventListener('click', function () { orgHintEl.style.display = 'none'; });
        // подсказка сама уходит через 9 секунд, чтобы не занимать экран
        setTimeout(function () {
            if (orgHintEl.style.display !== 'none') {
                orgHintEl.style.opacity = '0';
                setTimeout(function () { orgHintEl.style.display = 'none'; }, 450);
            }
        }, 9000);
    }

    // === SVG иконки ===
    var ICONS = {
        search: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
        folder: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
        book: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
        target: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
        user: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
        close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
        file: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
        link: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
        calendar: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
        chevronDown: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>',
        chevronRight: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>',
        plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
        lock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    };

    // === Переключатели содержимого (плитка / панель) ===
    function updateSwitcherUI() {
        $('[data-tile-mode]').each(function () {
            $(this).toggleClass('active', $(this).data('tile-mode') === state.tileMode);
        });
        $('[data-panel-mode]').each(function () {
            $(this).toggleClass('active', $(this).data('panel-mode') === state.panelMode);
        });
    }

    $('[data-tile-mode]').on('click', function () {
        state.tileMode = $(this).data('tile-mode');
        window.localStorage.setItem(TILE_KEY, state.tileMode);
        updateSwitcherUI();
        renderTree();
        if (state.selection && state.selection.kind === 'node') {
            var node = state.data.departments.find(function (d) { return d.name === state.selection.id; });
            if (node) renderNodePanel(node);
        }
    });

    $('[data-panel-mode]').on('click', function () {
        state.panelMode = $(this).data('panel-mode');
        window.localStorage.setItem(PANEL_KEY, state.panelMode);
        updateSwitcherUI();
        if (state.selection && state.selection.kind === 'node') {
            var node = state.data.departments.find(function (d) { return d.name === state.selection.id; });
            if (node) renderNodePanel(node);
        }
    });

    // === Загрузка данных ===
    // opts:
    //   keepModes     — не перетирать режимы плитки/панели/фильтр компании
    //                  (realtime-обновление и пересоздание цели)
    //   keepSelection — переоткрыть текущую панель после обновления,
    //                  если её узел ещё существует
    //   center       — центрировать дерево (только первая загрузка)
    //   after        — колбэк после успешного рендера
    function loadData(opts) {
        opts = opts || {};
        frappe.call({
            method: METHOD_PATH,
            callback: function (r) {
                if (r.message) {
                    var prevSelection = state.selection;
                    state.data = r.message;
                    state.permissions = r.message.permissions || {};
                    if (!opts.keepModes) {
                        state.settings = r.message.settings || state.settings;
                        // Приоритет: выбор пользователя (localStorage) → настройки → ЦКП/Функции
                        var savedTile = window.localStorage.getItem(TILE_KEY);
                        state.tileMode = savedTile || state.settings.card_default || 'ЦКП';
                        var savedPanel = window.localStorage.getItem(PANEL_KEY);
                        state.panelMode = savedPanel || state.settings.panel_default || 'Функции';
                    }
                    state.companies = r.message.companies || [];
                    state.goalEditableDepts = r.message.goal_editable_depts || [];
                    state.goalStatusOptions = r.message.goal_status_options || [];
                    if (!opts.keepModes) restoreCompanyFilter();
                    else validateCompanyFilter();
                    applyCompanyFilter();
                    buildDepthMap();
                    updateSwitcherUI();
                    updateCompanySelector();
                    updateStats();
                    renderTree();
                    if (opts.center) centerContent();
                    if (opts.keepSelection && prevSelection) reopenPanel(prevSelection);
                    state.refreshCount++;
                    var cv = document.getElementById('org-canvas');
                    if (cv) cv.setAttribute('data-refresh-count', String(state.refreshCount));
                    if (opts.after) opts.after();
                } else {
                    $('#org-canvas').html('<div style="text-align:center;padding:40px;color:#ef4444;">' +
                        '<p>' + __('Ошибка: данные не получены от сервера.') + '</p>' +
                        '<p style="font-size:11px;color:#9ca3af;">' + __('Проверьте, что метод') + ' <code>' + METHOD_PATH + '</code> ' + __('существует') + '</p>' +
                        '</div>');
                }
            },
            error: function (err) {
                $('#org-canvas').html('<div style="text-align:center;padding:40px;color:#ef4444;">' +
                    '<p>' + __('Ошибка загрузки данных') + ': ' + (err && err.message ? err.message : __('неизвестная')) + '</p>' +
                    '<p style="font-size:11px;color:#9ca3af;">' + __('Приложение') + ': <code>' + APP_NAME + '</code>, ' + __('метод') + ': <code>' + METHOD_PATH + '</code></p>' +
                    '</div>');
            },
        });
    }

    // Первая загрузка: после рендера — deep link из URL-hash, если есть
    loadData({
        center: true,
        after: function () {
            var target = parseLocationHash();
            if (target) {
                // небольшой таймаут: канвас должен получить размеры после центрирования
                setTimeout(function () { openFromHash(target); }, 200);
            }
        },
    });

    // === Мультикомпанийность ===
    function restoreCompanyFilter() {
        var saved = null;
        try { saved = window.localStorage.getItem(COMPANY_KEY); } catch (e) { /* приватный режим */ }
        if (saved && saved !== COMPANY_ALL && state.companies.indexOf(saved) < 0) {
            saved = COMPANY_ALL; // компания исчезла с сайта
        }
        state.companyFilter = saved || COMPANY_ALL;
    }

    function validateCompanyFilter() {
        if (state.companyFilter !== COMPANY_ALL
                && state.companies.indexOf(state.companyFilter) < 0) {
            state.companyFilter = COMPANY_ALL;
        }
    }

    // Пересчёт state.filtered: отделы выбранной компании + их предки
    // (связность дерева), сотрудники по Employee.company (или отделу,
    // который остался видим — совместимость со старыми записями без компании)
    function applyCompanyFilter() {
        var d = (state.data && state.data.departments) || [];
        var e = (state.data && state.data.employees) || [];
        if (state.companyFilter === COMPANY_ALL || !state.companies.length) {
            state.filtered = { departments: d, employees: e };
            return;
        }
        var company = state.companyFilter;
        var keep = {};
        d.forEach(function (dept) { if (dept.company === company) keep[dept.name] = true; });
        var byName = {};
        d.forEach(function (dept) { byName[dept.name] = dept; });
        Object.keys(keep).forEach(function (name) {
            var cur = byName[name];
            var guard = 0;
            while (cur && cur.parent_department && guard++ < 50) {
                keep[cur.parent_department] = true;
                cur = byName[cur.parent_department];
            }
        });
        state.filtered = {
            departments: d.filter(function (dept) { return keep[dept.name]; }),
            employees: e.filter(function (emp) {
                return emp.company === company || keep[emp.department];
            }),
        };
    }

    function updateCompanySelector() {
        var sel = document.getElementById('org-company-select');
        if (!sel) return;
        if ((state.companies || []).length < 2) {
            // одна компания — фильтр не нужен
            sel.style.display = 'none';
            return;
        }
        sel.style.display = '';
        var html = '<option value="' + COMPANY_ALL + '">' + __('Все компании') + '</option>';
        state.companies.forEach(function (c) {
            html += '<option value="' + escapeHtml(c) + '"' + (c === state.companyFilter ? ' selected' : '') + '>'
                + escapeHtml(c) + '</option>';
        });
        sel.innerHTML = html;
    }

    function updateStats() {
        $('#org-stats').text(
            state.filtered.departments.length + ' ' + __('узлов') + ' · ' +
            state.filtered.employees.length + ' ' + __('сотрудников')
        );
    }

    $('#org-company-select').on('change', function () {
        setCompanyFilter($(this).val() || COMPANY_ALL);
    });

    function setCompanyFilter(company) {
        state.companyFilter = company;
        try { window.localStorage.setItem(COMPANY_KEY, company); } catch (e) { /* приватный режим */ }
        applyCompanyFilter();
        renderTree();
        updateStats();
        centerContent();
        // Открытая панель могла остаться на узле другой компании
        if (state.selection) {
            var sel = state.selection;
            var stillVisible = sel.kind === 'node'
                ? state.filtered.departments.some(function (x) { return x.name === sel.id; })
                : state.filtered.employees.some(function (x) { return x.name === sel.id; });
            if (!stillVisible) closePanel();
        }
    }

    // Узел из другой компании (deep link/поиск) — переключаем фильтр на «все»
    function ensureDeptVisible(deptName) {
        if (state.filtered.departments.some(function (x) { return x.name === deptName; })) return true;
        if (state.data.departments.some(function (x) { return x.name === deptName; })) {
            setCompanyFilter(COMPANY_ALL);
            $('#org-company-select').val(COMPANY_ALL);
            return true;
        }
        return false;
    }

    function ensureEmployeeVisible(empName) {
        if (state.filtered.employees.some(function (x) { return x.name === empName; })) return true;
        if (state.data.employees.some(function (x) { return x.name === empName; })) {
            setCompanyFilter(COMPANY_ALL);
            $('#org-company-select').val(COMPANY_ALL);
            return true;
        }
        return false;
    }

    // === Утилиты для работы с данными ===
    // Дерево всегда работает с state.filtered — данными ПОСЛЕ фильтра
    // компании (при «Все компании» — полный набор без копирования)
    function findInAllDepartments(name) {
        return (state.data && state.data.departments || []).find(function (d) { return d.name === name; }) || null;
    }

    function findInAllEmployees(name) {
        return (state.data && state.data.employees || []).find(function (e) { return e.name === name; }) || null;
    }

    function getChildren(parentId) {
        return state.filtered.departments.filter(function (d) {
            return d.parent_department === parentId;
        });
    }

    function getEmployees(deptName) {
        return state.filtered.employees.filter(function (e) {
            return e.department === deptName && e.status === 'Active';
        });
    }

    function getAttachments(doctype, name) {
        return state.data.attachments.filter(function (a) {
            return a.attached_to_doctype === doctype && a.attached_to_name === name;
        });
    }

    function getGoalsForEmployee(empName) {
        return (state.data.goals || []).filter(function (g) {
            return g.employee === empName;
        });
    }

    function getNodeType(depth) {
        if (depth === 0) return 'company';
        if (depth === 1) return 'department';
        if (depth === 2) return 'subdepartment';
        return 'section';
    }

    function getNodeColor(node) {
        // Цвет ТОЛЬКО из Department.custom_color; иначе нейтральный
        return (node && node.custom_color) ? node.custom_color : NEUTRAL_COLOR;
    }

    function parseFunctions(node) {
        if (!node.custom_functions) return [];
        return node.custom_functions.split('\n').filter(function (s) { return s.trim(); });
    }

    // === Блок содержимого плитки: ЦКП или Функции ===
    function renderTileContent(node) {
        var label = state.tileMode;
        var html = '';
        if (label === 'ЦКП') {
            if (node.kra_title) {
                html += '<div class="org-node-section"><div class="org-node-section-label">' + __('ЦКП') + '</div>';
                html += '<div class="org-node-ckp-title">' + escapeHtml(node.kra_title) + '</div>';
                if (node.kra_description) {
                    var short = node.kra_description.length > 140
                        ? node.kra_description.slice(0, 140) + '…'
                        : node.kra_description;
                    html += '<div class="org-node-ckp-desc">' + escapeHtml(short) + '</div>';
                }
                html += '</div>';
            } else {
                // Нет ЦКП — показываем функции как fallback
                var fns = parseFunctions(node);
                if (fns.length > 0) {
                    html += '<div class="org-node-section"><div class="org-node-section-label">' + __('Функции') + '</div><ul class="org-node-functions">';
                    fns.forEach(function (fn) { html += '<li>' + escapeHtml(fn) + '</li>'; });
                    html += '</ul></div>';
                } else {
                    html += '<div class="org-node-section"><div class="org-node-section-label">' + __('ЦКП') + '</div><div class="org-node-empty">' + __('не задано') + '</div></div>';
                }
            }
        } else {
            var fns2 = parseFunctions(node);
            if (fns2.length > 0) {
                html += '<div class="org-node-section"><div class="org-node-section-label">' + __('Функции') + '</div><ul class="org-node-functions">';
                fns2.forEach(function (fn) { html += '<li>' + escapeHtml(fn) + '</li>'; });
                html += '</ul></div>';
            } else if (node.kra_title) {
                // Нет функций — показываем ЦКП как fallback
                html += '<div class="org-node-section"><div class="org-node-section-label">' + __('ЦКП') + '</div><div class="org-node-ckp-title">' + escapeHtml(node.kra_title) + '</div></div>';
            } else {
                html += '<div class="org-node-section"><div class="org-node-section-label">' + __('Функции') + '</div><div class="org-node-empty">' + __('не задано') + '</div></div>';
            }
        }
        return html;
    }

    // === Рекурсивный рендер дерева ===
    function renderNode(node, depth) {
        if (!node) return '';
        var nodeType = getNodeType(depth);
        var color = getNodeColor(node);
        var children = getChildren(node.name);
        var empList = getEmployees(node.name);
        var isCollapsed = state.collapsed.has(node.name);
        var hasChildren = children.length > 0;

        // Дети: группы (is_group=1) — горизонтальный ряд, службы (is_group=0) — вертикальная цепочка
        var parentChildren = children.filter(function (child) {
            return child.is_group == 1 || child.is_group === true;
        });
        var leafChildren = children.filter(function (child) {
            return child.is_group == 0 || child.is_group === false;
        });

        var LINE = '#cbd5e1';

        var html = '<div class="org-tree-level" style="align-items:flex-start;">';
        html += '<div class="org-node ' + (nodeType === 'company' ? 'is-root' : nodeType === 'section' ? 'is-section' : '') + '" data-no-pan data-node-id="' + escapeHtml(node.name) + '" style="border-top: 3px solid ' + color + ';">';
        html += '<div class="org-node-header">';
        html += '<span class="org-node-code" style="background:' + color + '22;color:' + color + ';">' + escapeHtml(node.department_name || node.name) + '</span>';
        html += '</div>';

        // Содержимое плитки: ЦКП или Функции (переключается)
        html += renderTileContent(node);

        // Сотрудники (если включены в настройках)
        if (state.settings.show_employees && empList.length > 0) {
            html += '<div class="org-node-employees" data-no-pan>';
            empList.forEach(function (emp) {
                html += '<button class="org-emp-chip" data-no-pan data-emp-id="' + escapeHtml(emp.name) + '">' + ICONS.user + escapeHtml(emp.employee_name || emp.name) + '</button>';
            });
            html += '</div>';
        }
        html += '</div>';

        // Кнопка свернуть + дети
        if (hasChildren) {
            html += '<button class="org-collapse-btn" data-no-pan data-collapse-id="' + escapeHtml(node.name) + '">';
            html += isCollapsed ? ICONS.chevronRight : ICONS.chevronDown;
            html += '</button>';
            if (!isCollapsed) {
                html += '<div style="display:flex; flex-direction:column; align-items:flex-start;">';
                html += '<div style="width:1px; height:16px; background:' + LINE + '; margin-left:12px;"></div>';
                html += '<div style="display:flex; align-items:flex-start; flex-wrap:nowrap; gap:32px;">';

                // 1. Поток служб (is_group = 0) — вертикальная цепочка слева
                if (leafChildren.length > 0) {
                    html += '<div style="border-left:1px solid ' + LINE + '; padding-left:12px; display:flex; flex-direction:column; gap:8px;">';
                    leafChildren.forEach(function (child) {
                        html += '<div style="position:relative;">';
                        html += '<div style="position:absolute; left:-12px; top:18px; width:12px; height:1px; background:' + LINE + ';"></div>';
                        html += renderNode(child, depth + 1);
                        html += '</div>';
                    });
                    html += '</div>';
                }

                // 2. Поток департаментов (is_group = 1) — горизонтальный ряд справа
                if (parentChildren.length > 0) {
                    html += '<div style="display:flex; align-items:flex-start; flex-wrap:nowrap;">';
                    parentChildren.forEach(function (child, i) {
                        var connWidth = (i === 0 && leafChildren.length === 0) ? 12 : 24;
                        html += '<div style="display:flex; align-items:flex-start;">';
                        html += '<div style="width:' + connWidth + 'px; height:1px; background:' + LINE + '; margin-top:22px; flex-shrink:0;"></div>';
                        html += renderNode(child, depth + 1);
                        html += '</div>';
                    });
                    html += '</div>';
                }

                html += '</div>';
                html += '</div>';
            } else {
                html += '<div class="org-collapsed-label">' + __('Свернуто') + ': ' + children.length + '</div>';
            }
        }
        html += '</div>';
        return html;
    }

    function renderTree() {
        state.exportSize = null; // дерево изменилось — сброс кэша размеров экспорта
        if (!state.data || state.filtered.departments.length === 0) {
            $('#org-canvas').html('<div style="text-align:center;padding:40px;color:#9ca3af;">' + __('Нет данных. Создайте Department в ERPNext.') + '</div>');
            return;
        }
        var roots = state.filtered.departments.filter(function (d) {
            return !d.parent_department;
        });
        var html = '';
        roots.forEach(function (root) {
            html += renderNode(root, 0);
        });
        $('#org-canvas').html(html);
        attachEventHandlers();
        applyTransform();
    }

    // === Обработчики ===
    // Гард: клик сразу после пана — это продолжение жеста, игнорируем
    function isPanClick() {
        return Date.now() - state.lastPanEnd < PAN_CLICK_GUARD;
    }

    function attachEventHandlers() {
        $('[data-node-id]').off('click').on('click', function (e) {
            e.stopPropagation();
            if (isPanClick()) return;
            var nodeId = $(this).data('node-id');
            var node = state.filtered.departments.find(function (d) { return d.name === nodeId; });
            if (node) openNodePanel(node);
        });
        $('[data-emp-id]').off('click').on('click', function (e) {
            e.stopPropagation();
            if (isPanClick()) return;
            var empId = $(this).data('emp-id');
            var emp = state.filtered.employees.find(function (em) { return em.name === empId; });
            if (emp) openEmployeePanel(emp);
        });
        $('[data-collapse-id]').off('click').on('click', function (e) {
            e.stopPropagation();
            if (isPanClick()) return;
            var id = $(this).data('collapse-id');
            if (state.collapsed.has(id)) state.collapsed.delete(id);
            else state.collapsed.add(id);
            renderTree();
        });
    }

    // === Панель отдела ===
    function closePanel() {
        $('#org-side-panel').hide();
        $('#org-panel-backdrop').removeClass('open');
        state.selection = null;
        clearHash();
    }

    // Панель и мобильное затемнение появляются/уходят вместе
    // (на десктопе шторка-затемнение скрыта CSS — класс безвреден)
    function showPanelChrome() {
        $('#org-side-panel').show();
        $('#org-panel-backdrop').addClass('open');
    }
    var orgBackdropEl = document.getElementById('org-panel-backdrop');
    if (orgBackdropEl) orgBackdropEl.addEventListener('click', closePanel);

    function openNodePanel(node) {
        state.selection = { kind: 'node', id: node.name };
        state.activeTab = 'folder';
        renderNodePanel(node);
        showPanelChrome();
        updateHash('node', node.name);
    }

    function renderNodePanel(node) {
        var depth = getDepth(node);
        var color = getNodeColor(node);
        var empList = getEmployees(node.name);
        var attachments = getAttachments('Department', node.name);
        var functions = parseFunctions(node);
        var ckp = node.kra_title || '';
        var ckpDesc = node.kra_description || '';
        var wikiUrl = node.custom_wiki_url || ('/app/Department/' + encodeURIComponent(node.name));
        // Цели отдела видят: HR или руководитель (есть подчинённые)
        var canViewGoals = (state.permissions && state.permissions.is_hr) || (state.permissions && state.permissions.is_manager);

        var html = '';
        // Шапка
        html += '<div class="org-panel-header" style="background:linear-gradient(135deg,' + color + '08 0%,' + color + '15 100%);">';
        html += '<div style="display:flex;align-items:flex-start;flex:1;min-width:0;">';
        html += '<div class="icon" style="background:' + color + '">' + ICONS.folder + '</div>';
        html += '<div class="title-block"><div class="type-label">' + (getNodeType(depth) === 'company' ? __('Компания') : getNodeType(depth) === 'department' ? __('Отдел') : __('Секция')) + '</div>';
        html += '<h2>' + escapeHtml(node.department_name || node.name) + '</h2></div></div>';
        html += '<button class="org-panel-close" id="panel-close">' + ICONS.close + '</button></div>';

        // Содержимое панели: ЦКП или Функции (переключается, по умолчанию Функции)
        if (state.panelMode === 'ЦКП') {
            html += '<div class="org-panel-ckp"><div class="label">' + __('ЦКП (KRA)') + '</div><div class="text"><strong>' + (ckp ? escapeHtml(ckp) : '<span style="color:#9ca3af;font-weight:400;">' + __('не задано') + '</span>') + '</strong>';
            if (ckpDesc) html += '<br>' + escapeHtml(ckpDesc);
            html += '</div></div>';
        } else {
            html += '<div class="org-panel-ckp"><div class="label">' + __('Функции') + '</div><div class="text">';
            if (functions.length > 0) {
                html += '<ul class="org-node-functions">';
                functions.forEach(function (fn) { html += '<li>' + escapeHtml(fn) + '</li>'; });
                html += '</ul>';
            } else {
                html += '<span style="color:#9ca3af;">' + __('не задано') + '</span>';
            }
            html += '</div></div>';
        }

        // Сотрудники
        if (empList.length > 0) {
            html += '<div class="org-panel-employees"><div class="label">' + __('Сотрудники') + ' (' + empList.length + ')</div><div class="chips">';
            empList.forEach(function (emp) {
                html += '<button class="chip" data-emp-id="' + escapeHtml(emp.name) + '">' + ICONS.user + escapeHtml(emp.employee_name || emp.name) + '</button>';
            });
            html += '</div></div>';
        }

        // Вкладки
        html += '<div class="org-panel-tabs">';
        html += '<button class="org-tab ' + (state.activeTab === 'folder' ? 'active' : '') + '" data-tab="folder">' + ICONS.folder + __('Папка') + '</button>';
        html += '<button class="org-tab ' + (state.activeTab === 'wiki' ? 'active' : '') + '" data-tab="wiki">' + ICONS.book + 'Wiki</button>';
        if (canViewGoals) {
            html += '<button class="org-tab ' + (state.activeTab === 'goals' ? 'active' : '') + '" data-tab="goals">' + ICONS.target + __('Цели') + '</button>';
        }
        html += '</div>';

        // Содержимое
        html += '<div class="org-panel-content">';
        if (state.activeTab === 'folder') {
            html += renderFolderTab(attachments, node.custom_folder_url);
        } else if (state.activeTab === 'wiki') {
            html += renderWikiTab(wikiUrl);
        } else if (state.activeTab === 'goals') {
            html += renderGoalsTab(node);
        }
        html += '</div>';

        $('#org-side-panel').html(html);

        $('#panel-close').off('click').on('click', closePanel);
        $('.org-tab').off('click').on('click', function () {
            state.activeTab = $(this).data('tab');
            renderNodePanel(node);
        });
        bindAddGoalButtons();
        $('[data-emp-id]').off('click').on('click', function (e) {
            e.stopPropagation();
            var empId = $(this).data('emp-id');
            var emp = state.filtered.employees.find(function (em) { return em.name === empId; }) || findInAllEmployees(empId);
            if (emp) openEmployeePanel(emp);
        });
    }

    // === Precompute глубин: O(n) вместо O(n²) в getDepth ===
    function buildDepthMap() {
        state.depthMap = {};
        var byName = {};
        state.data.departments.forEach(function (d) { byName[d.name] = d; });
        state.data.departments.forEach(function (d) {
            var depth = 0;
            var cur = d;
            var guard = 0;
            while (cur && cur.parent_department && guard++ < 50) {
                depth++;
                cur = byName[cur.parent_department];
            }
            state.depthMap[d.name] = depth;
        });
    }

    function getDepth(node) {
        if (state.depthMap && Object.prototype.hasOwnProperty.call(state.depthMap, node.name)) {
            return state.depthMap[node.name];
        }
        return 0;
    }

    // === Общий рендер списка целей (отдел + сотрудник) ===
    // Каждая цель — обычный Goal из hrms; карточка цели — ссылка
    // на документ Goal (открывается в новой вкладке).
    var GOAL_STATUS_META = {
        'Pending':     { label: __('Ожидает'),   cls: 'st-pending' },
        'In Progress': { label: __('В работе'),  cls: 'st-inprogress' },
        'Completed':   { label: __('Завершена'), cls: 'st-completed' },
        'Archived':    { label: __('В архиве'),  cls: 'st-archived' },
        'Closed':      { label: __('Закрыта'),   cls: 'st-closed' }
    };

    function renderGoalItems(goals, showOwner) {
        var html = '';
        goals.forEach(function (g) {
            var st = GOAL_STATUS_META[g.status] || null;
            html += '<a class="org-goal-item" href="/app/goal/' + encodeURIComponent(g.name) + '" target="_blank" title="' + __('Открыть Goal в HRMS') + '">';
            html += '<div class="org-goal-top"><div class="org-goal-text">' + escapeHtml(g.goal_name) + '</div>' + ICONS.link + '</div>';
            html += '<div class="org-goal-meta">';
            if (st) html += '<span class="org-goal-status ' + st.cls + '">' + st.label + '</span>';
            if (showOwner && g.employee_name) html += '<span class="org-goal-owner">' + ICONS.user + escapeHtml(g.employee_name) + '</span>';
            if (g.end_date) html += '<span class="org-goal-due">' + ICONS.calendar + ' ' + __('до') + ' ' + escapeHtml(g.end_date) + '</span>';
            html += '</div>';
            if (g.progress !== undefined && g.progress !== null && g.progress !== '') {
                html += '<div class="org-progress-bar" style="margin-top:6px;"><div class="org-progress-fill" style="width:' + g.progress + '%;"></div></div>';
                html += '<div style="font-size:10px;color:#6b7280;margin-top:2px;">' + __('Прогресс') + ': ' + g.progress + '%</div>';
            }
            html += '</a>';
        });
        return html;
    }

    function renderFolderTab(attachments, folderUrl) {
        var html = '';
        if (folderUrl) {
            html += '<a class="org-wiki-link" href="' + escapeHtml(folderUrl) + '" target="_blank" style="margin-bottom:12px;">' +
                '<div style="display:flex;align-items:center;gap:12px;">' +
                '<div style="width:32px;height:32px;border-radius:6px;background:#fef3c7;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#d97706;">' + ICONS.folder + '</div>' +
                '<div style="flex:1;min-width:0;"><div style="font-size:12px;font-weight:500;color:#92400e;">' + __('Папка отдела') + '</div><div style="font-size:10px;color:#b45309;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(folderUrl) + '</div></div>' +
                ICONS.link + '</div></a>';
        }
        if (attachments.length === 0) {
            html += '<div class="org-restricted">' + ICONS.folder + '<p style="margin-top:8px;">' + __('Вложений нет') + '</p></div>';
            return html;
        }
        html += '<p style="font-size:12px;color:#6b7280;margin-bottom:12px;">' + __('Файлов') + ': ' + attachments.length + '</p>';
        attachments.forEach(function (att) {
            var sizeStr = att.file_size ? Math.round(att.file_size / 1024) + ' ' + __('КБ') : '';
            html += '<a class="org-file-item" href="' + escapeHtml(att.file_url) + '" target="_blank">';
            html += '<div class="org-file-icon">' + ICONS.file + '</div>';
            html += '<div style="flex:1;min-width:0;"><div class="org-file-name">' + escapeHtml(att.file_name) + '</div><div class="org-file-meta">' + sizeStr + '</div></div>';
            html += ICONS.link + '</a>';
        });
        return html;
    }

    function renderWikiTab(wikiUrl) {
        return '<a class="org-wiki-link" href="' + escapeHtml(wikiUrl) + '" target="_blank">' +
            '<div style="display:flex;align-items:center;gap:12px;">' +
            '<div style="width:32px;height:32px;border-radius:6px;background:#dbeafe;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#2563eb;">' + ICONS.book + '</div>' +
            '<div style="flex:1;min-width:0;"><div style="font-size:12px;font-weight:500;color:#1e3a8a;">' + __('Wiki отдела') + '</div><div style="font-size:10px;color:#1d4ed8;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(wikiUrl) + '</div></div>' +
            ICONS.link + '</div></a>';
    }

    // === Права на создание целей ===
    // Отдел: HR или руководитель ветки, которой принадлежит отдел
    function canAddDeptGoal(deptName) {
        if (!state.permissions) return false;
        if (state.permissions.is_hr) return true;
        return (state.goalEditableDepts || []).indexOf(deptName) >= 0;
    }

    // Сотрудник: HR или вышестоящий начальник (не сам себе)
    function canAddEmployeeGoal(empName) {
        if (!state.permissions) return false;
        if (state.permissions.is_hr) return true;
        var visible = state.permissions.visible_employee_ids || [];
        return visible.indexOf(empName) >= 0 && empName !== state.permissions.current_employee;
    }

    // Кнопки «+ Добавить цель» в панелях (навешиваются после рендера панели)
    function bindAddGoalButtons() {
        $('[data-add-goal-dept]').off('click').on('click', function (e) {
            e.stopPropagation();
            openGoalDialog({ department: $(this).data('add-goal-dept') });
        });
        $('[data-add-goal-emp]').off('click').on('click', function (e) {
            e.stopPropagation();
            openGoalDialog({ employee: $(this).data('add-goal-emp') });
        });
    }

    // === Диалог создания цели (Goal из hrms) ===
    // Права проверяет сервер (create_goal): только HR или вышестоящий
    // начальник — клиент лишь прячет кнопку у тех, кому точно нельзя.
    function openGoalDialog(opts) {
        opts = opts || {};
        var isDept = !!opts.department;
        var statusOptions = (state.goalStatusOptions && state.goalStatusOptions.length)
            ? state.goalStatusOptions
            : ['Pending', 'In Progress', 'Completed', 'Archived', 'Closed'];
        var empObj = opts.employee ? findInAllEmployees(opts.employee) : null;
        var defaultDept = opts.department || (empObj && empObj.department) || '';

        var d = new frappe.ui.Dialog({
            title: isDept ? __('Новая цель отдела') : __('Новая цель сотрудника'),
            fields: [
                {
                    fieldname: 'goal_name', label: __('Название цели'), fieldtype: 'Data', reqd: 1,
                    placeholder: isDept ? __('Например: Выручка направления 500 млн') : __('Например: 10 продлений контрактов'),
                },
                {
                    fieldname: 'status', label: __('Статус'), fieldtype: 'Select',
                    options: statusOptions, default: 'Pending',
                },
                {
                    fieldname: 'employee', label: __('Владелец (сотрудник)'), fieldtype: 'Link',
                    options: 'Employee', reqd: 1, default: opts.employee || '',
                    read_only: opts.employee ? 1 : 0,
                    description: isDept ? __('Ответственный за цель отдела') : __('Кому назначается цель'),
                },
                {
                    fieldname: 'custom_department', label: __('Отдел'), fieldtype: 'Link',
                    options: 'Department', default: defaultDept,
                    read_only: isDept ? 1 : 0,
                    description: isDept
                        ? __('Цель будет закреплена за этим отделом')
                        : __('Заполните, чтобы сделать цель целью отдела'),
                },
                {
                    fieldname: 'start_date', label: __('Начало'), fieldtype: 'Date',
                    default: frappe.datetime.get_today(),
                },
                { fieldname: 'end_date', label: __('Срок'), fieldtype: 'Date' },
                { fieldname: 'progress', label: __('Прогресс, %'), fieldtype: 'Int', default: 0 },
            ],
            primary_action_label: __('Создать'),
            primary_action: function () {
                var values = d.get_values();
                if (!values) return;
                frappe.call({
                    method: CREATE_GOAL_METHOD,
                    args: {
                        goal_name: values.goal_name,
                        employee: values.employee,
                        custom_department: values.custom_department || '',
                        status: values.status,
                        start_date: values.start_date,
                        end_date: values.end_date,
                        progress: values.progress,
                    },
                    callback: function () {
                        d.hide();
                        frappe.show_alert({
                            message: __('Цель создана'),
                            indicator: 'green',
                        });
                        // Мягкое обновление: данные + открытая панель
                        // (остальным клиентам придёт realtime-событие)
                        loadData({ keepModes: true, keepSelection: true });
                    },
                });
            },
        });
        if (d.$wrapper) d.$wrapper.addClass('org-chart-dialog'); // мобильная ширина диалога
        d.show();
    }

    function renderGoalsTab(node) {
        var canViewGoals = (state.permissions && state.permissions.is_hr) || (state.permissions && state.permissions.is_manager);
        if (!canViewGoals) {
            return '<div class="org-restricted">' + ICONS.target + '<p style="margin-top:8px;">' + __('Нет прав для просмотра целей') + '</p></div>';
        }

        // Цели отдела — обычные Goal из hrms, закреплённые полем
        // Goal.custom_department (= «Отдел» на форме Goal)
        var deptGoals = (state.data.dept_goals && state.data.dept_goals[node.name]) || [];
        var html = '';

        html += '<div class="org-goals-head">';
        html += '<div class="org-section-title" style="margin-bottom:0;">' + ICONS.target + '<span>' + __('Цели отдела') + ' (' + deptGoals.length + ')</span></div>';
        if (canAddDeptGoal(node.name)) {
            html += '<button class="org-add-goal-btn" data-add-goal-dept="' + escapeHtml(node.name) + '">' + ICONS.plus + __('Добавить цель') + '</button>';
        }
        html += '</div>';
        if (deptGoals.length === 0) {
            html += '<p style="font-size:11px;color:#9ca3af;font-style:italic;margin-bottom:16px;">' +
                __('Целей нет. Добавьте кнопкой «Добавить цель» или создайте Goal в HRMS и закрепите её за отделом полем «Отдел»') + '</p>';
        } else {
            html += renderGoalItems(deptGoals, true);
        }
        return html;
    }

    // === Панель сотрудника ===
    function openEmployeePanel(emp) {
        state.selection = { kind: 'employee', id: emp.name };
        state.activeTab = 'folder';
        renderEmployeePanel(emp);
        showPanelChrome();
        updateHash('employee', emp.name);
    }

    function renderEmployeePanel(emp) {
        var attachments = getAttachments('Employee', emp.name);
        var goals = getGoalsForEmployee(emp.name);
        var isOwnProfile = state.permissions && state.permissions.current_employee === emp.name;
        var visibleIds = (state.permissions && state.permissions.visible_employee_ids) || [];
        var isVisible = visibleIds.indexOf(emp.name) >= 0;
        var canViewGoals = (state.permissions && state.permissions.is_hr) || isOwnProfile || isVisible;
        // Контакты (email, телефон) видны ВСЕМ — это публичная информация
        var canViewContacts = true;
        var initials = (emp.employee_name || emp.name || '?').split(' ').map(function (p) { return p[0]; }).join('').slice(0, 2);

        var html = '';
        html += '<div class="org-panel-header" style="background:linear-gradient(135deg,#eff6ff 0%,#f3e8ff 100%);">';
        html += '<div style="display:flex;align-items:center;">';
        html += '<div style="width:40px;height:40px;border-radius:50%;background:#2563eb;color:white;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:14px;flex-shrink:0;">' + initials + '</div>';
        html += '<div class="title-block"><div class="type-label">' + __('Сотрудник') + '</div><h2><a href="/app/employee/' + encodeURIComponent(emp.name) + '" target="_blank" style="color:#2563eb;text-decoration:none;" onmouseover="this.style.textDecoration=\'underline\';" onmouseout="this.style.textDecoration=\'none\';">' + escapeHtml(emp.employee_name || emp.name) + '</a></h2><p style="font-size:12px;color:#6b7280;margin:2px 0 0;">' + escapeHtml(emp.designation || '') + '</p></div>';
        html += '</div><button class="org-panel-close" id="panel-close">' + ICONS.close + '</button></div>';

        if (canViewContacts && (emp.user_id || emp.cell_number)) {
            html += '<div style="padding:10px 16px;background:#f9fafb;border-bottom:1px solid #f3f4f6;font-size:12px;">';
            if (emp.user_id) html += '<div style="display:flex;margin-bottom:4px;"><span style="color:#9ca3af;min-width:60px;">' + __('Email') + ':</span><span style="color:#111827;word-break:break-all;">' + escapeHtml(emp.user_id) + '</span></div>';
            if (emp.cell_number) html += '<div style="display:flex;margin-bottom:4px;"><span style="color:#9ca3af;min-width:60px;">' + __('Телефон') + ':</span><span style="color:#111827;">' + escapeHtml(emp.cell_number) + '</span></div>';
            html += '<div style="display:flex;margin-bottom:4px;"><span style="color:#9ca3af;min-width:60px;">' + __('Отдел') + ':</span><span style="color:#111827;">' + escapeHtml(emp.department || '—') + '</span></div>';
            html += '</div>';
        } else {
            html += '<div style="padding:10px 16px;background:#f9fafb;border-bottom:1px solid #f3f4f6;font-size:12px;">';
            html += '<div style="display:flex;margin-bottom:4px;"><span style="color:#9ca3af;min-width:60px;">' + __('Отдел') + ':</span><span style="color:#111827;">' + escapeHtml(emp.department || '—') + '</span></div>';
            html += '</div>';
        }

        // Вкладки
        html += '<div class="org-panel-tabs">';
        html += '<button class="org-tab ' + (state.activeTab === 'folder' ? 'active' : '') + '" data-tab="folder">' + ICONS.folder + __('Папка') + '</button>';
        html += '<button class="org-tab ' + (state.activeTab === 'wiki' ? 'active' : '') + '" data-tab="wiki">' + ICONS.book + 'Wiki</button>';
        if (canViewGoals || isOwnProfile) {
            html += '<button class="org-tab ' + (state.activeTab === 'goals' ? 'active' : '') + '" data-tab="goals">' + ICONS.target + __('Цели') + '</button>';
        }
        html += '</div>';

        html += '<div class="org-panel-content">';
        if (state.activeTab === 'folder') {
            html += renderFolderTab(attachments, null);
        } else if (state.activeTab === 'wiki') {
            html += renderWikiTab('/app/Employee/' + encodeURIComponent(emp.name));
        } else if (state.activeTab === 'goals') {
            var canAdd = canAddEmployeeGoal(emp.name);
            if (canAdd) {
                html += '<div class="org-goals-head">';
                html += '<div class="org-section-title" style="margin-bottom:0;">' + ICONS.target + '<span>' + __('Цели') + ' (' + goals.length + ')</span></div>';
                html += '<button class="org-add-goal-btn" data-add-goal-emp="' + escapeHtml(emp.name) + '">' + ICONS.plus + __('Добавить цель') + '</button>';
                html += '</div>';
            }
            if (goals.length === 0) {
                html += '<div class="org-restricted"><p>' +
                    (canAdd ? __('Целей нет — добавьте первую кнопкой выше') : __('Целей нет')) + '</p></div>';
            } else {
                if (!canAdd) {
                    html += '<div class="org-section-title">' + ICONS.target + '<span>' + __('Цели') + ' (' + goals.length + ')</span></div>';
                }
                html += renderGoalItems(goals, false);
            }
        }
        html += '</div>';

        $('#org-side-panel').html(html);

        $('#panel-close').off('click').on('click', closePanel);
        $('.org-tab').off('click').on('click', function () {
            state.activeTab = $(this).data('tab');
            renderEmployeePanel(emp);
        });
        bindAddGoalButtons();
    }

    // === Зум к курсору и панорамирование ===
    function applyTransform() {
        var canvas = document.getElementById('org-canvas');
        if (!canvas) return;
        canvas.style.transform = 'translate(' + state.tx + 'px, ' + state.ty + 'px) scale(' + state.scale + ')';
        $('#zoom-value').text(Math.round(state.scale * 100) + '%');
    }

    function zoomAtPoint(mx, my, delta) {
        var oldScale = state.scale;
        var newScale = Math.min(2.5, Math.max(0.3, oldScale + delta));
        if (newScale === oldScale) return;
        var ratio = newScale / oldScale;
        state.tx = mx - (mx - state.tx) * ratio;
        state.ty = my - (my - state.ty) * ratio;
        state.scale = newScale;
        applyTransform();
    }

    function centerContent() {
        // На телефоне центрируем корневую плитку (360px) в видимой ширине
        if (isMobileScreen()) {
            var rect = document.getElementById('org-canvas-wrapper').getBoundingClientRect();
            state.tx = Math.max(8, (rect.width - 360) / 2);
            state.ty = 24;
        } else {
            state.tx = 40;
            state.ty = 40;
        }
        state.hasCentered = true;
        applyTransform();
    }

    $('#zoom-in').off('click').on('click', function () {
        var rect = document.getElementById('org-canvas-wrapper').getBoundingClientRect();
        zoomAtPoint(rect.width / 2, rect.height / 2, 0.15);
    });
    $('#zoom-out').off('click').on('click', function () {
        var rect = document.getElementById('org-canvas-wrapper').getBoundingClientRect();
        zoomAtPoint(rect.width / 2, rect.height / 2, -0.15);
    });
    $('#zoom-reset').off('click').on('click', function () {
        state.scale = 1;
        state.hasCentered = false;
        centerContent();
    });

    var canvasWrapper = document.getElementById('org-canvas-wrapper');
    canvasWrapper.addEventListener('wheel', function (e) {
        e.preventDefault();
        var rect = canvasWrapper.getBoundingClientRect();
        var mx = e.clientX - rect.left;
        var my = e.clientY - rect.top;
        var delta = e.deltaY > 0 ? -0.1 : 0.1;
        zoomAtPoint(mx, my, delta);
    }, { passive: false });

    // === Панорамирование + pinch-zoom: pointer events (мышь + тач) ===
    // Зажатие в ЛЮБОМ месте канваса (включая плитку) = пан;
    // короткий клик без движения = действие (открыть плитку/чип/кнопку).
    // Боковая панель не участвует в пане.
    //
    // Захват указателя (setPointerCapture) — ТОЛЬКО при начале пана.
    // Если захватить сразу на pointerdown, браузер ретаргетит все
    // последующие события указателя И совместимые mouse-события
    // (mousedown/mouseup/click) на обёртку — клик по плитке умирает
    // (баг из issue-отчёта юзера: «клик по пластинке перестал работать»).
    // При захвате с началом пана чистый клик идёт нативно на плитку,
    // а click сразу после пана всё равно гасится порогом + гардом lastPanEnd.
    //
    // Мобильные жесты (два указателя): pinch-zoom вокруг середины щипка
    // (+ пан, если середина сместилась); после щипка оставшийся палец
    // продолжает пан. Двойной тап по фону — зум к точке.
    var pointers = new Map();  // pointerId → {x, y} — активные указатели на канвасе
    var pinch = null;          // {dist, cx, cy, scale, tx, ty} — база щипка

    function pinchStart() {
        var pts = Array.from(pointers.values()).slice(0, 2);
        var dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
        var rect = canvasWrapper.getBoundingClientRect();
        pinch = {
            dist: Math.max(1, Math.sqrt(dx * dx + dy * dy)),
            cx: (pts[0].x + pts[1].x) / 2 - rect.left,
            cy: (pts[0].y + pts[1].y) / 2 - rect.top,
            scale: state.scale, tx: state.tx, ty: state.ty,
        };
        // щипок отменяет одиночный пан и гасит возможный клик
        state.isPointerDown = false;
        state.isPanning = false;
        state.panMoved = true;
        canvasWrapper.classList.remove('panning');
    }

    function pinchApply() {
        if (!pinch || pointers.size < 2) return;
        var pts = Array.from(pointers.values()).slice(0, 2);
        var dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
        var dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        var rect = canvasWrapper.getBoundingClientRect();
        var cx = (pts[0].x + pts[1].x) / 2 - rect.left;
        var cy = (pts[0].y + pts[1].y) / 2 - rect.top;
        var newScale = Math.min(2.5, Math.max(0.3, pinch.scale * dist / pinch.dist));
        // мировая точка, что была под стартовым центром щипка, остаётся под центром сейчас
        var wx = (pinch.cx - pinch.tx) / pinch.scale;
        var wy = (pinch.cy - pinch.ty) / pinch.scale;
        state.scale = newScale;
        state.tx = cx - wx * newScale;
        state.ty = cy - wy * newScale;
        applyTransform();
    }

    canvasWrapper.addEventListener('pointerdown', function (e) {
        if (e.target.closest('#org-side-panel')) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) { pinchStart(); return; }
        if (pointers.size > 2) return; // третий палец не меняет жест
        state.isPointerDown = true;
        state.panMoved = false;
        state.activePointerId = e.pointerId;
        state.panStart = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty };
        // ВАЖНО: здесь НЕ вызываем setPointerCapture (см. комментарий выше)
    });
    canvasWrapper.addEventListener('pointermove', function (e) {
        if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && pointers.size >= 2) { pinchApply(); return; }
        if (!state.isPointerDown || e.pointerId !== state.activePointerId) return;
        var dx = e.clientX - state.panStart.x;
        var dy = e.clientY - state.panStart.y;
        // у пальца дрожание выше — порог больше, чтобы тап не превращался в пан
        var threshold = e.pointerType === 'touch' ? PAN_THRESHOLD_TOUCH : PAN_THRESHOLD;
        if (!state.panMoved && Math.sqrt(dx * dx + dy * dy) < threshold) return;
        if (!state.panMoved) {
            // Жест стал паном — теперь захватываем указатель, чтобы
            // события продолжали приходить даже за пределами обёртки.
            // С этого момента совместимый click (если будет) уйдёт
            // на обёртку — что и требуется (клик после пана не открывает плитку).
            state.panMoved = true;
            try { canvasWrapper.setPointerCapture(e.pointerId); } catch (err) { /* старые браузеры */ }
        }
        state.isPanning = true;
        canvasWrapper.classList.add('panning');
        state.tx = state.panStart.tx + dx;
        state.ty = state.panStart.ty + dy;
        applyTransform();
    });

    // Двойной тап по фону — зум к точке (только тач; слушатель стоит
    // до endPan, чтобы видеть state.panMoved до его сброса)
    var lastTap = { t: 0, x: 0, y: 0 };
    canvasWrapper.addEventListener('pointerup', function (e) {
        if (e.pointerType === 'mouse' || pinch || state.panMoved) return;
        if (e.target.closest('.org-node') || e.target.closest('.org-emp-chip') ||
            e.target.closest('.org-collapse-btn') || e.target.closest('#org-side-panel') ||
            e.target.closest('.org-hint')) return;
        var now = Date.now();
        var dx = e.clientX - lastTap.x, dy = e.clientY - lastTap.y;
        if (now - lastTap.t < DOUBLE_TAP_MS && dx * dx + dy * dy < DOUBLE_TAP_DIST * DOUBLE_TAP_DIST) {
            var rect = canvasWrapper.getBoundingClientRect();
            zoomAtPoint(e.clientX - rect.left, e.clientY - rect.top, 0.25);
            lastTap.t = 0; // третий тап подряд не должен зумить ещё раз
        } else {
            lastTap.t = now;
        }
        lastTap.x = e.clientX;
        lastTap.y = e.clientY;
    });

    function endPan(e) {
        pointers.delete(e.pointerId);
        if (pinch) {
            if (pointers.size < 2) {
                // щипок закончился: гасим клики; если остался один палец —
                // продолжаем им пан с новой базой
                pinch = null;
                state.lastPanEnd = Date.now();
                if (pointers.size === 1) {
                    var pid = null, p = null;
                    pointers.forEach(function (v, k) { pid = k; p = v; });
                    state.isPointerDown = true;
                    state.activePointerId = pid;
                    state.panMoved = true; // продолжение жеста, не клик
                    state.panStart = { x: p.x, y: p.y, tx: state.tx, ty: state.ty };
                } else {
                    state.panMoved = false;
                }
            }
            return;
        }
        // pointerup и последующий lostpointercapture приходят парой —
        // обрабатываем только событие активного указателя
        if (!state.isPointerDown || e.pointerId !== state.activePointerId) return;
        state.isPointerDown = false;
        state.activePointerId = null;
        if (state.panMoved) state.lastPanEnd = Date.now();
        state.isPanning = false;
        state.panMoved = false;
        canvasWrapper.classList.remove('panning');
    }
    canvasWrapper.addEventListener('pointerup', endPan);
    canvasWrapper.addEventListener('pointercancel', endPan);
    canvasWrapper.addEventListener('lostpointercapture', endPan);

    // === Мобильная шторка: свайп вниз за шапку закрывает панель ===
    var sheetDrag = null;
    var orgPanelEl = document.getElementById('org-side-panel');
    orgPanelEl.addEventListener('pointerdown', function (e) {
        if (!isMobileScreen() || e.pointerType === 'mouse') return;
        if (!e.target.closest('.org-panel-header')) return;
        sheetDrag = { id: e.pointerId, startY: e.clientY, dy: 0, moved: false };
    });
    orgPanelEl.addEventListener('pointermove', function (e) {
        if (!sheetDrag || e.pointerId !== sheetDrag.id) return;
        sheetDrag.dy = e.clientY - sheetDrag.startY;
        if (sheetDrag.dy > 10) {
            sheetDrag.moved = true;
            orgPanelEl.style.transform = 'translateY(' + Math.min(sheetDrag.dy, 240) + 'px)';
        }
    });
    function sheetDragEnd(e) {
        if (!sheetDrag || e.pointerId !== sheetDrag.id) return;
        var moved = sheetDrag.moved, dy = sheetDrag.dy;
        sheetDrag = null;
        orgPanelEl.style.transform = '';
        if (moved) {
            if (dy > 90) closePanel();
            // не даём клику после драга открыть ссылку/кнопку в шапке панели
            var kill = function (ev) { ev.stopPropagation(); ev.preventDefault(); };
            orgPanelEl.addEventListener('click', kill, true);
            setTimeout(function () { orgPanelEl.removeEventListener('click', kill, true); }, 250);
        }
    }
    orgPanelEl.addEventListener('pointerup', sheetDragEnd);
    orgPanelEl.addEventListener('pointercancel', sheetDragEnd);

    // === Поиск по отделам и сотрудникам ===
    var searchInput = document.getElementById('org-search-input');
    var searchDropdown = document.getElementById('org-search-dropdown');
    var searchTimer = null;

    searchInput.addEventListener('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
            state.searchTerm = searchInput.value || '';
            renderSearchDropdown();
        }, 180);
    });
    searchInput.addEventListener('focus', function () {
        if ((searchInput.value || '').trim()) renderSearchDropdown();
    });
    document.addEventListener('click', function (e) {
        if (!e.target.closest('.org-search')) closeSearchDropdown();
    });

    function closeSearchDropdown() {
        searchDropdown.classList.remove('open');
    }

    function renderSearchDropdown() {
        var term = (state.searchTerm || '').trim().toLowerCase();
        if (!term || !state.data) { closeSearchDropdown(); return; }

        var depts = state.filtered.departments.filter(function (d) {
            return (d.department_name || '').toLowerCase().indexOf(term) >= 0
                || (d.name || '').toLowerCase().indexOf(term) >= 0;
        }).slice(0, 7);
        var emps = state.filtered.employees.filter(function (emp) {
            return (emp.employee_name || '').toLowerCase().indexOf(term) >= 0;
        }).slice(0, 7);

        var html = '';
        if (depts.length > 0) {
            html += '<div class="org-search-group">' + __('Отделы') + '</div>';
            depts.forEach(function (d) {
                html += '<div class="org-search-item" data-search-dept="' + escapeHtml(d.name) + '">' +
                    '<span class="title">' + escapeHtml(d.department_name || d.name) + '</span>' +
                    '<span class="subtitle">' + __('Отдел') + '</span></div>';
            });
        }
        if (emps.length > 0) {
            html += '<div class="org-search-group">' + __('Сотрудники') + '</div>';
            emps.forEach(function (emp) {
                html += '<div class="org-search-item" data-search-emp="' + escapeHtml(emp.name) + '">' +
                    '<span class="title">' + escapeHtml(emp.employee_name || emp.name) + '</span>' +
                    '<span class="subtitle">' + escapeHtml(emp.designation || '') + '</span></div>';
            });
        }
        if (!html) {
            html = '<div class="org-search-empty">' + __('Ничего не найдено') + '</div>';
        }
        searchDropdown.innerHTML = html;
        searchDropdown.classList.add('open');

        $('[data-search-dept]').off('click').on('click', function () {
            var name = $(this).data('search-dept');
            closeSearchDropdown();
            searchInput.blur();
            scrollToDepartment(name);
        });
        $('[data-search-emp]').off('click').on('click', function () {
            var empId = $(this).data('search-emp');
            closeSearchDropdown();
            searchInput.blur();
            scrollToEmployee(empId);
        });
    }

    function cssEscape(value) {
        if (window.CSS && CSS.escape) return CSS.escape(value);
        return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    }

    function expandAncestors(deptName) {
        // развернуть всех предков, чтобы узел стал виден в DOM
        // (поиск в отфильтрованном наборе — предки выбранной компании всегда в нём)
        var byName = {};
        state.filtered.departments.forEach(function (d) { byName[d.name] = d; });
        var cur = byName[deptName];
        var guard = 0;
        while (cur && cur.parent_department && guard++ < 50) {
            if (state.collapsed.has(cur.parent_department)) {
                state.collapsed.delete(cur.parent_department);
            }
            cur = byName[cur.parent_department];
        }
    }

    // Плавная анимация transform к целевым tx/ty/scale
    function animateTransformTo(targetTx, targetTy, targetScale, done) {
        var start = { tx: state.tx, ty: state.ty, scale: state.scale };
        var t0 = performance.now();
        var DURATION = 350;
        function step(now) {
            var t = Math.min(1, (now - t0) / DURATION);
            var ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad
            state.tx = start.tx + (targetTx - start.tx) * ease;
            state.ty = start.ty + (targetTy - start.ty) * ease;
            state.scale = start.scale + (targetScale - start.scale) * ease;
            applyTransform();
            if (t < 1) requestAnimationFrame(step);
            else if (done) done();
        }
        requestAnimationFrame(step);
    }

    function centerOnElement(el, highlightClass) {
        if (!el) return;
        var wrapRect = canvasWrapper.getBoundingClientRect();
        var elRect = el.getBoundingClientRect();
        var cx = elRect.left + elRect.width / 2;
        var cy = elRect.top + elRect.height / 2;
        var targetTx = state.tx + (wrapRect.width / 2 - cx);
        var targetTy = state.ty + (wrapRect.height / 2 - cy);
        animateTransformTo(targetTx, targetTy, state.scale, function () {
            el.classList.add(highlightClass || 'org-highlight');
            setTimeout(function () { el.classList.remove(highlightClass || 'org-highlight'); }, 2000);
        });
    }

    function scrollToDepartment(deptName) {
        if (!ensureDeptVisible(deptName)) return;
        expandAncestors(deptName);
        renderTree();
        requestAnimationFrame(function () {
            var el = canvasWrapper.querySelector('[data-node-id="' + cssEscape(deptName) + '"]');
            centerOnElement(el, 'org-highlight');
        });
    }

    function scrollToEmployee(empId) {
        if (!ensureEmployeeVisible(empId)) return;
        var emp = findInAllEmployees(empId);
        if (!emp) return;
        var deptName = emp.department;
        if (deptName) {
            expandAncestors(deptName);
            renderTree();
            requestAnimationFrame(function () {
                var chip = canvasWrapper.querySelector('[data-emp-id="' + cssEscape(empId) + '"]');
                if (chip) {
                    centerOnElement(chip, 'org-highlight');
                } else {
                    // сотрудник без чипа (скрыт настройкой) — подсветим его отдел
                    var el = canvasWrapper.querySelector('[data-node-id="' + cssEscape(deptName) + '"]');
                    centerOnElement(el, 'org-highlight');
                }
            });
        }
    }

    // === Deep links: выбор отдела/сотрудника в URL-hash ===
    // #dept=<имя отдела> / #emp=<сотрудник>. Запись в hash создаёт запись
    // истории — кнопка «Назад» браузера закрывает панель. Роутер frappe
    // v16 работает на pushState-путях и сохраняет hash страницы,
    // hashchange он не слушает — конфликтов нет.
    function parseLocationHash() {
        var h = (window.location.hash || '').replace(/^#/, '');
        if (!h) return null;
        var m = h.match(/^(dept|emp)=(.+)$/);
        if (!m) return null;
        var id;
        try { id = decodeURIComponent(m[2]); } catch (e) { id = m[2]; }
        return { kind: m[1] === 'dept' ? 'node' : 'employee', id: id };
    }

    function updateHash(kind, id) {
        var prefix = kind === 'node' ? 'dept' : 'emp';
        var newHash = '#' + prefix + '=' + encodeURIComponent(id);
        if (window.location.hash === newHash) return;
        window.location.hash = newHash;
    }

    function clearHash() {
        if (!window.location.hash) return;
        // replaceState (без записи в историю): закрытие панели само по себе
        // не должно плодить записи «назад»
        history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    window.addEventListener('hashchange', function () {
        if (!state.data) return;
        var target = parseLocationHash();
        if (!target) {
            // hash убрали (кнопка «Назад») — закрываем панель
            if (state.selection) {
                $('#org-side-panel').hide();
                state.selection = null;
            }
            return;
        }
        // уже открыто — не трогаем (наш собственный updateHash)
        if (state.selection && state.selection.kind === target.kind && state.selection.id === target.id) return;
        openFromHash(target);
    });

    function openFromHash(target) {
        if (!state.data) return;
        if (target.kind === 'node') {
            var node = findInAllDepartments(target.id);
            if (!node || !ensureDeptVisible(target.id)) return;
            expandAncestors(target.id);
            renderTree();
            openNodePanel(node);
            requestAnimationFrame(function () {
                var el = canvasWrapper.querySelector('[data-node-id="' + cssEscape(target.id) + '"]');
                centerOnElement(el, 'org-highlight');
            });
        } else {
            var emp = findInAllEmployees(target.id);
            if (!emp || !ensureEmployeeVisible(target.id)) return;
            if (emp.department) {
                expandAncestors(emp.department);
                renderTree();
            }
            openEmployeePanel(emp);
            requestAnimationFrame(function () {
                var chip = canvasWrapper.querySelector('[data-emp-id="' + cssEscape(target.id) + '"]');
                if (chip) centerOnElement(chip, 'org-highlight');
            });
        }
    }

    // === Realtime: мягкое обновление при изменениях данных ===
    // Сервер (doc_events) публикует org_chart_mtp_refresh после коммита;
    // страница перезагружает данные с debounce, сохраняя зум/пан/
    // свёрнутость/режимы/открытую панель.
    if (window.frappe && frappe.realtime && typeof frappe.realtime.on === 'function') {
        frappe.realtime.on(REALTIME_EVENT, function () {
            clearTimeout(state.softRefreshTimer);
            state.softRefreshTimer = setTimeout(function () {
                loadData({ keepModes: true, keepSelection: true });
            }, SOFT_REFRESH_DELAY);
        });
    }

    // Переоткрыть панель после мягкого обновления (если узел ещё существует
    // и остался в текущем фильтре компании)
    function reopenPanel(sel) {
        if (sel.kind === 'node') {
            var node = findInAllDepartments(sel.id);
            if (node && state.filtered.departments.some(function (d) { return d.name === sel.id; })) {
                renderNodePanel(node);
                showPanelChrome();
                return;
            }
        } else {
            var emp = findInAllEmployees(sel.id);
            if (emp && state.filtered.employees.some(function (e) { return e.name === sel.id; })) {
                renderEmployeePanel(emp);
                showPanelChrome();
                return;
            }
        }
        closePanel();
    }

    // === Экспорт: PNG / JPG / векторный PDF ===
    // Растровые (PNG/JPG): рендер полного дерева (без зума/пана) в
    // изолированный контейнер → SVG foreignObject → canvas → blob
    // (масштаб и качество — из диалога экспорта).
    // PDF — векторный с выделяемым текстом: тот же контейнер сериализуется
    // и отправляется на сервер (headless-Chromium → wkhtmltopdf);
    // при недоступности серверных движков — откат на растровый PDF.
    var EXPORT_PDF_METHOD = 'org_chart_mtp.api.export.export_chart_pdf';

    function buildExportContainer() {
        var source = document.getElementById('org-canvas');
        var holder = document.createElement('div');
        holder.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
        holder.style.cssText = 'position:absolute;left:-99999px;top:0;background:#f8fafc;padding:32px;box-sizing:border-box;';
        var inner = document.createElement('div');
        inner.style.cssText = 'position:relative;transform:none;';
        // Клонируем детей канваса (сам .org-canvas несёт transform зума)
        inner.innerHTML = source.innerHTML;
        holder.appendChild(inner);
        // Клонируем стили страницы (инлайн <style> в body корневого элемента страницы)
        var styles = document.querySelectorAll('style');
        for (var i = 0; i < styles.length; i++) {
            if (styles[i].textContent && styles[i].textContent.indexOf('.org-node') >= 0) {
                var st = document.createElement('style');
                st.textContent = styles[i].textContent;
                holder.insertBefore(st, holder.firstChild);
            }
        }
        document.body.appendChild(holder);
        return holder;
    }

    // Размеры контейнера экспорта (для подписей разрешения в диалоге).
    // Кэшируется в state.exportSize и сбрасывается в renderTree().
    function getExportDimensions() {
        if (state.exportSize) return state.exportSize;
        var holder = null;
        try {
            holder = buildExportContainer();
            state.exportSize = {
                w: Math.ceil(holder.scrollWidth) || 1200,
                h: Math.ceil(holder.scrollHeight) || 800
            };
        } catch (e) {
            state.exportSize = { w: 1200, h: 800 };
        } finally {
            if (holder && holder.parentNode) holder.parentNode.removeChild(holder);
        }
        return state.exportSize;
    }

    // HTML-строка контейнера экспорта для серверного векторного PDF.
    function buildExportHTML() {
        var holder = buildExportContainer();
        var w, h, html;
        try {
            w = Math.ceil(holder.scrollWidth) || 1200;
            h = Math.ceil(holder.scrollHeight) || 800;
            // Offscreen-позиционирование нельзя сериализовать (контент
            // уедет за вьюпорт при серверном рендере) — чистим до outerHTML.
            holder.style.position = 'static';
            holder.style.left = 'auto';
            holder.style.top = 'auto';
            html = holder.outerHTML;
        } finally {
            if (holder && holder.parentNode) holder.parentNode.removeChild(holder);
        }
        return { html: html, w: w, h: h };
    }

    function renderExportCanvas(cb, opts) {
        opts = opts || {};
        frappe.dom.freeze(__('Рендеринг') + '…');
        setTimeout(function () {
            var holder = null;
            try {
                holder = buildExportContainer();
                var w = Math.ceil(holder.scrollWidth) || 1200;
                var h = Math.ceil(holder.scrollHeight) || 800;
                // Убираем offscreen-позиционирование ДО сериализации:
                // иначе контент рендерится за пределами foreignObject (пустой PNG).
                holder.style.position = 'static';
                holder.style.left = 'auto';
                holder.style.top = 'auto';
                var xml = new XMLSerializer().serializeToString(holder);
                var svgStr = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
                    '<foreignObject x="0" y="0" width="100%" height="100%">' + xml + '</foreignObject></svg>';
                // ВАЖНО: data: URL, а не blob: — Chrome помечает canvas как tainted
                // после drawImage(blob-SVG с foreignObject), и toBlob падает.
                var url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
                var img = new Image();
                img.onload = function () {
                    try {
                        var canvas = document.createElement('canvas');
                        // Ограничения canvas: сторона ≤ 8192px, площадь ≤ ~100 МП;
                        // меньше 1× не уменьшаем (лучше большая картинка, чем мыло)
                        var userScale = opts.scale || 2;
                        var cap = Math.min(8192 / Math.max(w, h), 100000000 / (w * h));
                        var scale = Math.max(1, Math.min(userScale, cap));
                        canvas.width = Math.round(w * scale);
                        canvas.height = Math.round(h * scale);
                        var ctx = canvas.getContext('2d');
                        ctx.fillStyle = '#f8fafc';
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        ctx.scale(scale, scale);
                        ctx.drawImage(img, 0, 0);
                        cb(null, canvas, holder);
                    } catch (err) {
                        cb(err, null, holder);
                    }
                };
                img.onerror = function () {
                    cb(new Error('foreignObject render failed'), null, holder);
                };
                img.src = url;
            } catch (err) {
                cb(err, null, holder);
            }
        }, 50);
    }

    function cleanupExport(holder) {
        if (holder && holder.parentNode) holder.parentNode.removeChild(holder);
        frappe.dom.unfreeze();
    }

    function downloadBlob(blob, filename) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            URL.revokeObjectURL(a.href);
            a.remove();
        }, 3000);
    }

    // Общий растровый экспорт: format 'PNG' | 'JPG', scale 1..4, quality 0..1 (JPG)
    function exportRaster(format, scale, quality) {
        var btn = document.getElementById('export-btn');
        if (btn) btn.disabled = true;
        function done() { if (btn) btn.disabled = false; }
        renderExportCanvas(function (err, canvas, holder) {
            try {
                if (err) throw err;
                var mime = format === 'JPG' ? 'image/jpeg' : 'image/png';
                var ext = format === 'JPG' ? '.jpg' : '.png';
                canvas.toBlob(function (blob) {
                    if (!blob) {
                        frappe.msgprint(__('Не удалось сформировать изображение'));
                        cleanupExport(holder);
                        done();
                        return;
                    }
                    downloadBlob(blob, 'orgchart-' + frappe.datetime.get_today() + ext);
                    cleanupExport(holder);
                    done();
                }, mime, quality);
            } catch (e) {
                frappe.msgprint(__('Не удалось сформировать изображение') + ': ' + e.message);
                cleanupExport(holder);
                done();
            }
        }, { scale: scale || 2 });
    }

    // Минимальный PDF-генератор: одна страница A4 landscape, изображение
    // вписано по центру (DCTDecode — JPEG без перекодирования).
    function buildPdfFromJpeg(jpegBytes, imgW, imgH) {
        var PAGE_W = 842, PAGE_H = 595; // A4 landscape, pt
        var s = Math.min(PAGE_W / imgW, PAGE_H / imgH);
        var dw = imgW * s, dh = imgH * s;
        var x = (PAGE_W - dw) / 2;
        var y = (PAGE_H - dh) / 2;

        var content = 'q ' + dw.toFixed(2) + ' 0 0 ' + dh.toFixed(2) + ' ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' cm /Im0 Do Q';
        var chunks = [];
        var offsets = [];
        var pos = 0;

        function push(s_) {
            var bytes = (typeof s_ === 'string')
                ? s_.split('').map(function (c) { return c.charCodeAt(0) & 0xff; })
                : s_;
            chunks.push(bytes);
            pos += bytes.length;
        }
        function obj(n) {
            offsets[n] = pos;
            push(n + ' 0 obj\n');
        }

        push('%PDF-1.4\n');
        obj(1); push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
        obj(2); push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
        obj(3); push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + '] ' +
            '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n');
        obj(4); push('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n');
        obj(5); push('<< /Type /XObject /Subtype /Image /Width ' + imgW + ' /Height ' + imgH +
            ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpegBytes.length + ' >>\nstream\n');
        push(jpegBytes);
        push('\nendstream\nendobj\n');

        var xrefPos = pos;
        var xref = 'xref\n0 6\n0000000000 65535 f \n';
        for (var i = 1; i <= 5; i++) {
            xref += ('0000000000' + offsets[i]).slice(-10) + ' 00000 n \n';
        }
        push(xref + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF');

        var total = 0;
        chunks.forEach(function (c) { total += c.length; });
        var out = new Uint8Array(total);
        var p = 0;
        chunks.forEach(function (c) { out.set(c, p); p += c.length; });
        return out;
    }

    function dataUrlToBytes(dataUrl) {
        var b64 = dataUrl.split(',')[1];
        var bin = window.atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    // Растровый PDF (крайний случай): используется как откат, если
    // сервер не смог сформировать векторный PDF.
    function exportPDF() {
        var btn = document.getElementById('export-btn');
        if (btn) btn.disabled = true;
        renderExportCanvas(function (err, canvas, holder) {
            try {
                if (err) throw err;
                var jpegUrl = canvas.toDataURL('image/jpeg', 0.92);
                var jpegBytes = dataUrlToBytes(jpegUrl);
                var pdfBytes = buildPdfFromJpeg(jpegBytes, canvas.width, canvas.height);
                downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }),
                    'orgchart-' + frappe.datetime.get_today() + '.pdf');
                cleanupExport(holder);
                if (btn) btn.disabled = false;
            } catch (e) {
                frappe.msgprint(__('Не удалось сформировать PDF') + ': ' + e.message);
                cleanupExport(holder);
                if (btn) btn.disabled = false;
            }
        });
    }

    // === Векторный PDF: контейнер экспорта уходит на сервер ===
    // (headless-Chromium по CDP → wkhtmltopdf), ответ — blob c PDF.
    // Ответ бинарный, поэтому fetch(), а не frappe.call.
    function fetchVectorPDF() {
        var payload = buildExportHTML();
        return fetch('/api/method/' + EXPORT_PDF_METHOD, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Frappe-CSRF-Token': frappe.csrf_token
            },
            body: JSON.stringify({ html: payload.html, width: payload.w, height: payload.h })
        }).then(function (resp) {
            if (!resp.ok) {
                return resp.text().then(function (txt) {
                    var msg = '';
                    try {
                        var j = JSON.parse(txt);
                        msg = j.exception || j.exc_message || j._server_messages || j.message || '';
                        if (typeof msg === 'string' && msg.charAt(0) === '[') {
                            try {
                                msg = JSON.parse(msg).map(function (m) { return m.message || m; }).join(' ');
                            } catch (e2) { /* оставляем как есть */ }
                        }
                    } catch (e) {
                        msg = (txt || '').slice(0, 300);
                    }
                    throw new Error(msg || ('HTTP ' + resp.status));
                }, function () {
                    throw new Error('HTTP ' + resp.status);
                });
            }
            return resp.blob();
        }).then(function (blob) {
            // Защита: вместо PDF может прийти JSON-ошибка с HTTP 200
            if (!blob || blob.size < 500 || (blob.type || '').indexOf('json') >= 0) {
                throw new Error(__('пустой ответ сервера'));
            }
            return blob;
        });
    }

    function exportVectorPDF() {
        frappe.dom.freeze(__('Формирование векторного PDF') + '…');
        fetchVectorPDF()
            .then(function (blob) {
                frappe.dom.unfreeze();
                downloadBlob(blob, 'orgchart-' + frappe.datetime.get_today() + '.pdf');
            })
            .catch(function (err) {
                frappe.dom.unfreeze();
                // Сервер не смог (нет Chromium/wkhtmltopdf) — откат на растровый PDF,
                // чтобы юзер в любом случае получил файл.
                frappe.msgprint({
                    title: __('Векторный PDF недоступен'),
                    indicator: 'orange',
                    message: __('Не удалось сформировать векторный PDF на сервере') +
                        ' (' + ((err && err.message) ? err.message : __('неизвестная ошибка')) + '). ' +
                        __('Сохранён растровый PDF (текст не выделяется).') + '<br><br>' +
                        __('Чтобы включить векторный экспорт, выполните на сервере') +
                        ': <code>bench setup-chromium</code>'
                });
                exportPDF();
            });
    }

    // === Диалог экспорта: формат / разрешение / качество ===
    // Открыта одна кнопка «Экспорт». Диалог создаётся ОДИН раз и
    // переиспользуется: frappe не убирает wrapper скрытого диалога из
    // DOM, поэтому новый Dialog на каждый клик копил бы мусор в body.
    // Последний выбранный формат запоминается в localStorage.
    var EXPORT_FMT_KEY = 'org_chart_mtp_export_format';
    var exportDialog = null;

    function openExportDialog() {
        var savedFmt = null;
        try { savedFmt = window.localStorage.getItem(EXPORT_FMT_KEY); } catch (e) { /* приватный режим */ }
        var fmt = ['PNG', 'JPG', 'PDF'].indexOf(savedFmt) >= 0 ? savedFmt : 'PNG';
        var dims = getExportDimensions();
        var scaleOptions = buildScaleOptions(dims);
        if (!exportDialog) exportDialog = buildExportDialog(scaleOptions);

        // подписи разрешений актуальны для текущего размера дерева
        exportDialog.set_df_property('scale', 'options', scaleOptions);
        exportDialog.set_value('format', fmt); // триггерит syncExportFields
        exportDialog.set_value('scale', '2');
        exportDialog.set_value('quality', '0.92');
        exportDialog.show();
        syncExportFields();
    }

    function buildScaleOptions(dims) {
        return [1, 2, 3, 4].map(function (s) {
            return {
                label: s + '\u00d7 \u2014 ' +
                    Math.round(dims.w * s).toLocaleString() + ' \u00d7 ' +
                    Math.round(dims.h * s).toLocaleString() + ' ' + __('пкс'),
                value: String(s)
            };
        });
    }

    function buildExportDialog(scaleOptions) {
        var d = new frappe.ui.Dialog({
            title: __('Экспорт оргчарта'),
            fields: [
                {
                    fieldname: 'format', label: __('Формат'), fieldtype: 'Select',
                    options: [
                        { label: __('PNG — растровое, без потерь'), value: 'PNG' },
                        { label: __('JPG — растровое, компактный файл'), value: 'JPG' },
                        { label: __('PDF — векторный, текст выделяется'), value: 'PDF' }
                    ],
                    default: 'PNG',
                    description: __('PDF формируется на сервере (Chromium) и содержит живой текст; растровые форматы рисуются в браузере.')
                },
                {
                    fieldname: 'scale', label: __('Разрешение'), fieldtype: 'Select',
                    options: scaleOptions, default: '2',
                    description: __('Итоговый размер изображения в пикселях')
                },
                {
                    fieldname: 'quality', label: __('Качество JPG'), fieldtype: 'Select',
                    options: [
                        { label: __('85% — минимальный размер файла'), value: '0.85' },
                        { label: __('92% — сбалансированное'), value: '0.92' },
                        { label: __('96% — максимальное качество'), value: '0.96' }
                    ],
                    default: '0.92'
                }
            ],
            primary_action_label: __('Скачать'),
            primary_action: function (values) {
                d.hide();
                try { window.localStorage.setItem(EXPORT_FMT_KEY, values.format); } catch (e) { /* приватный режим */ }
                if (values.format === 'PDF') {
                    exportVectorPDF();
                } else {
                    exportRaster(
                        values.format,
                        parseInt(values.scale, 10) || 2,
                        parseFloat(values.quality) || 0.92
                    );
                }
            }
        });
        d.fields_dict.format.df.onchange = syncExportFields;
        if (d.$wrapper) d.$wrapper.addClass('org-chart-dialog'); // мобильная ширина диалога
        return d;
    }

    // Поля НЕ прячем через df.hidden при создании диалога: v16 не
    // рендерит input у скрытого поля (toggle потом нечего показывать).
    // Вместо этого рендерим все поля, а видимость синхронизируем
    // вручную (df.hidden + toggle) — надёжнее depends_on.
    function syncExportFields() {
        var d = exportDialog;
        if (!d) return;
        var cur = d.fields_dict.format.get_value() || 'PNG';
        setFieldVisible(d, 'scale', cur !== 'PDF');
        setFieldVisible(d, 'quality', cur === 'JPG');
    }

    function setFieldVisible(dlg, name, show) {
        var f = dlg.fields_dict[name];
        if (!f) return;
        if (f.df) f.df.hidden = !show;
        var w = f.$wrapper || (f.wrapper ? $(f.wrapper) : null);
        if (w) w.toggle(show);
    }

    $('#export-btn').off('click').on('click', openExportDialog);

    // === Утилиты ===
    function escapeHtml(text) {
        if (!text) return '';
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
