// Extracts the frontend's per-endpoint contract with the TypeScript compiler: for every function tagged
// `@route METHOD /path` in FRONTEND_DIR/src, its parameters and resolved response type as a JSON shape.
// Output: docs/contract/frontend-endpoints.json (input to ALIGNMENT.md and the contract tests).
// Usage: `bun scripts/extract-frontend-contract.mjs` (rebuild) or `--check` (fail when the committed file is stale).
// It runs the frontend's own TypeScript (its node_modules) so the frontend tsconfig resolves exactly; read-only.

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { frontendDir, ROOT } from './lib/manifest.mjs';

const FE = frontendDir();
const OUT = join(ROOT, 'docs', 'contract', 'frontend-endpoints.json');
const ts = createRequire(join(FE, 'package.json'))('typescript');

const MAX_DEPTH = 8;
// Aliases that carry wire meaning (frontend src/lib/api/types.ts); kept in the shape even though they are primitives.
const SEMANTIC = new Set(['Id', 'Money', 'Decimal', 'IsoDateTime', 'JsonValue', 'JsonObject']);
const OPAQUE = new Set(['Date', 'Blob', 'File', 'FormData', 'URLSearchParams', 'AbortSignal', 'Response', 'Headers', 'ReadableStream']);

const config = ts.readConfigFile(join(FE, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, FE);
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const checker = program.getTypeChecker();
const F = ts.TypeFlags;

/**
 * Serialises a TypeScript type into a compact JSON shape: primitives, `const`, `enum` (string literal unions),
 * `array`, `object` (props with `optional`), `record`, `anyOf`, plus `nullable` and semantic `alias` markers.
 * Why: the backend's zod schemas and the contract tests compare against this, not against TS source text.
 */
function shape(type, depth, stack) {
  const alias = type.aliasSymbol && SEMANTIC.has(type.aliasSymbol.name) ? type.aliasSymbol.name : undefined;
  const withAlias = (s) => (alias ? { ...s, alias } : s);
  const f = type.flags;
  if (alias === 'JsonValue' || alias === 'JsonObject') return { type: 'json', alias };
  if (f & F.Any) return { type: 'any' };
  if (f & F.Unknown) return { type: 'unknown' };
  if (f & F.Never) return { type: 'never' };
  if (f & F.StringLiteral) return { const: type.value };
  if (f & F.NumberLiteral) return { const: type.value };
  if (f & F.BooleanLiteral) return { const: checker.typeToString(type) === 'true' };
  if (f & F.String || f & F.TemplateLiteral) return withAlias({ type: 'string' });
  if (f & F.Number) return withAlias({ type: 'number' });
  if (f & F.Boolean) return { type: 'boolean' };
  if (f & F.Null) return { type: 'null' };
  if (f & (F.Undefined | F.Void)) return { type: 'undefined' };

  if (type.isUnion()) {
    let parts = type.types;
    const nullable = parts.some((t) => t.flags & F.Null);
    const undefinable = parts.some((t) => t.flags & (F.Undefined | F.Void));
    parts = parts.filter((t) => !(t.flags & (F.Null | F.Undefined | F.Void)));
    let shapes = parts.map((t) => shape(t, depth, stack));
    // TS spells `boolean` as `true | false`.
    const bools = shapes.filter((s) => typeof s.const === 'boolean');
    if (bools.length === 2) shapes = [...shapes.filter((s) => typeof s.const !== 'boolean'), { type: 'boolean' }];
    let out;
    if (shapes.length === 1) out = { ...shapes[0] };
    else if (shapes.length && shapes.every((s) => typeof s.const === 'string')) out = { enum: shapes.map((s) => s.const) };
    else if (shapes.length && shapes.every((s) => typeof s.const === 'number')) out = { enum: shapes.map((s) => s.const) };
    else out = { anyOf: shapes };
    if (nullable) out.nullable = true;
    if (undefinable) out.undefinable = true;
    return withAlias(out);
  }

  if (checker.isArrayType(type)) return { array: shape(checker.getTypeArguments(type)[0], depth + 1, stack) };
  if (checker.isTupleType(type)) return { tuple: checker.getTypeArguments(type).map((t) => shape(t, depth + 1, stack)) };
  const symName = type.symbol?.name;
  if (symName && OPAQUE.has(symName)) return { type: symName };
  if (type.getCallSignatures().length && !checker.getPropertiesOfType(type).length) return { type: 'function' };
  const id = type.id;
  if (stack.includes(id)) return { ref: checker.typeToString(type) };
  if (depth > MAX_DEPTH) return { truncated: checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation) };

  const object = {};
  for (const prop of checker.getPropertiesOfType(type)) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    const pt = decl ? checker.getTypeOfSymbolAtLocation(prop, decl) : checker.getTypeOfSymbol(prop);
    if (pt.getCallSignatures().length && !(pt.flags & F.Union)) continue; // methods are not data
    const s = markAlias(shape(pt, depth + 1, [...stack, id]), decl);
    const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
    if (optional) delete s.undefinable;
    object[prop.name] = optional ? { ...s, optional: true } : s;
  }
  const out = { object };
  const index = checker.getIndexInfosOfType(type);
  if (index.length) out.record = shape(index[0].type, depth + 1, [...stack, id]);
  return out;
}

