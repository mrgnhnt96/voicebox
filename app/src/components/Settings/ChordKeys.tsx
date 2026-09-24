import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils/cn';
import { displayLabelForKey, modifierSideHint } from '@/lib/utils/keyCodes';

/**
 * A chord as keycaps. A small badge marks left- or right-hand modifiers, since
 * the chord engine tells them apart.
 */
export function ChordKeys({ keys, size = 'sm' }: { keys: string[]; size?: 'sm' | 'lg' }) {
  const { t } = useTranslation();
  if (keys.length === 0) {
    return (
      <span className="font-mono text-xs text-muted-foreground">{t('captures.chord.notSet')}</span>
    );
  }
  return (
    <span className={cn('flex items-center', size === 'lg' ? 'gap-2' : 'gap-1')}>
      {keys.map((k) => {
        const side = modifierSideHint(k);
        return (
          <kbd
            key={k}
            className={cn(
              'relative inline-flex items-center justify-center border border-input bg-secondary font-mono text-foreground',
              size === 'lg'
                ? 'min-w-10 rounded-lg border-b-[3px] px-3.5 py-2 text-lg'
                : 'min-w-7 rounded-[5px] border-b-2 px-2 py-1 text-xs',
            )}
          >
            {displayLabelForKey(k)}
            {side ? (
              <span
                className={cn(
                  'absolute flex items-center justify-center rounded bg-accent font-mono leading-none text-accent-foreground',
                  size === 'lg'
                    ? '-top-[7px] -right-[7px] px-1 py-px text-[9px]'
                    : '-top-1.5 -right-1.5 px-0.5 py-px text-[8px]',
                )}
              >
                {side}
              </span>
            ) : null}
          </kbd>
        );
      })}
    </span>
  );
}
