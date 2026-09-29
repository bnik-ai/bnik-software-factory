/**
 * Secret-shaped paths (matched lowercased) and secret material. Shared by the classifier (a
 * change touching them is secrets handling) and the collector sandbox (its snapshot never
 * carries them), so this module has no imports and ships in the worker image.
 */
export const SECRET_MATERIAL_PATH =
  /(^|\/)\.env(\.[^/]*)?$|\.(pem|key|p12|pfx|jks|keystore|crt|cer|gpg|asc)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|(^|\/|[-_.])(secret|secrets|credential|credentials)([-_./]|$)/;
export const SECRET_MATERIAL_CONTENT =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{20,}|\bsk-ant-[A-Za-z0-9_-]{20,}|\bsk-(proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\b(sk|rk)_live_[A-Za-z0-9]{16,}|\bAIza[0-9A-Za-z_-]{35}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[baprse]-[A-Za-z0-9-]{10,}|\bglpat-[A-Za-z0-9_-]{20,}|\bnpm_[A-Za-z0-9]{36}\b|\bhf_[A-Za-z0-9]{30,}/;
