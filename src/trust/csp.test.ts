import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CSP_CORE_DIRECTIVES,
  CSP_HEADER_STRING,
  CSP_META_STRING,
  HF_MODEL_HOSTS,
  parseCsp,
} from './csp';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function extractMetaCspFromIndexHtml(): string {
  const html = readFileSync(resolve(repoRoot, 'index.html'), 'utf-8');
  const match = html.match(
    /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
  );
  if (!match) {
    throw new Error('No CSP <meta> tag found in index.html');
  }
  return match[1];
}

function extractHeaderCspFromHeadersFile(): string {
  const headers = readFileSync(resolve(repoRoot, 'public/_headers'), 'utf-8');
  const match = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m);
  if (!match) {
    throw new Error('No Content-Security-Policy header found in public/_headers');
  }
  return match[1].trim();
}

describe('CSP constants (src/trust/csp.ts)', () => {
  it('defines default-src and connect-src including self', () => {
    expect(CSP_CORE_DIRECTIVES['default-src']).toContain("'self'");
    expect(CSP_CORE_DIRECTIVES['connect-src']).toContain("'self'");
  });

  it('is present in the meta CSP string with connect-src and default-src', () => {
    expect(CSP_META_STRING).toContain("default-src 'self'");
    expect(CSP_META_STRING).toMatch(/connect-src [^;]*'self'/);
  });

  // Covers R10. Allows exactly the documented HF hosts as the only
  // third-party origins in connect-src, nothing else. The complementary
  // manual check (DevTools: fly-mode on, only same-origin + these hosts
  // ever appear in the Network tab) is a separate manual milestone per the
  // plan (U1 test scenarios) — this test only proves the *policy string*
  // is scoped correctly, not runtime browser enforcement.
  it('allows exactly the documented HF model hosts as foreign connect-src origins, and no others', () => {
    const connectSrc = parseCsp(CSP_HEADER_STRING)['connect-src'];
    const foreignOrigins = connectSrc.filter((value) => value !== "'self'");

    expect(new Set(foreignOrigins)).toEqual(new Set(HF_MODEL_HOSTS));

    const knownDisallowedHosts = [
      'https://example.com',
      'https://api.openai.com',
      'https://google-analytics.com',
      '*',
      'https:',
    ];
    for (const host of knownDisallowedHosts) {
      expect(foreignOrigins).not.toContain(host);
    }
  });

  it('does not allow wildcard or unsafe-inline in script-src (only self + wasm-unsafe-eval)', () => {
    expect(new Set(CSP_CORE_DIRECTIVES['script-src'])).toEqual(
      new Set(["'self'", "'wasm-unsafe-eval'"]),
    );
  });

  // Drift test: index.html (<meta>, local-only fallback) and public/_headers
  // (real HTTP header, authoritative on Cloudflare Pages) are separate
  // static files that both have to match src/trust/csp.ts by hand. This
  // test is the guardrail that catches the moment they drift apart.
  it('index.html meta CSP and public/_headers CSP share the same core directives', () => {
    const metaCsp = parseCsp(extractMetaCspFromIndexHtml());
    const headerCsp = parseCsp(extractHeaderCspFromHeadersFile());
    const expectedCsp = parseCsp(CSP_META_STRING);

    for (const directive of Object.keys(CSP_CORE_DIRECTIVES)) {
      expect(new Set(metaCsp[directive])).toEqual(new Set(expectedCsp[directive]));
      expect(new Set(headerCsp[directive])).toEqual(new Set(expectedCsp[directive]));
    }
  });

  it('public/_headers additionally sets frame-ancestors none (meta cannot)', () => {
    const headerCsp = parseCsp(extractHeaderCspFromHeadersFile());
    expect(headerCsp['frame-ancestors']).toEqual(["'none'"]);

    const metaCsp = parseCsp(extractMetaCspFromIndexHtml());
    expect(metaCsp['frame-ancestors']).toBeUndefined();
  });

  it('CSP_HEADER_STRING matches what public/_headers actually ships', () => {
    expect(parseCsp(extractHeaderCspFromHeadersFile())).toEqual(
      parseCsp(CSP_HEADER_STRING),
    );
  });
});
