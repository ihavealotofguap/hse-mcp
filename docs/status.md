# Статус: что есть, что покрыто, что проверено

Одна таблица на вопрос «что тут вообще работает». Обновляйте её в том же PR, где меняются тулы или
тесты. Состояние на 2026-10-25.

| Часть | Тулы | Код | Тесты (`test/`) | Проверено вживую |
|---|---|---|---|---|
| Ядро: вход через SSO, браузер, лимитер, кэш, учётные данные | — | `src/*.ts`, `src/auth`, `src/cli` | `resource`, `fs-lock`, `credentials`; вход, лимитер и выключатель — нет | да |
| SmartLMS, чтение | `lms_list_courses`, `lms_get_course_materials`, `lms_list_assignments`, `lms_get_grades`, `lms_list_messages`, `lms_get_message`, `lms_open_page` | `services/lms/client.ts` | только защита `lms_open_page` (`open-page`) | да, один аккаунт, один семестр |
| ЕЛК, чтение | `elk_get_schedule`, `elk_get_user_info`, `elk_get_academic_data`, `elk_get_profile`, `elk_search_services`, `elk_list_requests`, `elk_get_notifications`, `elk_list_tasks`, `elk_get_login_history`, `elk_list_dpo_programs`, `elk_get_antiplagiat_status`, `elk_get_course_evaluation_status`, `elk_get_thesis_status`, `elk_get_portfolio`, `elk_list_internships`, `elk_get_scholarship_history`, `elk_open_page` | `services/elk/client.ts` | только защита `elk_open_page` (`open-page`) | частично: вне `/profile` разметка не проверялась, формат `elk_list_tasks` неизвестен |
| Сводки | `my_today`, `my_week`, `my_deadlines` | `services/digest/` | нет | да, один аккаунт |
| Изменения | `hse_changes`, `hse_changes_reset` | `services/changes/` | нет | да, один аккаунт; `added`/`changed`/`moved` — только имитацией правки базы |
| Служебное | `hse_clear_cache` | `services/system/` | нет | да |
| Каркас записи | — | `services/writes/` | `runner`, `token`, `journal`, `outbox`, `tools-gating` | да |
| Запись в SmartLMS | `lms_submit_assignment`, `lms_delete_submission` | `services/lms/submissions.ts` | `submissions-pure` | да, один аккаунт, один семестр |
| Заказ справки в ЕЛК | `elk_order_certificate` | `services/elk/certificate.ts` | `certificate-pure` | один заказ; тул всегда отвечает `unknown`, исход проверяется вручную |
| Архитектура | — | — | `architecture`: импорты соблюдают слои | — |

Тулы записи появляются только при `HSE_ENABLE_WRITES=true`: без него у сервера 30 тулов, с ним 33.

## Пробелы

- Нет тестов чистой логики сводок и изменений: `services/changes/diff.ts`, `normalize.ts`,
  `extractors.ts`, `services/digest/parse.ts`.
- Нет тестов разбора страниц LMS и ЕЛК на сохранённых HTML-образцах.
- Девять мелких тулов ЕЛК (ДПО, антиплагиат, СОП, ВКР, портфолио, практики, стипендия, задачи,
  история входов) кандидаты на объединение в один тул с параметром раздела.
- Аннотации `readOnlyHint` есть только у тулов записи; `outputSchema` нет ни у одного тула.
