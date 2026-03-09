const { execSync } = require('child_process');
const fs = require('fs');

const pkg = require('../../package.json');
const gitHash = execSync('git rev-parse --short HEAD')
  .toString()
  .trim();

const version = `${pkg.version}-${gitHash}`;

fs.writeFileSync(
  './src/version.ts',
  `export const VERSION = "${version}";\n`
);

console.log(`Injected version: ${version}`);