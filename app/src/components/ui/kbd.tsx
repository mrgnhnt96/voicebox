import type * as React from 'react';
import { cn } from '@/lib/utils/cn';

/** A keyboard key, or a shortcut hint beside a button label. */
export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-input px-1.5',
        'font-mono text-[11px] font-normal text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
