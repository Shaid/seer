/**
 * Nintendo Switch container primitives — browser-safe, no `node:*`.
 *
 * Everything here operates on `Uint8Array`s: a PFS0 partition table (the
 * shape of an NSP), a retail ticket's Rights ID and raw title key, and the
 * `NSO0` executable's segment table plus its flat decompressed image. The
 * LZ4 block codec those segments use lives in `@seer-project/core`
 * (`decompressLz4Block`), since it is not Switch-specific.
 *
 * Node-only file access — reading a 30 GB NSP's header region, carving a
 * byte range out into a file — is `@seer-project/switch/node`, kept out of
 * this barrel so a viewer can import the parsers.
 *
 * Deliberately **not** here: anything that touches console keys. No key
 * derivation, no AES, no keyset file format. Decrypting an NCA needs a
 * keyset the user supplies and a tool that consumes it (`hactool` and
 * friends); driving that is a project-level concern with project-level
 * paths, and this package stops at handing it the right byte range and the
 * right raw title key.
 */

export {
  PFS0_HEADER_SIZE,
  PFS0_ENTRY_SIZE,
  type Pfs0Entry,
  type Pfs0Header,
  parsePfs0Header,
  pfs0HeaderLength,
  parsePfs0,
} from './pfs0.js';

export { type SwitchTicket, parseTicket } from './ticket.js';

export {
  type NsoSegment,
  type NsoImage,
  buildNsoImage,
  readCString,
} from './nso.js';
