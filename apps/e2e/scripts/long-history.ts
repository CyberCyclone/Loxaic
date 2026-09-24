/**
 * A mock scenario long enough to push a thread past one page of history
 * (#213), generated rather than written into `fixtures/scenarios.json`: it is
 * a hundred-odd steps that differ only in a number.
 *
 * Every step is one assistant row and one tool row, so `LONG_HISTORY_STEPS`
 * steps put more than 200 rows into a single turn. Each step's arguments
 * differ — identical steps would trip the loop detector's check-in after the
 * third — and a spec driving it must raise `maxIterations` above the step
 * count, or the step check-in pauses the run at 100.
 */
export const LONG_HISTORY_PROMPT = 'Fill a long history, one step at a time.';
export const LONG_HISTORY_STEPS = 110;
export const LONG_HISTORY_DONE = 'Filled the history.';

export function longHistoryScenario(): { match: string; steps: unknown[]; finalText: string } {
  return {
    match: 'fill a long history',
    steps: Array.from({ length: LONG_HISTORY_STEPS }, (_, i) => ({
      tool: 'todo_write',
      args: { todos: [{ id: '1', text: `Step ${String(i + 1)} of ${String(LONG_HISTORY_STEPS)}`, status: 'in_progress' }] },
    })),
    finalText: `[Mock] ${LONG_HISTORY_DONE}\n`,
  };
}
