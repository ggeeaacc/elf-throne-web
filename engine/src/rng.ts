/**
 * 确定性种子 RNG（mulberry32）。
 *
 * 铁律：引擎内一切随机必须经由此处；cursor 存于 GameState 内随状态序列化，
 * 保证「同种子 + 同指令流 ⇒ 逐字节相同终态」（ADR-003）。
 */

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [0, n) 整数 */
  int(n: number): number;
  /** 原地 Fisher–Yates 洗牌并返回同一数组 */
  shuffle<T>(arr: T[]): T[];
  /** 当前游标（用于序列化） */
  cursor(): number;
}

/** 由种子与游标构造（游标用于从序列化状态恢复） */
export function createRng(seed: number, initialCursor = 0): Rng {
  let a = seed >>> 0;
  let c = initialCursor >>> 0;
  const step = () => {
    // mulberry32
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // 快进游标（恢复序列化状态时保持流一致）
  for (let i = 0; i < c; i++) step();
  return {
    next() {
      c = (c + 1) >>> 0;
      return step();
    },
    int(n: number) {
      if (n <= 0) throw new RangeError('int(n) requires n > 0');
      return Math.floor(this.next() * n);
    },
    shuffle<T>(arr: T[]): T[] {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = this.int(i + 1);
        const tmp = arr[i] as T;
        arr[i] = arr[j] as T;
        arr[j] = tmp;
      }
      return arr;
    },
    cursor() {
      return c;
    },
  };
}
