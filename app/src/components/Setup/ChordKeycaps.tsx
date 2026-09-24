import { displayLabelForKey, modifierSideHint } from '@/lib/utils/keyCodes';

/** A saved chord as raised keycaps, with an L/R tag on sided modifiers. */
export function ChordKeycaps({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {keys.map((k) => {
        const side = modifierSideHint(k);
        return (
          <kbd
            key={k}
            className="relative rounded-md border border-b-2 border-input bg-secondary px-2 py-1 font-mono text-[13px] text-foreground"
          >
            {displayLabelForKey(k)}
            {side ? (
              <span className="absolute -right-1.5 -top-1.5 rounded bg-accent px-1 text-[9px] leading-[14px] text-accent-foreground">
                {side}
              </span>
            ) : null}
          </kbd>
        );
      })}
    </span>
  );
}