/**
 * TS keeps no alias on primitives (`Money` resolves to plain `string`), so the alias is read back from the
 * declared type text of the property or parameter (`balance: Money`, `ids: Id[]`, `at: IsoDateTime | null`).
 */
function markAlias(s, decl) {
  const typeText = decl?.type?.getText?.() ?? '';
  const m = typeText.match(/\b(Money|Decimal|IsoDateTime|Id)\b/);
  if (!m || s.alias) return s;
  if (s.type === 'string' || s.type === 'number') return { ...s, alias: m[1] };
  if (s.array && (s.array.type === 'string' || s.array.type === 'number') && !s.array.alias) return { ...s, array: { ...s.array, alias: m[1] } };
  return s;
}

/** Unwraps Promise<T> to T. */
function awaited(type) {
  if (type.symbol?.name === 'Promise') return checker.getTypeArguments(type)[0] ?? type;
  return type;
}

const text = (t) => checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);

/** `@route` values on a node (function declaration or `export const` statement). */
function routeTags(node) {
  return ts
    .getJSDocTags(node)
    .filter((t) => t.tagName.text === 'route')
    .map((t) => (typeof t.comment === 'string' ? t.comment : ts.getTextOfJSDocComment(t.comment) ?? '').trim())
    .map((c) => c.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)/))
    .filter(Boolean)
    .map((m) => `${m[1]} ${m[2]}`);
}

const endpoints = [];
for (const sf of program.getSourceFiles()) {
  if (!sf.fileName.startsWith(join(FE, 'src')) || /\.test\.tsx?$/.test(sf.fileName)) continue;
  const file = relative(FE, sf.fileName);
  const visit = (node) => {
    let decl;
    let nameNode;
    if (ts.isFunctionDeclaration(node) && node.name) [decl, nameNode] = [node, node.name];
    else if (ts.isVariableStatement(node)) {
      const d = node.declarationList.declarations[0];
      if (d && ts.isIdentifier(d.name)) [decl, nameNode] = [d, d.name];
    }
    const tags = decl ? routeTags(node) : [];
    if (tags.length) {
      const fnType = checker.getTypeAtLocation(nameNode);
      const sig = fnType.getCallSignatures()[0];
      const params = (sig?.getParameters() ?? []).map((p) => {
        const pd = p.valueDeclaration;
        const pt = checker.getTypeOfSymbolAtLocation(p, pd ?? nameNode);
        const s = markAlias(shape(pt, 0, []), pd);
        const optional = pd ? checker.isOptionalParameter(pd) : false;
        if (optional) delete s.undefinable;
        return { name: p.name, optional, typeText: text(pt), shape: s };
      });
      const ret = sig ? awaited(sig.getReturnType()) : undefined;
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      for (const key of tags)
        endpoints.push({ key, fn: nameNode.text, file, line: line + 1, params, returnsText: ret ? text(ret) : null, returns: ret ? shape(ret, 0, []) : null });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
endpoints.sort((a, b) => a.key.localeCompare(b.key) || a.file.localeCompare(b.file));

const out = `${JSON.stringify({ generatedBy: 'scripts/extract-frontend-contract.mjs', frontend: relative(ROOT, FE), count: endpoints.length, endpoints }, null, 1)}\n`;
if (process.argv.includes('--check')) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== out) {
    console.error('docs/contract/frontend-endpoints.json is stale. Run: bun scripts/extract-frontend-contract.mjs');
    process.exit(1);
  }
  console.log('frontend contract extract is up to date');
} else {
  mkdirSync(join(ROOT, 'docs', 'contract'), { recursive: true });
  writeFileSync(OUT, out);
  const keys = new Set(endpoints.map((e) => e.key));
  console.log(`docs/contract/frontend-endpoints.json: ${endpoints.length} tagged functions, ${keys.size} distinct routes`);
}
