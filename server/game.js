// Правила гомоку: доска 15×15, чёрные (индекс 0) ходят первыми.
export const SIZE = 15;

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

/** Чей сейчас ход: 0 — чёрные, 1 — белые. */
export const turnOf = (g) => g.moves.length % 2;

/**
 * Проверяет, выиграл ли последний сделанный ход.
 * rule: 'free'  — 5 и больше камней в ряд;
 *       'exact' — ровно 5 (ряд из 6+ не засчитывается).
 * Возвращает клетки выигрышного ряда (по порядку) или null.
 */
export function findWin(moves, rule) {
  if (!moves.length) return null;
  const board = new Int8Array(SIZE * SIZE).fill(-1);
  moves.forEach(([x, y], i) => { board[y * SIZE + x] = i % 2; });

  const [x, y] = moves[moves.length - 1];
  const color = (moves.length - 1) % 2;
  const at = (cx, cy) => (cx >= 0 && cy >= 0 && cx < SIZE && cy < SIZE ? board[cy * SIZE + cx] : -2);

  for (const [dx, dy] of DIRS) {
    let back = 0;
    while (at(x - (back + 1) * dx, y - (back + 1) * dy) === color) back++;
    let fwd = 0;
    while (at(x + (fwd + 1) * dx, y + (fwd + 1) * dy) === color) fwd++;
    const len = back + fwd + 1;
    if (rule === 'exact' ? len === 5 : len >= 5) {
      const line = [];
      for (let k = -back; k <= fwd; k++) line.push([x + k * dx, y + k * dy]);
      return line;
    }
  }
  return null;
}
