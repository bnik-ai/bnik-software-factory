const { calcTotal } = require('./total.js');
module.exports = function invoice(lines) {
  return { lines, total: calcTotal(lines) };
};
