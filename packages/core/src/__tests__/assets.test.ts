import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadAssets, createAssetLoader } from '../assets.js';

function mockFetch(responses: Record<string, unknown | string>): void {
  globalThis.fetch = vi.fn(async (url: string | URL) => {
    const path = typeof url === 'string' ? url : url.pathname;
    const key = path.replace(/^https?:\/\/[^/]+/, '');
    if (!(key in responses)) {
      return new Response(null, { status: 404, statusText: 'Not Found' });
    }
    const body = responses[key];
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, {
      status: 200,
      headers: { 'content-type': key.endsWith('.json') ? 'application/json' : 'text/plain' },
    });
  }) as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadAssets', () => {
  it('fetches and parses JSON assets', async () => {
    mockFetch({
      '/assets/game1/amiga/atlas.json': { cellWidth: 16, rows: 4 },
    });

    const assets = await loadAssets<{ atlas: { cellWidth: number; rows: number } }>(
      '/assets/game1/amiga',
      { atlas: 'atlas.json' },
    );

    expect(assets.atlas).toEqual({ cellWidth: 16, rows: 4 });
  });

  it('fetches text assets as strings', async () => {
    mockFetch({
      '/assets/game1/amiga/labels.txt': 'hello world',
    });

    const assets = await loadAssets<{ labels: string }>('/assets/game1/amiga', {
      labels: 'labels.txt',
    });

    expect(assets.labels).toBe('hello world');
  });

  it('fetches multiple assets in parallel', async () => {
    mockFetch({
      '/assets/g/p/a.json': { a: 1 },
      '/assets/g/p/b.json': { b: 2 },
    });

    const assets = await loadAssets<{ a: { a: number }; b: { b: number } }>('/assets/g/p', {
      a: 'a.json',
      b: 'b.json',
    });

    expect(assets.a).toEqual({ a: 1 });
    expect(assets.b).toEqual({ b: 2 });
  });

  it('throws on HTTP errors', async () => {
    mockFetch({});

    await expect(loadAssets<{ x: unknown }>('/assets/g/p', { x: 'missing.json' })).rejects.toThrow(
      'Failed to fetch',
    );
  });
});

describe('createAssetLoader', () => {
  it('returns a reusable loader bound to a base path', async () => {
    mockFetch({
      '/assets/g/p/atlas.json': { cellWidth: 8 },
    });

    const load = createAssetLoader('/assets/g/p');
    const assets = await load<{ atlas: { cellWidth: number } }>({ atlas: 'atlas.json' });

    expect(assets.atlas).toEqual({ cellWidth: 8 });
  });
});
