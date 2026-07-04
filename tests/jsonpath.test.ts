import { describe, expect, it } from 'vitest';

import {
  isSingularPath,
  readAtPath,
  toSegments,
  UnsupportedPathError,
  writeAtPath,
} from '../src/schema/jsonpath.js';

describe('readAtPath', () => {
  const obj = {
    buyer: { phone_number: '+15551234567' },
    line_items: [{ id: 'li_1', quantity: 2 }],
  };

  it('reads a child key, an index, and a bracket-quoted key', () => {
    expect(readAtPath(obj, '$.buyer.phone_number')).toBe('+15551234567');
    expect(readAtPath(obj, '$.line_items[0].quantity')).toBe(2);
    expect(readAtPath(obj, "$['buyer']['phone_number']")).toBe('+15551234567');
  });

  it('returns undefined for an absent path (agent does not know the value yet)', () => {
    expect(readAtPath(obj, '$.buyer.email')).toBeUndefined();
  });
});

describe('writeAtPath', () => {
  it('writes a child value, CREATING intermediate objects', () => {
    const obj: Record<string, unknown> = {};
    writeAtPath(obj, '$.buyer.phone_number', '+15551234567');
    expect(obj).toEqual({ buyer: { phone_number: '+15551234567' } });
  });

  it('writes an index, creating an array intermediate', () => {
    const obj: Record<string, unknown> = {};
    writeAtPath(obj, '$.line_items[0].id', 'li_1');
    expect(Array.isArray(obj['line_items'])).toBe(true);
    expect((obj['line_items'] as Array<{ id: string }>)[0]?.id).toBe('li_1');
  });

  it('writes a bracket-quoted key without clobbering siblings', () => {
    const obj: Record<string, unknown> = { buyer: { first_name: 'Ada' } };
    writeAtPath(obj, "$['buyer']['email']", 'ada@example.com');
    expect(obj['buyer']).toEqual({ first_name: 'Ada', email: 'ada@example.com' });
  });

  it('REJECTS a non-singular FILTER path (a single field cannot fan out) — no write', () => {
    const obj: Record<string, unknown> = {
      line_items: [
        { id: 'li_1', quantity: 1 },
        { id: 'li_2', quantity: 1 },
      ],
    };
    expect(() => writeAtPath(obj, "$.line_items[?(@.id=='li_2')].quantity", 5)).toThrow(
      UnsupportedPathError
    );
    // Nothing was mutated.
    const items = obj['line_items'] as Array<{ id: string; quantity: number }>;
    expect(items[0]?.quantity).toBe(1);
    expect(items[1]?.quantity).toBe(1);
  });

  it('REJECTS wildcard, descendant, and NEGATIVE-index paths (no fan-out, no phantom -1 key)', () => {
    const obj: Record<string, unknown> = { totals: [{ amount: 1 }], x: [{ v: 1 }] };
    expect(() => writeAtPath(obj, '$.totals[*].amount', 9)).toThrow(UnsupportedPathError);
    expect(() => writeAtPath(obj, '$..amount', 9)).toThrow(UnsupportedPathError);
    expect(() => writeAtPath(obj, '$.x[-1].v', 9)).toThrow(UnsupportedPathError);
    // No phantom '-1' key was created and no value fanned out.
    expect((obj['x'] as Array<{ v: number }>)[0]?.v).toBe(1);
    expect(Object.keys(obj['x'] as object)).not.toContain('-1');
  });

  it('throws UnsupportedPathError for a non-singular path (never resolves against the instance)', () => {
    const obj: Record<string, unknown> = { line_items: [] };
    expect(() => writeAtPath(obj, "$.line_items[?(@.id=='zzz')].quantity", 5)).toThrow(
      UnsupportedPathError
    );
  });
});

