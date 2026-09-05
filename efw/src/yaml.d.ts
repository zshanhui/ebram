// wrangler bundles text assets (see `rules` in wrangler.toml) — teach
// TypeScript what a `*.yaml` import is.
declare module "*.yaml" {
  const content: string;
  export default content;
}
