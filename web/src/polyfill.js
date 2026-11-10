// web3.js / Anchor expect Node's Buffer; this must be imported before them.
import { Buffer } from "buffer";
if (!globalThis.Buffer) globalThis.Buffer = Buffer;
