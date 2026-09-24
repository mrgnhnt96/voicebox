import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

interface PermissionStepProps {
  /** Why macOS needs the permission, in plain words. */
  body: string;
  /** Where the switch lives in System Settings. */
  path: string;
  open: () => Promise<void>;
  /** Re-reads the permission; resolves true once it's granted. */
  recheck: () => Promise<boolean>;
}

/**
 * Body of a macOS permission step. The permission hooks also re-check on
 * window focus, so coming back from System Settings usually flips the step
 * to done without pressing anything. Once granted, the flow moves on.
 */
export function PermissionStep({ body, path, open, recheck }: PermissionStepProps) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [stillOff, setStillOff] = useState(false);

  const handleRecheck = async () => {
    setChecking(true);
    try {
      const granted = await recheck();
      setStillOff(!granted);
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <p className="text-sm leading-relaxed text-foreground/85">{body}</p>
      <div className="rounded-md border border-border bg-background px-3 py-2.5 font-mono text-xs text-muted-foreground">
        {path}
      </div>
      <div className="flex gap-2">
        <Button onClick={() => void open()}>
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          {t('setup.permission.open')}
        </Button>
        <Button variant="outline" disabled={checking} onClick={handleRecheck}>
          {checking ? t('setup.permission.checking') : t('setup.permission.recheck')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {stillOff ? t('setup.permission.stillOff') : t('setup.permission.focusHint')}
      </p>
    </>
  );
}
