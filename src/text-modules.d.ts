/**
 * Ambient type declarations for non-TS file imports done with
 * `import x from "./foo.{md,html,css,js}" with { type: "text" }`.
 *
 * Bun resolves these imports at build/start time and embeds them as string
 * literals in the compiled binary (or evaluates them eagerly under
 * `bun src/main.ts` in dev). TypeScript needs this declaration to type them
 * as `string` instead of erroring on the unknown extension.
 *
 * Used by:
 *   - instance.ts — embeds SOUL.md / SOLRAC.md as canonical defaults.
 *   - web.ts — embeds public/{index.html,style.css,app.js} + web-sanitize.ts
 *     so the compiled binary serves the UI without source-tree disk reads.
 */

declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.html" {
  const content: string;
  export default content;
}

declare module "*.css" {
  const content: string;
  export default content;
}

declare module "*.js" {
  const content: string;
  export default content;
}
