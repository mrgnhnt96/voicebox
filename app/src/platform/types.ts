/**
 * Platform abstraction types
 * These interfaces define the contract that platform implementations must fulfill
 */

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface PlatformFilesystem {
  saveFile(filename: string, blob: Blob, filters?: FileFilter[]): Promise<void>;
  openPath(path: string): Promise<void>;
  pickDirectory(title: string): Promise<string | null>;
}

export interface ServerLogEntry {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface PlatformLifecycle {
  startServer(modelsDir?: string | null): Promise<string>;
  stopServer(): Promise<void>;
  restartApp(): Promise<void>;
  restartServer(modelsDir?: string | null): Promise<string>;
  setupWindowCloseHandler(): Promise<void>;
  subscribeToServerLogs(callback: (entry: ServerLogEntry) => void): () => void;
  onServerReady?: () => void;
}

export interface PlatformMetadata {
  isTauri: boolean;
}

export interface Platform {
  filesystem: PlatformFilesystem;
  lifecycle: PlatformLifecycle;
  metadata: PlatformMetadata;
}
