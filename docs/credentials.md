# Local credentials and rotation

`sfac init` refuses existing state to avoid overwriting secrets for a retained
database. `runtime/configure.py` has the same rule for the optional native profile.
Preserve state and take a private database backup before changing credentials.
The container paths below are `.factory/`; native paths are `runtime/`.

- **Webhook secret:** stop intake, replace `secrets/webhook_secret` with a new
  cryptographically random value in a private file, update the GitHub App's webhook
  secret to match, then start and verify a new signed delivery. Demo submission
  reads the same file. Never paste a secret into an issue, log or command argument.
- **App private key:** generate a replacement in your GitHub App settings, install
  it as `secrets/app_private_key` with mode 0600, restart intake and run
  `./sfac worker github-check`. Revoke the old key after the replacement works;
  revoke immediately if compromised. Preserve the App/installation identity.
- **Model key:** stop active runs, replace private `secrets/model_key`, revoke the
  old provider key, and authorize any new test run explicitly. New supervisor runs
  read the replacement. Do not automatically repeat a paid job to test rotation.
- **Runtime database password:** stop services and active supervisors, replace
  `secrets/database_password`, then run `./sfac up`. The migrator authenticates
  with the unchanged admin credential and sets the runtime role password before
  runtime startup. Preserve the old value until the replacement is verified.
- **Database admin password:** changing `secrets/admin_password` alone does not
  update an initialized PostgreSQL volume. This requires a PostgreSQL administrator
  to change the role password and private file together while services are stopped.
  This launcher does not automate admin rotation. Do not delete a retained volume
  to work around a password mismatch; restore access or follow a reviewed restore.

Keep directories mode 0700 and secret files mode 0600, owned by the configuring
user. Back up secrets separately from database dumps using your approved encrypted
storage. A dump can contain source, prompts and audit records; handle it as private
data. See [quickstart backup verification](quickstart.md#persistence-backup-and-cleanup)
and [native backup/restore](local-runtime.md#backup-restore-and-reset).
