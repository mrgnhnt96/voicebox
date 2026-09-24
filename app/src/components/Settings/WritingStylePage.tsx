import { useTranslation } from 'react-i18next';
import { SettingSection } from '@/components/ServerTab/SettingRow';
import { CalibrationCard } from '@/components/WritingStyle/CalibrationCard';
import { CorrectionNotes } from '@/components/WritingStyle/CorrectionNotes';
import { PersonalExamples } from '@/components/WritingStyle/PersonalExamples';
import { RecentCorrections } from '@/components/WritingStyle/RecentCorrections';
import { ResetWritingStyle } from '@/components/WritingStyle/ResetWritingStyle';

/** Writing style: calibration, learned habits, examples, corrections. */
export function WritingStylePage() {
  const { t } = useTranslation();
  return (
    <>
      <CalibrationCard />
      <SettingSection title={t('writingStyle.settings.learnsFrom')}>
        <PersonalExamples />
        <CorrectionNotes />
        <ResetWritingStyle />
      </SettingSection>
      <RecentCorrections />
    </>
  );
}
