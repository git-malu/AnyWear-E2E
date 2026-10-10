export function recordForActiveStep<Page, Step>(
  activeSteps: ReadonlyMap<Page, Step>,
  page: Page,
  record: (step: Step) => void,
): void;
