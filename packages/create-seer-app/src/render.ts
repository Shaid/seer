/**
 * Shared template-rendering plumbing for the three scaffold modes.
 *
 * Each mode gets its own `Eta` instance rooted at its own templates
 * subdirectory. That separation is load-bearing, not tidiness: five template
 * filenames (`package.json.eta`, `tsconfig.json.eta`, `README.md.eta`,
 * `.gitignore.eta`, `index.html.eta`) exist in more than one mode, so a single
 * flat template root would silently resolve the wrong one.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to one mode's template root. */
export function templatesFor(mode: 'project' | 'viewer' | 'website'): string {
  return resolve(__dirname, '../templates', mode);
}

/**
 * A renderer bound to one mode's templates.
 *
 * `autoTrim` is off for the website mode: several of its templates interpolate
 * a value as the last thing on a line (frontmatter YAML, YAML-ish config), and
 * Eta's default auto-trim eats the trailing newline and merges it with the next
 * line.
 */
export function rendererFor(
  mode: 'project' | 'viewer' | 'website',
): (template: string, data: Record<string, string>) => string {
  const eta = new Eta({
    views: templatesFor(mode),
    ...(mode === 'website' ? { autoTrim: false as const } : {}),
  });
  return (template, data) => eta.render(template, data) as string;
}

export function write(filePath: string, content: string): void {
  writeFileSync(filePath, content);
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
