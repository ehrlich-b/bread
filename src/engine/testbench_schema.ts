// Dependency-free validation of the JSON Schema vocabulary used by our
// testbench schema. Keeping the schema authoritative also serves Node and UI.
type Schema = {
  $ref?: string;
  oneOf?: Schema[];
  type?: string;
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, Schema | undefined>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minProperties?: number;
  minLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  $defs?: Record<string, Schema>;
};

export function validateSchema(value: unknown, schema: Schema): void {
  const check = (value: unknown, rule: Schema, path: string): string | null => {
    if (rule.$ref) {
      const target = schema.$defs?.[rule.$ref.replace('#/$defs/', '')];
      if (!target) throw new Error(`Unknown schema reference ${rule.$ref}`);
      return check(value, target, path);
    }
    if (rule.oneOf && rule.oneOf.filter(branch => check(value, branch, path) === null).length !== 1) return `${path}: invalid value or fields`;
    if ('const' in rule && value !== rule.const) return `${path}: expected ${String(rule.const)}`;
    if (rule.enum && !rule.enum.includes(value)) return `${path}: expected one of ${rule.enum.join(', ')}`;
    if (rule.type) {
      const matches = rule.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
        : rule.type === 'array' ? Array.isArray(value)
        : rule.type === 'integer' ? Number.isSafeInteger(value)
        : typeof value === rule.type;
      if (!matches) return `${path}: expected ${rule.type}`;
    }
    if (typeof value === 'number') {
      if (rule.minimum !== undefined && value < rule.minimum) return `${path}: below ${rule.minimum}`;
      if (rule.maximum !== undefined && value > rule.maximum) return `${path}: above ${rule.maximum}`;
    }
    if (typeof value === 'string') {
      if (rule.minLength !== undefined && value.length < rule.minLength) return `${path}: empty string`;
      if (rule.pattern && !new RegExp(rule.pattern).test(value)) return `${path}: invalid string`;
    }
    if (Array.isArray(value)) {
      if (rule.minItems !== undefined && value.length < rule.minItems) return `${path}: too few items`;
      if (rule.maxItems !== undefined && value.length > rule.maxItems) return `${path}: too many items`;
      if (rule.items) for (let i = 0; i < value.length; i++) {
        const error = check(value[i], rule.items, `${path}[${i}]`);
        if (error) return error;
      }
    } else if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (rule.minProperties !== undefined && Object.keys(record).length < rule.minProperties) return `${path}: too few fields`;
      for (const key of rule.required ?? []) if (!Object.hasOwn(record, key)) return `${path}: missing ${key}`;
      for (const [key, child] of Object.entries(record)) {
        const property = Object.hasOwn(rule.properties ?? {}, key) ? rule.properties![key] : undefined;
        const childRule = property ?? rule.additionalProperties;
        if (childRule === false) return `${path}: unexpected ${key}`;
        if (childRule && childRule !== true) {
          const error = check(child, childRule, `${path}.${key}`);
          if (error) return error;
        }
      }
    }
    return null;
  };
  const error = check(value, schema, 'testbench');
  if (error) throw new Error(error);
}
