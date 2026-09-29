/**
 * Secret-shaped paths (matched lowercased) and secret material. Shared by the classifier (a
 * change touching them is secrets handling) and the collector sandbox (its snapshot never
 * carries them), so this module has no imports and ships in the worker image.
 */
export const SECRET_MATERIAL_PATH =
  /(^|\/)\.env(\.[^/]*)?$|\.(pem|key|p12|pfx|jks|keystore|crt|cer|gpg|asc)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|(^|\/|[-_.])(secret|secrets|credential|credentials)([-_./]|$)/;
const ENVIRONMENT_LINE = /^(export\s+|declare\s+-x\s+)?[A-Za-z_][A-Za-z0-9_]*=/;
/** Variables every process environment carries; a configuration file names none of them. */
const ENVIRONMENT_IDENTITY =
  /^(export\s+|declare\s+-x\s+)?(PATH|HOME|PWD|OLDPWD|HOSTNAME|SHLVL|_|TERM|USER|LOGNAME|SHELL|LANG|LC_ALL|TMPDIR)=/;
/**
 * The shape of `env` output: at least five non-empty lines, four in five of them `NAME=value`,
 * and at least two of the variables a process always has. A settings file with five keys is not.
 */
export function isEnvironmentDump(content: string): boolean {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 5) return false;
  const assignments = lines.filter((line) => ENVIRONMENT_LINE.test(line)).length;
  const identity = lines.filter((line) => ENVIRONMENT_IDENTITY.test(line)).length;
  return assignments * 5 >= lines.length * 4 && identity >= 2;
}
export const SECRET_MATERIAL_CONTENT =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{20,}|\bsk-ant-[A-Za-z0-9_-]{20,}|\bsk-(proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\b(sk|rk)_live_[A-Za-z0-9]{16,}|\bAIza[0-9A-Za-z_-]{35}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[baprse]-[A-Za-z0-9-]{10,}|\bglpat-[A-Za-z0-9_-]{20,}|\bnpm_[A-Za-z0-9]{36}\b|\bhf_[A-Za-z0-9]{30,}/;
