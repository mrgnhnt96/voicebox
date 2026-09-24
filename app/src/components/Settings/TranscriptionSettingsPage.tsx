import { useTranslation } from 'react-i18next';
import { SettingRow, SettingSection } from '@/components/ServerTab/SettingRow';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import type { PunctuationStyle, Qwen3ModelSize, WhisperModelSize } from '@/lib/api/types';
import { useCaptureSettings } from '@/lib/hooks/useSettings';
import { useWritingStyle } from '@/lib/hooks/useWritingStyle';

const P = 'settings.captures.transcription';
const R = 'settings.captures.refinement';

/** Whisper sizes, each with the speed/accuracy note shown after its name. */
const WHISPER_MODELS: Array<{ value: WhisperModelSize; tail: string }> = [
  { value: 'base', tail: 'fast' },
  { value: 'small', tail: 'balanced' },
  { value: 'medium', tail: 'higher' },
  { value: 'large', tail: 'best' },
  { value: 'turbo', tail: 'nearBest' },
];

const LANGUAGES = ['auto', 'en', 'es', 'fr', 'de', 'ja', 'zh', 'hi'] as const;

const QWEN_MODELS: Array<{ value: Qwen3ModelSize; key: string; tail: string }> = [
  { value: '0.6B', key: 'size06', tail: 'veryFast' },
  { value: '1.7B', key: 'size17', tail: 'fast' },
  { value: '4B', key: 'size40', tail: 'fullQuality' },
];

/** Transcription (Whisper) and refinement (Qwen3) settings. */
export function TranscriptionSettingsPage() {
  const { t } = useTranslation();
  const { settings, update } = useCaptureSettings();
  const { data: writingStyle } = useWritingStyle();
  const sttModel = settings?.stt_model ?? 'turbo';
  const language = settings?.language ?? 'auto';
  const autoRefine = settings?.auto_refine ?? true;
  const llmModel = settings?.llm_model ?? '0.6B';
  const smartCleanup = settings?.smart_cleanup ?? true;
  const selfCorrection = settings?.self_correction ?? true;
  const preserveTechnical = settings?.preserve_technical ?? true;
  const punctuationStyle = settings?.punctuation_style ?? 'standard';

  return (
    <>
      <SettingSection title={t(`${P}.title`)}>
        <SettingRow
          title={t(`${P}.model.title`)}
          description={t(`${P}.model.description`)}
          action={
            <Select
              value={sttModel}
              onValueChange={(v) => update({ stt_model: v as WhisperModelSize })}
            >
              <SelectTrigger className="h-8 w-[300px]" aria-label={t(`${P}.model.title`)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WHISPER_MODELS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {t(`${P}.model.${m.value}`, { tail: t(`${P}.model.tail.${m.tail}`) })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />

        <SettingRow
          title={t(`${P}.language.title`)}
          description={t(`${P}.language.description`)}
          action={
            <Select value={language} onValueChange={(v) => update({ language: v })}>
              <SelectTrigger className="h-8 w-[200px]" aria-label={t(`${P}.language.title`)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((code) => (
                  <SelectItem key={code} value={code}>
                    {t(`${P}.language.${code}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingSection>

      <SettingSection title={t(`${R}.title`)}>
        <SettingRow
          title={t(`${R}.auto.title`)}
          description={t(`${R}.auto.description`)}
          htmlFor="autoRefine"
          action={
            <Toggle
              id="autoRefine"
              checked={autoRefine}
              onCheckedChange={(v) => update({ auto_refine: v })}
            />
          }
        />

        <SettingRow
          title={t(`${R}.model.title`)}
          description={t(`${R}.model.description`)}
          action={
            <Select
              value={llmModel}
              onValueChange={(v) => update({ llm_model: v as Qwen3ModelSize })}
              disabled={!autoRefine}
            >
              <SelectTrigger className="h-8 w-[300px]" aria-label={t(`${R}.model.title`)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QWEN_MODELS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {t(`${R}.model.${m.key}`, { tail: t(`${R}.model.tail.${m.tail}`) })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />

        <SettingRow
          title={t(`${R}.smartCleanup.title`)}
          description={t(`${R}.smartCleanup.description`)}
          htmlFor="smartCleanup"
          action={
            <Toggle
              id="smartCleanup"
              checked={smartCleanup}
              onCheckedChange={(v) => update({ smart_cleanup: v })}
              disabled={!autoRefine}
            />
          }
        />

        <SettingRow
          title={t(`${R}.selfCorrection.title`)}
          description={t(`${R}.selfCorrection.description`)}
          htmlFor="selfCorrection"
          action={
            <Toggle
              id="selfCorrection"
              checked={selfCorrection}
              onCheckedChange={(v) => update({ self_correction: v })}
              disabled={!autoRefine}
            />
          }
        />

        <SettingRow
          title={t(`${R}.preserveTechnical.title`)}
          description={t(`${R}.preserveTechnical.description`)}
          htmlFor="preserveTechnical"
          action={
            <Toggle
              id="preserveTechnical"
              checked={preserveTechnical}
              onCheckedChange={(v) => update({ preserve_technical: v })}
              disabled={!autoRefine}
            />
          }
        />

        {/* Not tied to auto-refine: pause joins in raw dictation follow it too. */}
        <SettingRow
          title={t(`${R}.punctuationStyle.title`)}
          description={t(`${R}.punctuationStyle.description`)}
          action={
            <Select
              value={punctuationStyle}
              onValueChange={(v) => update({ punctuation_style: v as PunctuationStyle })}
            >
              <SelectTrigger
                className="h-8 w-[300px]"
                aria-label={t(`${R}.punctuationStyle.title`)}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="casual">{t(`${R}.punctuationStyle.casual`)}</SelectItem>
                <SelectItem value="standard">{t(`${R}.punctuationStyle.standard`)}</SelectItem>
                <SelectItem value="learned" disabled={!writingStyle?.ready}>
                  {writingStyle?.ready
                    ? t(`${R}.punctuationStyle.learned`)
                    : t(`${R}.punctuationStyle.learnedLocked`)}
                </SelectItem>
              </SelectContent>
            </Select>
          }
        />
      </SettingSection>
    </>
  );
}
