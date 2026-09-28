#!/usr/bin/env node
const HELP = `usage: tool <command> [--verbose] [--format text|json]\n\ncommands:\n  list     list items\n  show ID  show one item\n`;
if (process.argv.includes('--help')) process.stdout.write(HELP);
module.exports = { HELP };
