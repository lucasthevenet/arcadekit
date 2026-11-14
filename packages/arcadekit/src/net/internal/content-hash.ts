/**
 * A digest of the content a run is played with, as 8 hex digits: FNV-1a over its JSON. Every
 * peer of a co-op run must play the same content; the lockstep session compares this with the
 * host's at the start and refuses a mismatch. The content must be JSON data, and the
 * order of its keys counts. Plain on purpose: every peer compares it, and it is data
 * work.
 */
export const contentHash = (content: unknown): string => {
  const text = JSON.stringify(content) ?? "";
  let hash = 0x81_1c_9d_c5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.codePointAt(i)!, 0x01_00_01_93) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};
