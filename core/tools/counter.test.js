import { createCounter } from './counter.js';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

describe('createCounter', () => {
  it('starts at 0 by default', () => {
    const c = createCounter();
    assert.equal(c.getCount(), 0);
  });

  it('starts at a custom initial value', () => {
    const c = createCounter(10);
    assert.equal(c.getCount(), 10);
  });

  it('increments', () => {
    const c = createCounter();
    assert.equal(c.increment(), 1);
    assert.equal(c.increment(), 2);
    assert.equal(c.getCount(), 2);
  });

  it('decrements', () => {
    const c = createCounter(5);
    assert.equal(c.decrement(), 4);
    assert.equal(c.decrement(), 3);
    assert.equal(c.getCount(), 3);
  });

  it('resets to initial value', () => {
    const c = createCounter(3);
    c.increment();
    c.increment();
    assert.equal(c.getCount(), 5);
    assert.equal(c.reset(), 3);
    assert.equal(c.getCount(), 3);
  });

  it('handles negative counts', () => {
    const c = createCounter();
    c.decrement();
    c.decrement();
    assert.equal(c.getCount(), -2);
  });
});
