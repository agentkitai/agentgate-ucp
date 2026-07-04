/**
 * A pragmatic JSON Schema shape. We model the keywords the form-handoff path
 * reads (type/properties/items/required/enum/format/constraints) and keep an
 * index signature for everything else so a resolved sub-schema round-trips
 * losslessly into a FormBridge intake schema.
 */
export interface JSONSchema {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema | JSONSchema[];
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  format?: string;
  description?: string;
  title?: string;
  additionalProperties?: boolean | JSONSchema;
  allOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  [key: string]: unknown;
}
