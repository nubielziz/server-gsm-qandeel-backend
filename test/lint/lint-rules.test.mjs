// Tests of the project's own lint rules (decisions 013, 016): module boundaries with their two schema exceptions,
// process.env only in src/config, no console in src. Code strings are linted with the same config blocks that
// eslint.config.mjs uses (scripts/eslint/structural-rules.mjs), without type information.
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { judgeImport, locate } from '../../scripts/eslint/module-boundaries.mjs';
import { structuralRules } from '../../scripts/eslint/structural-rules.mjs';

const ROOT = join(import.meta.dirname, '../..');
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: true,
  overrideConfig: [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } }, ...structuralRules],
});

/** Lints code as if it were the file `file` (relative to the repo root) and returns the rule ids that fired. */
async function fired(file, code) {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, file) });
  return result.messages.map((message) => message.ruleId);
}

describe('locate', () => {
  it('tells modules, common, infra and the rest of src apart', () => {
    expect(locate('src/modules/orders/application/x.ts')).toEqual({
      zone: 'module',
      id: 'orders',
      inner: 'application/x.ts',
    });
    expect(locate('src/modules/orders/index.ts')).toEqual({ zone: 'module', id: 'orders', inner: 'index.ts' });
    expect(locate('src/modules/orders')).toEqual({ zone: 'module', id: 'orders', inner: undefined });
    expect(locate('src/common/contract/x.ts')).toEqual({ zone: 'common' });
    expect(locate('src/infra/db/schema.ts')).toEqual({ zone: 'infra' });
    expect(locate('src/config/env.ts')).toEqual({ zone: 'other' });
    expect(locate('src/app.module.ts')).toEqual({ zone: 'other' });
    expect(locate('test/support/app.ts')).toEqual({ zone: 'outside' });
    expect(locate('../elsewhere/src/x.ts')).toEqual({ zone: 'outside' });
  });
});

describe('judgeImport', () => {
  const ORDERS = 'src/modules/orders/application/place-order.ts';

  it('lets a module import its own files, shared code and the public API of other modules', () => {
    expect(judgeImport(ORDERS, 'src/modules/orders/domain/price')).toBeUndefined();
    expect(judgeImport(ORDERS, 'src/common/contract/index')).toBeUndefined();
    expect(judgeImport(ORDERS, 'src/infra/health')).toBeUndefined();
    expect(judgeImport(ORDERS, 'src/config')).toBeUndefined();
    for (const target of ['src/modules/identity', 'src/modules/identity/index', 'src/modules/identity/index.ts']) {
      expect(judgeImport(ORDERS, target), target).toBeUndefined();
    }
  });

  it('refuses a deep import into another module', () => {
    for (const target of [
      'src/modules/identity/application/staff.service',
      'src/modules/identity/identity.module',
      'src/modules/identity/db/schema',
      'src/modules/identity/index/extra',
    ]) {
      expect(judgeImport(ORDERS, target), target).toBe('deepImport');
    }
  });

  it('exception 1: a module db/schema.ts may import another module db/schema.ts, and nothing else of it', () => {
    const schema = 'src/modules/orders/db/schema.ts';
    expect(judgeImport(schema, 'src/modules/identity/db/schema')).toBeUndefined();
    expect(judgeImport(schema, 'src/modules/identity/db/schema.ts')).toBeUndefined();
    expect(judgeImport(schema, 'src/modules/identity/application/staff.service')).toBe('deepImport');
    expect(judgeImport(schema, 'src/modules/identity/db/other')).toBe('deepImport');
    expect(judgeImport('src/modules/orders/db/other.ts', 'src/modules/identity/db/schema')).toBe('deepImport');
    expect(judgeImport('src/modules/orders/application/x.ts', 'src/modules/identity/db/schema')).toBe('deepImport');
  });

  it('exception 2: src/infra/db/schema.ts re-exports every module db/schema.ts, and only that file may', () => {
    expect(judgeImport('src/infra/db/schema.ts', 'src/modules/orders/db/schema')).toBeUndefined();
    expect(judgeImport('src/infra/db/schema.ts', 'src/modules/orders/db/schema.ts')).toBeUndefined();
    expect(judgeImport('src/infra/db/schema.ts', 'src/modules/orders/application/x')).toBe('noModuleImport');
    expect(judgeImport('src/infra/db/schema.ts', 'src/modules/orders')).toBe('noModuleImport');
    expect(judgeImport('src/infra/db/client.ts', 'src/modules/orders/db/schema')).toBe('noModuleImport');
  });

  it('src/common and src/infra never import from src/modules, not even through an index', () => {
    expect(judgeImport('src/common/contract/x.ts', 'src/modules/health')).toBe('noModuleImport');
    expect(judgeImport('src/common/x.ts', 'src/modules/health/index')).toBe('noModuleImport');
    expect(judgeImport('src/infra/health/x.ts', 'src/modules/health')).toBe('noModuleImport');
    expect(judgeImport('src/infra/metrics/x.ts', 'src/modules/health/health.module')).toBe('noModuleImport');
  });

  it('lets the composition roots import module indexes only', () => {
    expect(judgeImport('src/app.module.ts', 'src/modules/orders')).toBeUndefined();
    expect(judgeImport('src/app.bootstrap.ts', 'src/modules/platform')).toBeUndefined();
    expect(judgeImport('src/app.module.ts', 'src/modules/orders/orders.module')).toBe('deepImport');
  });

  it('does not judge files outside src (tests may reach into modules)', () => {
    expect(judgeImport('test/support/app.ts', 'src/modules/identity/application/x')).toBeUndefined();
    expect(judgeImport('scripts/gen-openapi.ts', 'src/modules/platform/docs/x')).toBeUndefined();
  });
});

