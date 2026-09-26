// Synthetic onboarding exercise. Quantity support is deliberately incomplete.
export function subtotal(lines) {
  return lines.reduce((total, line) => total + line.unitPriceCents, 0);
}
