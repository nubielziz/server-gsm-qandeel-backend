# 008: Contract layer: zod route contracts → validation, types and OpenAPI

Status: accepted, 2026-10-31.

**Context.** One schema per request and response must feed validation, TypeScript types and OpenAPI (decided
stack: @nestjs/swagger + Scalar). `nestjs-zod` 5.5 does not declare NestJS 12 support. The spike proved
`z.toJSONSchema` (draft 2020-12) works inside @nestjs/swagger documents (OpenAPI 3.1) and renders in Scalar.

**Options.** class-validator DTOs (two sources: classes and frontend types); nestjs-zod (unsupported on Nest 12);
our own thin layer on zod 4 (≈ 200 lines, already proven in the spike).

**Decision.** zod 4 + our own contract layer in `src/common/contract/`:
- `defineRoute({ key: 'GET /admin/staff/:id', summary, description, access, permission, params, query, body,
  headers, responses: { 200: schema }, errors: ['NOT_FOUND', …], examples })`. The path text is the manifest key.
- `@Route(contract)` applies the Nest method + path from the key, the OpenAPI metadata (operation, params, body,
  every response, every error as `application/problem+json` with its codes) and the validation pipe.
- Responses always pass through the response schema (strip mode) before serialisation: unknown fields never leak
  (no `password_hash` by accident); a mismatch is a 500 logged as `RESPONSE_CONTRACT_VIOLATION`.
- Lists: a shared `listQuery({ filters, sorts, search })` builder for the simple-rest dialect and a `{ rows, total }`
  handler result that the list interceptor turns into an array body + `x-total-count`.
- Handler inputs and outputs are `z.infer` types; DB rows are mapped to contract shapes in repositories/services.

**Consequences.** One place per endpoint describes everything; the contract tests (decision 009) read the same
registry. zod's JSON Schema `$schema` key is stripped when building OpenAPI components.
