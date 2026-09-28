module.exports = function render(items, now) {
  return items.map((item) => `${item.text} (${item.at.toISOString()})`);
};
