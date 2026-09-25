// Renders every design/diagrams/{hld,lld}/*.mmd to design/images/{hld,lld}/*.png.
//   npm run design:render            (all)
//   npm run design:render -- 05      (only files whose name contains "05")
// Uses the Edge browser that ships with Windows (see puppeteer.json), so no Chromium download.
import { execFileSync } from 'node:child_process';
import { readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ?? '';
let failed = 0;
for (const level of ['hld', 'lld']) {
  const outDir = join(here, '..', 'images', level);
  mkdirSync(outDir, { recursive: true });
  for (const file of readdirSync(join(here, level)).filter((f) => f.endsWith('.mmd') && `${level}/${f}`.includes(filter)).sort()) {
    const out = join(outDir, file.replace(/\.mmd$/, '.png'));
    const render = (browserConfig) => execFileSync('npx', ['mmdc', '-q', '-p', join(here, browserConfig), '-c', join(here, 'mermaid.json'),
      '-i', join(here, level, file), '-o', out, '-s', '2', '-b', 'white', '-w', '1400'], { stdio: 'pipe', shell: true });
    try {
      try {
        render('puppeteer.json'); // Edge (ships with Windows)
      } catch (err) {
        if (!String(err.stderr).includes('Failed to launch the browser')) throw err;
        render('puppeteer-chrome.json'); // fall back to Chrome when Edge can't start
      }
      console.log(`ok   ${level}/${file}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${level}/${file}\n${String(err.stderr ?? err).split('\n').filter((l) => !/^\s+at /.test(l)).slice(0, 6).join('\n')}`);
    }
  }
}
process.exit(failed ? 1 : 0);
