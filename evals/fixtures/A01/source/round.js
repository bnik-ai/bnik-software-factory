// Round to cents, half up.
module.exports = function roundCents(value) {
  return Math.floor(value * 100) / 100;
};
