#!/usr/bin/env node
const report = require('./lib/report.js');
const entries = JSON.parse(process.argv[2] || '[]');
const result = report(entries);
process.stdout.write(`count=${result.count} total=${result.total}\n`);
