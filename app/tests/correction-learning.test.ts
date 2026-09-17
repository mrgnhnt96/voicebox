import { expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const { CorrectionLearning } = await import('../src/components/CapturesTab/CorrectionLearning');

test('learning is visible only for a report evaluated by the job', () => {
  for (const scenario of [
    { reports: [], evaluated: ['other'], visible: false },
    { reports: [{ id: 'pending' }], evaluated: ['other'], visible: false },
    { reports: [{ id: 'processed' }], evaluated: ['processed'], visible: true },
    { reports: [{ id: 'pending' }], evaluated: undefined, visible: false },
  ]) {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    client.setQueryData(['correction-learning'], { evaluated_report_ids: scenario.evaluated });
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(CorrectionLearning, { reports: scenario.reports }),
        ),
      );
    });
    expect(renderer!.toJSON() !== null).toBe(scenario.visible);
    act(() => renderer!.unmount());
    client.clear();
  }
});
