import crypto from 'node:crypto';

/**
 * Проверяет подпись initData, которую Telegram передаёт в Mini App.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Возвращает объект пользователя Telegram или null, если подпись неверна.
 */
export function verifyInitData(initData, botToken, maxAgeSec = 7 * 24 * 3600) {
  if (typeof initData !== 'string' || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  if (expected.length !== hash.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash))) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;

  try {
    const user = JSON.parse(params.get('user'));
    return user && Number.isInteger(user.id) ? user : null;
  } catch {
    return null;
  }
}
