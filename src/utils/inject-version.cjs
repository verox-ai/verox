const { execSync } = require('child_process');
const fs = require('fs');

const pkg = require('../../package.json');

let gitHash = process.env.GIT_HASH || 'unknown';
try {
  gitHash = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'pipe'] })
    .toString()
    .trim();
} catch { /* not a git repo (e.g. Docker build) */ }

const version = `${pkg.version}-${gitHash}`;

fs.writeFileSync(
  './src/version.ts',
  `export const VERSION = "${version}";\n`
);

console.log(`Injected version: ${version}`);