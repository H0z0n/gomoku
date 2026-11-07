# Гомоку — Telegram Mini App

«Пять в ряд» для двоих внутри Telegram. Вся игра работает в Mini App, а бот нужен для двух вещей: открывать игру и присылать «Твой ход!», когда приложение закрыто.

**Что умеет**
- Доска 15×15, игра в реальном времени или «по переписке» (сходил и закрыл, бот напомнит сопернику).
- Приглашение ссылкой: соперник открывает её, и партия начинается.
- Два правила: «5 и больше» или «Ровно 5» (ряд из 6+ не засчитывается).
- Ход в два касания: точка → подтверждение, чтобы не промахнуться пальцем.
- Подсветка последнего хода и выигрышного ряда, статус соперника «в игре / не в сети».
- Можно попросить вернуть ход, сдаться, сыграть реванш (цвета меняются).
- Общий счёт побед между вами, список всех партий, несколько партий одновременно.
- Тема и цвета берутся из Telegram (светлая/тёмная), есть виброотклик.
- Партии сохраняются на сервере (`data/db.json`) и переживают перезапуск.

## Структура

```
server/index.js   HTTP + WebSocket сервер, логика партий
server/game.js    правила (проверка пяти в ряд)
server/auth.js    проверка подписи Telegram (initData)
server/bot.js     бот: /start, кнопка меню, уведомления
server/store.js   хранение в JSON-файле
public/           сам Mini App (HTML/CSS/JS, без сборки)
deploy/           systemd-сервис и конфиг Caddy
```

## Попробовать локально (без Telegram)

Нужен Node.js 20.12 или новее.

```bash
npm install
# в .env: DEV=1, BOT_TOKEN пустой
cp .env.example .env
npm start
```

Откройте два окна браузера:
- http://localhost:3000/?as=Я
- http://localhost:3000/?as=Подруга

В первом создайте партию и нажмите «Скопировать ссылку». Во втором откройте эту ссылку, добавив `&as=Подруга`.

## Запуск в Telegram на VPS

### 1. Что нужно

- VPS с Ubuntu 22.04/24.04 (хватит самого дешёвого тарифа).
- **Домен**, направленный на IP сервера (A-запись). Telegram открывает Mini App только по HTTPS, а для HTTPS нужен домен. Подойдёт и бесплатный поддомен, например от DuckDNS.

### 2. Создать бота

1. В [@BotFather](https://t.me/BotFather) отправьте `/newbot` и получите **токен**.
2. Там же: `/mybots` → ваш бот → **Bot Settings → Configure Mini App → Enable Mini App** и укажите адрес `https://game.example.com/`.
   После этого ссылки вида `t.me/ваш_бот?startapp=…` будут сразу открывать игру, и приглашения работают именно так.

### 3. Установить на сервер

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# скопируйте папку проекта на сервер (без node_modules и data), например:
#   scp -r gomoku-telegram root@IP_СЕРВЕРА:/opt/
cd /opt/gomoku-telegram
npm ci --omit=dev

cp .env.example .env
nano .env        # BOT_TOKEN, WEBAPP_URL=https://game.example.com, DEV=0
```

### 4. Запустить как службу

```bash
sudo useradd -r -s /usr/sbin/nologin gomoku
sudo chown -R gomoku:gomoku /opt/gomoku-telegram
sudo cp deploy/gomoku.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gomoku
journalctl -u gomoku -f      # должно быть «Бот @… запущен»
```

### 5. HTTPS через Caddy

```bash
sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile   # впишите свой домен
sudo systemctl reload caddy
```

Откройте `https://game.example.com/health`: там должно быть `ok`. Если на сервере включён файрвол, откройте порты 80 и 443 (`sudo ufw allow 80,443/tcp`).

### 6. Играть

Откройте бота → **Играть** → «Новая партия» → «Пригласить» и отправьте ссылку подруге. Когда она откроет ссылку, партия начнётся.

## Обновление

Скопируйте новые файлы поверх старых (папку `data/` и файл `.env` не трогайте), затем выполните:

```bash
cd /opt/gomoku-telegram && npm ci --omit=dev && sudo systemctl restart gomoku
```

## Резервная копия

Все партии и счёт лежат в `data/db.json`. Достаточно иногда копировать этот файл.