describe('gsm/module-boundaries in the config', () => {
  const FILE = 'src/modules/orders/application/place-order.ts';

  it('flags relative imports, re-exports, dynamic imports and import types that go deep into another module', async () => {
    expect(
      await fired(FILE, `import { S } from '../../identity/application/staff.service';\nexport const x = S;`),
    ).toContain('gsm/module-boundaries');
    expect(await fired(FILE, `export { S } from '../../identity/application/staff.service';`)).toEqual([
      'gsm/module-boundaries',
    ]);
    expect(await fired(FILE, `export * from '../../identity/identity.module';`)).toEqual(['gsm/module-boundaries']);
    expect(await fired(FILE, `export const load = () => import('../../identity/application/staff.service');`)).toEqual([
      'gsm/module-boundaries',
    ]);
    expect(
      await fired(FILE, `export type T = import('../../identity/application/staff.service').StaffService;`),
    ).toEqual(['gsm/module-boundaries']);
    expect(
      await fired(FILE, `import type { S } from '../../identity/application/staff.service';\nexport type T = S;`),
    ).toEqual(['gsm/module-boundaries']);
  });

  it('accepts the public API of another module and files of the own module', async () => {
    expect(
      await fired(FILE, `import { IdentityModule } from '../../identity';\nexport const x = IdentityModule;`),
    ).toEqual([]);
    expect(
      await fired(FILE, `import { IdentityModule } from '../../identity/index';\nexport const x = IdentityModule;`),
    ).toEqual([]);
    expect(await fired(FILE, `import { price } from '../domain/price';\nexport const x = price;`)).toEqual([]);
    expect(await fired(FILE, `import { a } from '../../../common/money';\nexport const x = a;`)).toEqual([]);
    expect(await fired(FILE, `import { Module } from '@nestjs/common';\nexport const x = Module;`)).toEqual([]);
  });

  it('flags src/common and src/infra importing a module', async () => {
    expect(
      await fired(
        'src/common/errors/x.ts',
        `import { HealthModule } from '../../modules/health';\nexport const x = HealthModule;`,
      ),
    ).toEqual(['gsm/module-boundaries']);
    expect(
      await fired(
        'src/infra/health/x.ts',
        `import { HealthModule } from '../../modules/health';\nexport const x = HealthModule;`,
      ),
    ).toEqual(['gsm/module-boundaries']);
  });

  it('applies the two schema exceptions through the real relative paths', async () => {
    const reexport = `export * from '../../modules/identity/db/schema';`;
    expect(await fired('src/infra/db/schema.ts', reexport)).toEqual([]);
    expect(await fired('src/infra/db/other.ts', reexport)).toEqual(['gsm/module-boundaries']);
    expect(
      await fired('src/modules/orders/db/schema.ts', `export { staffUsers } from '../../identity/db/schema';`),
    ).toEqual([]);
    expect(
      await fired('src/modules/orders/db/relations.ts', `export { staffUsers } from '../../identity/db/schema';`),
    ).toEqual(['gsm/module-boundaries']);
  });

  it('does not apply to tests or scripts', async () => {
    expect(
      await fired(
        'test/integration/x.test.ts',
        `import { S } from '../../src/modules/identity/application/staff.service';\nexport const x = S;`,
      ),
    ).toEqual([]);
    expect(
      await fired(
        'scripts/gen-openapi.ts',
        `import { S } from '../src/modules/platform/docs/openapi-documents';\nexport const x = S;`,
      ),
    ).toEqual([]);
  });
});

