/** Storage and expansion bounds; no simulation parameters or truncation. */
export const CHECKPOINT_BYTES=25_000_000;
export const ENCODED_NODES=2_000_000;
export const EXPANDED_NODES=8_000_000;
export const EXPANDED_BYTES=200_000_000;
export const CHECKPOINT_DEPTH=40;
export const COLLECTION_LENGTH=100_001;
export const MAX_STRING=500_000;
// JSON string escaping can at most double each embedded checkpoint's UTF-8
// bytes. Two checkpoints plus a small fixed console envelope remain bounded.
export const CONSOLE_BYTES=4*CHECKPOINT_BYTES+1024;
