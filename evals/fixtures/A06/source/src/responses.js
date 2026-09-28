module.exports = {
  ok: (body) => ({ status: 200, body }),
  invalid: (field) => ({ status: 400, body: { error: `invalid ${field}` } }),
  forbidden: (why) => ({ status: 403, body: { error: why } }),
};
