import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** The bundled local server. The app never talks to any other backend. */
export const SERVER_URL = 'http://127.0.0.1:17493';

interface ServerStore {
  customModelsDir: string | null;
  setCustomModelsDir: (dir: string | null) => void;
}

export const useServerStore = create<ServerStore>()(
  persist(
    (set) => ({
      customModelsDir: null,
      setCustomModelsDir: (dir) => set({ customModelsDir: dir }),
    }),
    {
      name: 'voicebox-server',
      partialize: (state) => ({ customModelsDir: state.customModelsDir }),
    },
  ),
);
