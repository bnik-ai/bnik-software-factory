# Generated from {{FACTORY_REPO}}/templates/app-repo/.gitignore.tpl
# Stack-specific entries may be appended below the marker.

# Dependencies
node_modules/
__pycache__/
*.pyc
.venv/
venv/
target/                  # Rust
bin/                     # Go binaries

# Build output
dist/
build/
.next/
out/
*.tsbuildinfo

# Test / coverage
coverage/
*.lcov
.pytest_cache/
.mypy_cache/

# Environment / secrets
.env
.env.local
.env.*.local
*.pem
*.key

# Logs
*-debug.log*
npm-debug.log*
yarn-debug.log*
pnpm-debug.log*
bun-debug.log*

# OS
.DS_Store
Thumbs.db

# IDE / agent scratch
.vscode/
.idea/
.cursor/
.draft/
.claude/
*.swp
*.swo

# Caches
.cache/
.turbo/
.vercel/

# Lockfiles you do NOT want
bun.lockb
# (Keep bun.lock, package-lock.json, etc. — those ARE source of truth.)

# Local docker / data
docker-data/
*.sqlite-journal

# Plans drafts (committed plans go in plans/; .draft/ is scratch)
plans/.draft/

# ===== stack-specific (append below) =====
