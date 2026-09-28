// Returns the items of one page (1-based page numbers).
module.exports = function page(items, number, size) {
  const start = (number - 1) * size + 1;
  return items.slice(start, start + size);
};
