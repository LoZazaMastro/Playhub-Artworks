'use strict';
// Pass explicit paths, rather than a shell glob, so the test command also works on Windows.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const directory = path.resolve(__dirname, '../tests');
const files = fs.readdirSync(directory).filter(name => name.endsWith('.test.cjs')).sort()
  .map(name => path.join(directory, name));
if (!files.length) throw new Error('No frontend tests found.');
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
