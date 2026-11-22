// Static checks of the production deploy files (feature 24D, decision 036): the compose file, the Caddyfile, the Prometheus
// config and the images' Dockerfiles. Nothing is started; these are the rules that must not drift.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), 'utf8');

interface Service {
  image?: string;
  ports?: unknown;
  command?: string[];
  stop_grace_period?: string;
  profiles?: string[];
  restart?: string;
  init?: boolean;
  volumes?: string[];
  environment?: Record<string, string>;
  mem_limit?: string;
  depends_on?: Record<string, { condition: string }>;
  ulimits?: { nofile?: { soft: number; hard: number } };
}
const compose = Bun.YAML.parse(read('deploy/compose.prod.yaml')) as { services: Record<string, Service> };
const service = (name: string): Service => {
  const found = compose.services[name];
  if (!found) throw new Error(`service ${name} is missing`);
  return found;
};

describe('deploy/compose.prod.yaml', () => {
  it('publishes ports on Caddy only', () => {
    const withPorts = Object.entries(compose.services)
      .filter(([, definition]) => definition.ports !== undefined)
      .map(([name]) => name);
    expect(withPorts).toEqual(['caddy']);
    expect(service('caddy').ports).toEqual(['80:80', '443:443', '443:443/udp']);
  });

  it('runs the queue Redis with noeviction and an append-only file, the cache Redis with LRU and no persistence', () => {
    const queue = (service('redis-queue').command ?? []).join(' ');
    expect(queue).toContain('--appendonly yes');
    expect(queue).toContain('--appendfsync everysec');
    expect(queue).toContain('--maxmemory-policy noeviction');
    const cache = (service('redis-cache').command ?? []).join(' ');
    expect(cache).toContain('--maxmemory-policy allkeys-lru');
    expect(cache).toContain('--appendonly no');
    expect(cache).toContain('--maxmemory 256mb');
    expect(service('redis-cache').volumes).toBeUndefined();
    expect(service('redis-queue').volumes).toEqual(['redis-queue-data:/data']);
  });

  it('raises the descriptor limit of Caddy and the API for the live event streams (decision 037)', () => {
    for (const name of ['caddy', 'api']) {
      expect(service(name).ulimits).toEqual({ nofile: { soft: 65536, hard: 65536 } });
    }
  });

  it('gives the worker more time than its 25 s drain, and the API, worker and migrate one image', () => {
    expect(service('worker').stop_grace_period).toBe('30s');
    expect(service('worker').command).toEqual(['bun', 'src/worker.ts']);
    const images = new Set(['api', 'worker', 'migrate'].map((name) => service(name).image));
    expect(images.size).toBe(1);
    expect(service('migrate').command).toEqual(['bun', 'scripts/db-migrate.ts']);
    expect(service('migrate').profiles).toEqual(['tools']);
    expect(service('migrate').restart).toBe('no');
  });

  it('restarts every long-running service with an init process, and keeps tools and the site out of the default start', () => {
    for (const name of [
      'caddy',
      'api',
      'worker',
      'postgres',
      'redis-queue',
      'redis-cache',
      'minio',
      'prometheus',
      'console',
    ]) {
      expect(service(name).restart, name).toBe('unless-stopped');
      expect(service(name).init, name).toBe(true);
    }
    expect(service('backup').profiles).toEqual(['tools']);
    expect(service('site').profiles).toEqual(['site']);
    // The name the storefront reads (storefront lib/api/server.ts), so its server-side calls stay inside the network.
    expect(service('site').environment).toEqual({ GSM_API_ORIGIN: 'http://api:3000' });
  });

  it('runs the search engine on the internal network with its limits, and gives each app container only its own key (feature 29)', () => {
    const engine = service('typesense');
    const dev = Bun.YAML.parse(read('compose.yaml')) as { services: Record<string, Service> };
    // The same image and digest as the development stack, never published, restarted, memory-limited.
    expect(engine.image).toBe(dev.services.typesense?.image);
    expect(engine.image).toMatch(/^typesense\/typesense:30\.2@sha256:[0-9a-f]{64}$/);
    expect(engine.ports).toBeUndefined();
    expect(engine.restart).toBe('unless-stopped');
    expect(engine.mem_limit).toContain('TYPESENSE_MEM_LIMIT');
    const command = (engine.command ?? []).join(' ');
    expect(command).toContain('--api-key ${TYPESENSE_BOOTSTRAP_KEY:?');
    expect(command).toContain('--disk-used-max-percentage 85');
    expect(command).toContain('--db-compaction-interval 86400');
    // Step 0: the memory flag never refused a write under a cgroup limit, so it is not used.
    expect(command).not.toContain('--memory-used-max-percentage');
    // A slow multi_search is logged with its body, which holds the typed query: no slow log at all.
    expect(command).not.toContain('--log-slow-requests-time-ms');
    expect(command).toContain('--log-slow-searches-time-ms -1');
    expect(engine.volumes).toEqual(['typesense-data:/data']);
    // The API must boot without search: started, never healthy.
    for (const name of ['api', 'worker'])
      expect(service(name).depends_on?.typesense, name).toEqual({ condition: 'service_started' });
    expect(Object.keys(service('api').environment ?? {})).toEqual(['TYPESENSE_SEARCH_KEY']);
    expect(Object.keys(service('worker').environment ?? {})).toEqual(['TYPESENSE_INDEXER_KEY']);
  });

  it('pins every image by tag and never uses latest', () => {
    for (const [name, definition] of Object.entries(compose.services)) {
      const image = definition.image ?? '';
      if (image.includes('${') || image === 'gsm-backup:local') continue; // our own images are built or named by the operator
      expect(image, name).toMatch(/:[0-9]|@sha256:/);
      expect(image, name).not.toContain(':latest');
    }
  });
});

