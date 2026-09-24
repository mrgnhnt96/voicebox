import type { ReactNode } from 'react';

/**
 * A group of settings rows under a small monospace heading.
 */
export function SettingSection({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-7">
      {title && (
        <h2 className="mb-1 font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
      )}
      {description && <p className="mb-1 text-xs text-muted-foreground">{description}</p>}
      <div className="divide-y divide-border/70 border-b border-border/70">{children}</div>
    </section>
  );
}

/**
 * A single settings row: label+description on the left, action on the right.
 * Use for toggles, inputs, buttons, badges — any control type.
 */
export function SettingRow({
  title,
  description,
  htmlFor,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  htmlFor?: string;
  /** Right-aligned control (checkbox, button, badge, etc.) */
  action?: ReactNode;
  /** Full-width content rendered below the label row (for sliders, inputs, etc.) */
  children?: ReactNode;
}) {
  return (
    <div className="py-3.5">
      <div className="flex items-center justify-between gap-8">
        <div className="min-w-0">
          <label
            htmlFor={htmlFor}
            className={`text-sm leading-none select-none ${htmlFor ? 'cursor-pointer' : ''}`}
          >
            {title}
          </label>
          {description && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
