export function recordForActiveStep(activeSteps, page, record) {
  const step = activeSteps.get(page);
  if (step) record(step);
}
