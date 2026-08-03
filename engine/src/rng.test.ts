import { describe, expect, it } from 'vitest';
import { createRng } from './rng.js';

describe('rng（确定性种子随机）', () => {
  it('同种子同序列', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('异种子异序列', () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('游标恢复后序列一致（序列化回放性质）', () => {
    const a = createRng(7);
    for (let i = 0; i < 5; i++) a.next();
    const resumed = createRng(7, a.cursor());
    for (let i = 0; i < 20; i++) expect(resumed.next()).toBe(a.next());
  });

  it('shuffle 为排列且确定', () => {
    const src = Array.from({ length: 30 }, (_, i) => i);
    const a = createRng(99).shuffle([...src]);
    const b = createRng(99).shuffle([...src]);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual(src);
  });

  it('int 范围正确', () => {
    const r = createRng(3);
    for (let i = 0; i < 200; i++) {
      const v = r.int(6);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
    }
  });
});
