#!/usr/bin/env node
// Extract only the native glyph/CSS factories for an ephemeral browser test.
// Input must be the externally supplied Steam 11006468 chunk, never a release file.
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const file = process.argv[2];
if (!file) throw Error('Usage: node tools/prepare-browser-fixture.cjs <Steam chunk~2dcc5aaf7.js>');
const factories = {};
vm.runInNewContext(fs.readFileSync(file, 'utf8'), {self: {webpackChunksteamui: {push: chunk => Object.assign(factories, chunk[1])}}}, {timeout: 5000});
for (const id of [58470, 2247]) if (typeof factories[id] !== 'function') throw Error('Missing native fixture factory ' + id);
process.stdout.write('self.webpackChunksteamui.push([[], {' + [58470, 2247].map(id => JSON.stringify(id) + ':' + factories[id].toString()).join(',') + '}]);');
