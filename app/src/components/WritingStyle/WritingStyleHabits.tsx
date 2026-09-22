import { useTranslation } from 'react-i18next';
import type { WritingStyleHabit } from '@/lib/api/types';

/** Learned punctuation habits, one plain-language line each. */
export function WritingStyleHabits({ habits }: { habits: WritingStyleHabit[] }) {
  const { t } = useTranslation();
  return (
    <ul className="list-disc pl-5 space-y-0.5">
      {habits.map((habit) => (
        <li key={habit}>{t(`writingStyle.habits.${habit}`)}</li>
      ))}
    </ul>
  );
}
