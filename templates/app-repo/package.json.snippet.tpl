// SNIPPET — not a full package.json. Merge these keys into your existing package.json.
// For non-Node stacks (Python, Go, Rust), use the equivalent dev-tool config but keep
// Husky + lint-staged for commit hygiene (they work across stacks via npx).
//
// Generated from {{FACTORY_REPO}}/templates/app-repo/package.json.snippet.tpl

{
  "scripts": {
    "prepare": "husky",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "format": "biome format --write .",
    "type-check": "tsc --noEmit",
    "test": "vitest run"
  },
  "lint-staged": {
    "*.{js,jsx,ts,tsx,json,md,css}": ["biome check --write --no-errors-on-unmatched"]
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "@commitlint/cli": "^19.0.0",
    "@commitlint/config-conventional": "^19.0.0",
    "husky": "^9.1.7",
    "lint-staged": "^16.0.0"
  }
}
