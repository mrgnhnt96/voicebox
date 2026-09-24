import { Link, useMatchRoute } from '@tanstack/react-router';
import { Box, Captions, type LucideIcon, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import voiceboxLogo from '@/assets/voicebox-logo.png';
import { cn } from '@/lib/utils/cn';
import { version } from '../../package.json';

const tabs: Array<{ id: string; path: string; icon: LucideIcon; labelKey: string }> = [
  { id: 'captures', path: '/captures', icon: Captions, labelKey: 'nav.captures' },
  { id: 'models', path: '/models', icon: Box, labelKey: 'nav.models' },
  { id: 'settings', path: '/settings', icon: SlidersHorizontal, labelKey: 'nav.settings' },
];

/** The app's left rail: logo, labeled icons, version. */
export function Sidebar() {
  const { t } = useTranslation();
  const matchRoute = useMatchRoute();

  return (
    <nav
      aria-label="Main"
      className="w-[68px] shrink-0 flex flex-col items-center gap-1 pt-3 pb-3 bg-sidebar border-r border-border"
    >
      <img src={voiceboxLogo} alt="Voicebox" className="mb-4 h-8 w-8 object-contain" />

      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = matchRoute({ to: tab.path, fuzzy: true });
        return (
          <Link
            key={tab.id}
            to={tab.path}
            className={cn(
              'flex h-[52px] w-14 flex-col items-center justify-center gap-1 rounded-lg text-[10px] transition-colors',
              isActive
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
            )}
          >
            <Icon className="h-[18px] w-[18px]" strokeWidth={1.7} />
            {t(tab.labelKey)}
          </Link>
        );
      })}

      <span className="mt-auto font-mono text-[10px] text-muted-foreground/60">v{version}</span>
    </nav>
  );
}
