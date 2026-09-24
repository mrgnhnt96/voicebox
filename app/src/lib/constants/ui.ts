/**
 * UI layout constants for safe area padding
 */

const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');

/**
 * Top safe area padding - height of the drag region bar
 * On macOS this accounts for the overlay titlebar (48px).
 * On Windows the native title bar is outside the webview, so no padding is needed.
 */
export const TOP_SAFE_AREA_PADDING = isWindows ? 'pt-8' : 'pt-12';
