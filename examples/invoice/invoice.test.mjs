import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subtotal } from './invoice.mjs';

test('an empty invoice totals zero', () => assert.equal(subtotal([]), 0));
test('one unit uses its integer-cent price', () => {
  assert.equal(subtotal([{ unitPriceCents: 250, quantity: 1 }]), 250);
});
