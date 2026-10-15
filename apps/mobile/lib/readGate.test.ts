import { describe, expect, it } from 'vitest';
import { createReadGate } from './readGate';

describe('createReadGate', () => {
  it('lets overlapping reads both land: a poll slower than the interval still lands', () => {
    const gate = createReadGate();
    const first = gate.beginRead();
    const second = gate.beginRead();
    expect(gate.landed(first)).toBe(true);
    expect(gate.landed(second)).toBe(true);
  });

  it('refuses a read that started before a write, and lands the ones after it', () => {
    const gate = createReadGate();
    const before = gate.beginRead();
    gate.write();
    const after = gate.beginRead();
    expect(gate.landed(before)).toBe(false);
    expect(gate.landed(after)).toBe(true);
  });

  it('is busy only while a read is out, so a poll can skip its tick', () => {
    const gate = createReadGate();
    expect(gate.busy()).toBe(false);
    gate.beginRead();
    expect(gate.busy()).toBe(true);
    gate.endRead();
    expect(gate.busy()).toBe(false);
    gate.endRead();
    expect(gate.busy()).toBe(false);
  });
});
