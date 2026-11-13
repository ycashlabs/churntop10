/** Interprets the small JSON Schema subset used by the Robinhood tool contracts.
 *  Ajv compiles schemas with `new Function`, which Cloudflare Workers block. */
export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  description?: string;
};

export function validateSchema(schema: JsonSchema, value: unknown): { ok: true } | { ok: false; errors: string } {
  const errors: string[] = [];
  check(schema, value, "", errors);
  if (errors.length === 0) return { ok: true };
  return { ok: false, errors: errors.join("; ") };
}

function check(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, value))) {
      errors.push(`${label(path)} must be ${types.join(" or ")}`);
      return;
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        errors.push(`${label(path)} must have required property '${key}'`);
      }
    }
    if (schema.properties) {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(record, key)) {
          check(child, record[key], `${path}/${key}`, errors);
        }
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
          errors.push(`${label(path)} must NOT have additional properties`);
        }
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      check(schema.items as JsonSchema, item, `${path}/${index}`, errors);
    });
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return false;
  }
}

function label(path: string): string {
  return path || "/";
}
