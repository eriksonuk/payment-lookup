# Payment Method Lookup

Инструмент подбора платёжных методов по стране и сумме.
Живёт на GitHub Pages, данные тянутся автоматически из Confluence
(страница Cashier Operations, ID `75333720`).

## Как устроено

```
index.html              — UI. Читает data/methods.json через fetch.
data/methods.json       — данные. Генерятся автоматически (НЕ править руками без нужды).
scripts/sync.mjs        — ходит в Confluence API, парсит таблицы, пишет methods.json.
.github/workflows/sync.yml — запускает sync.mjs по расписанию (раз в сутки) и по кнопке.
```

Тул статический — никакого бэкенда. Confluence напрямую из браузера дёргать
нельзя (CORS + токен), поэтому синхронизацию делает GitHub Action: он коммитит
свежий `methods.json` в репозиторий, а Pages раздаёт его как обычный файл.

## Разовая настройка (один раз)

1. **Создай Atlassian API-токен:**
   https://id.atlassian.com/manage-profile/security/api-tokens → Create API token.

2. **Добавь Secrets** в репозитории: Settings → Secrets and variables → Actions → New repository secret:
   - `CONF_BASE`  = `https://pokerplanets.atlassian.net/wiki`
   - `CONF_EMAIL` = твой email в Atlassian
   - `CONF_TOKEN` = созданный токен

   Secrets не видны в логах и в коде даже в публичном репо.

3. **Включи GitHub Pages:** Settings → Pages → Source: Deploy from a branch → `main` / root.

4. **Запусти первую синхронизацию вручную:** вкладка Actions → "Sync payment data from Confluence" → Run workflow.
   После прогона в `data/methods.json` появятся свежие лимиты, и тул их подхватит.

## Как обновляются данные

- **Автоматически** — каждый день в 06:00 UTC. Если на странице что-то поменялось,
  бот коммитит новый `methods.json`. Если изменений нет — коммита не будет.
- **Вручную** — Actions → Run workflow, когда нужно прямо сейчас.

## Что всё ещё правится руками

Ничего из платёжных данных. Все шесть блоков — пять стран плюс
`GENERAL / INTERNATIONAL` (общие методы + список стран) — живут на странице
Cashier Operations и тянутся автоматически. Чтобы изменить общие методы или
список «международных» стран, правь экспанд `GENERAL / INTERNATIONAL` прямо
на странице — синк подхватит.

## Локальный запуск синка (для отладки)

```bash
CONF_BASE=https://pokerplanets.atlassian.net/wiki \
CONF_EMAIL=you@example.com \
CONF_TOKEN=xxxx \
node scripts/sync.mjs
```

## Проверка после изменения payments

Открой тул — в плашке сверху видна дата синхронизации и версия страницы.
Если версия отстаёт от Confluence — жми Run workflow.
