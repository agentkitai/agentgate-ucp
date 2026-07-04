/**
 * Minimal ambient types for `json-schema-merge-allof` (no bundled/@types). The
 * package default-exports a function that merges every `allOf` in a schema into
 * the parent, producing an `allOf`-free schema. `resolvers.defaultResolver` is a
 * catch-all for keywords the library has no built-in resolver for (e.g. `if`).
 */
declare module 'json-schema-merge-allof' {
  interface Resolvers {
    defaultResolver?: (values: unknown[], path: string[], mergeSchemas: unknown, options: unknown) => unknown;
    [keyword: string]: unknown;
  }
  interface Options {
    ignoreAdditionalProperties?: boolean;
    resolvers?: Resolvers;
    deep?: boolean;
  }
  function mergeAllOf<T = unknown>(schema: T, options?: Options): T;
  export = mergeAllOf;
}
