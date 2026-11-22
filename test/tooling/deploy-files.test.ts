// Static checks of the production deploy files (feature 24D, decision 036): the compose file, the Caddyfile, the Prometheus
// config and the images' Dockerfiles. Nothing is started; these are the rules that must not drift.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { assertObjectKey } from '@src/infra/storage/storage-names';

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
  env_file?: unknown;
  mem_limit?: string;
  depends_on?: Record<string, { condition: string }>;
  ulimits?: { nofile?: { soft: number; hard: number } };
  healthcheck?: { test?: string[] };
  security_opt?: string[];
  pids_limit?: number;
  logging?: { driver?: string; options?: Record<string, string> };
  cap_drop?: string[];
  cap_add?: string[];
  networks?: string[] | Record<string, { ipv4_address?: string } | null>;
}
interface Network {
  internal?: boolean;
  ipam?: { config?: { subnet: string; ip_range?: string }[] };
}
const compose = Bun.YAML.parse(read('deploy/compose.prod.yaml')) as {
  services: Record<string, Service>;
  networks: Record<string, Network>;
};
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

  it('runs the queue Redis with noeviction, an append-only file and a memory bound, the cache Redis with LRU and no persistence', () => {
    const queue = (service('redis-queue').command ?? []).join(' ');
    expect(queue).toContain('--appendonly yes');
    expect(queue).toContain('--appendfsync everysec');
    expect(queue).toContain('--maxmemory-policy noeviction');
    // Decision 055: a full instance refuses new jobs and the outbox keeps the work; the container limit leaves room for the rewrite.
    expect(queue).toContain('--maxmemory ${REDIS_QUEUE_MAXMEMORY:-512mb}');
    expect(service('redis-queue').mem_limit).toBe('${REDIS_QUEUE_MEM_LIMIT:-1g}');
    const cache = (service('redis-cache').command ?? []).join(' ');
    expect(cache).toContain('--maxmemory-policy allkeys-lru');
    expect(cache).toContain('--appendonly no');
    expect(cache).toContain('--maxmemory 256mb');
    expect(service('redis-cache').volumes).toBeUndefined();
    expect(service('redis-queue').volumes).toEqual(['redis-queue-data:/data']);
  });

  it('gives both Redis instances a password, and a health check that needs none (decision 055)', () => {
    expect((service('redis-queue').command ?? []).join(' ')).toContain(
      '--requirepass ${REDIS_QUEUE_PASSWORD:?set REDIS_QUEUE_PASSWORD in deploy/.env}',
    );
    expect((service('redis-cache').command ?? []).join(' ')).toContain(
      '--requirepass ${REDIS_CACHE_PASSWORD:?set REDIS_CACHE_PASSWORD in deploy/.env}',
    );
    for (const name of ['redis-queue', 'redis-cache']) {
      // NOAUTH proves the server answers: the check has no password of its own.
      expect(service(name).healthcheck?.test, name).toEqual([
        'CMD-SHELL',
        "redis-cli ping 2>&1 | grep -Eq 'PONG|NOAUTH'",
      ]);
    }
  });

  it('splits the stack into five networks, the data ones internal, with explicit subnets that are not the old one (decision 055)', () => {
    expect(Object.keys(compose.networks).sort()).toEqual(['data', 'edge', 'egress', 'files', 'monitoring']);
    for (const name of ['data', 'files', 'monitoring']) expect(compose.networks[name]?.internal, name).toBe(true);
    for (const name of ['edge', 'egress']) expect(compose.networks[name]?.internal, name).toBeUndefined();
    const subnets = Object.fromEntries(
      Object.entries(compose.networks).map(([name, network]) => [name, network.ipam?.config?.[0]?.subnet]),
    );
    expect(subnets).toEqual({
      edge: '172.30.1.0/24',
      data: '172.30.2.0/24',
      files: '172.30.3.0/24',
      monitoring: '172.30.4.0/24',
      egress: '172.30.5.0/24',
    });
    // A new network can be created while the old one (172.30.0.0/24) still exists on the host.
    expect(Object.values(subnets)).not.toContain('172.30.0.0/24');
    // Every other container of `edge` gets an address from the upper half, so the two fixed ones never collide with it.
    expect(compose.networks.edge?.ipam?.config?.[0]?.ip_range).toBe('172.30.1.128/25');
  });

  it('puts each service on exactly the networks it needs, and gives Caddy and the site fixed addresses outside the dynamic range', () => {
    const networksOf = (name: string): string[] => {
      const networks = service(name).networks;
      if (networks === undefined) throw new Error(`${name} has no networks`);
      return (Array.isArray(networks) ? networks : Object.keys(networks)).sort();
    };
    expect(Object.fromEntries(Object.keys(compose.services).map((name) => [name, networksOf(name)]))).toEqual({
      caddy: ['edge', 'files'],
      api: ['data', 'edge', 'monitoring'],
      worker: ['data', 'egress', 'monitoring'],
      migrate: ['data'],
      postgres: ['data'],
      'redis-queue': ['data'],
      'redis-cache': ['data'],
      typesense: ['data'],
      minio: ['data', 'files'],
      'minio-init': ['data'],
      'minio-admin': ['data'],
      prometheus: ['monitoring'],
      console: ['edge'],
      site: ['edge'],
      backup: ['data', 'egress'],
    });
    const addressOf = (name: string): string | undefined => {
      const networks = service(name).networks;
      return Array.isArray(networks) ? undefined : (networks?.edge?.ipv4_address ?? undefined);
    };
    expect(addressOf('caddy')).toBe('172.30.1.2');
    expect(addressOf('site')).toBe('172.30.1.3');
    // The dynamic range is 172.30.1.128/25: both fixed addresses are below .128.
    for (const address of [addressOf('caddy'), addressOf('site')]) {
      expect(Number(address?.split('.')[3])).toBeLessThan(128);
    }
    // Only the services that serve browsers (or are reached by Caddy) are on `edge`: nothing else may be added to it.
    expect(Object.keys(compose.services).filter((name) => networksOf(name).includes('edge'))).toEqual([
      'caddy',
      'api',
      'console',
      'site',
    ]);
  });

  it('keeps every service from gaining privileges, bounds its logs and processes, and drops capabilities: all for the unprivileged images, raw sockets for the internal services (decision 055)', () => {
    for (const name of Object.keys(compose.services)) {
      const definition = service(name);
      expect(definition.security_opt, name).toEqual(['no-new-privileges:true']);
      expect(definition.pids_limit, name).toBe(1024);
      expect(definition.logging, name).toEqual({ driver: 'local', options: { 'max-size': '20m', 'max-file': '5' } });
    }
    const dropping = (capabilities: string[]): string[] =>
      Object.keys(compose.services)
        .filter((name) => JSON.stringify(service(name).cap_drop) === JSON.stringify(capabilities))
        .sort();
    // The images that run as an unprivileged user drop everything.
    expect(dropping(['ALL'])).toEqual(
      ['api', 'backup', 'caddy', 'migrate', 'minio-admin', 'minio-init', 'prometheus', 'site', 'worker'].sort(),
    );
    // The services that only answer on the data, files and monitoring networks (and the console, which only answers Caddy) drop raw
    // sockets and keep their other defaults: their entry points start as root and hand over to their own user.
    expect(dropping(['NET_RAW'])).toEqual(['console', 'minio', 'postgres', 'redis-cache', 'redis-queue', 'typesense']);
    // No service is left with every default capability.
    expect(Object.keys(compose.services).filter((name) => service(name).cap_drop === undefined)).toEqual([]);
    // Caddy binds 80 and 443, and nothing else.
    expect(Object.keys(compose.services).filter((name) => service(name).cap_add !== undefined)).toEqual(['caddy']);
    expect(service('caddy').cap_add).toEqual(['NET_BIND_SERVICE']);
  });

  it('gives only the migrate service the owner role, and the backups the same role in their own variable (decision 055)', () => {
    expect(service('migrate').environment).toEqual({
      DATABASE_OWNER_URL: 'postgres://gsm:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in deploy/.env}@postgres:5432/gsm',
    });
    for (const name of Object.keys(compose.services)) {
      if (name === 'migrate') continue;
      expect(Object.keys(service(name).environment ?? {}), name).not.toContain('DATABASE_OWNER_URL');
    }
    // The API and the worker connect with DATABASE_URL of .env.production, the application's own role.
    expect(read('deploy/compose.prod.yaml')).not.toContain('postgres://gsm_app');
    expect(service('backup').environment?.DATABASE_URL).toBe(
      'postgres://gsm:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in deploy/.env}@postgres:5432/gsm',
    );
  });

  it('gives the backup container its own variables only, and the read-only MinIO user (decision 055)', () => {
    const backup = service('backup');
    expect(backup.env_file).toBeUndefined();
    const names = Object.keys(backup.environment ?? {});
    expect(names.sort()).toEqual(
      [
        'DATABASE_URL',
        'BACKUP_S3_ENDPOINT',
        'BACKUP_S3_BUCKET',
        'BACKUP_S3_REGION',
        'BACKUP_S3_PROVIDER',
        'BACKUP_S3_ACCESS_KEY_ID',
        'BACKUP_S3_SECRET_ACCESS_KEY',
        'BACKUP_AGE_RECIPIENT',
        'BACKUP_ALLOW_PLAINTEXT',
        'BACKUP_RETENTION_DAYS',
        'BACKUP_MONTHLY_KEEP',
        'BACKUP_PRUNE',
        'S3_ENDPOINT',
        'S3_BUCKET',
        'S3_REGION',
        'S3_FORCE_PATH_STYLE',
        'S3_ACCESS_KEY_ID',
        'S3_SECRET_ACCESS_KEY',
      ].sort(),
    );
    for (const secret of ['TOKEN_PEPPER', 'CSRF_SECRET', 'ENCRYPTION_KEYS', 'LOOKUP_HASH_KEY', 'METRICS_TOKEN']) {
      expect(names).not.toContain(secret);
    }
    expect(names.filter((name) => /^MINIO_ROOT|TYPESENSE/.test(name))).toEqual([]);
    expect(backup.environment?.S3_ACCESS_KEY_ID).toBe('${MINIO_BACKUP_USER:-}');
    expect(backup.environment?.S3_SECRET_ACCESS_KEY).toBe('${MINIO_BACKUP_PASSWORD:-}');
    // The file that used to carry it is gone, so the switch is listed (default: refuse an unencrypted dump).
    expect(backup.environment?.BACKUP_ALLOW_PLAINTEXT).toBe('${BACKUP_ALLOW_PLAINTEXT:-0}');
    expect(backup.environment?.BACKUP_PRUNE).toBe('${BACKUP_PRUNE:-0}');
  });

  it('administers MinIO once per volume with a tools service, and the two policies allow exactly what each user needs (decision 055)', () => {
    const admin = service('minio-admin');
    expect(admin.profiles).toEqual(['tools']);
    expect(admin.restart).toBe('no');
    expect(admin.image).toBe(service('minio-init').image);
    expect(admin.volumes).toEqual(['./minio:/etc/gsm/minio:ro']);
    expect(admin.environment?.MC_HOST_local).toBe('http://${MINIO_ROOT_USER:?}:${MINIO_ROOT_PASSWORD:?}@minio:9000');
    // The root account stays with MinIO and its two tools: nothing else of the stack names it.
    for (const name of Object.keys(compose.services)) {
      const holdsRoot = Object.values(service(name).environment ?? {}).some((value) =>
        /MINIO_ROOT/.test(String(value)),
      );
      expect(holdsRoot, name).toBe(['minio', 'minio-init', 'minio-admin'].includes(name));
    }
    const policy = (file: string) => JSON.parse(read(`deploy/minio/${file}`)) as unknown;
    const listing = {
      Effect: 'Allow',
      Action: ['s3:GetBucketLocation', 's3:ListBucket'],
      Resource: ['arn:aws:s3:::gsm-files'],
    };
    expect(policy('gsm-app-policy.json')).toEqual({
      Version: '2012-10-17',
      Statement: [
        listing,
        {
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
          Resource: ['arn:aws:s3:::gsm-files/*'],
        },
      ],
    });
    expect(policy('gsm-backup-read-policy.json')).toEqual({
      Version: '2012-10-17',
      Statement: [listing, { Effect: 'Allow', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::gsm-files/*'] }],
    });
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
    // The one-off MinIO administration (decision 055): never in the default start, never restarted.
    expect(service('minio-admin').profiles).toEqual(['tools']);
    expect(service('minio-admin').restart).toBe('no');
    expect(service('minio-admin').init).toBeUndefined();
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
    // Decision 055: the admin key comes from the environment of the container, not from its command line (a user of the host sees that).
    expect(command).not.toContain('--api-key');
    expect(command).not.toContain('TYPESENSE_BOOTSTRAP_KEY');
    expect(engine.environment).toEqual({ TYPESENSE_API_KEY: '${TYPESENSE_BOOTSTRAP_KEY:?set it in deploy/.env}' });
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
    // Other features add variables to the API's environment (the country header): what must hold is its search key and no owner role.
    const apiVariables = Object.keys(service('api').environment ?? {});
    expect(apiVariables).toContain('TYPESENSE_SEARCH_KEY');
    expect(apiVariables).toContain('GEOIP_COUNTRY_HEADER');
    expect(apiVariables).not.toContain('DATABASE_OWNER_URL');
    expect(apiVariables.filter((name) => /INDEXER|BOOTSTRAP/.test(name))).toEqual([]);
    // The worker holds its indexer key, the database time limits of decision 055 (the test below) and never the owner role, the search key
    // or the engine's admin key.
    const workerVariables = Object.keys(service('worker').environment ?? {});
    expect(workerVariables).toContain('TYPESENSE_INDEXER_KEY');
    expect(workerVariables.filter((name) => /SEARCH|BOOTSTRAP|OWNER/.test(name))).toEqual([]);
  });

  it('gives the worker its own database time limits; the API keeps the defaults (decision 055)', () => {
    expect(service('worker').environment).toMatchObject({
      DATABASE_STATEMENT_TIMEOUT_MS: '300000',
      DATABASE_LOCK_TIMEOUT_MS: '30000',
    });
    expect(service('api').environment ?? {}).not.toHaveProperty('DATABASE_STATEMENT_TIMEOUT_MS');
    expect(service('migrate').environment ?? {}).not.toHaveProperty('DATABASE_STATEMENT_TIMEOUT_MS');
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

  it('removes the visitor-country header before the API on every host, with the name the API reads (decision 050)', () => {
    // The bundled edge writes no country: a value a visitor sends must never reach the API, whatever the operator sets.
    for (const host of ['SHOP_HOST', 'ADMIN_HOST', 'API_HOST']) {
      const text = block(host);
      expect(text, host).toContain('request_header -{$GEOIP_COUNTRY_HEADER:X-Visitor-Country}');
      // At the top of the host, before every handle (the site's own server forwards visitor headers to the API).
      expect(text.indexOf('request_header'), host).toBeLessThan(text.indexOf('handle'));
    }
    expect(service('caddy').environment?.['GEOIP_COUNTRY_HEADER']).toBe('${GEOIP_COUNTRY_HEADER:-X-Visitor-Country}');
    expect(service('api').environment?.['GEOIP_COUNTRY_HEADER']).toBe('${GEOIP_COUNTRY_HEADER:-}');
    // Nothing else reads a request: the worker and the migration get no copy.
    expect(service('worker').environment?.['GEOIP_COUNTRY_HEADER']).toBeUndefined();
    expect(service('migrate').environment?.['GEOIP_COUNTRY_HEADER']).toBeUndefined();
    const active = caddyfile
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(active).not.toContain('trusted_proxies');
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
      // The answer of a download names the stored file in it.
      'resp_headers>Content-Disposition',
    ]) {
      expect(accessLog, header).toContain(`${header} delete`);
    }
    expect(fieldRules('resp_headers>Location').at(-1)).toBe(QUERY_CUT);
  });

  it('cuts slow clients with server timeouts, and has no per-address cap that Caddy cannot enforce (decision 055)', () => {
    const active = caddyfile
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    const options = active.slice(0, active.indexOf('(common) {'));
    expect(options).toMatch(
      /servers \{\s*timeouts \{\s*read_header 10s\s*read_body_idle 30s\s*write_idle 1m\s*idle 2m\s*\}\s*\}/,
    );
    // The live event streams write at least every 15 s, so a write idle of a minute never cuts one.
    expect(active).not.toContain('rate_limit');
    expect(active).not.toContain('max_conns');
  });

  it("states in its header that the API trusts Caddy's and the site's fixed addresses, and describes the files host", () => {
    const header = caddyfile.slice(0, caddyfile.indexOf('\n{\n'));
    expect(header).toContain('TRUST_PROXY=172.30.1.2,172.30.1.3');
    expect(header).not.toContain('172.30.0.0/24');
    expect(header).toContain('FILES_HOST');
  });

  it('serves signed reads of single objects of the files bucket on the files host, and a 404 for everything else (decision 055)', () => {
    const files = block('FILES_HOST');
    expect(files).toContain('import common');
    expect(files).toContain('import access_log');
    expect(files).toMatch(
      /@signed_read \{\s*method GET HEAD\s*path_regexp (\S+)\s*vars_regexp raw_path \{http\.request\.uri\.path\} (\S+)\s*query X-Amz-Signature=\*\s*query response-content-disposition=\*\s*\}/,
    );
    expect(files).toMatch(
      /handle @signed_read \{[\s\S]*reverse_proxy minio:9000 \{\s*header_up Host \{hostport\}\s*\}[\s\S]*\}/,
    );
    expect(files).toMatch(/handle \{\s*respond 404\s*\}/);
    // The answers are attachments that can run nothing here, and the headers are set after the store's own (defer).
    const headers = /header \{([\s\S]*?)\n\t\t\}/.exec(files)?.[1] ?? '';
    for (const line of [
      'Content-Security-Policy "default-src \'none\'; sandbox"',
      'X-Content-Type-Options "nosniff"',
      'X-Frame-Options "DENY"',
      'Referrer-Policy "no-referrer"',
    ]) {
      expect(headers).toContain(line);
    }
    expect(headers).toMatch(/^\s*defer$/m);
    // The files host never reaches anything but the store: no API, no console, no site.
    expect(files).not.toContain('api:3000');
    expect(files).not.toContain('console:80');
    expect(files).not.toContain('site:3000');
    expect(files.match(/reverse_proxy/g)).toHaveLength(1);
  });

  it('lets only the path of one object through: the bucket itself and a listing are not objects', () => {
    const expression = /path_regexp (\S+)/.exec(block('FILES_HOST'))?.[1] ?? '';
    expect(expression).toBe('^/gsm-files/[A-Za-z0-9][A-Za-z0-9._=+-]*(/[A-Za-z0-9][A-Za-z0-9._=+-]*)*$');
    const objectPath = new RegExp(expression);
    for (const path of [
      '/gsm-files/files/2026/11/0b6f3c1e-receipt.pdf',
      '/gsm-files/a',
      '/gsm-files/uploads/kyc/1/id_card-1.png',
      '/gsm-files/x=y+z/a.b-c',
      '/gsm-files/1.2/3..4/a...b', // dots inside a segment are part of a name
    ]) {
      expect(objectPath.test(path), path).toBe(true);
    }
    for (const path of [
      '/gsm-files/', // the bucket: a listing with a signature must not reach the store
      '/gsm-files',
      '/gsm-files//x',
      '/gsm-files/a/',
      '/gsm-files/a b',
      '/gsm-files/a%2Fb',
      '/other/x',
      '/',
      '/minio/admin/v3/info',
      '/gsm-files-other/x',
    ]) {
      expect(objectPath.test(path), path).toBe(false);
    }
  });

  it('passes on only the names the storage layer accepts as a key: no "." or ".." segment, no segment that starts with a symbol', () => {
    const expression = /path_regexp (\S+)/.exec(block('FILES_HOST'))?.[1] ?? '';
    const objectPath = new RegExp(expression);
    // Caddy resolves "." and ".." before path_regexp sees a path, and passes the path on as it was sent: the same expression must
    // also judge the path as sent (decoded, not resolved), or such a segment would reach the object store.
    const asSent = /vars_regexp raw_path \{http\.request\.uri\.path\} (\S+)/.exec(block('FILES_HOST'))?.[1];
    expect(asSent).toBe(expression);
    // What the check of the path as sent sees for these requests ("%2e%2e" arrives decoded, as "..").
    for (const path of [
      '/gsm-files/.',
      '/gsm-files/..',
      '/gsm-files/../x',
      '/gsm-files/a/..',
      '/gsm-files/a/../b',
      '/gsm-files/a/./b',
      '/gsm-files/./a',
      '/gsm-files/.hidden',
      '/gsm-files/a/.hidden',
      '/gsm-files/-a',
      '/gsm-files/a/=b',
      '/gsm-files/+a',
      '/gsm-files/_a',
    ]) {
      expect(objectPath.test(path), path).toBe(false);
    }
    // The rule is the storage layer's own: for each sample, the host passes the path exactly when the layer accepts the key.
    for (const key of [
      'files/2026/11/0b6f3c1e-receipt.pdf',
      'a',
      'a.b',
      '.a',
      '..',
      '.',
      'a/./b',
      'a/../b',
      'a//b',
      'a/',
      '/a',
      'a/-b',
      '9/_',
      'x=y+z/a.b-c',
      'a b',
      'a%2Fb',
      '',
    ]) {
      let accepted = true;
      try {
        assertObjectKey(key);
      } catch {
        accepted = false;
      }
      expect(objectPath.test(`/gsm-files/${key}`), JSON.stringify(key)).toBe(accepted);
    }
  });

  it('replaces the signature parameters of a file link in the address and the Referer of the access log', () => {
    const link =
      '/gsm-files/files/2026/11/a.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=app%2F20261122&X-Amz-Signature=9f2c&response-content-disposition=attachment';
    for (const field of ['request>uri', 'request>headers>Referer']) {
      const written = applyRules(field, link);
      expect(written, field).not.toContain('9f2c');
      expect(written, field).not.toContain('app%2F20261122');
      expect(written, field).toContain('X-Amz-Signature=[redacted]');
      expect(written, field).toContain('X-Amz-Credential=[redacted]');
      // The path of the object is not secret and stays.
      expect(written, field).toStartWith('/gsm-files/files/2026/11/a.pdf?');
    }
  });

  it("does not write the stored file's name that a file link carries: the response-content-* values are replaced in the address and the Referer", () => {
    const disposition =
      'attachment%3B%20filename%3D%22Rania%20Haddad%20passport.png%22%3B%20filename%2A%3DUTF-8%27%27Rania%2520Haddad%2520passport.png';
    const withDisposition = `/gsm-files/uploads/kyc/1/0b6f3c1e?response-content-disposition=${disposition}&X-Amz-Signature=9f2c`;
    const withTwoParameters = `/gsm-files/files/2026/11/a.pdf?X-Amz-Signature=9f2c&response-content-type=application%2Fpdf&response-content-disposition=${disposition}`;
    const atTheEnd = `/gsm-files/files/2026/11/a.pdf?X-Amz-Signature=9f2c&response-content-disposition=${disposition}`;
    const cases: Array<[string, string]> = [
      [
        withDisposition,
        '/gsm-files/uploads/kyc/1/0b6f3c1e?response-content-disposition=[redacted]&X-Amz-Signature=[redacted]',
      ],
      [
        withTwoParameters,
        '/gsm-files/files/2026/11/a.pdf?X-Amz-Signature=[redacted]&response-content-type=[redacted]&response-content-disposition=[redacted]',
      ],
      [atTheEnd, '/gsm-files/files/2026/11/a.pdf?X-Amz-Signature=[redacted]&response-content-disposition=[redacted]'],
    ];
    for (const field of ['request>uri', 'request>headers>Referer']) {
      const prefix = field === 'request>uri' ? '' : 'https://files.example.com';
      for (const [input, expected] of cases) {
        const written = applyRules(field, prefix + input);
        expect(written, input).toBe(prefix + expected);
        expect(written, input).not.toContain('Rania');
        expect(written, input).not.toContain('Haddad');
        expect(written, input).not.toContain('passport');
      }
    }
    // Other parameters of other addresses are not touched.
    expect(applyRules('request>uri', '/admin/files?response=1&content=2')).toBe('/admin/files?response=1&content=2');
  });

  it("does not write the stored file's name that the answer of a download carries in Content-Disposition", () => {
    const filter = accessLog.split('\n').map((line) => line.trim());
    // The header is dropped from the log whole, so no rule has to know the file name's spelling.
    expect(filter).toContain('resp_headers>Content-Disposition delete');
    expect(filter.filter((line) => line.startsWith('resp_headers>Content-Disposition'))).toEqual([
      'resp_headers>Content-Disposition delete',
    ]);
    // The delete line sits inside the log's filter, next to the other answer headers that are removed.
    const filterStart = accessLog.indexOf('format filter {');
    expect(accessLog.indexOf('resp_headers>Content-Disposition delete')).toBeGreaterThan(filterStart);
    expect(accessLog.indexOf('resp_headers>Content-Disposition delete')).toBeGreaterThan(
      accessLog.indexOf('resp_headers>X-Csrf-Token delete'),
    );
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

describe('compose.yaml (development)', () => {
  it('publishes every port on 127.0.0.1 only (decision 055)', () => {
    const dev = Bun.YAML.parse(read('compose.yaml')) as { services: Record<string, Service> };
    const ports = Object.entries(dev.services).flatMap(([name, definition]) =>
      ((definition.ports as string[] | undefined) ?? []).map((port) => [name, port] as const),
    );
    expect(ports.length).toBeGreaterThanOrEqual(9);
    for (const [name, port] of ports) expect(port, name).toStartWith('127.0.0.1:');
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
