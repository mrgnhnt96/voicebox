/** Open a selected microphone, falling back only when that device is unavailable. */
export async function openAudioInput(
  deviceId?: string | null,
  constraints: MediaTrackConstraints = {},
): Promise<MediaStream> {
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
