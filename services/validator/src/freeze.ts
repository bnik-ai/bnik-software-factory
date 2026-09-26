// Shared deep-freeze utility for kind-FSM rule tables.
// Object.freeze is shallow; nested objects/arrays inside a frozen literal
// remain mutable. This recursively freezes every reachable object so the
// rule table cannot be silently mutated at runtime.

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  Object.freeze(value);
  return value;
}
