# Bybit USDT-perp бот

Торгує ф'ючерсами на твоєму акаунті Bybit через API-ключ. Сигнали й ризик-менеджмент — ті самі, що пройшли бектест у [docs/bybit-analysis.md](../docs/bybit-analysis.md).

## Що захищає депозит

| Захист | Як працює |
|---|---|
| Стоп на біржі | Стоп-лосс передається разом з ордером. Якщо бот або VPS впаде, стоп однаково спрацює на Bybit |
| «Жодної позиції без стопа» | Кожні 20 с бот перевіряє стопи. Якщо стоп зник — ставить новий, а якщо ціна вже за ним — закриває позицію |
| Розмір від стопа | Збиток по стопу разом з комісіями й сліпеджем = 1% капіталу (normal) |
| Плече | ≤ 3x (normal), жорстка межа 10x. Ліквідація завжди щонайменше вдвічі далі за стоп |
| Денний ліміт | −3% за день: нових угод до наступного дня немає |
| Серія збитків | 4 збитки поспіль: пауза 12 год |
| Kill-switch | −15% від піку капіталу або капітал нижче `MIN_EQUITY_USDT`: усі позиції закриваються, торгівля зупиняється до `/resume_confirm` |
| Ключ | Бот **відмовляється** працювати з ключем, що має право виводу, а в live — з ключем без прив'язки до IP |
| Режим | За замовчуванням демо-рахунок. Реальні гроші лише з `BYBIT_MODE=live` + `LIVE_CONFIRM=YES_REAL_MONEY` |
| Чужі позиції | Якщо ти вручну відкрив позицію на монеті бота, бот цю монету не чіпає |

## Крок 1. Bybit

1. **Створи субакаунт** для бота й переведи туди лише торговий капітал (наприклад, 200 €). Так бот фізично не зможе втратити більше.
2. **Демо:** Bybit → *Demo Trading* → у демо-режимі створи API-ключ (демо-ключі окремі від справжніх).
3. **Параметри ключа:** *System-generated*, права **Contract → Orders + Positions (Read-Write)**. **Без Withdraw і без Transfer.** Прив'язка до IP твого VPS.

## Крок 2. VPS у ЄС (~4–5 €/міс)

Наприклад, Hetzner CX22 (Німеччина/Фінляндія), Ubuntu 24.04. Сервери в США Bybit блокує.

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs git
git clone https://github.com/SimpleTrust1998/Odds.git && cd Odds
git checkout claude/pump-fun-monetization-6isqkv
cp bybit/.env.example bybit/.env && nano bybit/.env   # ключі, Telegram
sudo timedatectl set-ntp true                         # точний час (Bybit перевіряє мітки)

node --env-file=bybit/.env bybit/bot.mjs check        # перевірка: ключ, права, баланс — без угод
node --env-file=bybit/.env bybit/bot.mjs run          # пробний запуск у терміналі (Ctrl+C — зупинка)
```

Запуск 24/7 через systemd (`/etc/systemd/system/bybit-bot.service`):

```ini
[Unit]
Description=Bybit bot
After=network-online.target

[Service]
WorkingDirectory=/root/Odds
ExecStart=/usr/bin/node --env-file=bybit/.env bybit/bot.mjs run
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now bybit-bot
journalctl -u bybit-bot -f          # лог
```

## Крок 3. Етапи

1. **Демо, 2–4 тижні.** Порівняй угоди з бектестом: чи збігаються входи, стопи, розміри.
2. **Live з мінімальним капіталом.** Новий ключ на справжньому субакаунті, `BYBIT_MODE=live`, `LIVE_CONFIRM=YES_REAL_MONEY`, `MIN_EQUITY_USDT`.
3. **Аварійна кнопка:** `/stop` у Telegram або `node --env-file=bybit/.env bybit/bot.mjs flatten`.

## Команди Telegram

`/status` · `/pnl` · `/pause` (без нових входів) · `/resume` · `/stop` (закрити все й зупинитись) · `/resume_confirm` (після kill-switch)

## Інші команди

```bash
node bybit/analyze.mjs звіт.md            # бектест BTC/ETH/SOL, усі стратегії й профілі
node bybit/analyze-universe.mjs звіт.md   # сканер по 40 монетах
node --test bybit/                        # тести (фейкова біржа з перевіркою підписів)
node --env-file=bybit/.env bybit/bot.mjs status
```

## Що все одно може піти не так

- **Геп крізь стоп.** На різкому русі стоп виконується гірше заданої ціни.
- **Збій Bybit.** Біржа або API недоступні. Стопи на біржі зазвичай продовжують працювати.
- **Стратегія перестає працювати.** Ринок змінюється, а тренд-стратегії мають довгі періоди мінусів. Kill-switch обмежує збиток, але не робить стратегію прибутковою.
- **Ти сам.** Підняти плече «щоб швидше» або вимкнути ліміти після серії збитків — найчастіша причина зливу.
