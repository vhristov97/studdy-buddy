import { z } from "zod";

/**
 * Keywords Anthropic's strict structured output rejects. Zod still enforces them when the
 * answer is parsed (and the repair loop in `stage.ts` feeds violations back to the model).
 * `minItems` is handled separately: 0 and 1 are the only values accepted.
 */
const UNSUPPORTED_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "maxItems",
  "uniqueItems",
] as const;

type JsonSchema = Record<string, unknown>;

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapValues(value: unknown, fn: (schema: JsonSchema) => JsonSchema): unknown {
  if (!isSchema(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isSchema(v) ? fn(v) : v]));
}

function mapArray(value: unknown, fn: (schema: JsonSchema) => JsonSchema): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((v) => (isSchema(v) ? fn(v) : v));
}

function convert(node: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...node };

  for (const keyword of UNSUPPORTED_KEYWORDS) delete out[keyword];
  if (typeof out.minItems === "number" && out.minItems > 1) delete out.minItems;

  // Zod 4 renders nullable primitives as `type: ["string", "null"]`; use `anyOf`, the
  // documented way to express a union in Anthropic structured output.
  if (Array.isArray(out.type) && out.type.length > 1) {
    const { type, ...rest } = out;
    for (const key of Object.keys(out)) delete out[key];
    out.anyOf = (type as string[]).map((t) => (t === "null" ? { type: t } : { ...rest, type: t }));
  }

  if (out.type === "object" || isSchema(out.properties)) {
    if (isSchema(out.additionalProperties)) {
      throw new Error("Structured output does not support maps (z.record); model them as arrays.");
    }
    const properties = isSchema(out.properties) ? out.properties : {};
    out.properties = mapValues(properties, convert);
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }

  // Zod renders discriminated unions as `oneOf` (+ `discriminator`); the API only knows `anyOf`.
  if (Array.isArray(out.oneOf)) {
    out.anyOf = Array.isArray(out.anyOf) ? [...out.anyOf, ...out.oneOf] : out.oneOf;
    delete out.oneOf;
  }
  delete out.discriminator;

  if (isSchema(out.items)) out.items = convert(out.items);
  for (const key of ["prefixItems", "anyOf", "allOf"] as const) {
    if (key in out) out[key] = mapArray(out[key], convert);
  }
  for (const key of ["$defs", "definitions"] as const) {
    if (key in out) out[key] = mapValues(out[key], convert);
  }
  return out;
}

/**
 * Converts a Zod schema to JSON Schema acceptable for Anthropic strict structured output:
 * no `$schema`, every object closed (`additionalProperties: false`) with all properties
 * required, `oneOf` rewritten to `anyOf`, and unsupported validation keywords removed.
 *
 * Because every property is required, model optional fields as nullable
 * (`z.string().nullable()`), not `.optional()`. `z.record` is rejected. Numeric/string
 * bounds are only enforced by Zod after parsing, not by the API.
 */
export function toStructuredOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = { ...(z.toJSONSchema(schema) as JsonSchema) };
  delete json.$schema;
  return convert(json);
}
