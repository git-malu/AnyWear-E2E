export function recordForActiveStep(activeSteps, page, record) {
  const step = activeSteps.get(page);
  if (step) record(step);
}

export function recordPathForActiveStep(activeSteps, page, path) {
  recordForActiveStep(activeSteps, page, (step) => {
    if (step.paths.at(-1) !== path) step.paths.push(path);
  });
}
