import { Bot, InlineKeyboard } from 'grammy';

const RULES = [
  'Правила гомоку ⚫⚪',
  '',
  '• Доска 15×15, чёрные ходят первыми.',
  '• Игроки по очереди ставят камни на пересечения линий.',
  '• Побеждает тот, кто первым выстроит 5 и больше камней в ряд: по горизонтали, вертикали или диагонали.',
  '• Цвет определяется жребием.',
  '• Если на ход есть ограничение (30 или 60 секунд) и время вышло — партия проиграна.',
  '',
  'Чтобы поставить камень, коснись точки дважды или выбери её и нажми «Поставить».',
  'Если соперника нет в игре, я пришлю ему уведомление о твоём ходе.',
].join('\n');

/**
 * Запускает бота (long polling — не нужен вебхук и отдельный порт).
 * getInviteInfo(room) -> { host, status } | null — для текста приглашения.
 * onUser(tgUser) — запоминаем пользователя, чтобы потом слать уведомления.
 */
export async function startBot({ token, webappUrl, getInviteInfo, onUser }) {
  const bot = new Bot(token);
  await bot.init();

  const isHttps = webappUrl.startsWith('https://');
  if (!isHttps) {
    console.warn('⚠ WEBAPP_URL не https:// — Telegram не откроет Mini App по такой ссылке.');
  }

  const openButton = (text, room) => {
    const url = room ? `${webappUrl}/?room=${encodeURIComponent(room)}` : `${webappUrl}/`;
    return new InlineKeyboard().webApp(text, url);
  };

  bot.command('start', async (ctx) => {
    onUser(ctx.from);
    const room = (ctx.match || '').trim().toLowerCase();
    const info = room ? getInviteInfo(room) : null;
    if (info) {
      const text = info.status === 'waiting'
        ? `${info.host} приглашает тебя сыграть в гомоку — пять в ряд! ⚫⚪\n\nЖми кнопку, и партия начнётся.`
        : 'Партия уже идёт. Открыть её:';
      await ctx.reply(text, { reply_markup: openButton('🎮 Открыть партию', room) });
    } else {
      await ctx.reply(
        'Привет! Это гомоку — «пять в ряд» для двоих ⚫⚪\n\n' +
        'Создай партию, отправь приглашение другу и играйте: хоть сразу, хоть не спеша. ' +
        'Я напомню, когда наступит твой ход.',
        { reply_markup: openButton('🎮 Играть') },
      );
    }
  });

  bot.command('rules', (ctx) => ctx.reply(RULES));

  bot.on('message', (ctx) => {
    onUser(ctx.from);
    // Прислали код партии или ссылку-приглашение — даём кнопку прямо в эту партию
    const text = ctx.message.text || '';
    const m = text.match(/(?:startapp=|start=|room=)([a-z0-9]+)/i) || text.trim().match(/^([a-z0-9]{4,12})$/i);
    const room = m && m[1].toLowerCase();
    if (room && getInviteInfo(room)) {
      return ctx.reply('Нашёл партию 👇', { reply_markup: openButton('🎮 Открыть партию', room) });
    }
    return ctx.reply('Нажми кнопку, чтобы открыть игру 👇', { reply_markup: openButton('🎮 Играть') });
  });

  bot.catch((err) => console.error('Ошибка бота:', err.error?.description || err.error?.message || err));

  try {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Открыть игру' },
      { command: 'rules', description: 'Правила' },
    ]);
    if (isHttps) {
      await bot.api.setChatMenuButton({
        menu_button: { type: 'web_app', text: 'Играть', web_app: { url: `${webappUrl}/` } },
      });
    }
  } catch (e) {
    console.warn('Не удалось настроить меню бота:', e.description || e.message);
  }

  bot.start({
    drop_pending_updates: true,
    onStart: () => console.log(`Бот @${bot.botInfo.username} запущен`),
  }).catch((e) => {
    console.error('Бот остановился с ошибкой:', e.description || e.message);
    process.exit(1);
  });

  const hasMainApp = !!bot.botInfo.has_main_web_app;
  console.log(hasMainApp
    ? 'Main Mini App включён — приглашения открывают игру сразу.'
    : 'Main Mini App не включён в @BotFather — приглашения будут вести в чат с ботом (/start КОД).');

  return {
    username: bot.botInfo.username,
    hasMainApp,
    async send(chatId, text, room, buttonText = '🎮 Открыть партию') {
      const msg = await bot.api.sendMessage(chatId, text, { reply_markup: openButton(buttonText, room) });
      return msg.message_id;
    },
    async del(chatId, messageId) {
      try { await bot.api.deleteMessage(chatId, messageId); } catch { /* уже удалено */ }
    },
    stop: () => bot.stop(),
  };
}
