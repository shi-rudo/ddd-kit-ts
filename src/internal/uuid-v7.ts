const MAX_COUNTER = 0xfff;

let lastMilliseconds = Number.NEGATIVE_INFINITY;
let counter = 0;

/**
 * RFC 9562 UUID version 7: the Unix time in milliseconds in the first 48 bits,
 * then random bits from Web Crypto. A B-tree index on such ids stays
 * clustered.
 *
 * The ids of one process sort in creation order. Ids from several processes
 * interleave within one millisecond and depend on their clocks. Within one
 * millisecond of one process, the 12-bit `rand_a` field holds a counter that
 * starts at a random value with its top bit clear and increases by one per
 * id. When the counter runs out,
 * the time field moves one millisecond ahead. A clock that goes back does not
 * move the time field back. This is method 1 of RFC 9562, section 6.2.
 */
export function uuidV7(): string {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	const view = new DataView(bytes.buffer);
	const seed = view.getUint16(6) & 0x07ff;
	const now = Date.now();
	if (now > lastMilliseconds) {
		lastMilliseconds = now;
		counter = seed;
	} else if (counter < MAX_COUNTER) {
		counter += 1;
	} else {
		lastMilliseconds += 1;
		counter = seed;
	}

	// Bit operators work on 32 bits, and the time needs 48.
	let time = lastMilliseconds;
	for (let index = 5; index >= 0; index -= 1) {
		bytes[index] = time % 0x100;
		time = Math.floor(time / 0x100);
	}
	view.setUint16(6, 0x7000 | counter);
	view.setUint8(8, 0x80 | (view.getUint8(8) & 0x3f));

	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
