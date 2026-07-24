import { resolve, normalize, sep } from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/**
 * Serves the gitignored, user-supplied `data/` directory at `/data/*` in
 * dev. Useful when some asset type (typically audio) is decoded in the
 * browser at runtime rather than precompiled by the offline pipeline.
 * Delete this plugin if your project does not need runtime access to raw
 * data files.
 */
function serveDataDir(): Plugin {
  const dataRoot = resolve('data');
  return {
    name: 'serve-data-dir',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/data/')) return next();

        const relPath = decodeURIComponent(req.url.slice('/data/'.length).split('?')[0]);
        const filePath = normalize(resolve(dataRoot, relPath));

        if (!filePath.startsWith(dataRoot + sep) && filePath !== dataRoot) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }

        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        res.setHeader('Content-Type', 'application/octet-stream');
        createReadStream(filePath).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [serveDataDir()],
  server: { port: 3000 },
  build: { target: 'es2023' },
  test: {
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
  },
});
