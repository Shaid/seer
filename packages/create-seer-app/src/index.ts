/**
 * create-seer-app — scaffold a seer project, or just its viewer or docs site.
 *
 * The three scaffolds live in one package because they are one tool: a full
 * project composes the other two, and both are independently useful for adding
 * a viewer or a docs site to a project that already exists.
 */
export { scaffold } from './project.js';
export type { ScaffoldOptions } from './project.js';

export { scaffoldViewer } from './viewer.js';
export type { ViewerContext } from './viewer.js';

export { scaffoldWebsite } from './website.js';
export type { WebsiteContext } from './website.js';

export { capitalize } from './render.js';
