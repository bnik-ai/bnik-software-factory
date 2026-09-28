module.exports = function tokenize(text) {
  return text.split(' ').filter(Boolean);
};
