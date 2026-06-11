/**
 * src/actions/nova.ts — the Amazon Nova Sonic 2 voice surface, DERIVED from the SAME registry
 * declarations the Gemini surface uses (src/actions/gemini.ts). The registry stays the single source
 * of truth for the voice toolset; this module only re-projects an already-built Gemini
 * functionDeclarations[] into the Bedrock bidirectional-stream `toolConfiguration.tools[]` shape.
 *
 * WHY re-project the Gemini declarations rather than re-walk the zod schemas: the zod→schema walk
 * (zodToGeminiSchema) is non-trivial and already pinned by the gemini goldens. Nova's `inputSchema.json`
 * is an ordinary JSON-Schema object (just stringified), and a Gemini FunctionDeclaration is already a
 * near-isomorphic JSON-Schema (the only deltas are the @google/genai `Type` enum casing — "OBJECT" vs
 * "object" — and that Nova wants the schema as a JSON STRING). So we convert the cheap, late artifact
 * and keep ONE schema walker. toGeminiDeclarations(REGISTRY) → toNovaToolSpecs(...) is the whole chain.
 *
 * Nova Sonic tool spec (confirmed against the AWS nova-2-sonic samples / bidirectional API docs):
 *   { toolSpec: { name, description, inputSchema: { json: "<JSON-Schema as a string>" } } }
 * where the JSON-Schema string is `{"type":"object","properties":{...},"required":[...]}`.
 */

import type { GeminiFunctionDeclaration, GeminiSchema } from "./gemini";

/** One entry in the Nova Sonic `promptStart.toolConfiguration.tools[]` array. */
export interface NovaToolSpec {
  toolSpec: {
    name: string;
    description: string;
    /** inputSchema.json is a STRING holding a JSON-Schema object (Bedrock requirement). */
    inputSchema: { json: string };
  };
}

/** A plain JSON-Schema node (the lowercase, draft-style shape Bedrock/Nova expects). */
interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
  items?: JsonSchema;
}

/**
 * Map a @google/genai `Type` value (the GeminiSchema.type — uppercase enum strings like "OBJECT",
 * "STRING") to a JSON-Schema lowercase type. Tolerant of an already-lowercased value so the converter
 * is robust whether it is fed the SDK enum or a plain string.
 */
function jsonSchemaType(t: unknown): string {
  switch (String(t).toUpperCase()) {
    case "OBJECT": return "object";
    case "STRING": return "string";
    case "NUMBER": return "number";
    case "INTEGER": return "integer";
    case "BOOLEAN": return "boolean";
    case "ARRAY": return "array";
    // Unknown leaf → "string" is the safest permissive default (Nova validates the JSON-Schema string;
    // an unmapped type would be a hard parse error at promptStart, so degrade rather than emit garbage).
    default: return "string";
  }
}

/** Convert ONE GeminiSchema node into a plain JSON-Schema node (recursive). Pure; never throws. */
export function geminiSchemaToJsonSchema(schema: GeminiSchema): JsonSchema {
  const type = jsonSchemaType(schema.type);
  const out: JsonSchema = { type };
  if (schema.description) out.description = schema.description;
  if (schema.enum && schema.enum.length) out.enum = [...schema.enum];
  if (type === "object") {
    const properties: Record<string, JsonSchema> = {};
    for (const [k, v] of Object.entries(schema.properties ?? {})) {
      properties[k] = geminiSchemaToJsonSchema(v);
    }
    out.properties = properties;
    // Nova/Bedrock want `required` present (even if empty is acceptable); mirror Gemini's "omit when
    // empty" is also fine, but an explicit [] keeps the emitted schema self-describing for empty-param
    // tools. We attach it whenever the source had any required keys, else default to [].
    out.required = schema.required ? [...schema.required] : [];
  }
  if (type === "array" && schema.items) {
    out.items = geminiSchemaToJsonSchema(schema.items);
  }
  return out;
}

/**
 * toNovaToolSpecs(declarations) — the `toolConfiguration.tools[]` for the Nova Sonic promptStart event.
 * Takes the SAME GeminiFunctionDeclaration[] produced by toGeminiDeclarations(REGISTRY) so the Nova and
 * Gemini voice surfaces are parity-by-construction (identical name/description/param set). Pure.
 */
export function toNovaToolSpecs(declarations: readonly GeminiFunctionDeclaration[]): NovaToolSpec[] {
  return declarations.map((d) => ({
    toolSpec: {
      name: d.name,
      description: d.description,
      inputSchema: { json: JSON.stringify(geminiSchemaToJsonSchema(d.parameters)) },
    },
  }));
}
