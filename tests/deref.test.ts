import { describe, expect, it } from 'vitest';

import { loadCheckoutSchema, resolveFieldSchemaAtPath } from '../src/schema/deref.js';
import type { JSONSchema } from '../src/schema/json-schema.js';
import { UnsupportedPathError } from '../src/schema/jsonpath.js';

/** True if `key` appears anywhere in the (possibly cyclic) schema graph. */
function hasKeyDeep(obj: unknown, key: string, seen = new Set<unknown>()): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (seen.has(obj)) return false;
  seen.add(obj);
  if (Array.isArray(obj)) return obj.some((v) => hasKeyDeep(v, key, seen));
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) return true;
    if (hasKeyDeep(v, key, seen)) return true;
  }
  return false;
}

describe('deref — bundled UCP checkout schema', () => {
  it('dereferences the whole checkout graph to a $ref-free schema', async () => {
    const schema = await loadCheckoutSchema();
    // Every relative-file/allOf `$ref` (buyer.json, line_item.json, ../ucp.json…)
    // is inlined; the one self-referential branch ($.payment) is an object ref.
    expect(hasKeyDeep(schema, '$ref')).toBe(false);
    expect(schema.type).toBe('object');
    expect(schema.properties?.['buyer']).toBeDefined();
    expect(schema.properties?.['line_items']).toBeDefined();
  });

  it("resolveFieldSchemaAtPath('$.buyer.phone_number') → the REAL {type:'string',…}", async () => {
    const s = await resolveFieldSchemaAtPath('$.buyer.phone_number');
    expect(s.type).toBe('string');
    expect(s).not.toHaveProperty('$ref');
    expect(s).not.toHaveProperty('allOf');
    // The description comes from the real UCP buyer.json field.
    expect(String(s.description)).toMatch(/E\.164/);
  });

  it('resolves a nested/object path to the REAL object sub-schema', async () => {
    const buyer = await resolveFieldSchemaAtPath('$.buyer');
    expect(buyer.type).toBe('object');
    expect(buyer).not.toHaveProperty('allOf');
    expect(Object.keys(buyer.properties ?? {})).toEqual(
      expect.arrayContaining(['first_name', 'last_name', 'email', 'phone_number'])
    );
    const phone = (buyer.properties ?? {})['phone_number'] as JSONSchema | undefined;
    expect(phone?.type).toBe('string');
  });

  it('REALLY merges allOf: $.context folds locality + inline props, no allOf remains', async () => {
    const ctx = await resolveFieldSchemaAtPath('$.context');
    expect(ctx).not.toHaveProperty('allOf');
    const props = Object.keys(ctx.properties ?? {});
    expect(props).toContain('intent'); // from the inline object
    expect(props).toContain('address_country'); // merged out of the `allOf` locality ref
  });

  it('resolves a bracket-quoted key path', async () => {
    const email = await resolveFieldSchemaAtPath("$['buyer']['email']");
    expect(email.type).toBe('string');
  });

  it('resolves an array-element path via `items` (totals amount is a real number type)', async () => {
    const amount = await resolveFieldSchemaAtPath('$.totals[0].amount');
    // signed_amount.json is an integer/number amount.
    expect(['integer', 'number']).toContain(amount.type);
    expect(amount).not.toHaveProperty('allOf');
  });

  it('throws UnsupportedPathError for a path that is not a declared field', async () => {
    await expect(resolveFieldSchemaAtPath('$.buyer.not_a_real_field')).rejects.toBeInstanceOf(
      UnsupportedPathError
    );
  });

  it('$.line_items[0] is fully merged: NO nested allOf, NO $defs, and JSON-serialisable', async () => {
    const li = await resolveFieldSchemaAtPath('$.line_items[0]');
    expect(li.type).toBe('object');
    // The line-item subtree (item, totals→total.json) composes via allOf; every
    // nested allOf must be folded, not just the outermost node.
    expect(hasKeyDeep(li, 'allOf')).toBe(false);
    expect(hasKeyDeep(li, '$ref')).toBe(false);
    expect(hasKeyDeep(li, '$defs')).toBe(false);
    expect(() => JSON.stringify(li)).not.toThrow();
  });

  it('$.payment carries no $defs and is JSON-serialisable (circular carrier stripped)', async () => {
    const payment = await resolveFieldSchemaAtPath('$.payment');
    expect(payment.type).toBe('object');
    expect(hasKeyDeep(payment, '$defs')).toBe(false);
    expect(hasKeyDeep(payment, 'allOf')).toBe(false);
    // $defs was the carrier of the self-referential cycle; JSON.stringify must not throw.
    expect(() => JSON.stringify(payment)).not.toThrow();
  });

  it('$.payment.instruments[0] (selected_payment_instrument allOf) folds + serialises', async () => {
    const inst = await resolveFieldSchemaAtPath('$.payment.instruments[0]');
    expect(hasKeyDeep(inst, 'allOf')).toBe(false);
    expect(hasKeyDeep(inst, '$defs')).toBe(false);
    expect(() => JSON.stringify(inst)).not.toThrow();
    // The allOf-composed props are really merged in (base instrument + selected flag).
    const props = Object.keys(inst.properties ?? {});
    expect(props).toEqual(expect.arrayContaining(['id', 'handler_id', 'type', 'selected']));
  });
});
