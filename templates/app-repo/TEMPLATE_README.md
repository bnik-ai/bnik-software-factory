# Application repository templates

These are experimental scaffolding inputs, not a bootstrap installer. Copy only
the files appropriate to your application. Replace every `{{VARIABLE}}`, remove
`.tpl` suffixes, and validate the result before committing. No private repository,
reusable workflow, cloud identity or deployment environment is required.

Set repository name, project description, install/lint/type-check/test commands,
CODEOWNERS and any optional Claude-specific notes. The CI example runs those
commands locally in its job; it does not call an unpublished workflow. Pin action
versions and configure required checks for your own repository before enabling it.
Dependency snippets need the application's own lockfile and license review.

Issue forms retain the experimental planning vocabulary used by existing parsers.
They are not a promise that the Task-first onboarding flow is already implemented.
Do not enable autonomous merge/deployment from these templates.
