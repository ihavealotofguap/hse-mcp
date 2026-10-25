# Статус: что есть, что покрыто, что проверено

Одна таблица на вопрос «что тут вообще работает». Обновляйте её в том же PR, где меняются тулы или
тесты. Состояние на 2026-10-25.

| Часть | Тулы | Код | Тесты (`test/`) | Проверено вживую |
|---|---|---|---|---|
| Ядро: вход через SSO, браузер, лимитер, кэш, учётные данные | — | `src/*.ts`, `src/auth`, `src/cli` | `resource`, `fs-lock`, `credentials`; вход, лимитер и выключатель — нет | да |
| SmartLMS, чтение | `lms_list_courses`, `lms_get_course_materials`, `lms_list_assignments`, `lms_get_grades`, `lms_list_messages`, `lms_get_message`, `lms_open_page` | `services/lms/client.ts` | только защита `lms_open_page` (`open-page`) | да, один аккаунт, один семестр |
| ЕЛК, чтение | `elk_get_schedule`, `elk_get_user_info`, `elk_get_academic_data`, `elk_search_services`, `elk_list_requests`, `elk_get_notifications`, `elk_get_section` (10 разделов), `elk_open_page` | `services/elk/client.ts` | защита `elk_open_page` (`open-page`); схема и разделы `elk_get_section` (`elk-section`) | частично: вне `/profile` разметка не проверялась, формат раздела `tasks` неизвестен |
| Сводки | `my_today`, `my_week`, `my_deadlines` | `services/digest/` | `digest-parse`, `digest-client`: разбор дат, отбор курсов, `buildDigest` с подставными коллекторами; коллекторы с сетью — нет | да, один аккаунт |
| Изменения | `hse_changes`, `hse_changes_reset` | `services/changes/` | `changes-normalize`, `changes-diff`, `changes-extractors`, `changes-store` (журнал и курсор через `getChanges` во временном каталоге) | да, один аккаунт; `added`/`changed`/`moved` — только имитацией правки базы |
| Служебное | `hse_clear_cache` | `services/system/` | нет | да |
| Каркас записи | — | `services/writes/` | `runner`, `token`, `journal`, `outbox`, `tools-gating` | да |
| Запись в SmartLMS | `lms_submit_assignment`, `lms_delete_submission` | `services/lms/submissions/` | `submissions-pure` | да, один аккаунт, один семестр |
| Заказ справки в ЕЛК | `elk_order_certificate` | `services/elk/certificate/` | `certificate-pure` | один заказ (тогда исход `unknown`); проверка по странице «Заявки» с заказом не проверена |
| Архитектура | — | — | `architecture`: импорты соблюдают слои | — |
| Оформление тулов | все | `src/mcp-utils.ts`, `*/tools.ts` | `tools-annotations`: аннотации у каждого тула, `runTool`, `outputSchema` на типичных ответах, `tools/list` через stdio | — |

Тулы записи появляются только при `HSE_ENABLE_WRITES=true`: без него у сервера 21 тул, с ним 24.
У каждого тула есть аннотации: чтение — `readOnlyHint: true`, запись — `destructiveHint: true`;
`hse_changes_reset` — `destructiveHint: true` (стирает локальную базу), `hse_clear_cache` — не
`readOnly`, но `idempotent`.

## Пробелы

- Нет тестов разбора страниц LMS и ЕЛК на сохранённых HTML-образцах.
- `outputSchema` есть только у основных тулов (`elk_get_schedule`, `my_today`, `my_week`,
  `my_deadlines`, `lms_list_assignments`, `lms_list_courses`); у остальных ответ описан только текстом.
