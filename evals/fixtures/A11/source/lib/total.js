function calcTotal(lines) {
  return lines.reduce((sum, line) => sum + line.quantity * line.price, 0);
}
module.exports = { calcTotal };
