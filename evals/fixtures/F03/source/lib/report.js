module.exports = function report(entries) {
  const total = entries.reduce((sum, e) => sum + e.amount, 0);
  return { count: entries.length, total };
};