describe('process.env only in src/config', () => {
  const ENV_FORMS = {
    'process.env.X': `export const a = process.env.X;`,
    "process['env']": `export const a = process['env'];`,
    'globalThis.process.env': `export const a = globalThis.process.env.X;`,
    'Bun.env': `export const a = Bun.env.X;`,
    'import.meta.env': `export const a = import.meta.env.X;`,
    destructuring: `const { env } = process;\nexport const a = env.X;`,
    "import { env } from 'node:process'": `import { env } from 'node:process';\nexport const a = env.X;`,
    "import { env } from 'process'": `import { env } from 'process';\nexport const a = env.X;`,
  };

  for (const [name, code] of Object.entries(ENV_FORMS)) {
    it(`flags ${name} in a module, in common and in infra`, async () => {
      for (const file of [
        'src/modules/orders/application/x.ts',
        'src/common/x.ts',
        'src/infra/logging/x.ts',
        'src/app.bootstrap.ts',
      ]) {
        expect(await fired(file, code), `${name} in ${file}`).toContain('no-restricted-syntax');
      }
    });

    it(`allows ${name} under src/config`, async () => {
      expect(await fired('src/config/env.ts', code)).not.toContain('no-restricted-syntax');
      expect(await fired('src/config/deep/x.ts', code)).not.toContain('no-restricted-syntax');
    });
  }

  it('allows tests and scripts to read the environment', async () => {
    expect(await fired('test/setup.ts', `process.env.NODE_ENV = 'test';`)).toEqual([]);
    expect(await fired('scripts/gen-openapi.ts', `process.env.NODE_ENV = 'test';`)).toEqual([]);
  });

  it('does not flag other uses of process', async () => {
    expect(await fired('src/infra/x.ts', `export const a = process.pid;\nexport const b = process.argv;`)).toEqual([]);
  });
});

describe('no console in src', () => {
  it('flags every console method in src, also in src/config and in specs', async () => {
    for (const file of ['src/modules/orders/x.ts', 'src/config/env.ts', 'src/common/x.spec.ts']) {
      expect(await fired(file, `console.log('x');`), file).toEqual(['no-console']);
    }
    expect(await fired('src/infra/x.ts', `console.error('x');\nconsole.warn('y');`)).toEqual([
      'no-console',
      'no-console',
    ]);
  });

  it('accepts a justified inline disable', async () => {
    const code = `// eslint-disable-next-line no-console -- the logger needs a valid config\nconsole.error('boom');`;
    expect(await fired('src/config/env.ts', code)).toEqual([]);
  });

  it('allows console in tests and scripts', async () => {
    expect(await fired('test/integration/x.test.ts', `console.log('x');`)).toEqual([]);
    expect(await fired('scripts/gen-openapi.ts', `console.log('x');`)).toEqual([]);
  });
});
