import assert from "node:assert/strict";

interface Expectation<T> {
  not: {
    toBe(expected: unknown): void;
    toBeNull(): void;
    toHaveProperty(property: string): void;
  };
  toBe(expected: unknown): void;
  toBeDefined(): void;
  toBeGreaterThan(expected: number): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toContain(expected: unknown): void;
  toEqual(expected: unknown): void;
  toHaveLength(expected: number): void;
  toHaveProperty(property: string): void;
  toThrow(expected?: RegExp): void;
}

export function expect<T>(received: T): Expectation<T> {
  return {
    not: {
      toBe(expected: unknown): void {
        assert.notStrictEqual(received, expected);
      },
      toBeNull(): void {
        assert.notStrictEqual(received, null);
      },
      toHaveProperty(property: string): void {
        assert.equal(hasProperty(received, property), false);
      },
    },
    toBe(expected: unknown): void {
      assert.strictEqual(received, expected);
    },
    toBeDefined(): void {
      assert.notStrictEqual(received, undefined);
    },
    toBeGreaterThan(expected: number): void {
      assert.equal(typeof received, "number");
      assert.ok((received as number) > expected, `${String(received)} is not greater than ${expected}`);
    },
    toBeNull(): void {
      assert.strictEqual(received, null);
    },
    toBeUndefined(): void {
      assert.strictEqual(received, undefined);
    },
    toContain(expected: unknown): void {
      assert.ok(
        hasIncludes(received) && received.includes(expected as never),
        `${String(received)} does not contain ${String(expected)}`,
      );
    },
    toEqual(expected: unknown): void {
      assert.deepEqual(stripUndefinedProperties(received), stripUndefinedProperties(expected));
    },
    toHaveLength(expected: number): void {
      assert.equal(hasLength(received), true);
      assert.strictEqual((received as { length: number }).length, expected);
    },
    toHaveProperty(property: string): void {
      assert.equal(hasProperty(received, property), true);
    },
    toThrow(expected?: RegExp): void {
      assert.equal(typeof received, "function");
      if (expected) {
        assert.throws(received as () => unknown, expected);
      } else {
        assert.throws(received as () => unknown);
      }
    },
  };
}

function stripUndefinedProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefinedProperties);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, stripUndefinedProperties(entry)]),
    );
  }
  return value;
}

function hasIncludes(value: unknown): value is { includes(item: never): boolean } {
  return value != null && typeof (value as { includes?: unknown }).includes === "function";
}

function hasLength(value: unknown): value is { length: number } {
  return value != null && typeof (value as { length?: unknown }).length === "number";
}

function hasProperty(value: unknown, property: string): boolean {
  return value != null && Object.prototype.hasOwnProperty.call(value, property);
}
