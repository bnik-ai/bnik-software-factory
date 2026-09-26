# Synthetic invoice exercise

A dependency-free example for a bounded coding-agent pilot. No real invoices,
customer records, tax logic or payment processing belong here. Amounts use integer
cents. Run `node --test invoice.test.mjs` with Node 24.21.0.

The baseline covers empty invoices and one-unit lines. Quantity support is
intentionally incomplete; the first coding Task must add it and its tests.
This source is an exercise, not a financial library.

Use the factory's `docs/end-to-end-pilot.md` walkthrough. Copy this directory into
a **new repository without the factory's Git history**, configure your own global
CODEOWNER, and keep the pilot private. Do not copy internal preparation records,
credentials or the factory runtime into the sample repository.