describe('deploy/Caddyfile', () => {
  const caddyfile = read('deploy/Caddyfile');
  const block = (host: string): string => {
    const start = caddyfile.indexOf(`{$${host}} {`);
    if (start < 0) throw new Error(`no block for ${host}`);
    return caddyfile.slice(start, caddyfile.indexOf('\n}\n', start));
  };

  it('routes the shop host to the API for /client/* and /store/v1/* only', () => {
    expect(block('SHOP_HOST')).toContain('@api path /client/* /store/v1/*');
    expect(block('SHOP_HOST')).toContain('reverse_proxy site:3000');
  });

  it('routes the admin host to the API for /admin/*, /health and /reference only', () => {
    expect(block('ADMIN_HOST')).toContain('@api path /admin/* /health /reference /reference/*');
    expect(block('ADMIN_HOST')).toContain('reverse_proxy console:80');
  });

  it("routes the console's own pictures (/store/v1/media/*) on the admin host to the API, and nothing else of /store/v1 (decision 045)", () => {
    const admin = block('ADMIN_HOST');
    expect(admin).toMatch(/@api path \/admin\/\* \/health \/reference \/reference\/\* \/store\/v1\/media\/\*\n/);
    const matcher = /@api path (.+)\n/.exec(admin)?.[1] ?? '';
    // Only the pictures: no other path of the shop surface is reachable through the console's host.
    expect(matcher.split(' ').filter((path) => path.startsWith('/store/v1'))).toEqual(['/store/v1/media/*']);
    expect(matcher).not.toContain('/client');
    expect(block('SHOP_HOST')).toContain('@api path /client/* /store/v1/*');
  });

  it("puts the page headers of decision 045 on the console's and the shop's pages only, and no script policy at the edge", () => {
    const snippet = (name: string): string => {
      const start = caddyfile.indexOf(`(${name}) {`);
      if (start < 0) throw new Error(`no snippet ${name}`);
      return caddyfile.slice(start, caddyfile.indexOf('\n}\n', start));
    };
    const consoleHeaders = snippet('console_page_headers');
    for (const line of [
      "Content-Security-Policy \"frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'\"",
      'X-Frame-Options "DENY"',
      'X-Content-Type-Options "nosniff"',
      'Referrer-Policy "same-origin"',
    ]) {
      expect(consoleHeaders).toContain(line);
    }
    expect(consoleHeaders).toMatch(/^\s*defer$/m);
    const shopHeaders = snippet('shop_page_headers');
    expect(shopHeaders).toContain(
      "+Content-Security-Policy \"frame-ancestors 'none'; base-uri 'self'; object-src 'none'\"",
    );
    expect(shopHeaders).toContain('X-Frame-Options "DENY"');
    expect(shopHeaders).toContain('X-Content-Type-Options "nosniff"');
    expect(shopHeaders).toMatch(/^\s*defer$/m);
    expect(shopHeaders).toContain('header ?Referrer-Policy "strict-origin-when-cross-origin"');

    // Imported in the handle that proxies to the page server, never in the handle of the API's own routes.
    expect(block('ADMIN_HOST')).toMatch(/handle \{\s*import console_page_headers\s*reverse_proxy console:80\s*\}/);
    expect(block('ADMIN_HOST')).toMatch(/handle @api \{\s*reverse_proxy api:3000\s*\}/);
    expect(block('SHOP_HOST')).toMatch(/handle \{\s*import shop_page_headers\s*reverse_proxy site:3000\s*\}/);
    expect(block('SHOP_HOST')).toMatch(/handle @api \{\s*reverse_proxy api:3000\s*\}/);
    expect(block('API_HOST')).not.toContain('_page_headers');

    const active = caddyfile
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(active).not.toContain('script-src');
    expect(active).toContain('header Strict-Transport-Security "max-age=31536000"');
  });

  it('answers 404 on the API host except for the machine surfaces', () => {
    expect(block('API_HOST')).toContain('@api path /api/index.php /v1/* /webhooks/* /docs /docs/*');
    expect(block('API_HOST')).toContain('respond 404');
  });

  it('never routes /metrics, never trusts forwarded headers from outside, and caps request bodies', () => {
    const active = caddyfile
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(active).not.toContain('/metrics');
    expect(active).not.toContain('trusted_proxies');
    expect(caddyfile).toContain('max_size 27MB');
    expect(caddyfile).toContain('Strict-Transport-Security');
  });

  // The shared access log (decision 054): every site block imports it and none writes a log of its own.
  const accessLog = (() => {
    const start = caddyfile.indexOf('(access_log) {');
    if (start < 0) throw new Error('no access_log snippet');
    return caddyfile.slice(start, caddyfile.indexOf('\n}\n', start));
  })();
  const fieldRules = (field: string): string[] => {
    const body = new RegExp(`${field} multi_regexp \\{([\\s\\S]*?)\\n\\s*\\}`).exec(accessLog)?.[1] ?? '';
    return body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  };
  /** Applies the rules of one field in order, the way Caddy does (Go's `${n}` written as JavaScript's `$n`). */
  const applyRules = (field: string, input: string): string =>
    fieldRules(field).reduce((text, line) => {
      const match = /^regexp "(.*)" "(.*)"$/.exec(line);
      if (!match?.[1] || match[2] === undefined) throw new Error(`not a regexp line: ${line}`);
      return text.replace(new RegExp(match[1], 'g'), match[2].replace(/\$\{(\d)\}/g, '$$$1'));
    }, input);

  it('every site block writes the shared access log and none has its own', () => {
    const hosts = [...caddyfile.matchAll(/^\{\$([A-Z_]+)\} \{$/gm)].map((match) => match[1] ?? '');
    expect(hosts.sort()).toEqual(expect.arrayContaining(['ADMIN_HOST', 'API_HOST', 'SHOP_HOST']));
    for (const host of hosts) expect(block(host), host).toContain('import access_log');
    const active = caddyfile
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(active.match(/^\s*log \{$/gm)).toHaveLength(1);
    expect(active).not.toContain('json_log');
    expect(accessLog).toContain('format filter {');
  });

  /** The one rule that cuts the whole query string of a redirect's Location. */
  const QUERY_CUT = 'regexp "[?].*" "?[redacted]"';

  it('the request address and the Referer use the same rules, and a redirect the same path rules', () => {
    const address = fieldRules('request>uri');
    expect(address.length).toBeGreaterThan(5);
    expect(fieldRules('request>headers>Referer')).toEqual(address);
    const pathRules = address.filter((line) => !line.startsWith('regexp "([?&])'));
    expect(pathRules).toHaveLength(7);
    expect(fieldRules('resp_headers>Location')).toEqual([...pathRules, QUERY_CUT]);
    expect(accessLog).not.toMatch(/^\s*(request|resp_headers)>[^\n]* regexp /m);
  });

  it('the rules replace link tokens, the webhook secret, searches and IMEIs', () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUv';
    const cases: Array<[string, string]> = [
      [`/store/v1/orders/${token}/receipt`, '/store/v1/orders/[token]/receipt'],
      [`/store/v1/checkout-sessions/${token}/pay`, '/store/v1/checkout-sessions/[token]/pay'],
      [`/store/v1/tickets/${token}/stream`, '/store/v1/tickets/[token]/stream'],
      [
        '/store/v1/marketing/unsubscribe/1a.0123456789abcdef0123456789abcdef',
        '/store/v1/marketing/unsubscribe/[token]',
      ],
      [`/en/track/${token}`, '/en/track/[token]'],
      [`/en/checkout/${token}`, '/en/checkout/[token]'],
      [`/en/checkout/return?token=${token}`, '/en/checkout/return?token=[redacted]'],
      [`/en/support/tickets/${token}`, '/en/support/tickets/[token]'],
      [`/en/support?order=${token}`, '/en/support?order=[redacted]'],
      ['/en/sign-in?as=customer&next=%2Fen%2Fcheckout%2FAbCd', '/en/sign-in?as=customer&next=[redacted]'],
      ['/set-password?token=abc', '/set-password?token=[redacted]'],
      ['/store/v1/search?q=356938035643809&page=2', '/store/v1/search?q=[redacted]&page=2'],
      ['/admin/customers?_start=0&_end=25&q=rania%40example.com', '/admin/customers?_start=0&_end=25&q=[redacted]'],
      ['/admin/orders?_sort=createdAt&_order=desc', '/admin/orders?_sort=createdAt&_order=desc'],
      ['/v1/orders?imei=356938035643809&limit=50', '/v1/orders?imei=[redacted]&limit=50'],
      ['/webhooks/telegram/0123456789abcdef0123', '/webhooks/telegram/[secret]'],
      ['/admin/orders/123', '/admin/orders/123'],
      ['/admin/support-tickets/9', '/admin/support-tickets/9'],
      ['/store/v1/me/tickets', '/store/v1/me/tickets'],
      ['/store/v1/checkout-sessions', '/store/v1/checkout-sessions'],
    ];
    for (const [input, expected] of cases) {
      expect(applyRules('request>uri', input), input).toBe(expected);
      const referer = 'https://shop.example.com';
      expect(applyRules('request>headers>Referer', referer + input), input).toBe(referer + expected);
    }
  });

  it("a redirect's Location loses its link tokens and its whole query string, and keeps any other path", () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUv';
    const cases: Array<[string, string]> = [
      // The storefront's redirect of a ticket mail's link (STORE_BASE_URL has no /en).
      [`https://shop.example.com/en/support/tickets/${token}`, 'https://shop.example.com/en/support/tickets/[token]'],
      [`https://shop.example.com/en/track/${token}`, 'https://shop.example.com/en/track/[token]'],
      [
        `https://shop.example.com/en/checkout/${token}?step=pay`,
        'https://shop.example.com/en/checkout/[token]?[redacted]',
      ],
      [`/store/v1/checkout-sessions/${token}`, '/store/v1/checkout-sessions/[token]'],
      ['/en/sign-in?as=customer&next=%2Fen%2Fcheckout%2FAbCd', '/en/sign-in?[redacted]'],
      ['https://shop.example.com/en/checkout/return', 'https://shop.example.com/en/checkout/return'],
      // A signed download link keeps its path; its signature is in the query.
      [
        'https://files.example.com/gsm-files/files/2026/11/0b6f3c1e-receipt.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=9f2c',
        'https://files.example.com/gsm-files/files/2026/11/0b6f3c1e-receipt.pdf?[redacted]',
      ],
    ];
    for (const [input, expected] of cases) {
      expect(applyRules('resp_headers>Location', input), input).toBe(expected);
    }
  });

  it('credential headers and redirect queries are not logged', () => {
    for (const header of [
      'request>headers>X-Csrf-Token',
      'request>headers>X-Turnstile-Token',
      'request>headers>Idempotency-Key',
      'request>headers>X-Telegram-Bot-Api-Secret-Token',
      'request>headers>Stripe-Signature',
      'request>headers>X-Gsm-Signature',
      // The shop's pages send their own address (a link token in it) with every prefetch, refresh and navigation.
      'request>headers>Next-Url',
      'request>headers>Next-Router-State-Tree',
      'resp_headers>X-Csrf-Token',
    ]) {
      expect(accessLog, header).toContain(`${header} delete`);
    }
    expect(fieldRules('resp_headers>Location').at(-1)).toBe(QUERY_CUT);
  });

  it('compresses everything except the live event streams (decision 037)', () => {
    const active = caddyfile
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    const matcher = /^\s*@compressible not path (.+)$/m.exec(active);
    expect((matcher?.[1] ?? '').split(' ')).toEqual([
      '/store/v1/me/stream',
      '/client/stream',
      '/admin/stream',
      '/store/v1/tickets/*/stream',
    ]);
    expect(active).toContain('encode @compressible zstd gzip');
    // Caddy flushes text/event-stream by itself; `flush_interval -1` would also stop it from cancelling the upstream on leave.
    expect(active).not.toContain('flush_interval');
  });
});

