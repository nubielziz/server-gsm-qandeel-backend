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
    expect(caddyfile).toContain('encode zstd gzip');
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

  it('copies no environment file into the image and bakes in no secret', () => {
    expect(dockerfile).not.toMatch(/COPY[^\n]*\.env/);
    expect(dockerfile).not.toMatch(/^(ENV|ARG)[^\n]*(SECRET|PASSWORD|TOKEN|PEPPER|KEY)/m);
  });
});
