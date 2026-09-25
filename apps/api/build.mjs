// Bundles the API for production. npm dependencies stay external (installed in
// the image); the workspace's TypeScript (@roomly/shared, scripts/lib) is bundled.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@roomly/'));

await build({
  entryPoints: { server: 'src/index.ts', migrate: 'src/db/migrate-cli.ts', seed: 'src/db/seed-cli.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  external,
  // Some CommonJS deps call require(); give ESM output a require function.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