describe('writeAtPath — array index is bounded (finding G, no sparse-array DoS)', () => {
  it('REJECTS a far-out index ($.line_items[1e9].id) — no giant sparse body materialised', () => {
    const obj: Record<string, unknown> = {
      line_items: [{ id: 'li_1', quantity: 1 }],
    };
    expect(() => writeAtPath(obj, '$.line_items[1000000000].id', 'x')).toThrow(UnsupportedPathError);
    // The array was NOT ballooned to ~1e9 elements.
    expect((obj['line_items'] as unknown[]).length).toBe(1);
  });

  it('REJECTS a leaf index past the array length (targets a non-existent element)', () => {
    const obj: Record<string, unknown> = { totals: [{ amount: 1 }] };
    // length 1 ⇒ valid index 0; index 2 is past the end.
    expect(() => writeAtPath(obj, '$.totals[2]', { amount: 9 })).toThrow(UnsupportedPathError);
    expect((obj['totals'] as unknown[]).length).toBe(1);
  });

  it('still writes an EXISTING element index (in-bounds) and the create-array append', () => {
    const obj: Record<string, unknown> = {
      line_items: [{ id: 'li_1' }, { id: 'li_2' }],
    };
    writeAtPath(obj, '$.line_items[1].id', 'li_2_updated'); // existing element
    expect((obj['line_items'] as Array<{ id: string }>)[1]?.id).toBe('li_2_updated');

    // Fresh array + index 0 (create-then-append) still works — bound is `<= length`.
    const fresh: Record<string, unknown> = {};
    writeAtPath(fresh, '$.line_items[0].id', 'li_1');
    expect((fresh['line_items'] as Array<{ id: string }>)[0]?.id).toBe('li_1');
  });
});

describe('writeAtPath / toSegments — bracket-quoted key is a STRING key (finding H)', () => {
  it("$.a['0'] round-trips as object property '0', NOT array index 0", () => {
    const obj: Record<string, unknown> = {};
    writeAtPath(obj, "$.a['0']", 'v');
    // A quoted key builds an OBJECT property, not an array element.
    expect(obj).toEqual({ a: { '0': 'v' } });
    expect(Array.isArray((obj['a'] as Record<string, unknown>))).toBe(false);
    // Write and read now agree on the location.
    expect(readAtPath(obj, "$.a['0']")).toBe('v');
  });

  it('toSegments classifies a bracket-quoted numeric as a key, a bare one as an index', () => {
    expect(toSegments("$.a['0']")).toEqual([
      { kind: 'key', key: 'a' },
      { kind: 'key', key: '0' },
    ]);
    expect(toSegments('$.a[0]')).toEqual([
      { kind: 'key', key: 'a' },
      { kind: 'index', index: 0 },
    ]);
    expect(toSegments('$.a["0"]')).toEqual([
      { kind: 'key', key: 'a' },
      { kind: 'key', key: '0' },
    ]);
  });
});

describe('writeAtPath / toSegments — prototype-pollution defence', () => {
  it('REJECTS __proto__/constructor/prototype in any segment and does NOT mutate Object.prototype', () => {
    const obj: Record<string, unknown> = { ucp: { services: {} } };
    for (const path of [
      '$.ucp.services.__proto__[0]',
      '$.__proto__.polluted',
      "$['constructor']['prototype']['polluted']",
      '$.a.prototype.b',
    ]) {
      expect(() => writeAtPath(obj, path, 'PWNED')).toThrow(UnsupportedPathError);
    }
    // The global prototype chain is untouched.
    expect(({} as Record<string, unknown>)['0']).toBeUndefined();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('toSegments rejects a forbidden key (bracket-quoted or dotted)', () => {
    expect(() => toSegments('$.a.__proto__.b')).toThrow(UnsupportedPathError);
    expect(() => toSegments("$['__proto__']")).toThrow(UnsupportedPathError);
    expect(() => toSegments('$.constructor')).toThrow(UnsupportedPathError);
  });
});

describe('toSegments / isSingularPath', () => {
  it('classifies keys, indices, wildcards, and filters', () => {
    expect(toSegments('$.buyer.phone_number')).toEqual([
      { kind: 'key', key: 'buyer' },
      { kind: 'key', key: 'phone_number' },
    ]);
    expect(toSegments('$.line_items[0].id')).toEqual([
      { kind: 'key', key: 'line_items' },
      { kind: 'index', index: 0 },
      { kind: 'key', key: 'id' },
    ]);
    expect(toSegments('$.totals[*].amount')[1]).toEqual({ kind: 'wildcard' });
    expect(toSegments("$.line_items[?(@.id=='li_1')].quantity")[1]?.kind).toBe('filter');
  });

  it('distinguishes singular from non-singular paths', () => {
    expect(isSingularPath('$.buyer.phone_number')).toBe(true);
    expect(isSingularPath('$.line_items[0].id')).toBe(true);
    expect(isSingularPath('$.totals[*].amount')).toBe(false);
    expect(isSingularPath("$.line_items[?(@.id=='li_1')].quantity")).toBe(false);
  });
});