describe('deploy/prometheus/prometheus.yml', () => {
  it('scrapes the API and the worker over the network with the metrics token from the secret file', () => {
    const config = Bun.YAML.parse(read('deploy/prometheus/prometheus.yml')) as {
      scrape_configs: {
        job_name: string;
        authorization: { credentials_file: string };
        static_configs: { targets: string[] }[];
      }[];
    };
    const jobs = Object.fromEntries(config.scrape_configs.map((job) => [job.job_name, job]));
    expect(jobs['gsm-api']?.static_configs[0]?.targets).toEqual(['api:3000']);
    expect(jobs['gsm-worker']?.static_configs[0]?.targets).toEqual(['worker:9464']);
    for (const job of config.scrape_configs) {
      expect(job.authorization.credentials_file).toBe('/run/secrets/metrics_token');
    }
  });
});

describe('Dockerfile and .dockerignore', () => {
  const dockerfile = read('Dockerfile');

  it('installs production dependencies without scripts, verifies the imports and runs as the bun user', () => {
    expect(dockerfile).toContain('bun install --frozen-lockfile --production --ignore-scripts');
    expect(dockerfile).toContain('FROM tree AS verify');
    expect(dockerfile).toContain("import('./src/app.module.ts')");
    expect(dockerfile).toContain("import('./src/worker.module.ts')");
    expect(dockerfile).toMatch(/^USER bun$/m);
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('/health?strict=1');
    expect(dockerfile).toContain('CMD ["bun", "src/main.ts"]');
  });

  it('keeps secrets, tests, docs and the map out of the build context', () => {
    const ignored = read('.dockerignore').split('\n');
    for (const entry of ['.git', 'node_modules', '.env', '.env.*', 'test', 'docs', 'reference', '.lead', 'deploy']) {
      expect(ignored).toContain(entry);
    }
  });

  it('carries the search-key tool the runbook runs in the api container, in the allow-list, the copy and the import check', () => {
    expect(read('.dockerignore').split('\n')).toContain('!scripts/search-keys.ts');
    expect(dockerfile).toMatch(/^COPY [^\n]*scripts\/search-keys\.ts [^\n]*\.\/scripts\/$/m);
    expect(dockerfile).toContain("'search-keys'");
  });

  it('carries the Telegram webhook tool the runbook runs in the api container, in the allow-list, the copy and the import check', () => {
    expect(read('.dockerignore').split('\n')).toContain('!scripts/telegram-webhook.ts');
    expect(dockerfile).toMatch(/^COPY [^\n]*scripts\/telegram-webhook\.ts [^\n]*\.\/scripts\/$/m);
    expect(dockerfile).toContain("'telegram-webhook'");
  });

  it('carries the English-only export the release-30 runbook runs in the migrate container, in the allow-list, the copy and the import check', () => {
    expect(read('.dockerignore').split('\n')).toContain('!scripts/english-only-export.ts');
    expect(dockerfile).toMatch(/^COPY [^\n]*scripts\/english-only-export\.ts [^\n]*\.\/scripts\/$/m);
    expect(dockerfile).toContain("'english-only-export'");
    // it reads the journal next to it (drizzle/ is copied whole) and nothing of scripts/lib or src
    expect(dockerfile).toMatch(/^COPY drizzle \.\/drizzle$/m);
    const source = read('scripts/english-only-export.ts');
    const imports = [...source.matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)'/gm)].map((match) => match[1]);
    expect(source).not.toMatch(/\bimport\(/);
    expect(imports.sort()).toEqual(['node:crypto', 'node:fs', 'node:path', 'pg']);
  });

  it('copies no environment file into the image and bakes in no secret', () => {
    expect(dockerfile).not.toMatch(/COPY[^\n]*\.env/);
    expect(dockerfile).not.toMatch(/^(ENV|ARG)[^\n]*(SECRET|PASSWORD|TOKEN|PEPPER|KEY)/m);
  });
});
