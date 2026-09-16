/** Open a selected microphone, falling back only when that device is unavailable. */
export async function openAudioInput(
  deviceId?: string | null,
  constraints: MediaTrackConstraints = {},
): Promise<MediaStream> {
  // WebKit may not support querying microphone permission; getUserMedia is
  // still authoritative there. A known denial must never start acquisition.
  let denied = false;
  try {
    const permission = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
    denied = permission?.state === 'denied';
  } catch {
    // Unsupported Permissions API; use the normal browser permission request.
  }
  if (denied) {
    throw new DOMException(
      'Microphone permission is not granted. Enable Voicebox in System Settings → Privacy & Security → Microphone.',
      'NotAllowedError',
    );
  }
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...constraints, deviceId: { exact: deviceId } },
      });
    } catch (error) {
      if (
        !(error instanceof DOMException) ||
        !['NotFoundError', 'OverconstrainedError'].includes(error.name)
      ) {
        throw error;
      }
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: constraints });
}
