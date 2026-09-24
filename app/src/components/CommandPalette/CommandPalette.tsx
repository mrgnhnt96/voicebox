import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogOverlay, DialogPortal } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils/cn';
import { captureText, searchCaptures } from './captureSearch';
import { PaletteCaptureRow, PaletteCommandRow } from './PaletteRows';
import { usePaletteCommands } from './usePaletteCommands';

/** Most captures listed at once; the Captures screen has the full list. */
const CAPTURE_LIMIT = 6;
const LISTBOX_ID = 'command-palette-list';
const optionId = (index: number) => `command-palette-option-${index}`;

/**
 * The ⌘K palette: search captures and run commands.
 *
 * ⌘K toggles it from anywhere in the main window. A leading ``>`` limits
 * the list to commands. ⏎ runs the highlighted row, and ⌘⏎ on a capture
 * copies its text instead of opening it.
 */
export function CommandPalette() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
        // Leave another open dialog (calibration, a delete confirmation) alone.
        const otherDialog = document.querySelector(
          '[role="dialog"]:not([data-command-palette]), [role="alertdialog"]',
        );
        if (otherDialog) return;
        event.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Each open starts fresh.
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          data-command-palette
          aria-describedby={undefined}
          className="fixed left-1/2 top-[14vh] z-50 w-[620px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-xl border border-input bg-popover shadow-2xl shadow-black/60 focus:outline-none"
        >
          <DialogPrimitive.Title className="sr-only">{t('palette.label')}</DialogPrimitive.Title>
          {open ? (
            <PaletteBody
              query={query}
              setQuery={setQuery}
              selected={selected}
              setSelected={setSelected}
              close={() => setOpen(false)}
            />
          ) : null}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

interface PaletteBodyProps {
  query: string;
  setQuery: (q: string) => void;
  selected: number;
  setSelected: (i: number) => void;
  close: () => void;
}

type Item =
  | { kind: 'capture'; id: string; open: () => void; copy: () => void }
  | { kind: 'command'; id: string; open: () => void };

/** Mounted only while open, so the captures query runs on demand. */
function PaletteBody({ query, setQuery, selected, setSelected, close }: PaletteBodyProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const commands = usePaletteCommands();
  // Same key and page size as the Captures screen, so the two share a cache.
  const { data: capturesData } = useQuery({
    queryKey: ['captures'],
    queryFn: () => apiClient.listCaptures(200, 0),
  });

  const commandsOnly = query.startsWith('>');
  const term = (commandsOnly ? query.slice(1) : query).trim();

  const captureMatches = useMemo(
    () => (commandsOnly ? [] : searchCaptures(capturesData?.items ?? [], term, CAPTURE_LIMIT)),
    [capturesData, term, commandsOnly],
  );
  const commandMatches = term
    ? commands.filter((c) => c.label.toLowerCase().includes(term.toLowerCase()))
    : commands;

  const copy = async (text: string) => {
    close();
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: t('captures.toast.transcriptCopied') });
    } catch {
      toast({ title: t('captures.toast.copyFailed'), variant: 'destructive' });
    }
  };

  const items: Item[] = [
    ...captureMatches.map(
      ({ capture }): Item => ({
        kind: 'capture',
        id: capture.id,
        open: () => {
          close();
          navigate({ to: '/captures', search: { capture: capture.id } });
        },
        copy: () => void copy(captureText(capture)),
      }),
    ),
    ...commandMatches.map(
      (command): Item => ({
        kind: 'command',
        id: command.id,
        open: () => {
          close();
          command.run();
        },
      }),
    ),
  ];
  const active = Math.min(selected, Math.max(items.length - 1, 0));

  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (items.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setSelected((active + step + items.length) % items.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[active];
      if (!item) return;
      if (event.metaKey && item.kind === 'capture') item.copy();
      else item.open();
    }
  };

  return (
    <>
      <label className="flex h-14 items-center gap-3 border-b border-border px-[18px]">
        <Search className="h-[17px] w-[17px] shrink-0 text-muted-foreground" aria-hidden />
        <input
          role="combobox"
          aria-expanded
          aria-controls={LISTBOX_ID}
          aria-activedescendant={items.length ? optionId(active) : undefined}
          aria-label={t('palette.placeholder')}
          placeholder={t('palette.placeholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
          className="flex-1 bg-transparent text-[17px] text-foreground outline-none placeholder:text-muted-foreground"
        />
        <Kbd>esc</Kbd>
      </label>

      <div id={LISTBOX_ID} role="listbox" className="max-h-[min(460px,60vh)] overflow-y-auto p-2">
        {captureMatches.length > 0 ? (
          // biome-ignore lint/a11y/useSemanticElements: an option group inside a listbox; a fieldset isn't valid there
          <div role="group" aria-labelledby="palette-captures-heading">
            <GroupHeading id="palette-captures-heading">
              {t('palette.captures', { count: captureMatches.length })}
            </GroupHeading>
            {captureMatches.map((match, i) => (
              <PaletteCaptureRow
                key={match.capture.id}
                id={optionId(i)}
                match={match}
                query={term}
                selected={active === i}
                onHover={() => setSelected(i)}
                onChoose={items[i].open}
              />
            ))}
          </div>
        ) : null}
        {commandMatches.length > 0 ? (
          // biome-ignore lint/a11y/useSemanticElements: an option group inside a listbox; a fieldset isn't valid there
          <div role="group" aria-labelledby="palette-commands-heading">
            <GroupHeading id="palette-commands-heading" spaced={captureMatches.length > 0}>
              {t('palette.commands')}
            </GroupHeading>
            {commandMatches.map((command, j) => {
              const i = captureMatches.length + j;
              return (
                <PaletteCommandRow
                  key={command.id}
                  id={optionId(i)}
                  command={command}
                  selected={active === i}
                  onHover={() => setSelected(i)}
                  onChoose={items[i].open}
                />
              );
            })}
          </div>
        ) : null}
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">
            {t('palette.empty')}
          </p>
        ) : null}
      </div>

      <div className="flex gap-[18px] border-t border-border px-[18px] py-2.5 font-mono text-[11px] text-muted-foreground">
        <span>{t('palette.hints.move')}</span>
        <span>{t('palette.hints.open')}</span>
        <span>{t('palette.hints.copy')}</span>
        <span className="flex-1" />
        <span>{t('palette.hints.commandsOnly')}</span>
      </div>
    </>
  );
}

function GroupHeading({
  id,
  spaced = false,
  children,
}: {
  id: string;
  spaced?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className={cn(
        'px-2.5 pb-1.5 font-mono text-[11px] text-muted-foreground',
        spaced ? 'pt-3.5' : 'pt-2.5',
      )}
    >
      {children}
    </div>
  );
}
