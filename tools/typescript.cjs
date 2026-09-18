// Prefer project dependencies; allow an installed global compiler for offline builds.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
try { module.exports = require('typescript'); }
catch {
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const globalRoot = execFileSync(npm, ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
    module.exports = require(path.join(globalRoot, 'typescript'));
  } catch {
    throw new Error('TypeScript is required. Run pnpm install, or use an existing global TypeScript >=5.5 installation.');
  }
}
